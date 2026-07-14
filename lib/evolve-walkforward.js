'use strict';
// EVOLVE — PURGED + EMBARGOED WALK-FORWARD  (OMEGA Phase A)
//
// EVOLVE's own op=evolvewalkforward measures the LIVE ledger, which is out-of-sample by
// construction but thin and un-purged. This is the missing rigor: a full historical
// walk-forward over reconstructed triple-barrier labels that (a) trains specialist
// performance only on the strict PAST, and (b) purges + EMBARGOES the boundary so a
// training label's forward window (up to 63 bars) can never overlap the test block.
//
// Why the embargo matters (the whole point of Phase A): the 21- and 63-day labels overlap
// heavily in time. A naive split that trains on events whose forward window bleeds into the
// test period leaks the answer and inflates apparent skill. We therefore keep a training
// event only if its label fully closes `embargo` trading days BEFORE the test block starts.
// We report the purged read AND a deliberately leaky (no-purge) read side by side, so the
// leakage inflation is measured, not assumed.
//
// Faithful to the live scorer: each test event is scored by the exact live probability path
// — specialistProb (empirical-Bayes pooled from TRAIN outcomes) → metaWeights → ensemble.
// No calibrator is applied in-fold (it is fit on live data downstream); raw ensemble P is
// used, and that is stated. Pure + dependency-light so it runs in a test and in an op.

const E = require('./evolve');
const L = require('./evolve-labels');
const RQ = require('./rankquality');
const U = require('./evolve-uniqueness');

const WF_VERSION = 'evolve-omega-wf-v1';
const MARGIN = 0.02;            // same OOS ship margin as lib/ghost-backtest.js
const DEFAULT_EMBARGO = 3;      // extra trading-day buffer BEYOND the label window
const CAL_PER_TD = 1.4;         // calendar days per trading day (~7/5) — the label window and
                                // embargo are in TRADING days; predDates are calendar dates.
const DEFAULTS = { folds: 4, minTrain: 30, minTest: 10 };

// Forward bars a horizon's triple-barrier label spans — the purge distance (trading days).
function horizonWindow(h) { return (L.HORIZON_META[h] || L.HORIZON_META.swing).window; }

// Calendar days between two YYYY-MM-DD dates (b − a).
function calDays(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

// Does a training event's label (window+embargo trading days forward of its predDate) fully
// close, with the embargo buffer, before the test block starts? Measured in CALENDAR days so
// it is correct for both the 21-step backfill ledger and the daily live ledger — the earlier
// ordinal-distance form silently under-trained when cohorts were spaced > 1 day apart.
function labelClearsTestBlock(trainDate, testStartDate, horizon, embargo) {
  const needCal = (horizonWindow(horizon) + embargo) * CAL_PER_TD;
  return calDays(trainDate, testStartDate) > needCal;
}

// Train specialist performance from a set of RESOLVED events. Mirrors the core of
// evolve-routes.recomputePerf (kept local so this module stays pure and free of the heavy
// route/network deps). Produces { bySpecialist: { sp: { global, byContext, recent } } },
// the exact shape E.specialistProb / E.metaWeights consume.
// `weighted` applies López de Prado average-uniqueness weights (Gap B): overlapping labels
// contribute a fraction of a sample, so wins/n and the effective sample used by pooledRate
// are de-duplicated for temporal autocorrelation instead of counting each 63-day window as
// one independent observation.
function fitPerf(events, { weighted = false } = {}) {
  const wmap = weighted ? U.uniquenessWeights(events) : null;
  const bySpecialist = {};
  const ensure = (sp) => (bySpecialist[sp] || (bySpecialist[sp] = { global: { wins: 0, n: 0 }, byContext: {}, _recent: [] }));
  for (const r of events) {
    const won = r.won ? 1 : 0;
    const wt = wmap ? (wmap.get(r) ?? 1) : 1;
    const contribs = r.contribs || (r.specialists || []).map(s => ({ specialist: s, p: r.probability == null ? 0.4 : r.probability }));
    for (const cb of contribs) {
      const sp = ensure(cb.specialist);
      sp.global.n += wt; sp.global.wins += wt * won;
      const cx = sp.byContext[r.contextKey] || (sp.byContext[r.contextKey] = { wins: 0, n: 0 });
      cx.n += wt; cx.wins += wt * won;
      sp._recent.push({ won });
    }
  }
  for (const o of Object.values(bySpecialist)) {
    o.global.n = +o.global.n.toFixed(2); o.global.wins = +o.global.wins.toFixed(2);
    for (const cx of Object.values(o.byContext)) { cx.n = +cx.n.toFixed(2); cx.wins = +cx.wins.toFixed(2); }
    o.recent = { n: o._recent.length };   // metaWeights reads recent.ic (absent → neutral icFactor)
    delete o._recent;
  }
  return { bySpecialist };
}

// Score ONE test event's ensemble P from TRAIN-derived perf, via the live probability path.
function scoreEvent(ev, perf) {
  const firing = (ev.specialists && ev.specialists.length) ? ev.specialists : (ev.contribs || []).map(c => c.specialist);
  if (!firing.length) return null;
  const contribs = firing.map(sp => {
    const pr = E.specialistProb(perf.bySpecialist[sp], ev.contextKey);
    return { specialist: sp, p: pr.p, effN: pr.effN };
  });
  const weights = E.metaWeights(firing, { perfById: perf.bySpecialist, driftById: {} });
  const ens = E.ensembleProbability(contribs, weights);
  return ens.p == null ? null : { p: ens.p, effN: ens.effN };
}

// One expanding-window walk-forward over a single event set.
//   purge=true  → drop training events whose label window (+embargo) reaches the test block.
//   purge=false → the leaky baseline (train on ALL strictly-past events) for comparison.
// Training is always PAST-only, so future leakage is impossible; the purge/embargo guards
// the remaining overlap leak on the near side of the boundary.
function walkForward(events, { folds = DEFAULTS.folds, embargo = DEFAULT_EMBARGO, purge = true,
  minTrain = DEFAULTS.minTrain, minTest = DEFAULTS.minTest, weighted = false } = {}) {
  const rows = (events || []).filter(e => e && e.predDate && Number.isFinite(e.terminalReturn));
  const dates = [...new Set(rows.map(r => r.predDate))].sort();
  const D = dates.length;
  if (D < folds) return { ready: false, blocks: D, note: 'too few distinct prediction dates' };
  const ord = new Map(dates.map((d, i) => [d, i]));

  const foldOut = []; const blockICs = []; const allTest = [];
  for (let f = 1; f < folds; f++) {                 // f=0 has no past → no training set
    const lo = Math.floor((D * f) / folds);
    const hi = Math.floor((D * (f + 1)) / folds);
    const testStartDate = dates[lo];
    const testDates = new Set(dates.slice(lo, hi));
    const testEvents = rows.filter(r => testDates.has(r.predDate));
    const train = rows.filter(r => {
      if (ord.get(r.predDate) >= lo) return false;  // strictly past only
      if (!purge) return true;                      // leaky baseline
      return labelClearsTestBlock(r.predDate, testStartDate, r.horizon, embargo);   // purge + embargo (calendar days)
    });
    if (train.length < minTrain || testEvents.length < minTest) {
      foldOut.push({ fold: f, from: dates[lo], to: dates[hi - 1], trainN: train.length, testN: testEvents.length, ic: null, skipped: 'below min train/test' });
      continue;
    }
    const perf = fitPerf(train, { weighted });
    const scored = [];
    for (const ev of testEvents) {
      const s = scoreEvent(ev, perf);
      if (s) scored.push({ score: s.p, outcome: ev.terminalReturn, won: ev.won ? 1 : 0 });
    }
    if (scored.length < minTest) {
      foldOut.push({ fold: f, from: dates[lo], to: dates[hi - 1], trainN: train.length, testN: scored.length, ic: null, skipped: 'too few scorable test events' });
      continue;
    }
    const icRes = RQ.informationCoefficient(scored);
    blockICs.push(icRes.ic);
    allTest.push(...scored);
    foldOut.push({ fold: f, from: dates[lo], to: dates[hi - 1], trainN: train.length, testN: scored.length, ic: icRes.ic, t: icRes.t, significant: icRes.significant });
  }

  const valid = blockICs.filter(v => v != null);
  const positive = valid.filter(v => v > 0).length;
  const meanOOS = valid.length ? +(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(4) : null;
  // Ship criterion (same as ghost-backtest): ≥3 OOS blocks, ALL positive, mean above margin.
  const passed = valid.length >= 3 && positive === valid.length && meanOOS != null && meanOOS > MARGIN;
  const cal = allTest.length ? RQ.calibration(allTest.map(r => ({ score: r.score * 100, won: r.won }))) : null;
  return {
    ready: valid.length > 0, blocks: D, folds: foldOut,
    testedBlocks: valid.length, positiveBlocks: positive, meanOOS, passed,
    brier: cal ? cal.brier : null, calibration: cal, testRows: allTest.length,
  };
}

// Regime label of an event — explicit field, else parsed from the contextKey
// (regimeLabel|cap|horizon). The gate operates on this.
function regimeOf(ev) {
  if (ev.regimeLabel) return ev.regimeLabel;
  return (ev.contextKey || '').split('|')[0] || 'neutral';
}

// Count of events per regime — so a gate result is read against real composition, not
// against an assumption that risk-off is even present in the window.
function regimeHistogram(events) {
  const h = {};
  for (const e of (events || [])) h[regimeOf(e)] = (h[regimeOf(e)] || 0) + 1;
  return h;
}

function verdictOf(wf) {
  if (!wf || !wf.ready) return 'insufficient';
  if (wf.passed) return 'edge-holds-oos';
  if (wf.meanOOS != null && wf.meanOOS <= 0) return 'no-edge';
  return 'inconclusive';
}

// Pure evaluation: per-horizon + pooled purged/embargoed walk-forward, each paired with a
// leaky (no-purge) run so the leakage inflation is measured. `events` are resolved,
// specialist-tagged, triple-barrier-labeled predictions (the backfill's additions values).
// `regimeAllow` (array of regime labels) restricts BOTH training and testing to those
// regimes — a coherent "we only operate in favorable regimes" system, not a hindsight
// filter. When null, all regimes are used.
function evaluate(events, { folds = DEFAULTS.folds, embargo = DEFAULT_EMBARGO, regimeAllow = null, weighted = false } = {}) {
  const all = events || [];
  const allow = regimeAllow ? new Set(regimeAllow) : null;
  const list = allow ? all.filter(e => allow.has(regimeOf(e))) : all;
  const byHorizon = {};
  for (const h of L.EVOLVE_HORIZONS) {
    const evs = list.filter(e => e.horizon === h);
    const purged = walkForward(evs, { folds, embargo, purge: true, weighted });
    const leaky = walkForward(evs, { folds, embargo, purge: false, weighted });
    byHorizon[h] = { n: evs.length, uniqueness: U.uniquenessSummary(evs), purged, leaky, verdict: verdictOf(purged) };
  }
  const pooledPurged = walkForward(list, { folds, embargo, purge: true, weighted });
  const pooledLeaky = walkForward(list, { folds, embargo, purge: false, weighted });
  const inflation = (pooledLeaky.meanOOS != null && pooledPurged.meanOOS != null)
    ? +(pooledLeaky.meanOOS - pooledPurged.meanOOS).toFixed(4) : null;
  return {
    version: WF_VERSION, margin: MARGIN, embargo, weighted: !!weighted, events: list.length,
    regimeAllow: regimeAllow || null, regimeComposition: regimeHistogram(all),
    uniqueness: U.uniquenessSummary(list),
    pooled: { purged: pooledPurged, leaky: pooledLeaky, leakageInflation: inflation },
    byHorizon, verdict: verdictOf(pooledPurged),
    note: 'Purged+embargoed OOS over reconstructed triple-barrier labels. `uniqueness` = López de Prado sample-independence (effectiveN < rawN under overlap); `weighted:true` down-weights overlapping labels in the perf fit. `leakageInflation` = how much a naive un-purged split flatters the mean OOS IC. Raw ensemble P (no in-fold calibrator).',
  };
}

// Orchestrator: reconstruct labeled events with the proven backfill replay, then evaluate.
// Read-only (does not write the ledger). `now` injected to avoid a clock dependency.
async function runEvolveOmegaWalkForward({ scope = 'large', limit = 80, months = 18, step = 21,
  folds = DEFAULTS.folds, embargo = DEFAULT_EMBARGO, deadlineMs = 48000, now = null, volAdjust = false, regimeAllow = null, range = '2y', weighted = false } = {}) {
  const { runEvolveBackfill } = require('./evolve-backfill');
  const { additions, stats } = await runEvolveBackfill({ scope, limit, months, step, deadlineMs, now, volAdjust, range });
  const events = Object.values(additions);
  const evalOut = evaluate(events, { folds, embargo, regimeAllow, weighted });
  return { scope, range, generatedAt: now, volAdjust: !!volAdjust, backfillStats: stats, ...evalOut };
}

module.exports = {
  WF_VERSION, MARGIN, DEFAULT_EMBARGO,
  runEvolveOmegaWalkForward, evaluate, walkForward, fitPerf, scoreEvent, horizonWindow, verdictOf, labelClearsTestBlock, calDays, regimeOf, regimeHistogram, uniquenessWeights: U.uniquenessWeights, uniquenessSummary: U.uniquenessSummary,
};
