'use strict';
// SHARED SWING SCREENER SELECTION ENGINE (Screener Replay v3).
//
// ONE pure production selection path used by BOTH the live screener
// (api/screener.js) and historical replay (lib/swing-replay-v3.js). Before this
// module, /api/backtest replayed only the raw per-ticker pattern evaluator —
// no RS-vs-SPY gate, no 50/200 trend eligibility, no same-date full-cohort
// percentiles, no quant composite, no cap/buffer, no liquidity floor, no regime
// admission — i.e. it validated a DIFFERENT strategy than production selects.
// Any parity claim must run THIS engine on point-in-time inputs.
//
// The engine is pure w.r.t. its inputs (no network, no store, `now` injectable).
// Per-ticker feature snapshots come from lib/screener.screenTicker (also pure);
// this module owns everything cross-sectional:
//   1. cohort freshness gate (one authoritative decision session; defect #3)
//   2. liquidity floor / scope rules
//   3. same-date cohort percentiles + the quant composite
//   4. market regime (SPY vs 200-DMA + breadth)
//   5. admission (status gate + regime-gated emergingLeader arm)
//   6. buffer cap + DETERMINISTIC ordering (composite desc, ticker asc — the
//      live sort used to break ties on input order, which is not replayable)
//   7. reason-coded rejection for EVERY evaluated candidate

const { gateCohort } = require('./cohort-freshness');
const { REJECT } = require('./swing-candidate-schema');

const ENGINE_VERSION = 'swing-screener-engine-v1';

// Default composite weighting — moved here from api/screener.js (single source).
// This project's own edge research found the DEAD factors — volume-surge (`vol`,
// rank-IC ≈ −0.004) and base-quality/VCP (`base`) — carry no forward-return edge,
// while accumulation ratio (`accum`, IC ~0.075) and up/down volume (`ud`, ~0.071)
// DO. base+vol stay in the shape (weight 0) for the Tune panel.
const DEFAULT_WEIGHTS = Object.freeze({ rs: 22, mom: 20, trend: 16, volAdj: 14, accum: 12, ud: 10, prox: 6, base: 0, vol: 0 });

// Scope configuration — the exact production thresholds/caps/floors (moved from
// api/screener.js so live and replay cannot drift).
const SCOPE_CONFIG = Object.freeze({
  large:    { cap: 20, bufferExtra: 8, liquidityFloor: null,      screenOpts: {} },
  small:    { cap: 10, bufferExtra: 6, liquidityFloor: 3_000_000, screenOpts: { baseMax: 0.45, setupBelow: 0.10, earlyAbove: 0.12, moveMax: 0.60, setupHighGate: 0.35, setupMaGate: 0.93 } },
  expanded: { cap: 10, bufferExtra: 6, liquidityFloor: 3_000_000, screenOpts: { baseMax: 0.45, setupBelow: 0.10, earlyAbove: 0.12, moveMax: 0.60, setupHighGate: 0.35, setupMaGate: 0.93 } },
  micro:    { cap: 10, bufferExtra: 6, liquidityFloor: 1_000_000, screenOpts: { baseMax: 0.60, setupBelow: 0.18, earlyAbove: 0.15, moveMax: 0.70, setupHighGate: 0.55, setupMaGate: 0.88 } },
  biotech:  { cap: 12, bufferExtra: 8, liquidityFloor: 3_000_000, screenOpts: { baseMax: 0.45, setupBelow: 0.10, earlyAbove: 0.12, moveMax: 0.60, setupHighGate: 0.35, setupMaGate: 0.93 } },
});
const isSmallScope = (scope) => scope === 'small' || scope === 'micro' || scope === 'biotech' || scope === 'expanded';

// Cross-sectional percentile rank (0-100) for each named factor across the set.
function attachPercentiles(items, getters) {
  for (const [name, fn] of Object.entries(getters)) {
    const vals = items.map(fn).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
    const pr = x => {
      if (x == null || isNaN(x) || !vals.length) return 0;
      let lo = 0, hi = vals.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] <= x) lo = mid + 1; else hi = mid; }
      return Math.round((lo / vals.length) * 100);
    };
    items.forEach(it => { it._pct = it._pct || {}; it._pct[name] = pr(fn(it)); });
  }
}

// Cross-sectional percentile components for one name (0-100 each).
function pctComponents(it) {
  const p = it._pct || {};
  return {
    rs:     p.mom126 || 0,
    mom:    Math.round(((p.mom63 || 0) + (p.mom126 || 0)) / 2),
    trend:  p.trend || 0,
    volAdj: p.volAdj || 0,
    base:   p.base || 0,
    vol:    p.volSurge || 0,
    prox:   p.prox || 0,
    accum:  p.accum || 0,
    ud:     p.ud || 0,
  };
}

function composite(pct, w) {
  const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let s = 0;
  for (const k in w) s += (w[k] / sum) * (pct[k] || 0);
  return Math.round(s);
}

const PERCENTILE_GETTERS = Object.freeze({
  mom63:    c => c.factors.mom63,
  mom126:   c => c.factors.mom126,
  trend:    c => c.factors.trendTemplate,
  volAdj:   c => c.factors.volAdjMom,
  volSurge: c => c.factors.volSurge,
  base:     c => c.factors.baseQuality,
  prox:     c => c.factors.proximity,
  accum:    c => c.metrics.accumRatio,
  ud:       c => c.metrics.udVol,
});

// SERVER-AUTHORITATIVE REGIME LATCH (alpha-research pass 3).
//
// The Apex tab used to debounce the regime in the BROWSER: a 3-refresh hysteresis
// counter persisted in `localStorage.apexRegime`, which gated tier assignment
// (apexTier caps apex/loaded → watch in RISK_OFF) and dropped names (apexRegimeFilter).
// Two consequences, both real:
//   • Two browsers could show DIFFERENT tiers for the same stock at the same instant.
//   • The hysteresis advanced per REFRESH, so how quickly the regime switched depended
//     on how often the user happened to open the tab.
// The brief is explicit that regime state cannot live only in browser storage.
//
// This computes the latch on the server as a PURE FUNCTION of SPY's dated history, so
// every client gets the same answer and the debounce is measured in market sessions
// rather than page views. No new persistence and no writer: deriving it from the price
// series avoids turning a public read into a state mutation (the defect fixed for
// op=maturity earlier in this pass).
//
// SCOPE NOTE, stated rather than hidden: the per-session read uses the benchmark's
// 200-DMA only. Cohort breadth is a same-day cross-section that is not reconstructable
// per historical session here, so it still contributes to TODAY's `bearish`/`riskOn` but
// not to the latch's history. The latch therefore debounces the trend component, which
// is the part that was flapping.
const REGIME_HOLD_SESSIONS = 3;   // a new reading must hold this many sessions to switch
const REGIME_LOOKBACK = 40;       // sessions scanned back for the most recent held run

function sessionRegimes(spyCandles, { smaAt } = require('./screener')) {
  const cl = (spyCandles || []).map(x => x.close);
  const out = [];
  const last = cl.length - 1;
  for (let i = Math.max(0, last - REGIME_LOOKBACK + 1); i <= last; i++) {
    const s200 = smaAt(cl, 200, i);
    out.push(s200 == null ? null : (cl[i] > s200 ? 'RISK_ON' : 'RISK_OFF'));
  }
  return out;
}

// The active regime = the most recent reading that has HELD for REGIME_HOLD_SESSIONS
// consecutive sessions. Walking back from the newest bar means a fresh flip does not
// take effect until it has persisted, and an older established regime stays in force
// until then — the same intent as the browser latch, without the browser.
function latchedRegime(spyCandles, deps) {
  const seq = sessionRegimes(spyCandles, deps);
  for (let end = seq.length - 1; end >= REGIME_HOLD_SESSIONS - 1; end--) {
    const v = seq[end];
    if (!v) continue;
    let held = true;
    for (let k = 0; k < REGIME_HOLD_SESSIONS; k++) if (seq[end - k] !== v) { held = false; break; }
    if (held) return { active: v, heldSessions: REGIME_HOLD_SESSIONS, sessionsAgo: (seq.length - 1) - end };
  }
  return { active: null, heldSessions: 0, sessionsAgo: null };
}

// Market regime from the benchmark + cohort breadth (large/unfiltered only —
// identical to the live rule).
function computeRegime(cohort, spyCandles, deps = require('./screener')) {
  if (!spyCandles || !spyCandles.length) return null;
  const { smaAt } = deps;
  const cl = spyCandles.map(x => x.close), li = cl.length - 1;
  const s200 = smaAt(cl, 200, li);
  const indexAbove200 = s200 != null ? cl[li] > s200 : null;
  const breadthPct = cohort.length ? Math.round((cohort.filter(c => c.above50).length / cohort.length) * 100) : null;
  const bearish = indexAbove200 === false || (breadthPct != null && breadthPct < 40);
  const riskOn = indexAbove200 === true && (breadthPct == null || breadthPct >= 45);
  const latch = latchedRegime(spyCandles, deps);
  return {
    indexAbove200, breadthPct, bearish, riskOn,
    // Debounced, server-computed, identical for every client. `raw` is the same-day
    // read the UI used to debounce itself; `active` is what it must now consume.
    raw: bearish ? 'RISK_OFF' : riskOn ? 'RISK_ON' : 'NEUTRAL',
    active: latch.active || (bearish ? 'RISK_OFF' : riskOn ? 'RISK_ON' : 'NEUTRAL'),
    latch: { holdSessions: REGIME_HOLD_SESSIONS, sessionsAgo: latch.sessionsAgo, basis: 'SPY 200-DMA, session-debounced server-side' },
  };
}

// Map a cohort-freshness class to the canonical rejection code.
const FRESHNESS_REJECT = Object.freeze({
  'prior-session': REJECT.STALE_DATA,
  stale: REJECT.STALE_DATA,
  'ahead-of-benchmark': REJECT.BENCHMARK_LAG,
  'future-dated': REJECT.FUTURE_DATED_DATA,
  missing: REJECT.MISSING_HISTORY,
});

// THE SHARED SELECTION. rows = screenTicker outputs, each carrying at least
// {ticker, lastBarDate, factors, metrics, status, include, emergingLeader,
// filters, above50}. Attaches _pct/pct/quant to the admitted cohort rows (the
// same in-place enrichment the live route always did) and returns the selected
// candidate buffer plus a reason-coded rejection for every other row.
function selectCandidates({
  rows = [],
  scope = 'large',
  spyCandles = null,
  macroRiskOff = false,
  weights = DEFAULT_WEIGHTS,
  now = new Date(),
  regimeEligible = true,      // live: only large/unfiltered computes regime
} = {}) {
  const cfg = SCOPE_CONFIG[scope] || SCOPE_CONFIG.large;
  const rejections = [];

  // 1. Cohort freshness gate (defect #3) — one authoritative decision session.
  const gate = gateCohort(rows.filter(Boolean), { benchmarkDates: spyCandles ? spyCandles.map(x => x.date) : [], now });
  for (const ex of gate.excluded) rejections.push({ ticker: ex.ticker, reason: FRESHNESS_REJECT[ex.reason] || REJECT.STALE_DATA, detail: ex.reason, lastBarDate: ex.lastBarDate });
  let cohort = gate.admitted;
  if (!gate.adjudicated) {
    // No benchmark axis → freshness unadjudicated; flagged, and every downstream
    // consumer sees missing-benchmark on the scan report.
    rejections.push({ ticker: null, reason: REJECT.MISSING_BENCHMARK, detail: 'no benchmark axis — freshness unadjudicated' });
  }

  // 2. Liquidity floor (scope rule — identical to live).
  if (isSmallScope(scope) && cfg.liquidityFloor) {
    const keep = [];
    for (const c of cohort) {
      if ((c.factors.dollarVol || 0) >= cfg.liquidityFloor) keep.push(c);
      else rejections.push({ ticker: c.ticker, reason: REJECT.LIQUIDITY, detail: `dollarVol ${c.factors.dollarVol || 0} < ${cfg.liquidityFloor}` });
    }
    cohort = keep;
  }

  // 3. Same-date cohort percentiles + quant composite over the WHOLE cohort.
  attachPercentiles(cohort, PERCENTILE_GETTERS);
  cohort.forEach(c => { c.pct = pctComponents(c); c.quant = { score: composite(c.pct, weights) }; });

  // 4. Regime (large/unfiltered only, exactly as live).
  const regime = (!isSmallScope(scope) && regimeEligible) ? computeRegime(cohort, spyCandles) : null;

  // 5+6. Admission + buffer, ranked purely by the quant composite. DETERMINISTIC:
  // composite desc, ticker asc — replayable regardless of input order.
  const admitEmerging = !isSmallScope(scope) && !((regime && regime.bearish) || macroRiskOff);
  const buffer = cfg.cap + (isSmallScope(scope) ? 6 : 8);
  const admitted = [];
  for (const c of cohort) {
    if (c.include) { admitted.push(c); continue; }
    if (c.emergingLeader) {
      if (admitEmerging) { admitted.push(c); continue; }
      rejections.push({ ticker: c.ticker, reason: REJECT.RISK_OFF, detail: 'emergingLeader arm closed (bearish regime / macro risk-off)' });
      continue;
    }
    const f = c.filters || {};
    const reason = f.aboveSmas === false ? REJECT.LIVE_TREND_GATE
      : f.rsVsSpy === false ? REJECT.RELATIVE_STRENGTH_GATE
      : REJECT.NO_QUALIFYING_SETUP;
    rejections.push({ ticker: c.ticker, reason, detail: c.status ? null : 'no qualifying pattern status' });
  }
  admitted.sort((a, b) => (b.quant.score - a.quant.score) || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  const candidates = admitted.slice(0, buffer);
  for (const c of admitted.slice(buffer)) {
    rejections.push({ ticker: c.ticker, reason: REJECT.BELOW_SELECTION_CAP, detail: `quant ${c.quant.score} below buffer ${buffer}` });
  }

  return {
    engineVersion: ENGINE_VERSION,
    scope, cap: cfg.cap, buffer, admitEmerging,
    cohort, candidates, regime, rejections,
    freshness: {
      decisionSession: gate.decisionSession, sessionSource: gate.sessionSource,
      adjudicated: gate.adjudicated, counts: gate.counts,
      // Calendar verdict: a scan running behind the exchange must SAY so rather than
      // publishing a stale cross-section that reads exactly like a current one.
      calendarSession: gate.calendarSession || null,
      benchmarkStale: !!gate.benchmarkStale, sessionsBehind: gate.sessionsBehind || 0,
      excluded: gate.excluded.slice(0, 100), excludedTotal: gate.excluded.length,
    },
  };
}

module.exports = {
  ENGINE_VERSION, DEFAULT_WEIGHTS, SCOPE_CONFIG, PERCENTILE_GETTERS,
  isSmallScope, attachPercentiles, pctComponents, composite, computeRegime, selectCandidates,
};
