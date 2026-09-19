'use strict';
// SESSION BOARD (session-board-v1) — "what is worth looking at RIGHT NOW, how good is it,
// and on what time frame?" — assembled from the engines the app already runs (op=today
// decision rows, the day-trade lifecycle, the premarket gap lane) and re-read against the
// exchange session at the moment of the request.
//
// PURE: no I/O, no clock of its own (`now` is injected), no mutation of inputs. The route
// (lib/session-board-routes.js) owns every fetch and store call.
//
// HONESTY CONTRACT. No lane in the app has validated, weight-bearing edge today (every
// governance status is paper / shadow). The grade below is therefore a SNAPSHOT-QUALITY
// read — how well a candidate lines up on the checklist an expert trader would run — with
// a hard ceiling of 'B' until a lane earns governance weight, and a ceiling of 'D' (held
// out) for any lane whose realized record is proven negative (lib/negative-lanes). A value
// the inputs do not carry is reported as null with its label — never invented.

const MS = require('./market-session');
const NL = require('./negative-lanes');
// Plain-English holding period per horizon — the same copy op=today stamps on every row.
const { HOLD_WINDOW } = require('./decision');

const VERSION = 'session-board-v1';

// ── Time frames ─────────────────────────────────────────────────────────────
const TIMEFRAME_LABEL = Object.freeze({
  intraday: 'Intraday (today)',
  swing: 'Days to weeks',
  position: 'Weeks to months',
  portfolio: 'Long term',
});
const TIMEFRAME_KEYS = Object.freeze(Object.keys(TIMEFRAME_LABEL));
// Which time frame leads the board in each phase: before/inside the session the intraday
// names matter first; after the close the intraday board is history and swings lead.
const PHASE_ORDER = Object.freeze({
  premarket: ['intraday', 'swing', 'position', 'portfolio'],
  regular: ['intraday', 'swing', 'position', 'portfolio'],
  afterhours: ['swing', 'position', 'portfolio', 'intraday'],
  closed: ['swing', 'position', 'portfolio', 'intraday'],
});

// ── Grade rubric (fixed) ────────────────────────────────────────────────────
// score = 0.35·evidence + 0.35·setup + 0.20·live + 0.10·regime, each component 0-100.
const WEIGHTS = Object.freeze({ evidence: 0.35, setup: 0.35, live: 0.20, regime: 0.10 });
const LETTER_FLOOR = Object.freeze([['A', 80], ['B', 65], ['C', 50], ['D', 35], ['F', 0]]);
const LETTER_MAX_SCORE = Object.freeze({ A: 100, B: 79, C: 64, D: 49, F: 34 });
const MATURITY_SCORE = Object.freeze({ validated: 100, promising: 75, experimental: 50, informational: 35, disabled: 0 });
const UNMEASURED_EVIDENCE = 50;
const LIVE_STATUS_SCORE = Object.freeze({
  'in-zone': 85, 'not-triggered': 70, triggered: 60, extended: 30, 'target-hit': 20, stopped: 0, unknown: 50,
});
const GAP_GOOD_MAX_PCT = 8;
const GAP_EXTENDED_PCT = 15;
const PRE_RELVOL_ACTIVE = 0.2;
const LIQUID_DOLLAR_VOL = 2_000_000;
const THIN_DOLLAR_VOL = 500_000;
const ENTRY_ZONE_PCT = 3;
const MIN_STOP_DISTANCE_PCT = 2;
const MIN_TARGET_DISTANCE_PCT = 5;
const RELVOL_ACTIVE = 1.5;
const ATR_PCT_RANGE = Object.freeze({ lo: 1.5, hi: 12 });
const SI_HIGH_PCT = 20;
const EARNINGS_SOON_SESSIONS = 5;
const NO_EDGE_WHY = 'No lane has validated edge yet — grade is a snapshot-quality read';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => (num(v) == null ? null : +v.toFixed(1));
const r2 = (v) => (num(v) == null ? null : +v.toFixed(2));
const isShort = (row) => String((row && row.side) || 'long').toLowerCase() === 'short';

// ── Session phase ───────────────────────────────────────────────────────────
// Converts an ET wall-clock (date + minutes past midnight) to a UTC instant. Two passes
// through Intl absorb the DST offset without a timezone table.
function etWallToUtc(etDate, minutes) {
  const [y, m, d] = etDate.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  for (let i = 0; i < 2; i++) {
    const p = MS.etParts(new Date(guess));
    const [py, pm, pd] = p.date.split('-').map(Number);
    const wall = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    guess += (Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60) - wall);
  }
  return new Date(guess);
}

function nextOpenAfter(now, deps) {
  const DAY = 24 * 60 * 60 * 1000;
  let probe = new Date(now.getTime());
  for (let i = 0; i < 15; i++) {
    const info = deps.sessionInfoAt(probe);
    if (info.isTradingDay && (i > 0 || info.etMinutes < info.regularOpenMin)) {
      return etWallToUtc(info.etDate, info.regularOpenMin);
    }
    probe = new Date(probe.getTime() + DAY);
  }
  return null;
}

// { phase, label, etTime, etDate, minutesToOpen, minutesToClose, nextTransition, isTradingDay }
function sessionPhase(now = new Date(), deps = {}) {
  const sessionInfoAt = deps.sessionInfoAt || MS.sessionInfoAt;
  const info = sessionInfoAt(now);
  const phase = info.marketSession;
  const hh = String(Math.floor(info.etMinutes / 60)).padStart(2, '0');
  const mm = String(info.etMinutes % 60).padStart(2, '0');
  const PRE_OPEN_MIN = 4 * 60;
  const postClose = info.isEarlyClose ? 17 * 60 : 20 * 60;
  let minutesToOpen = null, minutesToClose = null, nextTransition = null;
  if (phase === 'premarket') {
    minutesToOpen = info.regularOpenMin - info.etMinutes;
    nextTransition = { phase: 'regular', at: etWallToUtc(info.etDate, info.regularOpenMin).toISOString() };
  } else if (phase === 'regular') {
    minutesToClose = info.regularCloseMin - info.etMinutes;
    nextTransition = { phase: 'afterhours', at: etWallToUtc(info.etDate, info.regularCloseMin).toISOString() };
  } else if (phase === 'afterhours') {
    nextTransition = { phase: 'closed', at: etWallToUtc(info.etDate, postClose).toISOString() };
  } else if (info.isTradingDay && info.etMinutes < PRE_OPEN_MIN) {
    minutesToOpen = info.regularOpenMin - info.etMinutes;
    nextTransition = { phase: 'premarket', at: etWallToUtc(info.etDate, PRE_OPEN_MIN).toISOString() };
  } else {
    const open = nextOpenAfter(now, { sessionInfoAt });
    if (open) {
      minutesToOpen = Math.round((open.getTime() - now.getTime()) / 60000);
      nextTransition = { phase: 'premarket', at: new Date(open.getTime() - (info.regularOpenMin - PRE_OPEN_MIN) * 60000).toISOString() };
    }
  }
  const label = phase === 'premarket' ? 'Premarket'
    : phase === 'regular' ? 'Regular session'
    : phase === 'afterhours' ? 'After hours'
    : info.isHoliday ? 'Closed — market holiday' : info.isWeekend ? 'Closed — weekend' : 'Closed';
  return {
    phase, label, etTime: `${hh}:${mm}`, etDate: info.etDate,
    minutesToOpen, minutesToClose, nextTransition,
    isTradingDay: info.isTradingDay, isEarlyClose: info.isEarlyClose,
  };
}

// ── Time frame ──────────────────────────────────────────────────────────────
function timeframeFor(row) {
  const key = TIMEFRAME_KEYS.includes(row && row.horizon) ? row.horizon : 'swing';
  return { key, label: TIMEFRAME_LABEL[key], holdWindow: (row && row.holdWindow) || HOLD_WINDOW[key] || null };
}

// ── Component scores ────────────────────────────────────────────────────────
function evidenceScore(row, maturityGrade) {
  const g = maturityGrade && MATURITY_SCORE[String(maturityGrade).toLowerCase()];
  const gradeScore = g == null ? UNMEASURED_EVIDENCE : g;
  const conf = num(row.confidence);
  let s = conf == null ? gradeScore : 0.5 * gradeScore + 0.5 * clamp(conf);
  if (row.expectancyTiltNegative === true) s -= 15;
  const tilt = num(row.expectancyTilt);
  if (tilt != null && tilt !== 1) s += clamp((tilt - 1) * 60, -20, 15);
  return clamp(Math.round(s));
}

function rrScore(rr) {
  if (rr == null) return null;
  if (rr >= 2) return 100;
  if (rr >= 1) return Math.round(40 + (rr - 1) * 60);
  return Math.round(clamp(rr * 40, 0, 40));
}

function remainingEdgeFraction(re) {
  if (!re || typeof re !== 'object') return num(re);
  for (const k of ['fraction', 'remainingFraction', 'remaining']) if (num(re[k]) != null) return re[k];
  if (num(re.remainingPct) != null) return re.remainingPct / 100;
  return null;
}

function liquidityScore(dollarVol) {
  if (dollarVol == null) return null;
  if (dollarVol >= LIQUID_DOLLAR_VOL) return 100;
  if (dollarVol >= THIN_DOLLAR_VOL) return 60;
  return 20;
}

function directional(value, short) { return num(value) == null ? null : (short ? -value : value); }

function setupScore(row) {
  const parts = [];
  const rr = rrScore(num(row.rr)); if (rr != null) parts.push(rr);
  const rem = num(remainingEdgeFraction(row.remainingEdge)); if (rem != null) parts.push(clamp(rem * 100));
  const br = row.breadth && num(row.breadth.litCount) != null && num(row.breadth.of) > 0
    ? clamp((row.breadth.litCount / row.breadth.of) * 100) : null;
  if (br != null) parts.push(br);
  if ('catalyst' in (row || {})) parts.push(row.catalyst ? 80 : 40);
  const liq = liquidityScore(num(row.liquidity && row.liquidity.dollarVol) ?? num(row.avgDollarVol));
  if (liq != null) parts.push(liq);
  const ss = directional(row.sectorStrength, isShort(row));
  if (ss != null) parts.push(ss > 0 ? 80 : ss < 0 ? 30 : 55);
  if (!parts.length) return 50;
  return clamp(Math.round(parts.reduce((a, b) => a + b, 0) / parts.length));
}

function gapScore(gapPct, preRelVol, short) {
  const g = directional(gapPct, short);
  if (g == null) return null;
  let s = g < 0 ? 40 : g <= GAP_GOOD_MAX_PCT ? 80 : g <= GAP_EXTENDED_PCT ? 50 : 25;
  if (num(preRelVol) != null && preRelVol >= PRE_RELVOL_ACTIVE) s += 10;
  return clamp(s);
}

function liveScore(live, premarket, short) {
  const st = live && LIVE_STATUS_SCORE[live.status] != null ? LIVE_STATUS_SCORE[live.status] : null;
  const gs = premarket ? gapScore(premarket.gapPct, premarket.preRelVol, short) : null;
  if (st != null && gs != null) return Math.round(0.6 * st + 0.4 * gs);
  if (st != null) return st;
  if (gs != null) return gs;
  return LIVE_STATUS_SCORE.unknown;
}

function regimeState(regime) {
  if (!regime) return 'neutral';
  if (regime.riskOff === true || regime.bearish === true || /off/i.test(String(regime.label || regime.condition || ''))) return 'risk-off';
  if (regime.riskOn === true) return 'risk-on';
  return 'neutral';
}

// Opportunity density (lib/opportunity-density, the Today payload's `opportunity` block)
// answers "trade at all today?" — a no-trade / reduced day lowers the regime component.
const DENSITY_MULT = Object.freeze({ 'no-trade': 0.5, reduced: 0.75, selective: 0.9, normal: 1 });
function regimeScore(regime, short, density = null) {
  const st = regimeState(regime);
  const long = st === 'risk-on' ? 100 : st === 'risk-off' ? 20 : 60;
  const base = short ? 120 - long : long;
  const mult = density && DENSITY_MULT[density.decision] != null ? DENSITY_MULT[density.decision] : 1;
  return Math.round(base * mult);
}

function letterFor(score) {
  for (const [l, floor] of LETTER_FLOOR) if (score >= floor) return l;
  return 'F';
}

function letterDown(letter) {
  const order = ['A', 'B', 'C', 'D', 'F'];
  return order[Math.min(order.length - 1, order.indexOf(letter) + 1)];
}

function hasGovernanceWeight(governance) {
  const list = governance && Array.isArray(governance.strategies) ? governance.strategies : [];
  return list.some((s) => num(s && s.weight) > 0);
}

// gradeItem → { letter, score, components, caps, why, heldOut }
function gradeItem({ row, live = null, premarket = null, regime = null, negativeLanes = [], maturityGrade = null, governance = null, density = null } = {}) {
  const short = isShort(row);
  const components = {
    evidence: evidenceScore(row || {}, maturityGrade),
    setup: setupScore(row || {}),
    live: liveScore(live, premarket, short),
    regime: regimeScore(regime, short, density),
  };
  const raw = Math.round(Object.keys(WEIGHTS).reduce((a, k) => a + WEIGHTS[k] * components[k], 0));
  const caps = [];
  const why = [];
  let max = 100;
  const lane = NL.findLane(negativeLanes, row.section, row.tier, row.scope || row.universeScope || null);
  const heldOut = !!lane;
  if (heldOut) { caps.push({ rule: 'negative-lane', appliedMax: 'D' }); why.push(`Held out: ${lane.reason || lane.key + ' has a proven-negative realized record'}`); max = Math.min(max, LETTER_MAX_SCORE.D); }
  if (!hasGovernanceWeight(governance)) { caps.push({ rule: 'no-validated-edge', appliedMax: 'B' }); why.push(NO_EDGE_WHY); max = Math.min(max, LETTER_MAX_SCORE.B); }
  if (live && live.status === 'stopped') { caps.push({ rule: 'stop-hit', appliedMax: 'F' }); why.push('Stop level already breached'); max = Math.min(max, LETTER_MAX_SCORE.F); }
  else if (live && live.status === 'extended') { caps.push({ rule: 'extended', appliedMax: 'C' }); why.push('Already extended from the entry zone'); max = Math.min(max, LETTER_MAX_SCORE.C); }
  const score = Math.min(raw, max);
  let letter = letterFor(score);
  if (!short && regimeState(regime) === 'risk-off') { caps.push({ rule: 'long-in-risk-off', appliedMax: letterDown(letter) }); why.push('Risk-off tape — longs one grade down'); letter = letterDown(letter); }
  if (maturityGrade) why.push(`Lane evidence grade: ${maturityGrade}`);
  else why.push('Lane evidence grade: unmeasured');
  if (density && density.decision === 'no-trade') why.push('Opportunity density says no-trade today — regime component halved');
  if (live && live.note) why.push(live.note);
  return { letter, score, rawScore: raw, components, caps, why, heldOut };
}

// ── Checklist (never fabricated: absent input → value null, ok null) ────────
const check = (key, label, value, ok = null, unit = null) => ({ key, label, value: value == null ? null : value, ok: value == null ? null : ok, unit });

function pctFrom(price, level) {
  const p = num(price), l = num(level);
  if (p == null || l == null || p === 0) return null;
  return r2(((l - p) / p) * 100);
}

function buildChecks({ row, live, premarket, regime }) {
  const short = isShort(row);
  const dir = (v) => directional(v, short);
  const gap = premarket ? num(premarket.gapPct) : null;
  const preRv = premarket ? num(premarket.preRelVol) : null;
  const relVol = num(live && live.relVol) ?? num(row.relVol);
  const price = num(live && live.price) ?? num(premarket && premarket.preMarketPrice) ?? num(row.price) ?? num(row.last);
  const toEntry = live && live.pct && num(live.pct.toEntry) != null ? live.pct.toEntry : pctFrom(price, row.entry);
  const toStop = live && live.pct && num(live.pct.toStop) != null ? live.pct.toStop : pctFrom(price, row.stop);
  const toTarget = live && live.pct && num(live.pct.toTarget) != null ? live.pct.toTarget : pctFrom(price, row.target);
  const vwap = live && live.vwap ? live.vwap : null;
  const orb = live && live.orb ? live.orb : null;
  const atrPct = num(row.atrPct) ?? num(row._cf && row._cf.adr);
  const ss = num(row.sectorStrength);
  const si = num(row.shortInterestPct) ?? num(row.si);
  const dtc = num(row.daysToCover) ?? num(row.dtc);
  const float = num(row.floatShares) ?? num(row.float);
  const dilution = row.dilution != null ? !!(row.dilution && (row.dilution.flagged ?? row.dilution)) : null;
  const earn = num(row.sessionsToEarnings) ?? num(row.daysToEarnings);
  const rs = regimeState(regime);
  return [
    check('gapPct', 'Gap vs prior close', r2(gap), gap == null ? null : dir(gap) >= 0 && dir(gap) <= GAP_EXTENDED_PCT, '%'),
    check('preRelVol', 'Premarket relative volume', r2(preRv), preRv == null ? null : preRv >= PRE_RELVOL_ACTIVE, 'x'),
    check('relVol', 'Relative volume', r2(relVol), relVol == null ? null : relVol >= RELVOL_ACTIVE, 'x'),
    check('catalyst', 'Catalyst', row.catalyst == null ? null : (typeof row.catalyst === 'string' ? row.catalyst : (row.catalyst.type || row.catalyst.label || 'present')), row.catalyst == null ? null : true),
    check('toEntry', 'Distance to entry', r2(toEntry), toEntry == null ? null : Math.abs(toEntry) <= ENTRY_ZONE_PCT, '%'),
    check('toStop', 'Distance to stop', r2(toStop), toStop == null ? null : Math.abs(toStop) >= MIN_STOP_DISTANCE_PCT && (short ? toStop > 0 : toStop < 0), '%'),
    check('toTarget', 'Distance to target', r2(toTarget), toTarget == null ? null : Math.abs(toTarget) >= MIN_TARGET_DISTANCE_PCT && (short ? toTarget < 0 : toTarget > 0), '%'),
    check('vwap', 'VWAP side', vwap && vwap.above != null ? (vwap.above ? 'above' : 'below') : null, vwap && vwap.above != null ? (short ? !vwap.above : vwap.above) : null),
    check('orb', 'Opening range', orb && orb.state ? orb.state : null, orb && orb.state ? /break.*(up|high)|held/i.test(orb.state) === !short || /break.*(down|low)/i.test(orb.state) === short : null),
    check('atrPct', 'ATR %', r2(atrPct), atrPct == null ? null : atrPct >= ATR_PCT_RANGE.lo && atrPct <= ATR_PCT_RANGE.hi, '%'),
    check('sectorStrength', 'Sector strength', r2(ss), ss == null ? null : dir(ss) > 0),
    check('shortInterest', 'Short interest / days to cover', si == null ? null : `${r1(si)}%${dtc != null ? ` / ${r1(dtc)}d` : ''}`, si == null ? null : (short ? si < SI_HIGH_PCT : si < SI_HIGH_PCT)),
    check('float', 'Float', float, null),
    check('dilution', 'Dilution filing (424B5)', dilution, dilution == null ? null : !dilution),
    check('earningsSoon', 'Earnings within 5 sessions', earn == null ? null : earn <= EARNINGS_SOON_SESSIONS, earn == null ? null : earn > EARNINGS_SOON_SESSIONS),
    check('regime', 'Market regime', rs, short ? rs !== 'risk-on' : rs !== 'risk-off'),
  ];
}

// ── Row adapters ────────────────────────────────────────────────────────────
function todayItemBase(row) {
  return {
    id: row.id || `${row.source || row.section}:${row.horizon}:${row.ticker}`,
    ticker: row.ticker, company: row.company || null, sector: row.sector || null,
    source: row.source || null, section: row.section || null, tier: row.tier || null,
    side: isShort(row) ? 'short' : 'long', horizon: timeframeFor(row).key,
    signalClass: row.signalClass || null, evidenceClass: row.evidenceClass || row.signalClass || null, setup: row.setup || null,
  };
}

const DAYTRADE_ACTIVE = new Set(['ACTIONABLE_NOW', 'REVERSAL_RECLAIM', 'ARMED', 'BUILDING', 'WATCHING', 'OPENING_RANGE_FORMING', 'MANAGING']);

function daytradeToRow(c) {
  return {
    id: `daytrade:intraday:${c.ticker}`, ticker: c.ticker, company: c.company || null, sector: c.sector || null,
    source: 'daytrade', section: 'daytrade', tier: c.tier || null, side: 'long', horizon: 'intraday',
    setup: c.scan || null, price: num(c.currentPrice) ?? num(c.last), entry: num(c.entry), stop: num(c.stop), target: num(c.target), rr: num(c.rr),
    confidence: null, catalyst: c.catalyst ?? null, relVol: num(c.relVol), gapPct: num(c.gapPct), avgDollarVol: num(c.avgDollarVol),
    liquidity: { dollarVol: num(c.avgDollarVol) }, _cf: c._cf || null, lifecycleState: c.lifecycleState || null,
    signalClass: c.actionable ? 'ACTIONABLE' : 'RESEARCH', remainingEdge: num(c.remainingRR) != null ? { fraction: clamp(c.remainingRR / (num(c.rr) || 2), 0, 1) } : null,
  };
}

function premarketGapToRow(hit) {
  return {
    id: `premarket-gap:intraday:${hit.ticker}`, ticker: hit.ticker, source: 'premarket-gap', section: 'PremarketGap', tier: hit.direction === 'up' ? 'GAP_UP' : 'GAP_DOWN',
    side: hit.direction === 'up' ? 'long' : 'short', horizon: 'intraday', setup: 'premarket gap', price: num(hit.preMarketPrice), prevClose: num(hit.prevClose),
    entry: null, stop: null, target: null, rr: null, gapPct: num(hit.gapPct), catalyst: null,
  };
}

function collectTodayRows(todayRows) {
  if (Array.isArray(todayRows)) return todayRows;
  const buckets = [];
  for (const k of ['horizons', 'researchByHorizon', 'topByHorizon']) {
    const b = todayRows && todayRows[k];
    if (b && typeof b === 'object') for (const arr of Object.values(b)) if (Array.isArray(arr)) buckets.push(...arr);
  }
  const seen = new Set();
  return buckets.filter((r) => r && r.ticker && !seen.has(r.id || `${r.section}:${r.ticker}`) && seen.add(r.id || `${r.section}:${r.ticker}`));
}

function maturityFor(row, maturityBySection) {
  if (!maturityBySection) return null;
  return maturityBySection[row.section] || maturityBySection[row.source] || null;
}

// ── Assembly ────────────────────────────────────────────────────────────────
function assembleSessionBoard({
  now = new Date(), session = null, todayRows = null, daytradeRows = null, premarket = null,
  liveByTicker = {}, regime = null, market = null, negativeLanes = [], maturityBySection = null, governance = null,
  density = null, sources = [], deps = {},
} = {}) {
  const sess = session || sessionPhase(now, deps);
  const preRows = new Map(((premarket && premarket.rows) || []).map((r) => [r.ticker, r]));
  const gapHits = (premarket && Array.isArray(premarket.gapLane)) ? premarket.gapLane : [];
  const rows = collectTodayRows(todayRows).map((r) => ({ ...r }));
  const have = new Set(rows.map((r) => r.ticker));
  for (const c of (daytradeRows || [])) {
    if (!c || !c.ticker || (c.lifecycleState && !DAYTRADE_ACTIVE.has(c.lifecycleState))) continue;
    if (have.has(c.ticker)) continue;
    rows.push(daytradeToRow(c)); have.add(c.ticker);
  }
  for (const hit of gapHits) {
    if (!hit || !hit.ticker || have.has(hit.ticker)) continue;
    rows.push(premarketGapToRow(hit)); have.add(hit.ticker);
  }

  const items = rows.map((row) => {
    const pre = preRows.get(row.ticker) || null;
    const preSlice = pre && (num(pre.preMarketPrice) != null || num(pre.postMarketPrice) != null || num(pre.prevClose) != null)
      ? { gapPct: r2(num(pre.preMarketChangePct) ?? num(row.gapPct)), preRelVol: r2(num(pre.preRelVol)), preMarketPrice: num(pre.preMarketPrice), postMarketPrice: num(pre.postMarketPrice), postMarketChangePct: r2(num(pre.postMarketChangePct)), prevClose: num(pre.prevClose) }
      : (num(row.gapPct) != null && row.source === 'premarket-gap' ? { gapPct: r2(row.gapPct), preRelVol: null, preMarketPrice: num(row.price), postMarketPrice: null, postMarketChangePct: null, prevClose: num(row.prevClose) } : null);
    const live = liveByTicker[row.ticker] || null;
    const maturityGrade = maturityFor(row, maturityBySection);
    const grade = gradeItem({ row, live, premarket: preSlice, regime, negativeLanes, maturityGrade, governance, density });
    const tf = timeframeFor(row);
    return {
      ...todayItemBase(row), timeframe: tf, grade,
      levels: { prevClose: num(preSlice && preSlice.prevClose) ?? num(row.prevClose), entry: num(row.entry), stop: num(row.stop), target: num(row.target), rr: num(row.rr), atrPct: num(row.atrPct) ?? num(row._cf && row._cf.adr) },
      live: live || { status: 'unknown', note: sess.phase === 'regular' ? 'no live read' : `market ${sess.phase} — levels are as of the last session` },
      premarket: preSlice,
      lifecycleState: row.lifecycleState || null,
      checks: buildChecks({ row, live, premarket: preSlice, regime }),
      flags: {
        heldOut: grade.heldOut, negativeLane: grade.heldOut,
        dilution: row.dilution == null ? null : !!(row.dilution && (row.dilution.flagged ?? row.dilution)),
        shortInterest: (num(row.shortInterestPct) ?? num(row.si)) == null ? null : (num(row.shortInterestPct) ?? num(row.si)) >= SI_HIGH_PCT,
        lowFloat: row.lowFloat == null ? null : !!row.lowFloat,
      },
      why: grade.why,
    };
  });

  const order = PHASE_ORDER[sess.phase] || PHASE_ORDER.closed;
  const rank = (it) => order.indexOf(it.horizon);
  const sortFn = (a, b) => (b.grade.score - a.grade.score) || (rank(a) - rank(b)) || a.ticker.localeCompare(b.ticker);
  const shown = items.filter((i) => !i.grade.heldOut).sort(sortFn);
  const heldOut = items.filter((i) => i.grade.heldOut).sort(sortFn);
  const byTimeframe = Object.fromEntries(TIMEFRAME_KEYS.map((k) => [k, shown.filter((i) => i.horizon === k).map((i) => i.id)]));
  const counts = {
    items: shown.length, heldOut: heldOut.length,
    byGrade: Object.fromEntries(['A', 'B', 'C', 'D', 'F'].map((l) => [l, shown.filter((i) => i.grade.letter === l).length])),
    byTimeframe: Object.fromEntries(TIMEFRAME_KEYS.map((k) => [k, byTimeframe[k].length])),
  };
  const mkt = market ? {
    mode: (market.mode && (market.mode.mode || market.mode)) || null,
    spyChangePct: r2(num(market.indexes && market.indexes.SPY && market.indexes.SPY.dayReturnPct) ?? num(market.spyChangePct)),
    leading: market.leading || (market.sectors && market.sectors.leading) || null,
    weakening: market.weakening || (market.sectors && market.sectors.weakening) || null,
    asOf: market.marketDataAsOf || market.asOf || null,
    density: density ? { decision: density.decision, label: density.decisionLabel || null, maxExposurePct: num(density.maxExposurePct), score: num(density.score) } : null,
  } : (density ? { mode: null, spyChangePct: null, leading: null, weakening: null, asOf: null, density: { decision: density.decision, label: density.decisionLabel || null, maxExposurePct: num(density.maxExposurePct), score: num(density.score) } } : null);
  return {
    ok: true, version: VERSION, generatedAt: now.toISOString(),
    session: sess, regime: regime ? { state: regimeState(regime), label: regime.label || null, breadthPct: num(regime.breadthPct) } : null,
    market: mkt, items: shown, heldOut, byTimeframe, counts, sources,
    timeframeOrder: order, timeframeLabels: TIMEFRAME_LABEL,
    disclosure: 'Grades are snapshot-quality reads of how a candidate lines up on an expert checklist — not probabilities and not a validated edge. No lane in this app has earned governance weight; the ceiling is B until one does. Held-out lanes have a proven-negative realized record.',
    empty: shown.length === 0 && heldOut.length === 0,
  };
}

module.exports = {
  VERSION, TIMEFRAME_LABEL, TIMEFRAME_KEYS, PHASE_ORDER, WEIGHTS, LETTER_FLOOR, LIVE_STATUS_SCORE, DAYTRADE_ACTIVE, NO_EDGE_WHY,
  sessionPhase, etWallToUtc, timeframeFor, gradeItem, buildChecks, assembleSessionBoard,
  collectTodayRows, daytradeToRow, premarketGapToRow, regimeState, letterFor,
  DENSITY_MULT,
  _components: { evidenceScore, setupScore, liveScore, regimeScore, gapScore, rrScore },
};
