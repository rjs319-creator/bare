'use strict';
// ROUTER COUNTERFACTUAL EVALUATION (router-cf-v1) — the missing gate between
// "the router computes weights" and "the router may ever bind capital".
//
// The audit finding: no harness compared router allocation against the obvious
// baselines on identical episodes, so bindingReady flipping true would have
// enabled a capital control that had never been shown to beat equal weight.
// A true retroactive replay is impossible — router/latest.json holds only the
// latest weights — so the design is PROSPECTIVE: op=router force runs persist a
// per-day weight history, and this module evaluates arms over the accrued
// history as it matures. Until the pre-registered minimum history exists the
// status is INSUFFICIENT_HISTORY and no comparison is reported as meaningful.
//
// Arms, evaluated on the SAME dates with the SAME resolved rows:
//   router     — that day's persisted router weights over the algorithms active
//                that day (all-zero weights ⇒ the abstain arm ⇒ cash, 0)
//   equal      — equal weight per active algorithm
//   bestRecent — 100% in the single algorithm with the best trailing mean
//                excess over STRICTLY PRIOR dates (no lookahead; needs a
//                minimum trailing sample or the date is skipped for this arm)
//   cash       — 0 every day (the abstention benchmark)
//
// Honesty rules:
//   - Rows are the ledger's 5-session SPY-relative excess: GROSS, present-day
//     universe. Labeled as such; nothing here may be presented as net edge.
//   - No verdict and no binding recommendation — this reports measurements.
//     Binding remains gated elsewhere (computeStrategyBudgets fail-closed AND
//     the pre-registered comparison criteria below AND prospective confirmation).
//   - Coverage is disclosed: the evaluation covers only algorithms present in
//     the resolved rows (currently the picks+ghost ledgers).
//
// Pure: history + rows in, frozen report out.

const ROUTER_CF_VERSION = 'router-cf-v1';

// Pre-registered evaluation bar — do not tune against the accrued history.
const MIN_HISTORY_DATES = 40;      // independent decision dates before EVALUABLE
const BEST_RECENT_WINDOW = 60;     // trailing calendar entries for the naive-chaser arm
const BEST_RECENT_MIN_ROWS = 20;   // minimum trailing rows before bestRecent may pick

const num = (v) => (Number.isFinite(v) ? v : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function round3(v) { return v == null ? null : +v.toFixed(3); }

// Per-date, per-algorithm mean excess from the raw resolved rows.
function dailyAlgoMeans(rows) {
  const byDate = new Map();
  for (const r of rows || []) {
    if (!r || !r.date || !r.algorithm || typeof r.excess !== 'number') continue;
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    const m = byDate.get(r.date);
    if (!m.has(r.algorithm)) m.set(r.algorithm, []);
    m.get(r.algorithm).push(r.excess);
  }
  const out = new Map();
  for (const [date, m] of byDate) {
    const perAlgo = {};
    for (const [algo, xs] of m) perAlgo[algo] = mean(xs);
    out.set(date, perAlgo);
  }
  return out;
}

// Max drawdown of the cumulative sum of a daily series (percent-points space).
function maxDrawdown(series) {
  let peak = 0, cum = 0, dd = 0;
  for (const v of series) { cum += v; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return +dd.toFixed(3);
}

function summarizeArm(daily) {
  const vals = daily.filter(Number.isFinite);
  if (!vals.length) return { n: 0, meanDaily: null, cumulative: null, maxDrawdown: null, winRate: null };
  const m = mean(vals);
  const sd = vals.length > 1 ? Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / (vals.length - 1)) : null;
  return {
    n: vals.length,
    meanDaily: round3(m),
    stdev: round3(sd),
    tStat: sd && sd > 0 ? round3(m / (sd / Math.sqrt(vals.length))) : null,
    cumulative: round3(vals.reduce((s, v) => s + v, 0)),
    maxDrawdown: maxDrawdown(vals),
    winRate: round3(vals.filter(v => v > 0).length / vals.length),
  };
}

// historyDays: [{ date, weights: { algoId: weight } }] — persisted per force run.
// rows:        [{ date, algorithm, excess }] — the resolved forward ledger.
function evaluateRouterCounterfactual({ historyDays = [], rows = [], minDates = MIN_HISTORY_DATES } = {}) {
  const algoMeans = dailyAlgoMeans(rows);
  const allRowDates = [...algoMeans.keys()].sort();

  // Only history dates that have graded rows can be evaluated.
  const history = (historyDays || [])
    .filter(h => h && h.date && h.weights && algoMeans.has(h.date))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const perDate = [];
  const arms = { router: [], equal: [], bestRecent: [], cash: [] };
  let routerAbstained = 0, bestRecentSkipped = 0;

  for (const h of history) {
    const perAlgo = algoMeans.get(h.date);
    const active = Object.keys(perAlgo).filter(a => Number.isFinite(perAlgo[a]));
    if (!active.length) continue;

    // router arm — that day's weights over the active set; all-zero ⇒ cash.
    let wSum = 0, wRet = 0;
    for (const a of active) {
      const w = num(h.weights[a]) || 0;
      wSum += w; wRet += w * perAlgo[a];
    }
    const routerRet = wSum > 0 ? wRet / wSum : 0;
    if (wSum <= 0) routerAbstained++;

    // equal arm.
    const equalRet = mean(active.map(a => perAlgo[a]));

    // bestRecent arm — best trailing mean over STRICTLY PRIOR dates only.
    let bestRet = null;
    {
      const priorDates = allRowDates.filter(d => d < h.date).slice(-BEST_RECENT_WINDOW);
      const trailing = new Map();
      let trailingRows = 0;
      for (const d of priorDates) {
        const pm = algoMeans.get(d);
        for (const [a, v] of Object.entries(pm)) {
          if (!Number.isFinite(v)) continue;
          if (!trailing.has(a)) trailing.set(a, []);
          trailing.get(a).push(v); trailingRows++;
        }
      }
      if (trailingRows >= BEST_RECENT_MIN_ROWS && trailing.size) {
        let bestAlgo = null, bestMean = -Infinity;
        for (const [a, xs] of trailing) { const m = mean(xs); if (m > bestMean) { bestMean = m; bestAlgo = a; } }
        // The chaser holds its pick even when that algorithm is inactive today
        // (0 return then) — switching to cash would flatter it.
        bestRet = Number.isFinite(perAlgo[bestAlgo]) ? perAlgo[bestAlgo] : 0;
      } else {
        bestRecentSkipped++;
      }
    }

    arms.router.push(routerRet);
    arms.equal.push(equalRet);
    arms.bestRecent.push(bestRet);
    arms.cash.push(0);
    perDate.push({
      date: h.date, activeAlgos: active.length,
      router: round3(routerRet), equal: round3(equalRet),
      bestRecent: round3(bestRet), abstained: wSum <= 0,
    });
  }

  const evaluatedDates = perDate.length;
  const status = evaluatedDates >= minDates ? 'EVALUABLE' : 'INSUFFICIENT_HISTORY';

  // Paired difference router-minus-equal — the pre-registered primary metric.
  const paired = perDate
    .map(d => (Number.isFinite(d.router) && Number.isFinite(d.equal) ? d.router - d.equal : null))
    .filter(Number.isFinite);
  const pairedSummary = summarizeArm(paired);

  return Object.freeze({
    version: ROUTER_CF_VERSION,
    status,
    verdict: null,   // measurements only — binding eligibility is decided elsewhere
    preRegistered: {
      minHistoryDates: minDates,
      primaryMetric: 'paired daily (router − equal) mean excess with t-stat',
      bindingAdditionallyRequires: [
        'router beats equal on the primary metric',
        'no material drawdown/tail worsening vs equal',
        'advantage not concentrated in one regime',
        'survives costs and delay',
        'prospective confirmation after EVALUABLE',
      ],
    },
    returnsBasis: 'gross 5-session SPY-relative excess (present-day universe) — NOT net edge',
    coverage: {
      historyDays: (historyDays || []).length,
      evaluatedDates,
      remaining: Math.max(0, minDates - evaluatedDates),
      routerAbstainedDates: routerAbstained,
      bestRecentSkippedDates: bestRecentSkipped,
      algorithmsCovered: [...new Set(rows.map(r => r && r.algorithm).filter(Boolean))].sort(),
      note: 'covers only algorithms present in the resolved rows ledger',
    },
    arms: {
      router: summarizeArm(arms.router),
      equal: summarizeArm(arms.equal),
      bestRecent: summarizeArm(arms.bestRecent),
      cash: summarizeArm(arms.cash),
    },
    routerMinusEqual: pairedSummary,
    perDate: Object.freeze(perDate),
  });
}

module.exports = {
  ROUTER_CF_VERSION, MIN_HISTORY_DATES, BEST_RECENT_WINDOW, BEST_RECENT_MIN_ROWS,
  evaluateRouterCounterfactual, dailyAlgoMeans,
};
