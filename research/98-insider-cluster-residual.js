'use strict';
// Step 98 — INSIDER CLUSTER BUYS, MATCHED-RESIDUAL (exploratory, registered 2026-09-09).
//   node --max-old-space-size=6144 research/98-insider-cluster-residual.js
//
// The ONE preregistered exploratory pass for hypothesis `insider-cluster-residual`
// (family alt-signals) — research/PREREGISTRATION-INSIDER-CLUSTER-RESIDUAL-2026-09.md.
// Every parameter below is FROZEN there; changing one is a new hypothesis.
//
// Data: SEC Form 345 bulk buys (research/97-form345-build.js → research/data/form345-buys)
// joined to the research price cache. The cluster definition is study 69's, unchanged.
// PIT rule: event date = LATEST FILING date of the cluster; entry = NEXT session open.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const K = require('./lib/experiment-kit');
const REG = require('../lib/research/hypothesis-registry');
const { clusterEvents, singleBuyerEvents } = require('./69-insider-cluster');
const { SMALL_CAPS, MICRO_CAPS } = require('../lib/universe');

const DATA = process.env.RESEARCH_DATA_DIR || path.join(__dirname, 'data');
const BUYS_DIR = path.join(DATA, 'form345-buys');
const CACHE_DIR = path.join(DATA, 'cache');
const OUT_DIR = path.join(DATA, 'insider-cluster-residual');
const HYP_ID = 'insider-cluster-residual';

// ── FROZEN DESIGN (preregistration §2) ──────────────────────────────────────
const FROZEN = Object.freeze({
  id: 'insider-cluster-residual-2026-09', family: 'alt-signals', hypothesisId: HYP_ID,
  declaredBeforeReadingResults: true,
  eventFrom: '2022-01-03', eventTo: '2026-03-20',
  holds: [5, 21, 63], primaryCell: 'RES_21', cells: ['RES_5', 'RES_21', 'RES_63'],
  momLookback: 126, momSkip: 5, advLookback: 60,
  minAdv: 5e5, maxAdv: 2e7, minPrice: 1, minHistoryBars: 126, cooldownSessions: 21,
  controlsPerEvent: 20, minControls: 5, poolSize: 3000, seed: 20260909,
  placeboShift: 126, minEvents: 200, minDates: 60, fdrAlpha: 0.10, blocks: 4,
  quintiles: 5, drawdownFrac: 0.70, drawdownLookback: 252,
  maxPricePerShare: 1e5, maxTxValue: 1e9,   // §2a data-quality sanity (keyed-in totals), counted as insaneRows
  entry: 'next session OPEN after the decision bar (last bar ≤ filing date); exit close at +H',
  outcome: 'event cost-net return − mean matched-control cost-net return (pct); SPY-excess fallback below minControls, flagged',
  multipleTesting: 'Benjamini-Hochberg across the 3 cells at q ≤ 0.10',
  promisingGate: 'RES_21 mean > 0 AND q ≤ 0.10 AND ≥3/4 blocks positive AND placebo |mean| < ½ event mean with CI spanning zero',
  insufficient: 'primary events < 200 or distinct decision dates < 60',
});

// ── pure helpers (locked by test/insider-cluster-residual-prereg.test.js) ────
function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));

// Slim, ascending candle series with a cumulative dollar-volume prefix for O(1) ADV.
function slimSeries(raw) {
  const rows = (raw || []).slice().reverse();
  if (rows.length < 60) return null;
  const candles = rows.map(r => ({ date: r.date, open: r.open, close: r.close, volume: r.volume }));
  const cum = new Array(candles.length + 1).fill(0);
  for (let i = 0; i < candles.length; i++) cum[i + 1] = cum[i] + ((candles[i].close || 0) * (candles[i].volume || 0));
  return { candles, idx: new Map(candles.map((b, i) => [b.date, i])), cum };
}
function advAt(entry, i, lookback = FROZEN.advLookback) {
  const lo = Math.max(0, i - lookback + 1);
  const n = i - lo + 1;
  return n > 0 ? (entry.cum[i + 1] - entry.cum[lo]) / n : 0;
}
function momentumAt(entry, i, { lookback = FROZEN.momLookback, skip = FROZEN.momSkip } = {}) {
  if (i < lookback) return null;
  const a = entry.candles[i - skip], b = entry.candles[i - lookback];
  return (a && b && b.close > 0 && a.close > 0) ? a.close / b.close - 1 : null;
}
function tierOf(adv) { return K.costFractions(adv).tier; }
// Last bar with date ≤ isoDate (the filing-day bar when the filing date is a session).
function decisionIndex(entry, isoDate) {
  const c = entry.candles;
  let lo = 0, hi = c.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].date <= isoDate) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function quintileOf(value, sortedPool, q = FROZEN.quintiles) {
  if (value == null || !sortedPool.length) return null;
  let rank = 0; for (const v of sortedPool) { if (v <= value) rank++; else break; }
  return Math.min(q - 1, Math.floor((rank - 1) * q / sortedPool.length));
}
function isDrawdown(entry, i, { frac = FROZEN.drawdownFrac, lookback = FROZEN.drawdownLookback } = {}) {
  if (i < lookback) return null;
  let hi = 0; for (let k = i - lookback; k <= i; k++) hi = Math.max(hi, entry.candles[k].close);
  return entry.candles[i].close <= frac * hi;
}
function netReturn(entry, decisionDate, H, adv, attrition) {
  const gross = K.forwardFromNextOpen(entry, decisionDate, H, attrition);
  if (gross == null) return null;
  return gross - K.costFractions(adv).base;
}
// Verdict from the frozen gates. Pure.
function verdictOf({ nEvents, nDates, primary, primaryFdr, placebo }) {
  if (nEvents < FROZEN.minEvents || nDates < FROZEN.minDates) return 'insufficient-data';
  if (!primary || !Number.isFinite(primary.avg)) return 'insufficient-data';
  const blocksOk = !!(primary.blockStability && primary.blockStability.usable && primary.blockStability.positive >= 3);
  const placeboOk = !placebo || !Number.isFinite(placebo.avg)
    ? false
    : Math.abs(placebo.avg) < 0.5 * Math.abs(primary.avg) && placebo.ci95 && placebo.ci95.lo <= 0 && placebo.ci95.hi >= 0;
  const pass = primary.avg > 0 && !!(primaryFdr && primaryFdr.survives) && blocksOk && placeboOk;
  return pass ? 'research-promising' : 'not-confirmed';
}

// ── data loading ────────────────────────────────────────────────────────────
function loadBuys() {
  const out = new Map();
  if (!fs.existsSync(BUYS_DIR)) return out;
  for (const f of fs.readdirSync(BUYS_DIR)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try { const d = JSON.parse(fs.readFileSync(path.join(BUYS_DIR, f), 'utf8')); if (d && Array.isArray(d.txs) && d.txs.length) out.set(f.replace(/\.json$/, '').toUpperCase(), d.txs); } catch { /* counted below */ }
  }
  return out;
}
function loadEntry(sym) {
  try { return slimSeries(JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${sym}.json`), 'utf8')).price); } catch { return null; }
}

// ── matching ────────────────────────────────────────────────────────────────
// Day-level cache: for a decision date, the tier-eligible pool with momentum + adv.
function poolOnDate(pool, date, eventIndexByName, cache) {
  if (cache.has(date)) return cache.get(date);
  const rows = [];
  for (const [sym, entry] of pool) {
    const i = entry.idx.get(date);
    if (i == null || i < FROZEN.minHistoryBars) continue;
    const c = entry.candles[i];
    if (!(c.close >= FROZEN.minPrice)) continue;
    const adv = advAt(entry, i);
    if (!(adv >= FROZEN.minAdv)) continue;
    const mom = momentumAt(entry, i);
    if (mom == null) continue;
    const evs = eventIndexByName.get(sym);
    if (evs && evs.some(k => Math.abs(k - i) <= FROZEN.cooldownSessions)) continue;   // never an event name near an event
    rows.push({ sym, i, adv, tier: tierOf(adv), mom });
  }
  const byTier = {};
  for (const r of rows) (byTier[r.tier] = byTier[r.tier] || []).push(r);
  for (const t of Object.keys(byTier)) byTier[t].sorted = byTier[t].map(r => r.mom).sort((a, b) => a - b);
  cache.set(date, byTier);
  return byTier;
}
function pickControls(byTier, tier, mom, rnd, n = FROZEN.controlsPerEvent) {
  const grp = byTier[tier];
  if (!grp || !grp.length) return [];
  const q = quintileOf(mom, grp.sorted);
  const cands = grp.filter(r => quintileOf(r.mom, grp.sorted) === q);
  // seeded partial Fisher–Yates
  const arr = cands.slice();
  for (let k = 0; k < Math.min(n, arr.length); k++) { const j = k + Math.floor(rnd() * (arr.length - k)); [arr[k], arr[j]] = [arr[j], arr[k]]; }
  return arr.slice(0, n);
}

// ── study ───────────────────────────────────────────────────────────────────
async function study() {
  const hyp = REG.find(HYP_ID);
  if (!hyp) { console.log(`BLOCKED: ${HYP_ID} not registered`); process.exitCode = 1; return; }
  console.log(`registered exploratory pass — familyTrials(${hyp.familyId}) = ${REG.familyTrials(hyp.familyId)}`);
  const buys = loadBuys();
  if (!buys.size) { console.log('BLOCKED: no research/data/form345-buys — run research/97-form345-build.js first'); process.exitCode = 1; return; }
  const spy = loadEntry('SPY');
  if (!spy) { console.log('BLOCKED: SPY cache missing'); process.exitCode = 1; return; }
  const t0 = Date.now();

  // 1) events per name (frozen cluster definition), split 10b5-1 at the cluster level
  const rawByName = new Map();
  let namesWithBuys = 0, clustersRaw = 0, insaneRows = 0;
  for (const [sym, txs] of buys) {
    // DATA-QUALITY SANITY (declared in preregistration §2a before the run, counted): a
    // handful of bulk rows carry totals keyed into the per-share price field.
    const clean = txs.filter(t => t && t.code === 'P' && t.shares > 0 && t.price > 0 && t.owner && t.date && t.filingDate)
      .filter(t => { const ok = t.price < FROZEN.maxPricePerShare && (t.value || t.shares * t.price) < FROZEN.maxTxValue; if (!ok) insaneRows++; return ok; });
    if (!clean.length) continue;
    namesWithBuys++;
    const clusters = clusterEvents(clean).map(ev => {
      const members = clean.filter(t => t.date >= ev.txDates[0] && t.date <= ev.txDates[1]);
      return { ...ev, tenB51: members.some(t => t.tenB51 === true), officerDirectorOnly: members.every(t => (t.isOfficer || t.isDirector) && !t.isTenPct), amended: members.some(t => t.amended === true) };
    });
    clustersRaw += clusters.length;
    const singles = singleBuyerEvents(clean, clusters);
    rawByName.set(sym, { clusters, singles });
  }

  // 2) price data: event names ∪ seeded random pool
  const cacheFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json') && f !== 'SPY.json').map(f => f.replace(/\.json$/, ''));
  const rnd = lcg(FROZEN.seed);
  const eventNames = new Set([...rawByName.keys()].filter(s => fs.existsSync(path.join(CACHE_DIR, `${s}.json`))));
  const others = cacheFiles.filter(s => !eventNames.has(s));
  for (let k = others.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [others[k], others[j]] = [others[j], others[k]]; }
  const poolNames = [...eventNames, ...others.slice(0, FROZEN.poolSize)];
  const pool = new Map();
  let unreadable = 0, tooShort = 0;
  for (const sym of poolNames) {
    const e = loadEntry(sym);
    if (!e) { unreadable++; continue; }
    if (e.candles.length < 280) { tooShort++; continue; }
    pool.set(sym, e);
  }
  console.log(`buys: ${buys.size} names, ${namesWithBuys} with clean P-buys, ${clustersRaw} raw clusters; price-cached event names ${eventNames.size}; pool ${pool.size} (unreadable ${unreadable}, <280 bars ${tooShort}) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // 3) event rows with eligibility (attrition counted, never silent)
  const attrition = { noPrice: 0, noDecisionBar: 0, beforeWindow: 0, afterWindow: 0, tooLittleHistory: 0, subDollar: 0, illiquid: 0, liquidTier: 0, tenB51: 0, cooled: 0, noDecisionBarFwd: 0, truncatedHistory: 0, badPrices: 0, extremeMove: 0, noBenchmark: 0, ineligible: 0 };
  const eventIndexByName = new Map();
  const events = [];   // every cluster with a decision bar, tagged with cohort flags
  const legacy = new Set([...SMALL_CAPS, ...MICRO_CAPS].map(s => String(s).toUpperCase()));
  for (const [sym, { clusters }] of rawByName) {
    const entry = pool.get(sym);
    if (!entry) { attrition.noPrice += clusters.length; continue; }
    let lastIdx = -Infinity;
    const idxs = [];
    for (const ev of clusters.sort((a, b) => (a.eventDate < b.eventDate ? -1 : 1))) {
      const i = decisionIndex(entry, ev.eventDate);
      if (i < 0) { attrition.noDecisionBar++; continue; }
      const d = entry.candles[i].date;
      if (Date.parse(ev.eventDate) - Date.parse(d) > 7 * 86400000) { attrition.noDecisionBar++; continue; }   // stale bar (delisted before filing)
      idxs.push(i);
      if (d < FROZEN.eventFrom) { attrition.beforeWindow++; continue; }
      if (d > FROZEN.eventTo) { attrition.afterWindow++; continue; }
      if (i < FROZEN.minHistoryBars) { attrition.tooLittleHistory++; continue; }
      if (!(entry.candles[i].close >= FROZEN.minPrice)) { attrition.subDollar++; continue; }
      const adv = advAt(entry, i);
      const tier = tierOf(adv);
      if (!(adv >= FROZEN.minAdv)) { attrition.illiquid++; continue; }
      if (i - lastIdx < FROZEN.cooldownSessions) { attrition.cooled++; continue; }
      lastIdx = i;
      const row = { sym, i, date: d, eventDate: ev.eventDate, adv, tier, mom: momentumAt(entry, i), owners: ev.owners, combinedValue: ev.combinedValue,
        tenB51: ev.tenB51, officerDirectorOnly: ev.officerDirectorOnly, amended: ev.amended, drawdown: isDrawdown(entry, i), legacyUniverse: legacy.has(sym),
        year: d.slice(0, 4), primary: !ev.tenB51 && tier !== 'liquid' };
      if (ev.tenB51) attrition.tenB51++;
      if (tier === 'liquid') attrition.liquidTier++;
      events.push(row);
    }
    eventIndexByName.set(sym, idxs);
  }
  console.log(`events with a decision bar in window: ${events.length} (primary ${events.filter(e => e.primary).length}); attrition ${JSON.stringify(attrition)}`);

  // 4) outcomes: event leg, matched controls, placebo
  const dayCache = new Map();
  const mrnd = lcg(FROZEN.seed + 1);
  const spyEntry = { candles: spy.candles, idx: spy.idx };
  const spyIdx = new Map(spy.candles.map((b, i) => [b.date, i]));
  const outcomeOf = (entry, row, iDecision, tag) => {
    const decisionDate = entry.candles[iDecision] && entry.candles[iDecision].date;
    if (!decisionDate) return null;
    const adv = advAt(entry, iDecision), tier = tierOf(adv), mom = momentumAt(entry, iDecision);
    const byTier = poolOnDate(pool, decisionDate, eventIndexByName, dayCache);
    const controls = mom == null ? [] : pickControls(byTier, tier, mom, mrnd);
    const res = { date: decisionDate, tier, nControls: controls.length, basis: controls.length >= FROZEN.minControls ? 'matched' : 'spy-fallback' };
    for (const H of FROZEN.holds) {
      const ev = netReturn(entry, decisionDate, H, adv, attrition);
      if (ev == null) { res[`RES_${H}`] = null; continue; }
      let ctrl = null;
      if (res.basis === 'matched') {
        const rets = controls.map(c => netReturn(pool.get(c.sym), decisionDate, H, c.adv, null)).filter(x => x != null);
        ctrl = rets.length >= FROZEN.minControls ? mean(rets) : null;
      }
      if (ctrl == null) {
        const b = K.benchmarkForward(spy.candles, spyIdx, decisionDate, H);
        if (b == null) { attrition.noBenchmark++; res[`RES_${H}`] = null; continue; }
        ctrl = b - K.costFractions(adv).base;   // charge the fallback leg the same round trip
        res[`basis_${H}`] = 'spy-fallback';
      }
      res[`RES_${H}`] = (ev - ctrl) * 100;
      res[`SPYX_${H}`] = (ev - ((K.benchmarkForward(spy.candles, spyIdx, decisionDate, H) ?? 0) - K.costFractions(adv).base)) * 100;
    }
    return res;
  };
  const scored = [];
  for (const row of events) {
    const entry = pool.get(row.sym);
    const o = outcomeOf(entry, row, row.i, 'event');
    if (!o) continue;
    const p = row.i - FROZEN.placeboShift >= FROZEN.minHistoryBars ? outcomeOf(entry, row, row.i - FROZEN.placeboShift, 'placebo') : null;
    scored.push({ ...row, outcome: o, placebo: p });
  }
  // single-buyer comparison (descriptive)
  const singles = [];
  for (const [sym, { singles: sg }] of rawByName) {
    const entry = pool.get(sym); if (!entry) continue;
    for (const ev of sg) {
      const i = decisionIndex(entry, ev.eventDate);
      if (i < FROZEN.minHistoryBars) continue;
      const d = entry.candles[i].date;
      if (d < FROZEN.eventFrom || d > FROZEN.eventTo) continue;
      const adv = advAt(entry, i); if (!(adv >= FROZEN.minAdv) || tierOf(adv) === 'liquid' || !(entry.candles[i].close >= FROZEN.minPrice)) continue;
      const o = outcomeOf(entry, null, i, 'single'); if (o) singles.push({ sym, date: d, outcome: o });
    }
  }
  console.log(`scored ${scored.length} events, ${singles.length} single-buyer comparisons in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // 5) inference — one observation per decision date
  const cell = (rows, key, pick = (r) => r.outcome) => {
    const obs = rows.map(r => ({ date: r.date, value: pick(r) && pick(r)[key] })).filter(r => Number.isFinite(r.value));
    const H = Number(key.split('_')[1]);
    const s = obs.length ? K.summarizeByDate(obs, { horizonBars: H }) : null;
    return s ? { ...s, p: K.pValue(s), events: obs.length } : null;
  };
  const cohortStats = (rows, label) => {
    const out = { label, events: rows.length, dates: new Set(rows.map(r => r.date)).size };
    for (const H of FROZEN.holds) { out[`RES_${H}`] = cell(rows, `RES_${H}`); out[`SPYX_${H}`] = cell(rows, `SPYX_${H}`); }
    return out;
  };
  const primaryRows = scored.filter(r => r.primary);
  const results = cohortStats(primaryRows, 'primary (small+micro, non-10b5-1)');
  const matchedOnly = cohortStats(primaryRows.filter(r => r.outcome.basis === 'matched'), 'primary, matched-only');
  const placeboRows = primaryRows.filter(r => r.placebo).map(r => ({ date: r.placebo.date, outcome: r.placebo }));
  const placebo = cohortStats(placeboRows, 'placebo (−126 sessions)');
  const fdrOut = K.fdr(FROZEN.cells.map(c => ({ id: c, p: results[c] && results[c].p })), { alpha: FROZEN.fdrAlpha });
  const primaryFdr = fdrOut.find(x => x.id === FROZEN.primaryCell) || null;
  const verdict = verdictOf({ nEvents: results.events, nDates: results.dates, primary: results[FROZEN.primaryCell], primaryFdr, placebo: placebo[FROZEN.primaryCell] });

  const cohorts = {
    singleBuyer: cohortStats(singles, 'single-buyer ≥$25k, small+micro'),
    tenB51: cohortStats(scored.filter(r => r.tenB51 && r.tier !== 'liquid'), '10b5-1 clusters'),
    liquidTier: cohortStats(scored.filter(r => r.tier === 'liquid' && !r.tenB51), 'liquid-tier clusters'),
    officerDirectorOnly: cohortStats(primaryRows.filter(r => r.officerDirectorOnly), 'officer/director-only'),
    owners3plus: cohortStats(primaryRows.filter(r => r.owners >= 3), '≥3 owners'),
    value250k: cohortStats(primaryRows.filter(r => r.combinedValue >= 250000), '≥$250k'),
    drawdown: cohortStats(primaryRows.filter(r => r.drawdown === true), 'drawdown ≤0.70×max252'),
    noDrawdown: cohortStats(primaryRows.filter(r => r.drawdown === false), 'no drawdown'),
    tierSmall: cohortStats(primaryRows.filter(r => r.tier === 'small'), 'small tier'),
    tierMicro: cohortStats(primaryRows.filter(r => r.tier === 'micro'), 'micro tier'),
    legacyUniverse: cohortStats(primaryRows.filter(r => r.legacyUniverse), '2026-08 universe names'),
    exLegacy: cohortStats(primaryRows.filter(r => !r.legacyUniverse), 'excluding 2026-08 universe'),
    byYear: Object.fromEntries([...new Set(primaryRows.map(r => r.year))].sort().map(y => [y, cohortStats(primaryRows.filter(r => r.year === y), y)])),
  };

  const brief = (c) => c && { events: c.events, dates: c.dates, avg: r4(c.avg), ci95: c.ci95, t: c.se ? r4(c.avg / c.se) : null, p: r4(c.p), effN: c.effectiveN, blocks: c.blockStability && `${c.blockStability.positive}+/${c.blockStability.blocks}` };
  const out = {
    frozen: FROZEN, generatedAt: new Date().toISOString(), runSeconds: +((Date.now() - t0) / 1000).toFixed(0),
    data: { buyNames: buys.size, namesWithBuys, insaneRows, clustersRaw, eventNamesPriced: eventNames.size, pool: pool.size, attrition, scored: scored.length, primary: primaryRows.length, matchedShare: r4(primaryRows.filter(r => r.outcome.basis === 'matched').length / Math.max(1, primaryRows.length)) },
    results, matchedOnly, placebo, fdr: fdrOut, verdict, cohorts,
  };
  const art = K.writeArtifact(OUT_DIR, 'insider-cluster-residual-result.json', out);
  K.writeArtifact(OUT_DIR, 'insider-cluster-residual-events.json', { events: scored.map(r => ({ sym: r.sym, date: r.date, tier: r.tier, owners: r.owners, value: r.combinedValue, primary: r.primary, basis: r.outcome.basis, RES_21: r4(r.outcome.RES_21) })) });
  K.recordExperiment({
    id: FROZEN.id, hypothesis: hyp.hypothesis, family: FROZEN.family, frozenConfig: FROZEN,
    dataSnapshot: { buyNames: buys.size, clustersRaw, scored: scored.length, primary: primaryRows.length, attrition, matchedShare: out.data.matchedShare },
    trialCount: FROZEN.cells.length,
    results: { primary: Object.fromEntries(FROZEN.cells.map(c => [c, brief(results[c])])), matchedOnly: Object.fromEntries(FROZEN.cells.map(c => [c, brief(matchedOnly[c])])), placebo: Object.fromEntries(FROZEN.cells.map(c => [c, brief(placebo[c])])), fdr: fdrOut, verdict,
      cohorts: Object.fromEntries(Object.entries(cohorts).filter(([k]) => k !== 'byYear').map(([k, v]) => [k, { events: v.events, RES_21: brief(v.RES_21) }])) },
    artifact: art,
  });
  console.log(JSON.stringify({ verdict, primary: Object.fromEntries(FROZEN.cells.map(c => [c, brief(results[c])])), matchedOnly: brief(matchedOnly.RES_21), placebo: brief(placebo.RES_21), fdr: fdrOut.map(x => ({ id: x.id, p: r4(x.p), q: r4(x.q), survives: x.survives })), spyExcess21: brief(results.SPYX_21) }, null, 1));
  console.log('cohorts (RES_21):', Object.entries(cohorts).filter(([k]) => k !== 'byYear').map(([k, v]) => `${k}: n=${v.events} avg=${r4(v.RES_21 && v.RES_21.avg)} t=${brief(v.RES_21) && brief(v.RES_21).t}`).join(' | '));
  console.log('byYear (RES_21):', Object.entries(cohorts.byYear).map(([y, v]) => `${y}: n=${v.events} avg=${r4(v.RES_21 && v.RES_21.avg)}`).join(' | '));
  console.log(`artifact ${art.file} sha256 ${art.sha256.slice(0, 16)}; registry appended`);
}

if (require.main === module) study().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
module.exports = { FROZEN, HYP_ID, slimSeries, advAt, momentumAt, tierOf, decisionIndex, quintileOf, isDrawdown, netReturn, verdictOf, poolOnDate, pickControls, lcg };
