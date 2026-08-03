'use strict';
// PATTERN INTELLIGENCE ROUTES (v2) — folded into api/tracker.js (no new function).
//
//   op=patternsearch   public read — full multi-timeframe analysis for ONE ticker with a
//                      LIVE intraday confirmation object built in this runtime path, plus
//                      the ticker's persisted episodes and a chart payload for overlays.
//   op=patterns        public read — the Pattern Radar action board, served from the
//                      PERSISTED EPISODES (stateful), with scan observability + evidence.
//   op=patternlog      privileged cron writer — advance existing episodes with the new
//                      bar, then continue the resumable two-stage universe scan; create
//                      episodes for new structures (immutable first-detection record).
//   op=patterngrade    privileged cron writer — fill-aware grading of matured episodes.
//   op=patternresearch privileged — offline PIT research: collect record shards, then
//                      evaluate → the versioned evidence artifact that alone can make a
//                      family eligible for actionable language.
//
// Everything is SHADOW (weight-0): nothing here changes a live screener ranking.

const { analyzeTicker } = require('./patterns');
const EP = require('./patterns/episodes');
const { actionFor, ACTIONS, ACTION_LABEL, noviceLine } = require('./patterns/actions');
const { recommendationEligibility } = require('./patterns/confirm');
const { resolveOutcome, outcomeRecord } = require('./patterns/grade');
const RESEARCH = require('./patterns/research');
const { scanPass } = require('./patterns/scan');
const { FAMILY_DETECTORS, DISABLED_FAMILIES } = require('./patterns/families');
const { MODEL_VERSION, FEATURE_VERSION } = require('./patterns/schema');
const { isRecentSession } = require('./patterns/decision');
const { fetchDailyHistory } = require('./screener');
const universe = require('./universe');
const store = require('./store');
const { etDate } = require('./freshness');

let signal = null;
try { signal = require('./signal'); } catch { /* intraday optional */ }
let macro = null;
try { macro = require('./macro'); } catch { /* regime optional */ }

const EPISODES_PATH = 'pattern/episodes.json';
const SCAN_STATE_PATH = 'pattern/scan-state.json';
// v2 grades to its OWN resolved doc: the v1 index at pattern/resolved/index.json was
// graded by the defective pre-fill-stop grader and must never be presented as (or mixed
// into) Pattern Radar v2's record.
const RESOLVED_PATH = 'pattern/resolved/v2.json';
const EVIDENCE_PATH = 'pattern/evidence.json';
const RESEARCH_SHARD_PREFIX = 'pattern/research/';
const DAY_PREFIX = 'pattern/day/';
const EPISODE_STREAM = 'pattern-episode';         // immutable first-detection ledger
const TERMINAL_RETENTION_DAYS = 45;               // terminal episodes stay visible this long
const MAX_EPISODE_ADVANCE = 80;                   // active-episode bar updates per tick

const isNum = v => typeof v === 'number' && isFinite(v);
const sanitize = t => String(t || '').toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 8);

// fetchDailyHistory returns { candles, ... } (or, defensively, a bare array). Normalize.
function candlesOf(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.candles)) return result.candles;
  return [];
}
async function fetchDaily(sym, range = '1y') {
  try { return candlesOf(await fetchDailyHistory(sym, range)); } catch { return []; }
}

async function currentRegime() {
  if (!macro) return 'NEUTRAL';
  try {
    const m = await macro.fetchMacro();
    if (m && m.regime) return m.regime === 'riskOff' ? 'RISK_OFF' : m.regime === 'riskOn' ? 'RISK_ON' : 'NEUTRAL';
  } catch { /* degrade */ }
  return 'NEUTRAL';
}

async function loadEvidenceTable() {
  if (!store.hasStore()) return null;
  try { return await store.readJSON(EVIDENCE_PATH, null); } catch { return null; }
}

async function loadEpisodesDoc() {
  const doc = await store.readJSON(EPISODES_PATH, null);
  return doc && doc.episodes ? doc : { episodes: {}, version: EP.EPISODE_SCHEMA_VERSION, updatedAt: null };
}

// The full scan universe with market-cap bands (replaces the 16-name shortlist).
function scanUniverse() {
  const seen = new Set();
  const out = [];
  const add = (list, band) => {
    for (const t of list || []) {
      const s = sanitize(t);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push({ ticker: s, band });
    }
  };
  add(universe.LARGE, 'large');
  add(universe.SMALL_CAPS, 'small');
  add(universe.MICRO_CAPS, 'micro');
  return out;
}

// Fetch inputs and run the full analysis for one ticker.
async function analyzeOne(ticker, { withIntraday = false, marketRegime = 'NEUTRAL', spyDaily = null, corpus = [], evidenceTable = null, daily = null } = {}) {
  const sym = sanitize(ticker);
  if (!sym) return { ticker, ok: false, reason: 'bad-ticker' };
  const bars = daily || await fetchDaily(sym, '1y');
  if (!Array.isArray(bars) || bars.length < 30) return { ticker: sym, ok: false, reason: 'insufficient-history' };

  let intradayBars = null;
  if (withIntraday && signal && signal.fetchYahooIntraday) {
    try { intradayBars = await signal.fetchYahooIntraday(sym); } catch { intradayBars = null; }
  }
  const now = new Date().toISOString();
  return analyzeTicker({ ticker: sym, daily: bars, intradayBars, spyDaily, marketRegime, corpus, evidenceTable, now });
}

// ---- op=patternsearch ---------------------------------------------------------

async function runPatternSearch(req, res) {
  const ticker = sanitize(req.query.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'ticker required' });
  const [marketRegime, spyDaily, evidenceTable] = await Promise.all([currentRegime(), fetchDaily('SPY', '1y'), loadEvidenceTable()]);
  const daily = await fetchDaily(ticker, '1y');
  const report = await analyzeOne(ticker, { withIntraday: true, marketRegime, spyDaily, evidenceTable, daily });

  // The ticker's persisted episodes (stateful view) + chart payload for overlays.
  let episodes = [];
  if (store.hasStore()) {
    try {
      const doc = await loadEpisodesDoc();
      episodes = Object.values(doc.episodes).filter(e => e.ticker === ticker).map(slimEpisode);
    } catch { episodes = []; }
  }
  const chart = { candles: daily.slice(-130).map(c => ({ date: c.date, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })) };

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  return res.status(200).json({ ok: report.ok !== false, report, episodes, chart, shadow: true, generatedAt: new Date().toISOString() });
}

// ---- op=patterns (radar from persisted episodes) -------------------------------

function emptyRadar() {
  return { triggeredNow: [], ready: [], developing: [], retests: [], manage: [], failedToday: [], failedEarlier: [], expired: [], resolved: [] };
}

function slimEpisode(e) {
  return {
    episodeId: e.episodeId, ticker: e.ticker, family: e.family, label: e.label,
    direction: e.direction, timeframe: e.timeframe, state: e.state,
    detectedDate: e.detectedDate, patternStart: e.patternStart,
    trigger: e.frozen.trigger.price, triggerType: e.frozen.trigger.type,
    invalidation: isNum(e.current.invalidation) ? e.current.invalidation : e.frozen.invalidation.price,
    target: isNum(e.current.target) ? e.current.target : e.frozen.target.price,
    rr: e.frozen.plan ? e.frozen.plan.rr : null,
    setupQuality: e.setupQuality,
    structuralValidity: e.structuralValidity,
    featureCoverage: e.featureCoverage,
    entry: e.entry,
    barsSinceDetection: e.barsSinceDetection,
    regimeAtDetection: e.regimeAtDetection,
    lastEvaluatedDate: e.lastEvaluatedDate,
    lastClose: e.lastClose ?? null,
    transitions: e.transitions.slice(-5),
    amendments: e.amendments,
    modelVersion: e.modelVersion,
  };
}

// Radar card: episode + live-read fields + the fail-closed action.
function radarCard(e, { evidenceTable, date }) {
  const eligibility = recommendationEligibility({ evidenceTable, family: e.family, direction: e.direction, timeframe: e.timeframe });
  const atr = e.frozen.atr;
  const lastClose = e.lastClose;
  const trigger = e.frozen.trigger.price;
  const stop = isNum(e.current.invalidation) ? e.current.invalidation : e.frozen.invalidation.price;
  const target = isNum(e.current.target) ? e.current.target : e.frozen.target.price;
  const long = e.direction !== 'SHORT';
  const distPct = isNum(lastClose) && isNum(trigger) && lastClose > 0 ? Math.round(((trigger - lastClose) / lastClose) * (long ? 1 : -1) * 10000) / 100 : null;
  const distAtr = isNum(lastClose) && isNum(trigger) && isNum(atr) && atr > 0 ? Math.round(((long ? trigger - lastClose : lastClose - trigger) / atr) * 100) / 100 : null;
  let remainingRR = null;
  if (isNum(lastClose)) {
    const reward = long ? target - lastClose : lastClose - target;
    const risk = long ? lastClose - stop : stop - lastClose;
    remainingRR = risk > 0 ? Math.round((Math.max(reward, 0) / risk) * 100) / 100 : null;
  }
  const fresh = isRecentSession(e.lastEvaluatedDate, new Date().toISOString());
  const action = actionFor({
    state: e.state, direction: e.direction, eligibility, fresh,
    planQuality: e.setupQuality, remainingRR,
  });
  const lastTransition = e.transitions[e.transitions.length - 1];
  return {
    ...slimEpisode(e),
    action,
    actionLabel: ACTION_LABEL[action] || action,
    noviceLine: noviceLine(action, { direction: e.direction, trigger, invalidation: stop }),
    distanceToTriggerPct: distPct,
    distanceToTriggerAtr: distAtr,
    remainingRR,
    fresh,
    recommendationEligibility: eligibility,
    probability: null, // populated ONLY from a calibrated evidence cell (see below)
    lastRule: lastTransition ? lastTransition.rule : null,
    downgradeReason: action === ACTIONS.AVOID ? (e.setupQuality === 'poor' || e.setupQuality === 'invalid' ? 'poor structural reward:risk' : 'remaining reward:risk too low') : (action === ACTIONS.WATCH && !fresh ? 'data not fresh' : null),
  };
}

function attachCalibratedProbability(card, evidenceTable) {
  if (!evidenceTable || !evidenceTable.cells) return card;
  const cell = evidenceTable.cells[`${card.family}|${card.direction}|${card.timeframe}`];
  if (cell && cell.proven === true && isNum(cell.calibrationRate)) {
    return { ...card, probability: cell.calibrationRate, probabilityCI: cell.wilsonCI || null, probabilitySample: cell.effectiveN };
  }
  return card;
}

async function runPatterns(req, res) {
  const view = String(req.query.view || 'all');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  if (!store.hasStore()) return res.status(200).json({ ok: true, ready: false, reason: 'no-store', shadow: true, radar: emptyRadar() });
  const [doc, evidenceTable, scanState, resolvedDoc] = await Promise.all([
    loadEpisodesDoc(), loadEvidenceTable(), store.readJSON(SCAN_STATE_PATH, null), store.readJSON(RESOLVED_PATH, null),
  ]);
  const all = Object.values(doc.episodes);
  if (!all.length) {
    return res.status(200).json({
      ok: true, ready: false, reason: 'not-built-yet', shadow: true, radar: emptyRadar(),
      evidence: evidenceSummary(evidenceTable, resolvedDoc),
      families: familyStatus(evidenceTable),
    });
  }
  const date = etDate();
  const filtered = all.filter(e => {
    if (view === 'bullish') return e.direction === 'LONG';
    if (view === 'bearish') return e.direction === 'SHORT';
    if (view === 'actionable') return [EP.EP_STATES.CONFIRMED, EP.EP_STATES.READY, EP.EP_STATES.RETESTING, EP.EP_STATES.TRIGGERED_PENDING_CONFIRMATION].includes(e.state);
    return true;
  });
  const radar = emptyRadar();
  for (const e of filtered) {
    const bucket = EP.primaryBucket(e, { date });
    if (!radar[bucket]) radar[bucket] = [];
    radar[bucket].push(attachCalibratedProbability(radarCard(e, { evidenceTable, date }), evidenceTable));
  }
  const rank = c => (c.recommendationEligibility && c.recommendationEligibility.eligible ? 2 : 0) + (c.structuralValidity || 0) + (c.fresh ? 0.5 : 0);
  for (const k of Object.keys(radar)) radar[k].sort((a, b) => rank(b) - rank(a));

  return res.status(200).json({
    ok: true, ready: true, shadow: true, date,
    count: filtered.length,
    radar,
    scan: scanState ? { date: scanState.date, cursor: scanState.cursor, done: scanState.cursor >= (scanState.stats && scanState.stats.universe || 0), stats: scanState.stats } : null,
    evidence: evidenceSummary(evidenceTable, resolvedDoc),
    families: familyStatus(evidenceTable),
    updatedAt: doc.updatedAt,
    modelVersion: MODEL_VERSION,
  });
}

// The radar's OWN evidence line — never another strategy's record.
function evidenceSummary(evidenceTable, resolvedDoc) {
  const resolvedCount = resolvedDoc && resolvedDoc.resolved ? Object.keys(resolvedDoc.resolved).length : 0;
  const provenCells = evidenceTable && evidenceTable.cells ? Object.values(evidenceTable.cells).filter(c => c.proven === true).length : 0;
  return {
    strategyId: 'chartpattern',
    resolvedCount,
    provenFamilies: provenCells,
    artifactVersion: evidenceTable ? evidenceTable.version : null,
    artifactBuiltAt: evidenceTable ? evidenceTable.builtAt : null,
    message: resolvedCount === 0
      ? 'No independently graded Pattern Radar history yet. Every setup here is research until this system earns its own record.'
      : provenCells === 0
        ? `${resolvedCount} resolved episodes so far — no family has passed validation yet. Everything remains research-only.`
        : `${resolvedCount} resolved episodes; ${provenCells} family cell(s) validated.`,
  };
}

// Bucket 8: per-family evidence status (research-only families are explicit, and disabled
// families are labeled instead of borrowing a generic match).
function familyStatus(evidenceTable) {
  const rows = FAMILY_DETECTORS.map(f => {
    const elig = recommendationEligibility({ evidenceTable, family: f.family, direction: f.direction, timeframe: f.timeframes[0] });
    return { family: f.family, label: f.label, direction: f.direction, timeframes: f.timeframes, implemented: true, status: elig.status, reason: elig.reason };
  });
  for (const d of DISABLED_FAMILIES) rows.push({ family: d, implemented: false, status: 'not-implemented', reason: 'No structurally valid dedicated detector — disabled rather than displayed from a generic match.' });
  return rows;
}

// ---- op=patternlog (privileged: advance episodes + resumable scan) --------------

async function runPatternLog(req, res) {
  if (!store.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store' });
  const date = etDate();
  const now = new Date().toISOString();
  const [marketRegime, spyDaily, evidenceTable, doc, scanStatePrev] = await Promise.all([
    currentRegime(), fetchDaily('SPY', '1y'), loadEvidenceTable(), loadEpisodesDoc(), store.readJSON(SCAN_STATE_PATH, null),
  ]);
  const episodes = { ...doc.episodes };
  const barCache = new Map();
  const getDaily = async sym => {
    if (!barCache.has(sym)) barCache.set(sym, await fetchDaily(sym, '1y'));
    return barCache.get(sym);
  };

  // 1) ADVANCE existing non-terminal episodes with the newest bar (restore-prior-state
  //    is literal here: we read the persisted episode and advance it).
  let advanced = 0;
  let transitionsCount = 0;
  const activeTickers = [...new Set(Object.values(episodes).filter(e => !EP.isTerminal(e.state)).map(e => e.ticker))].slice(0, MAX_EPISODE_ADVANCE);
  for (const tk of activeTickers) {
    const bars = await getDaily(tk);
    if (!bars.length) continue;
    const lastBar = bars[bars.length - 1];
    for (const e of Object.values(episodes)) {
      if (e.ticker !== tk || EP.isTerminal(e.state)) continue;
      const next = EP.advanceEpisode(e, { bar: lastBar, now, date });
      if (next !== e) {
        advanced++;
        if (next.state !== e.state) transitionsCount++;
        episodes[next.episodeId] = { ...next, lastClose: lastBar.close };
      } else if (episodes[e.episodeId].lastClose !== lastBar.close) {
        episodes[e.episodeId] = { ...e, lastClose: lastBar.close };
      }
    }
  }

  // 2) SCAN: resumable two-stage pass over the full universe for NEW structures.
  const tickers = scanUniverse();
  const budgetMs = Math.max(5000, Math.min(40000, parseInt(req.query.budget, 10) || 30000));
  const { state: scanState, results } = await scanPass({
    tickers,
    state: scanStatePrev,
    date,
    budgetMs,
    fetchDaily: sym => getDaily(sym),
    analyze: async (sym, candles) => analyzeOne(sym, { marketRegime, spyDaily, evidenceTable, daily: candles }),
  });

  // 3) EPISODES from detections: match-or-create (dedup against live episodes).
  let created = 0;
  let ledgerAppends = 0;
  const existingList = Object.values(episodes);
  for (const { ticker, report } of results) {
    if (!report || !Array.isArray(report.detections)) continue;
    const dets = report.detections.filter(d => d.structural && d.structural.pass && d.plan && d.plan.trigger != null);
    for (const d of dets) {
      const detection = reconstructDetection(d, ticker);
      const match = EP.matchEpisode(existingList, detection, MODEL_VERSION);
      if (match) continue; // already tracked — advancement (step 1) owns its lifecycle
      const ep = EP.createEpisode(detection, { now, date, context: report.context || {}, modelVersion: MODEL_VERSION, featureVersion: FEATURE_VERSION });
      if (!ep) continue;
      const bars = barCache.get(ticker);
      const withClose = { ...ep, lastClose: bars && bars.length ? bars[bars.length - 1].close : null };
      episodes[ep.episodeId] = withClose;
      existingList.push({ ticker: ep.ticker, family: ep.family, direction: ep.direction, timeframe: ep.timeframe, key: ep.key, state: ep.state, frozen: ep.frozen, pivotsUsed: ep.pivotsUsed, geometry: { atr: ep.frozen.atr } });
      created++;
      try {
        const led = require('./immutable-ledger');
        if (led.hasStore && led.hasStore()) {
          await led.append(EPISODE_STREAM, { episodeId: ep.episodeId, key: ep.key, date, ticker: ep.ticker, family: ep.family, direction: ep.direction, timeframe: ep.timeframe, trigger: ep.frozen.trigger, invalidation: ep.frozen.invalidation, target: ep.frozen.target, structuralValidity: ep.structuralValidity, modelVersion: MODEL_VERSION, affectedProductionDecision: false });
          ledgerAppends++;
        }
      } catch { /* ledger optional; the episodes doc is durable */ }
    }
  }

  // 4) PRUNE long-dead terminal episodes (retained TERMINAL_RETENTION_DAYS for the UI).
  const cutoff = Date.now() - TERMINAL_RETENTION_DAYS * 86400000;
  for (const [id, e] of Object.entries(episodes)) {
    if (EP.isTerminal(e.state) && e.lastEvaluatedAt && Date.parse(e.lastEvaluatedAt) < cutoff) delete episodes[id];
  }

  await store.writeJSON(EPISODES_PATH, { episodes, version: EP.EPISODE_SCHEMA_VERSION, updatedAt: now }, 0);
  await store.writeJSON(SCAN_STATE_PATH, scanState, 0);
  // REFRESHABLE day snapshot (rewritten every tick — an early-session write no longer
  // stays stale all day).
  const daySnap = { date, updatedAt: now, states: countStates(episodes), scan: scanState.stats };
  await store.writeJSON(`${DAY_PREFIX}${date}.json`, daySnap, 0);

  return res.status(200).json({
    ok: true, date, advanced, transitions: transitionsCount, created, ledgerAppends,
    episodes: Object.keys(episodes).length,
    scan: { cursor: scanState.cursor, universe: tickers.length, done: scanState.cursor >= tickers.length, stats: scanState.stats },
  });
}

function countStates(episodes) {
  const out = {};
  for (const e of Object.values(episodes)) out[e.state] = (out[e.state] || 0) + 1;
  return out;
}

// A canonical (schema) detection back into the raw shape episodes.createEpisode expects.
function reconstructDetection(d, ticker) {
  return {
    ticker,
    family: d.patternFamily,
    label: d.patternLabel,
    direction: d.direction,
    timeframe: d.timeframe,
    horizon: d.horizon,
    phase: d.phase,
    structural: d.structural,
    structuralValidity: d.structural ? d.structural.validity : null,
    featureCoverage: d.structural ? d.structural.featureCoverage : null,
    missingRequiredFeatures: d.structural ? d.structural.missingRequiredFeatures : [],
    structurallyInvalid: d.structural ? !d.structural.pass : true,
    pivotsUsed: d.pivotsUsed || [],
    triggerLevel: { price: d.plan.trigger, type: d.plan.triggerType || 'level', sourceBarDates: [] },
    invalidationLevel: { price: d.plan.stop, type: d.plan.invalidationType || 'level' },
    targetLevel: { price: d.plan.target, method: d.plan.targetMethod || 'measured' },
    plan: { trigger: d.plan.trigger, stop: d.plan.stop, target: d.plan.target, rr: d.plan.rewardRisk, quality: d.plan.quality, direction: d.direction },
    geometry: { atr: d.measurements && isNum(d.measurements.atr) ? d.measurements.atr : (isNum(d.plan.trigger) && isNum(d.plan.stop) ? Math.abs(d.plan.trigger - d.plan.stop) / 1.5 : null), lastClose: d.currentPrice },
    similarity: d.similarity,
    confirmation: d.confirmation,
    breakoutConfirmed: !!(d.confirmation && d.confirmation.closedThrough),
    invalidationHit: !!(d.confirmation && d.confirmation.invalidationClosedThrough),
    retesting: d.phase === 'RETESTING',
    patternStart: d.patternStart,
    patternAsOf: d.patternAsOf,
  };
}

// ---- op=patterngrade (privileged: fill-aware grading) ---------------------------

async function runPatternGrade(req, res) {
  if (!store.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store' });
  const doc = await loadEpisodesDoc();
  const resolvedDoc = await store.readJSON(RESOLVED_PATH, { resolved: {} });
  const already = resolvedDoc.resolved || {};
  const now = new Date().toISOString();
  const t0 = Date.now();
  let graded = 0;

  for (const e of Object.values(doc.episodes)) {
    if (Date.now() - t0 > 40000) break;
    if (already[e.key]) continue;
    // Grade when the episode is terminal, or confirmed long enough ago to have matured.
    const confirmedAt = (e.transitions.find(t => t.to === EP.EP_STATES.CONFIRMED) || {}).date || null;
    const matured = confirmedAt && (Date.now() - Date.parse(confirmedAt)) / 86400000 > e.holdBars * 1.6;
    if (!EP.isTerminal(e.state) && !matured) continue;
    if (!confirmedAt && !EP.isTerminal(e.state)) continue;

    const anchor = confirmedAt || e.detectedDate;
    const daily = await fetchDaily(e.ticker, '1y');
    if (!daily.length) {
      already[e.key] = outcomeRecord(e, { outcome: 'data-unavailable', targetFirst: null, filled: false, reason: 'no-daily-history' }, { horizonBars: e.holdBars, resolvedAt: now });
      graded++;
      continue;
    }
    // STRICTLY after the confirmation date — the fill search and barrier evaluation
    // start there (never inside the formation window).
    const forward = daily.filter(c => String(c.date) > String(anchor));
    const plan = {
      trigger: e.frozen.trigger.price,
      stop: isNum(e.current.invalidation) ? e.current.invalidation : e.frozen.invalidation.price,
      target: isNum(e.current.target) ? e.current.target : e.frozen.target.price,
    };
    const outcome = resolveOutcome(plan, e.direction, forward, { horizonBars: e.holdBars, entryValidBars: Math.min(10, e.holdBars) });
    if (!EP.isTerminal(e.state) && (outcome.outcome === 'no-fill' || outcome.outcome === 'data-unavailable') && forward.length < e.holdBars) continue; // not matured
    already[e.key] = outcomeRecord(e, outcome, { horizonBars: e.holdBars, resolvedAt: now });
    graded++;
  }

  await store.writeJSON(RESOLVED_PATH, { resolved: already, updatedAt: now }, 0);
  return res.status(200).json({ ok: true, graded, totalResolved: Object.keys(already).length });
}

// ---- op=patternresearch (privileged: offline PIT study) -------------------------

async function runPatternResearch(req, res) {
  if (!store.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store' });
  const mode = String(req.query.mode || 'collect');
  const now = new Date().toISOString();

  if (mode === 'collect') {
    // Resumable shard collection: ?start=N&limit=M over the scan universe, 2y history.
    const tickers = scanUniverse();
    const start = Math.max(0, parseInt(req.query.start, 10) || 0);
    const limit = Math.max(1, Math.min(25, parseInt(req.query.limit, 10) || 10));
    const slice = tickers.slice(start, start + limit);
    const records = [];
    const controls = [];
    const t0 = Date.now();
    let processed = 0;
    for (const { ticker } of slice) {
      if (Date.now() - t0 > 40000) break;
      const candles = await fetchDaily(ticker, '2y');
      if (candles.length < 120) continue;
      for (const tf of [{ timeframe: '20d', windowBars: 22, horizonBars: 21 }, { timeframe: '60d', windowBars: 60, horizonBars: 42 }]) {
        records.push(...RESEARCH.buildResearchRecords({ ticker, candles, ...tf, stepBars: 5 }));
        controls.push(...RESEARCH.buildControlRecords({ ticker, candles, ...tf, stepBars: 10 }));
      }
      processed++;
    }
    const shard = { start, processed, records, controls, builtAt: now, modelVersion: MODEL_VERSION };
    await store.writeJSON(`${RESEARCH_SHARD_PREFIX}shard-${String(start).padStart(5, '0')}.json`, shard, 0);
    const nextStart = start + processed;
    return res.status(200).json({ ok: true, mode, start, processed, records: records.length, controls: controls.length, nextStart: nextStart < tickers.length ? nextStart : null, universe: tickers.length });
  }

  if (mode === 'evaluate') {
    // Merge all shards → per-cell evaluation → the versioned evidence artifact.
    let shards = [];
    try {
      const { list } = require('@vercel/blob');
      const { blobs } = await list({ prefix: RESEARCH_SHARD_PREFIX });
      const paths = (blobs || []).map(b => b.pathname).filter(p => p.includes('shard-'));
      for (const p of paths) {
        const s = await store.readJSON(p, null);
        if (s) shards.push(s);
      }
    } catch { shards = []; }
    if (!shards.length) return res.status(200).json({ ok: false, reason: 'no-shards — run mode=collect first' });
    const records = shards.flatMap(s => s.records || []);
    const controls = shards.flatMap(s => s.controls || []);
    const evaluated = RESEARCH.evaluateCells({ records, controls });
    const table = RESEARCH.buildEvidenceTable(evaluated, { builtAt: now });
    await store.writeJSON(EVIDENCE_PATH, table, 0);
    const proven = Object.values(table.cells).filter(c => c.proven).length;
    return res.status(200).json({ ok: true, mode, records: records.length, controls: controls.length, cells: Object.keys(table.cells).length, proven, split: table.split, version: table.version });
  }

  return res.status(400).json({ ok: false, error: 'mode must be collect or evaluate' });
}

module.exports = {
  runPatternSearch, runPatterns, runPatternLog, runPatternGrade, runPatternResearch,
  analyzeOne, radarCard, evidenceSummary, familyStatus, reconstructDetection, scanUniverse,
  EPISODES_PATH, SCAN_STATE_PATH, RESOLVED_PATH, EVIDENCE_PATH, EPISODE_STREAM, DAY_PREFIX,
};
