'use strict';
// OPTIONS EVALUATION v2 — three DISTINCT questions, never mixed, all prospective.
//
//   1. DETECTION QUALITY — was flagged activity actually abnormal (did it persist,
//      did later OI support new positioning, or was it likely spread/hedge noise)?
//   2. DIRECTIONAL VALUE — did the provisional lean forward-perform on the
//      underlying (multi-horizon, next-open entry, SPY- AND sector-relative,
//      cost-aware, MFE/MAE, target-before-stop)?
//   3. INCREMENTAL TRADE VALUE — do identical stock setups do BETTER with options
//      evidence than without it? (The only question that could ever justify letting
//      options modify ranking/confidence.)
//
// The legacy call=up/put=down ledger (op=optionsperf) is NOT mixed in here — v2
// events are graded only on their own interpretation states.
//
// Champion/challenger: every event logs the champion + challenger anomaly scores
// at decision time; a purged, embargoed walk-forward tests score-vs-outcome per
// scorer. Outcomes are clustered by decision session (independent-date counts,
// date-blocked folds) because overlapping holding periods are NOT independent.
//
// Everything reported carries sample size, independent dates, uncertainty, and a
// `prospective: true` stamp — nothing here is backfilled.

const { gradeEpisode, summarizeEpisodes } = require('./options-grade');
const { bootstrapMeanCI, purgedWalkForward } = require('./challenger-eval');
const { MODEL_VERSION } = require('./options-config-v2');

const SECTOR_ETF = Object.freeze({
  'Technology': 'XLK', 'Communication Services': 'XLC', 'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP', 'Health Care': 'XLV', 'Financials': 'XLF',
  'Industrials': 'XLI', 'Energy': 'XLE', 'Utilities': 'XLU',
  'Real Estate': 'XLRE', 'Materials': 'XLB',
});

// ── 1. Detection quality ─────────────────────────────────────────────────────
function detectionQuality(events) {
  const evs = (events || []).filter(e => e && e.firstSeen);
  const n = evs.length;
  if (!n) return { n: 0, note: 'no events yet' };
  const persisted = evs.filter(e => (e.appearances || 1) >= 2).length;
  const withOi = evs.filter(e => e.oiConfirmation && e.oiConfirmation.status !== 'PENDING');
  const oiConfirmed = withOi.filter(e => e.oiConfirmation.status === 'CONFIRMED_BUILDING').length;
  const oiWeakened = withOi.filter(e => ['WEAKENED', 'FLAT'].includes(e.oiConfirmation.status)).length;
  const oiUnavailable = withOi.filter(e => e.oiConfirmation.status === 'UNAVAILABLE').length;
  const spreadSuspect = evs.filter(e => e.firstSeen.interpretation && ['POSSIBLE_SPREAD', 'POSSIBLE_HEDGE'].includes(e.firstSeen.interpretation.state)).length;
  const unknownDir = evs.filter(e => !e.firstSeen.interpretation || e.firstSeen.interpretation.state === 'UNKNOWN').length;
  return {
    n,
    persistedPct: Math.round((persisted / n) * 100),
    oiResolved: withOi.length,
    oiConfirmedPct: withOi.length ? Math.round((oiConfirmed / withOi.length) * 100) : null,
    oiWeakenedPct: withOi.length ? Math.round((oiWeakened / withOi.length) * 100) : null,
    oiUnavailable,
    spreadOrHedgeSuspectPct: Math.round((spreadSuspect / n) * 100),
    unknownDirectionPct: Math.round((unknownDir / n) * 100),
    note: 'Detection health of the anomaly engine itself — persistence and later-OI support say whether flagged activity was real positioning; neither implies direction or edge.',
  };
}

// ── Grading adapter: v2 event → the shared episode grader ────────────────────
function eventToEpisode(ev) {
  return {
    id: ev.id,
    ticker: ev.ticker,
    side: ev.side,   // 'bullish' | 'bearish' | 'neutral' (neutral not graded)
    firstSeenDate: ev.firstSeen.session,
    firstSeenState: { score: ev.firstSeen.anomalyScore },
  };
}

// Target-before-stop from the decision-time plan (when one existed).
function targetBeforeStop(candles, entryIdx, setup, maxH) {
  if (!setup || setup.target == null || setup.invalidation == null) return null;
  const long = setup.direction === 'long';
  for (let i = entryIdx + 1; i <= entryIdx + maxH && i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    const hi = c.high != null ? c.high : c.close;
    const lo = c.low != null ? c.low : c.close;
    const hitTarget = long ? hi >= setup.target : lo <= setup.target;
    const hitStop = long ? lo <= setup.invalidation : hi >= setup.invalidation;
    if (hitTarget && hitStop) return 'ambiguous-same-bar';
    if (hitTarget) return 'target-first';
    if (hitStop) return 'stop-first';
  }
  return 'neither';
}

// ── 2. Directional value ─────────────────────────────────────────────────────
/**
 * Grade directional v2 events. series = { candlesByTicker:Map, spy, sectorByTicker:Map }.
 * Only bullish/bearish events with a matured decision session are graded.
 */
function gradeEvents(events, series, { horizons = [1, 3, 5, 10, 21] } = {}) {
  const graded = [];
  const maxH = Math.max(...horizons);
  for (const ev of events || []) {
    if (!ev || ev.side === 'neutral' || !ev.firstSeen) continue;
    const candles = series.candlesByTicker && series.candlesByTicker.get(ev.ticker);
    if (!candles) continue;
    const g = gradeEpisode(eventToEpisode(ev), {
      candles, spy: series.spy || null,
      sector: (series.sectorByTicker && series.sectorByTicker.get(ev.ticker)) || null,
    }, { horizons });
    if (!g.graded) continue;
    g.confidence = ev.firstSeen.interpretation ? ev.firstSeen.interpretation.confidence : null;
    g.activityStatus = ev.firstSeen.activityStatus;
    g.tradeStatusAtDecision = ev.firstSeen.tradeStatus;
    g.challengerScores = ev.firstSeen.challengerScores || null;
    if (ev.firstSeen.setup) {
      const entryIdx = candles.findIndex(c => c.date === g.entryDate);
      g.targetBeforeStop = entryIdx >= 0
        ? targetBeforeStop(candles, entryIdx, { ...ev.firstSeen.setup, direction: ev.side === 'bullish' ? 'long' : 'short' }, maxH)
        : null;
    }
    graded.push(g);
  }
  return graded;
}

function directionalValue(graded, { horizons = [1, 3, 5, 10, 21] } = {}) {
  const out = { n: graded.length, independentDates: new Set(graded.map(g => g.decisionDate)).size, prospective: true, horizons: {} };
  for (const h of horizons) {
    out.horizons[h] = {
      vsSpy: summarizeEpisodes(graded, { horizon: h, metric: 'excessVsSpy' }),
      vsSector: summarizeEpisodes(graded, { horizon: h, metric: 'excessVsSector' }),
      raw: summarizeEpisodes(graded, { horizon: h, metric: 'directional' }),
    };
  }
  const tbs = graded.map(g => g.targetBeforeStop).filter(Boolean);
  out.targetBeforeStop = tbs.length ? {
    n: tbs.length,
    targetFirstPct: Math.round((tbs.filter(v => v === 'target-first').length / tbs.length) * 100),
    stopFirstPct: Math.round((tbs.filter(v => v === 'stop-first').length / tbs.length) * 100),
  } : null;
  // Splits: by confidence band and by decision-time trade status.
  const byBand = { 'conf<20': [], 'conf20-40': [], 'conf>40': [] };
  for (const g of graded) {
    const c = g.confidence || 0;
    (c < 20 ? byBand['conf<20'] : c <= 40 ? byBand['conf20-40'] : byBand['conf>40']).push(g);
  }
  out.byConfidence = Object.fromEntries(Object.entries(byBand).map(([k, v]) => [k, summarizeEpisodes(v, { horizon: 21, metric: 'excessVsSpy' })]));
  out.note = 'Forward returns on the UNDERLYING for events whose interpretation had a provisional lean. Costs netted. Not a probability; a small n means noise.';
  return out;
}

// ── 3. Incremental value: price-only vs price+options ────────────────────────
// controls = graded control episodes: valid stock setups from the SAME sessions
// with NO unusual options activity (persisted alongside each scan). Comparing the
// two cohorts asks the only question that matters: does options evidence ADD
// anything beyond the identical stock-setup engine?
function incrementalValue(gradedWithOptions, gradedControls, { horizon = 21 } = {}) {
  const pick = rows => rows
    .map(g => g.horizons && g.horizons[horizon] && g.horizons[horizon].excessVsSpy)
    .filter(v => v != null);
  const w = pick(gradedWithOptions), c = pick(gradedControls);
  if (w.length < 5 || c.length < 5) {
    return {
      ready: false, withOptionsN: w.length, controlN: c.length, prospective: true,
      note: 'Insufficient matured events in one or both cohorts — the incremental question stays OPEN. No claim is made either way.',
    };
  }
  const wCI = bootstrapMeanCI(w), cCI = bootstrapMeanCI(c);
  const diff = +(wCI.mean - cCI.mean).toFixed(3);
  return {
    ready: true, prospective: true, horizon,
    withOptions: { n: w.length, mean: wCI.mean, ci: [wCI.lo, wCI.hi] },
    priceOnly: { n: c.length, mean: cCI.mean, ci: [cCI.lo, cCI.hi] },
    incrementalMeanExcess: diff,
    verdict: diff > 0 && wCI.lo > cCI.hi ? 'options-evidence-adds-value'
      : diff < 0 && wCI.hi < cCI.lo ? 'options-evidence-subtracts-value'
        : 'no-significant-difference',
    note: 'Same-session valid stock setups WITH unusual-options support vs WITHOUT. Only a significant positive gap would ever justify options evidence modifying live ranking — and promotion is still a deliberate governance act.',
  };
}

// ── Champion/challenger walk-forward on anomaly scorers ──────────────────────
function challengerReport(graded, { horizon = 21, folds = 4 } = {}) {
  const scorers = new Map();   // id → preds
  for (const g of graded) {
    const outcome = g.horizons && g.horizons[horizon] && g.horizons[horizon].excessVsSpy;
    if (outcome == null) continue;
    const rows = [{ id: 'champion', score: g.score }, ...((g.challengerScores || []).map(c => ({ id: c.id, score: c.score })))];
    for (const r of rows) {
      if (typeof r.score !== 'number') continue;
      (scorers.get(r.id) || scorers.set(r.id, []).get(r.id)).push({ predDate: g.decisionDate, residualScore: r.score, outcome });
    }
  }
  const out = {};
  for (const [id, preds] of scorers) {
    const wf = purgedWalkForward(preds, { folds, embargoDays: horizon });
    out[id] = { n: preds.length, ...wf, state: id === 'champion' ? 'champion (display)' : 'challenger (shadow — logged only, never displayed as the read)' };
  }
  return {
    horizon, scorers: out, prospective: true,
    note: 'Purged, embargoed walk-forward of decision-time anomaly score vs realized excess, per scorer. A challenger may replace the champion only after clearing the promotion gate on prospective evidence.',
  };
}

// One combined evidence report.
function evidenceReport({ events = [], gradedDirectional = [], gradedControls = [] } = {}) {
  return {
    modelVersion: MODEL_VERSION,
    prospective: true,
    detection: detectionQuality(events),
    directional: directionalValue(gradedDirectional),
    incremental: incrementalValue(gradedDirectional.filter(g => g.tradeStatusAtDecision === 'PRICE_CONFIRMED' || g.tradeStatusAtDecision === 'READY' || g.tradeStatusAtDecision === 'WATCH_FOR_PRICE_TRIGGER'), gradedControls),
    challengers: challengerReport(gradedDirectional),
    note: 'All results are prospective (no backfill), clustered by decision session, and reported with sample sizes and uncertainty. Small samples mean NO conclusion — the report says so rather than manufacturing one.',
  };
}

module.exports = {
  SECTOR_ETF, detectionQuality, eventToEpisode, targetBeforeStop,
  gradeEvents, directionalValue, incrementalValue, challengerReport, evidenceReport,
};
