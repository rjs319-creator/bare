'use strict';
// ATLAS-X — RESEARCH / VALIDATION HARNESS (atlasx-research-v1)
//
// PURE core that turns cached daily candles into a point-in-time labeled event set and
// runs the ATLAS-X ranker through the SAME purged, group-aware walk-forward the rest of
// the research stack uses (lib/research/harness.js). It compares a baseline ladder
// (null control → simple momentum → residual momentum → production composite → ridge →
// atlasx-baseline) on IDENTICAL folds and returns PER-RANKER metrics — never a single
// combined backtest number.
//
// HONESTY CONTRACT (this module is SHADOW research only):
//   • Features are strictly point-in-time (only bars dated <= the decision date feed a
//     feature; labels read only bars strictly AFTER it, entered at the NEXT open).
//   • The cached universe is present-day membership → SURVIVORSHIP-BIASED. Every verdict
//     is stamped survivorshipSafe:false and can NEVER pass a production gate, no matter
//     how strong the IC. promotionReadout() is fail-closed for the same reason.
//   • Nothing here is fabricated: thin-history names are SKIPPED, not imputed.
//
// Deterministic → byte-identical reruns on identical input (seeded harness, fixed fits).

const { residualize } = require('./atlasx-residual');
const { detectTransition } = require('./atlasx-transition');
const { pathFeatures } = require('./atlasx-path');
const { featureRow, atlasxRanker } = require('./atlasx-ranking');
const { labelEvent, toEvolveHorizon, HORIZON_META } = require('./evolve-labels');
const { computeFeatureVector } = require('./research/features');
const { runExperiment } = require('./research/harness');
const {
  randomRanker, residualMomentumRanker, productionCompositeRanker, ridgeRanker,
} = require('./research/baseline-ranker');
const { promotionView } = require('./atlasx-governance');

const RESEARCH_VERSION = 'atlasx-research-v1';

// PIT history a name needs before a decision date to have trustworthy features. Below
// this we SKIP the event rather than fabricate features from too few bars.
const MIN_HISTORY_BARS = 30;

// The single, honest reason this data can never clear a production gate.
const SURVIVORSHIP_REASON =
  'cached universe = present-day membership (survivorship-biased): delisted/renamed names '
  + 'are absent, so any measured IC is optimistic and cannot support production promotion';

const isFin = (v) => Number.isFinite(v);

// ── candle normalization ──────────────────────────────────────────────────────
// Accept candle-cache objects {date,open,high,low,close,volume,adjClose} OR tuples
// [date,o,h,l,c,v,adj]. Return ascending [{date,open,high,low,close,volume}].
function normalizeBars(candles) {
  if (!Array.isArray(candles)) return [];
  const out = [];
  for (const row of candles) {
    if (Array.isArray(row)) {
      const [date, o, h, l, c, v] = row;
      if (date == null || c == null) continue;
      out.push({ date: String(date), open: num(o, c), high: num(h, c), low: num(l, c), close: Number(c), volume: num(v, 0) });
    } else if (row && typeof row === 'object') {
      const date = row.date || row.d || row.t;
      const c = row.close != null ? row.close : row.c;
      if (date == null || c == null) continue;
      out.push({
        date: String(date), open: num(row.open ?? row.o, c), high: num(row.high ?? row.h, c),
        low: num(row.low ?? row.l, c), close: Number(c), volume: num(row.volume ?? row.v, 0),
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}
const num = (x, fallback) => (x == null || !Number.isFinite(Number(x)) ? fallback : Number(x));

// { date -> close } benchmark map for the research feature vector's residual momentum.
function benchCloses(spyCandles) {
  const map = {};
  for (const b of normalizeBars(spyCandles)) map[b.date] = b.close;
  return map;
}

// A proxy PRODUCTION composite score (the existing app rank is momentum/trend-driven and
// is not reproducible offline). Deterministic; consumed only by productionCompositeRanker.
function compositeScore(values) {
  const parts = [];
  if (isFin(values.ret21)) parts.push(values.ret21);
  if (isFin(values.residMom21)) parts.push(values.residMom21);
  if (isFin(values.trendSlope21)) parts.push(values.trendSlope21 / 100);
  const m = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return +(50 + 100 * m).toFixed(2);
}

// A trailing total-return momentum ranker (6-1 style; uses the longest trailing return
// the feature vector carries). Deliberately NON-residualized — the "generic momentum" null.
const simpleMomentumRanker = Object.freeze({
  name: 'simple-momentum',
  fit() { return null; },
  score(_m, row) {
    const f = (row && row.features) || {};
    const v = isFin(f.ret63) ? f.ret63 : (isFin(f.ret21) ? f.ret21 : null);
    return v == null ? 0 : v;
  },
});

// The baseline ladder ATLAS-X must be measured against on identical folds.
const DEFAULT_RANKERS = Object.freeze([
  randomRanker,             // control-random    (null control)
  simpleMomentumRanker,     // simple-momentum   (trailing total return)
  residualMomentumRanker,   // residual-momentum (market-residual 21d)
  productionCompositeRanker,// production-composite (proxy of the live rank)
  ridgeRanker,              // ridge-linear      (regularized linear over the feature vector)
  atlasxRanker,             // atlasx-baseline   (interpretable additive challenger)
]);

// ── event construction ─────────────────────────────────────────────────────────
/**
 * Build point-in-time labeled harness rows for each ticker × decision date.
 * @param {object} p
 * @param {Map<string,Array>|Object} p.candleMap  ticker -> candle series
 * @param {Array} p.spyCandles                     SPY (market) candles
 * @param {Map<string,Array>|Object} [p.sectorMap] ticker -> sector-ETF candles (optional)
 * @param {string[]} p.decisionDates               'YYYY-MM-DD' decision dates
 * @param {string} [p.horizon]                      decision/evolve horizon (default 'swing')
 * @returns {ReadonlyArray<object>} frozen harness event rows (thin-history events skipped)
 */
function buildEvents({ candleMap, spyCandles, sectorMap = null, decisionDates, horizon = 'swing' } = {}) {
  const evHorizon = toEvolveHorizon(horizon) === horizon ? horizon
    : (HORIZON_META[horizon] ? horizon : toEvolveHorizon(horizon));
  const window = (HORIZON_META[evHorizon] || HORIZON_META.swing).window;
  const bench = benchCloses(spyCandles);
  const dates = [...new Set((decisionDates || []).filter(Boolean))].sort();
  const rows = [];

  for (const [ticker, rawCandles] of entriesOf(candleMap)) {
    const bars = normalizeBars(rawCandles);
    if (bars.length < MIN_HISTORY_BARS + 1) continue;
    const sectorCandles = sectorMap ? getFrom(sectorMap, ticker) : null;

    for (const decisionDate of dates) {
      const row = buildOneEvent({
        ticker, bars, rawCandles, spyCandles, sectorCandles, bench, decisionDate, evHorizon, window,
      });
      if (row) rows.push(row);
    }
  }
  return Object.freeze(rows);
}

// One (ticker, decisionDate) event, or null when history/forward bars are insufficient.
function buildOneEvent({ ticker, bars, rawCandles, spyCandles, sectorCandles, bench, decisionDate, evHorizon, window }) {
  // Decision bar = last bar at-or-before the decision date (PIT).
  let idx = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i].date <= decisionDate) idx = i; else break; }
  if (idx < MIN_HISTORY_BARS) return null;                        // thin history → skip (never fabricate)

  // Forward bars strictly AFTER the decision date; need the full window to resolve a label.
  const forward = bars.filter((b) => b.date > decisionDate);
  if (forward.length < window) return null;

  // Next-open execution: fill at the FIRST forward bar's open (strictly after the decision).
  const entryBar = forward[0];
  const entry = isFin(entryBar.open) && entryBar.open > 0 ? entryBar.open : entryBar.close;
  if (!isFin(entry) || entry <= 0) return null;
  const eligibleEntryTs = entryBar.date;                          // strictly > decisionDate by construction

  // PIT features (each source slices to asOf = decisionDate internally).
  const residual = residualize({ stock: rawCandles, spy: spyCandles, sector: sectorCandles, asOf: decisionDate });
  const transition = detectTransition({ candles: rawCandles, residual, asOf: decisionDate });
  const path = pathFeatures({ candles: rawCandles, asOf: decisionDate });
  const atlasxFeats = featureRow({ residual, transition, path }); // expert omitted → null (never guessed)
  const fv = computeFeatureVector(bars, idx, { benchCloses: bench });
  const features = Object.freeze({ ...fv.values, ...atlasxFeats });

  // Realistic outcome: target-before-stop triple barrier, next-open entry, timeout.
  const label = labelEvent({
    entry, candles: rawCandles, predDate: decisionDate, horizon: evHorizon,
    spyCandles, sectorCandles,
  });
  if (!label.resolved) return null;                               // window not elapsed → not an event yet

  // Outcome the ranker is graded on: market-residual terminal return where SPY is known.
  const outcome = label.spyRelReturn != null ? label.spyRelReturn : label.terminalReturn;
  if (!isFin(outcome)) return null;

  return Object.freeze({
    securityId: `cache:${ticker}`,          // ticker is NOT identity; cache-scoped id (survivorship-unsafe)
    ticker,
    decisionTs: decisionDate,
    eligibleEntryTs,                        // strictly AFTER decisionTs (no same-close fill)
    labelEndDate: label.labelEndDate,       // exact resolve date (for exact purge)
    predDate: decisionDate,
    horizon: evHorizon,
    barsToBarrier: label.barsToBarrier,
    features,
    score: compositeScore(fv.values),       // production-composite proxy passthrough
    outcome,
    won: !!label.won,
    barrier: label.barrier,
    terminalReturn: label.terminalReturn,
    entry,
  });
}

// ── comparison ───────────────────────────────────────────────────────────────
/**
 * Run the purged walk-forward ranker comparison and return per-ranker metrics.
 * REUSES lib/research/harness.runExperiment (identical folds for every ranker).
 * @param {ReadonlyArray<object>} events  from buildEvents
 * @param {object} [opts]  { rankers?, folds?, embargo?, universePolicy?, experimentId? }
 * @returns {object} frozen { champion, perRankerIC, perRankerMetrics, verdict, manifest, ... }
 */
function runComparison(events, opts = {}) {
  const rankers = Array.isArray(opts.rankers) && opts.rankers.length ? opts.rankers : DEFAULT_RANKERS;
  const rows = (events || []).filter((e) => e && e.decisionTs && isFin(e.outcome));

  const meta = {
    experimentId: opts.experimentId || `atlasx-research-${rows.length ? rows[0].horizon : 'swing'}`,
    experimentFamilyId: 'atlasx-ranker-comparison',
    datasetHash: opts.datasetHash || hashEvents(rows),
    universePolicy: opts.universePolicy || 'present-day-static cached universe (survivorship-unsafe)',
    primaryMetric: 'mean-daily-rank-IC (OOS, purged)',
    survivorshipSafe: false,                       // HARD: cache-derived data is never survivorship-safe
    survivorshipReason: SURVIVORSHIP_REASON,
    relatedExperimentsAttempted: rankers.length,
    seed: 12345,
  };

  const exp = runExperiment(rows, rankers, { folds: opts.folds, embargo: opts.embargo }, meta);
  const perRankerIC = exp.result.perRanker;

  // Base rate + supplementary precision@5/@10 and lift (pooled — clearly flagged, NOT the
  // purged OOS number; the rank-IC with CI is the rigorous OOS metric).
  const baseRate = rows.length ? +(rows.filter((r) => r.won).length / rows.length).toFixed(3) : null;
  const perRankerMetrics = {};
  for (const r of rankers) {
    const ic = perRankerIC[r.name] || {};
    const p = pooledPrecision(rows, r);
    perRankerMetrics[r.name] = Object.freeze({
      datedICs: ic.dates || 0,
      meanIC: ic.meanIC == null ? null : ic.meanIC,
      medianIC: ic.medianIC == null ? null : ic.medianIC,
      ci90: ic.ci90 || null,
      tstat: ic.tstat == null ? null : ic.tstat,
      icir: ic.icir == null ? null : ic.icir,
      significant: !!ic.significant,
      precisionAt5: p.p5,
      precisionAt10: p.p10,
      liftAt5: p.p5 == null || baseRate == null ? null : +(p.p5 - baseRate).toFixed(3),
      liftAt10: p.p10 == null || baseRate == null ? null : +(p.p10 - baseRate).toFixed(3),
      pooledInSample: true,   // precision/lift are pooled diagnostics, not purged OOS
    });
  }

  const verdict = Object.freeze({
    survivorshipSafe: false,
    survivorshipReason: SURVIVORSHIP_REASON,
    productionEligible: false,                     // fail-closed regardless of IC
    summary: exp.verdict,                          // harness's PROVISIONAL string
    champion: exp.champion,
    note: 'Rank-IC measures RANKING QUALITY only and never certifies production. '
      + 'Survivorship-unsafe universe → fail-closed: no result here can promote ATLAS-X.',
  });

  return Object.freeze({
    version: RESEARCH_VERSION,
    rankers: Object.freeze(rankers.map((r) => r.name)),
    events: rows.length,
    distinctDates: exp.result.distinctDates,
    uniqueness: exp.result.uniqueness,
    baseRate,
    champion: exp.champion,
    perRankerIC,
    perRankerMetrics: Object.freeze(perRankerMetrics),
    foldReport: exp.result.foldReport,
    verdict,
    manifest: exp.manifest,
  });
}

// Pooled (in-sample) top-k precision for a ranker — a supplementary diagnostic only.
function pooledPrecision(rows, ranker) {
  const model = ranker.fit(rows, {});
  const scored = rows
    .map((e) => ({ won: !!e.won, s: ranker.score(model, e) }))
    .filter((x) => isFin(x.s));
  scored.sort((a, b) => b.s - a.s);
  const at = (k) => {
    const kk = Math.min(k, scored.length);
    if (kk < 1) return null;
    let w = 0;
    for (let i = 0; i < kk; i++) if (scored[i].won) w++;
    return +(w / kk).toFixed(3);
  };
  return { p5: at(5), p10: at(10) };
}

// Deterministic FNV-1a hash of the events → a stable datasetHash for the manifest.
function hashEvents(rows) {
  let h = 2166136261;
  for (const r of rows) {
    const s = `${r.ticker}|${r.decisionTs}|${r.outcome}`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  }
  return `fnv:${(h >>> 0).toString(16)}:${rows.length}`;
}

// ── promotion readout (fail-closed) ─────────────────────────────────────────────
/**
 * Map a comparison to the strategy-gate PROMOTION_GATE criteria. ALWAYS returns
 * eligible:false while survivorshipSafe is false OR episodes are insufficient — even
 * when atlasx-baseline tops the IC table.
 * @param {object} comparison  from runComparison
 * @returns {object} frozen promotion readout
 */
function promotionReadout(comparison) {
  const c = comparison || {};
  const safe = !!(c.verdict && c.verdict.survivorshipSafe);       // false for cache-derived data
  const atlas = (c.perRankerMetrics && c.perRankerMetrics['atlasx-baseline']) || {};
  const prod = (c.perRankerMetrics && c.perRankerMetrics['production-composite']) || {};
  const beatsProduction = isFin(atlas.meanIC) && isFin(prod.meanIC) && atlas.meanIC > prod.meanIC;
  const ciExcludesZero = Array.isArray(atlas.ci90) && atlas.ci90[0] != null && atlas.ci90[0] > 0;

  // Evidence fed to the shared, fail-closed gate. Trust-dependent criteria are gated on
  // `safe` so survivorship-unsafe data can never satisfy them; calibration/cost are out of
  // scope for a rank-IC study, so they stay false here.
  const evidence = {
    resolvedEpisodes: c.events || 0,
    independentDates: c.distinctDates || 0,
    incrementalExcessReturn: safe && beatsProduction,
    calibrationBeatsBaseRate: false,   // no calibration artifact in a rank-IC study
    costAware: false,                  // rank-IC is cost-agnostic
    regimeRobust: safe && atlasRobust(c),
    confidenceInterval: safe && ciExcludesZero,
  };

  const view = promotionView(evidence);
  return Object.freeze({
    version: RESEARCH_VERSION,
    survivorshipSafe: safe,
    survivorshipReason: c.verdict ? c.verdict.survivorshipReason : SURVIVORSHIP_REASON,
    atlasxTopsIC: isATLASXChampion(c),
    beatsProductionIC: beatsProduction,
    evidence: Object.freeze(evidence),
    gate: view.gate,
    met: view.met,
    unmet: view.unmet,
    eligible: view.eligible,           // fail-closed: false while survivorship-unsafe or thin
    note: 'ATLAS-X is SHADOW/weight-0. Even if every criterion were met, promotion requires an '
      + 'explicit registry maturity flip — and survivorship-unsafe data can never meet them.',
  });
}

// Is atlasx-baseline the IC champion (informational — does NOT relax the gate)?
function isATLASXChampion(c) {
  return !!(c.champion && c.champion.ranker === 'atlasx-baseline');
}

// Crude regime-robustness proxy: atlas posts a positive mean fold-IC in a majority of folds.
function atlasRobust(c) {
  const folds = (c.foldReport || []);
  if (folds.length < 2) return false;
  let pos = 0, seen = 0;
  for (const f of folds) {
    const r = f.rankers && f.rankers['atlasx-baseline'];
    if (r && r.meanIC != null) { seen++; if (r.meanIC > 0) pos++; }
  }
  return seen >= 2 && pos / seen > 0.5;
}

module.exports = {
  RESEARCH_VERSION,
  MIN_HISTORY_BARS,
  SURVIVORSHIP_REASON,
  DEFAULT_RANKERS,
  simpleMomentumRanker,
  normalizeBars,
  buildEvents,
  runComparison,
  promotionReadout,
};

// ── small map/object helpers (accept Map OR plain object) ───────────────────────
function entriesOf(m) {
  if (!m) return [];
  if (m instanceof Map) return [...m.entries()];
  return Object.entries(m);
}
function getFrom(m, k) {
  if (!m) return null;
  if (m instanceof Map) return m.get(k) || null;
  return m[k] || null;
}
