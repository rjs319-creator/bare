'use strict';
// CATALYST–FLOW — TARGET AND RELEVANCE GRADES.
//
//   netTarget(i,t) = winsorised 5-session stock return
//                    − 5-session SECTOR-BENCHMARK return
//                    − estimated round-trip cost
//
// Three properties this module is responsible for:
//
//  1. EXECUTABLE PRICES ONLY. Entry is the entry session's open (or the configured
//     09:35–09:45 VWAP — refused outright when intraday bars are absent, never silently
//     downgraded to the open). Exit is the close of the fifth session. Both conventions
//     are applied identically to the stock and to its benchmark, so the difference is a
//     spread that could actually have been traded.
//
//  2. COSTS FROM DECISION-TIME INPUTS ONLY. The liquidity tier comes from dollar volume
//     measured up to the decision date. Using the trade's own realised volume to price its
//     own friction is a small, seductive leak.
//
//  3. GRADES ARE COMPUTED WITHIN ONE DECISION DATE. A percentile boundary pooled across
//     dates imports the future into today's cohort. When a cohort is too small to resolve
//     a 0.5% bin, a deterministic rank-based rule is used INSTEAD and recorded per date —
//     not silently approximated with the same percentile call.
//
// Pure module: no network, no clock, no fs.

const { COST_CASES, GRADE_BINS, MIN_COHORT_FOR_PERCENTILE_BINS, CLOCK } = require('./config');
const { roundTripCostPct } = require('../costs');

const LABEL_VERSION = 'catalyst-label-v1';
const WINSOR = 0.30;   // ±30% on a 5-session return: a preregistered fat-tail clip, not a fit

const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Liquidity tier from decision-time dollar volume, matching the app's single cost model.
const tierOf = (dollarVol) => (!Number.isFinite(dollarVol) ? 'micro'
  : dollarVol >= 2e7 ? 'liquid' : dollarVol >= 5e6 ? 'small' : 'micro');

// Round-trip friction as a FRACTION for one of the three declared cost cases.
function costFraction(caseName, { dollarVolumeAtDecision } = {}) {
  const spec = COST_CASES[caseName];
  if (!spec) return null;
  if (spec.kind === 'fixed') return (2 * spec.perSideBps) / 10000;
  return roundTripCostPct(tierOf(dollarVolumeAtDecision)) / 100;
}

// Executable entry price under the declared convention. A VWAP convention with no
// intraday bars REFUSES — returning the open here would make the backtest quietly
// describe a trade nobody placed.
function entryPrice(bars, entryIdx, convention = CLOCK.entryConvention, intraday = null) {
  const bar = bars && bars[entryIdx];
  if (!bar) return { price: null, reason: 'no-entry-bar' };
  if (convention === 'next-open') {
    return bar.open > 0 ? { price: bar.open, reason: null } : { price: null, reason: 'bad-open' };
  }
  if (convention === 'vwap-0935-0945') {
    const w = intraday && intraday.vwap0935to0945;
    if (!(w > 0)) return { price: null, reason: 'vwap-window-unavailable' };
    return { price: w, reason: null };
  }
  return { price: null, reason: `unknown-convention:${convention}` };
}

// Raw hold return over EXACTLY `holdSessions` sessions, entry-convention price → exit close.
function holdReturn(bars, entryIdx, holdSessions, convention = CLOCK.entryConvention, intraday = null) {
  const exitIdx = entryIdx + holdSessions - 1;
  if (!Array.isArray(bars) || exitIdx > bars.length - 1) return { ret: null, reason: 'horizon-beyond-history' };
  const e = entryPrice(bars, entryIdx, convention, intraday);
  if (e.price == null) return { ret: null, reason: e.reason };
  const exit = bars[exitIdx];
  if (!exit || !(exit.close > 0)) return { ret: null, reason: 'bad-exit-close' };
  return { ret: exit.close / e.price - 1, reason: null };
}

// The full target. `benchmarkBars` must be the SECTOR benchmark — the caller is
// responsible for having resolved one; there is deliberately no SPY fallback here,
// because a sector-labelled statistic that silently became a market statistic is a
// defect this repo has already shipped once.
function netTarget({
  bars, benchmarkBars, entryIdx, benchmarkEntryIdx,
  holdSessions = CLOCK.holdSessions, convention = CLOCK.entryConvention,
  intraday = null, benchmarkIntraday = null,
  dollarVolumeAtDecision = null, costCase = 'liquidityAware',
}) {
  const stock = holdReturn(bars, entryIdx, holdSessions, convention, intraday);
  if (stock.ret == null) return { value: null, reason: `stock:${stock.reason}` };
  const bench = holdReturn(benchmarkBars, benchmarkEntryIdx, holdSessions, convention, benchmarkIntraday);
  if (bench.ret == null) return { value: null, reason: `benchmark:${bench.reason}` };

  const cost = costFraction(costCase, { dollarVolumeAtDecision });
  if (cost == null) return { value: null, reason: `unknown-cost-case:${costCase}` };

  const winsorised = clip(stock.ret, -WINSOR, WINSOR);
  return {
    value: winsorised - bench.ret - cost,
    reason: null,
    parts: { rawReturn: stock.ret, winsorisedReturn: winsorised, benchmarkReturn: bench.ret, costFraction: cost, costCase },
  };
}

// ── Relevance grades, WITHIN one decision date ──────────────────────────────
// `rows` = [{ key, target }] for ONE date. Ties are broken deterministically by key so a
// re-run reproduces the same grades byte-for-byte.
function gradeCohort(rows, { minForPercentile = MIN_COHORT_FOR_PERCENTILE_BINS } = {}) {
  const usable = (rows || []).filter((r) => r && Number.isFinite(r.target));
  const n = usable.length;
  if (!n) return { grades: [], rule: 'none', n: 0 };

  const sorted = [...usable].sort((a, b) => (a.target - b.target) || String(a.key).localeCompare(String(b.key)));

  // Percentile bins need enough names for the narrowest bin (0.5%) to contain ≥1 row.
  if (n >= minForPercentile) {
    const grades = sorted.map((r, i) => {
      const pct = i / (n - 1 || 1);        // 0 = worst, 1 = best
      const bin = GRADE_BINS.find((b) => pct >= b.minPct) || GRADE_BINS[GRADE_BINS.length - 1];
      return { key: r.key, target: r.target, grade: bin.grade };
    });
    return { grades, rule: 'percentile-bins', n };
  }

  // DETERMINISTIC RANK FALLBACK, documented rather than approximated. Preserves the
  // ordering and the same 5-level scale by allocating the top ranks to the top grades in
  // the same proportions the percentile rule implies, floored at one row per used grade.
  const shares = [0.005, 0.045, 0.15, 0.30];   // grade 4, 3, 2, 1; remainder is grade 0
  const counts = shares.map((s) => Math.max(n >= 5 ? 1 : 0, Math.floor(n * s)));
  const grades = sorted.map((r) => ({ key: r.key, target: r.target, grade: 0 }));
  let cursor = grades.length - 1;
  [4, 3, 2, 1].forEach((g, gi) => {
    for (let k = 0; k < counts[gi] && cursor >= 0; k++, cursor--) grades[cursor].grade = g;
  });
  return { grades, rule: 'deterministic-rank-fallback', n, fallbackCounts: counts };
}

module.exports = {
  LABEL_VERSION, WINSOR, tierOf, costFraction,
  entryPrice, holdReturn, netTarget, gradeCohort,
};
