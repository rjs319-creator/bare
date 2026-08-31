'use strict';
// COST-AWARE PORTFOLIO BACKTEST (forecast-backtest-v1)
//
// AFTER-COST RESULTS ARE THE PRIMARY ONES. Gross is reported beside them only so the size of
// the friction is visible; no conclusion in this system may rest on a gross number.
//
// EXECUTION. The signal is computed at a decision session's close and the sleeve is filled at
// the NEXT session's open, exiting at the close of session d+h. That is baked into the labels
// (lib/forecast/targets.js), so this module cannot accidentally execute a close-to-close signal
// at the same close.
//
// OVERLAPPING HOLDING PERIODS, HANDLED EXPLICITLY. A horizon-h strategy that rebalances daily
// holds h overlapping sleeves. Rather than pretend daily sleeve returns are independent, the
// backtest builds h NON-OVERLAPPING TRANCHES (tranche j takes every h-th decision date, so no
// two sleeves inside a tranche overlap), compounds each tranche into its own equity curve, and
// reports the distribution of tranche statistics as well as the pooled series. Every pooled
// statistic states that its observations overlap.
//
// COSTS come from lib/costs.js — the app's single cost model, tiered by dollar volume — charged
// as one round trip per name per sleeve, at the configured stress multipliers.
//
// LONG-ONLY BY DEFAULT. A market/sector-neutral long-short book is only simulated when
// `cfg.portfolio.longOnly` is false AND a borrow cost is supplied; otherwise the short leg would
// be free money. The top-minus-bottom spread is still reported as a ranking diagnostic
// (lib/forecast/metrics.js quantileSpread), clearly labelled as a diagnostic and not a book.

const { roundTripCostPct } = require('../costs');

const BACKTEST_VERSION = 'forecast-backtest-v1';

const isFin = Number.isFinite;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1));
};

/**
 * Cost tier + round-trip cost FRACTION for one row.
 * The liquidity → tier thresholds are the repo's existing research convention
 * (research/lib/experiment-kit.js costFractions), so the research side and this backtest charge
 * identical friction. `roundTripCostPct` is the app's single cost model — there is no second one.
 */
function tierForAdv(adv) {
  if (!Number.isFinite(adv)) return 'micro';
  return adv >= 2e7 ? 'liquid' : adv >= 5e6 ? 'small' : 'micro';
}
function costFor(row, multiplier = 1) {
  const tier = row.costTier || tierForAdv(row.adv);
  return { tier, cost: (roundTripCostPct(tier) / 100) * multiplier };
}

/**
 * Select and weight one sleeve's members, honouring position and sector caps.
 *
 * NO-TRADE BAND. With `previous` supplied and `noTradeBand > 1`, a name already held is KEPT
 * while it stays inside rank `topK * noTradeBand`, and only names inside the top `topK` are
 * bought. Without it, a name oscillating around rank K is sold and re-bought every rebalance and
 * pays a round trip each time for no change in exposure — pure friction, no information.
 * The band is the cheapest way to convert a small gross edge into a smaller net one.
 */
function selectSleeve(rows, cfg, { topK, weighting, previous = null }) {
  const ranked = rows
    .filter((r) => isFin(r.score) && r.label && isFin(r.label.rawReturn))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return { members: [], skipped: 'no ranked rows' };

  // Sector cap expressed as a count: no sector may take more than maxWeightPerSector of the book.
  const maxPerSector = Math.max(1, Math.ceil(topK * cfg.portfolio.maxWeightPerSector));
  const bySector = new Map();
  const picked = [];
  const takeIfRoom = (r) => {
    if (picked.length >= topK) return false;
    const sec = r.sector || 'UNKNOWN';
    const n = bySector.get(sec) || 0;
    if (n >= maxPerSector) return false;
    bySector.set(sec, n + 1);
    picked.push(r);
    return true;
  };

  const band = Math.max(1, cfg.portfolio.noTradeBand || 1);
  if (previous && previous.length && band > 1) {
    const held = new Set(previous.map((m) => m.ticker));
    const keepLimit = Math.min(ranked.length, Math.ceil(topK * band));
    // Incumbents first, in score order, while they remain inside the band.
    for (let i = 0; i < keepLimit; i++) if (held.has(ranked[i].ticker)) takeIfRoom(ranked[i]);
    // Then fill the remaining slots from the top, skipping what is already in.
    const inBook = new Set(picked.map((r) => r.ticker));
    for (const r of ranked) { if (!inBook.has(r.ticker)) takeIfRoom(r); if (picked.length >= topK) break; }
  } else {
    for (const r of ranked) { takeIfRoom(r); if (picked.length >= topK) break; }
  }
  if (!picked.length) return { members: [], skipped: 'sector caps excluded every candidate' };

  let weights;
  if (weighting === 'score') {
    const lo = Math.min(...picked.map((r) => r.score));
    const shifted = picked.map((r) => Math.max(1e-9, r.score - lo + 1e-9));
    const total = shifted.reduce((a, b) => a + b, 0);
    weights = shifted.map((v) => v / total);
  } else {
    weights = picked.map(() => 1 / picked.length);
  }
  // Position cap, then renormalize the uncapped remainder.
  const cap = cfg.portfolio.maxWeightPerName;
  let w = weights.slice();
  for (let pass = 0; pass < 4; pass++) {
    const over = w.map((v, i) => (v > cap ? i : -1)).filter((i) => i >= 0);
    if (!over.length) break;
    const excess = over.reduce((a, i) => a + (w[i] - cap), 0);
    for (const i of over) w[i] = cap;
    const freeIdx = w.map((v, i) => (v < cap ? i : -1)).filter((i) => i >= 0);
    const freeMass = freeIdx.reduce((a, i) => a + w[i], 0);
    if (!freeIdx.length || freeMass <= 0) break;
    for (const i of freeIdx) w[i] += excess * (w[i] / freeMass);
  }
  const sum = w.reduce((a, b) => a + b, 0);
  w = w.map((v) => v / sum);

  return { members: picked.map((r, i) => ({ ...r, weight: w[i] })), skipped: null };
}

/**
 * One sleeve's gross/net return on both the tradable (raw) and neutralized (residual) legs.
 *
 * COST IS CHARGED ON THE WEIGHT ACTUALLY TRADED, not on the whole book.
 *
 * The earlier model charged a full round trip on 100% of the book at every rebalance, even for a
 * name that was simply held. That overstates friction whenever anything is carried forward, and —
 * worse — it makes turnover reduction INVISIBLE: banding the selection changed nothing in the P&L
 * because the cost did not depend on what was traded.
 *
 * `roundTripCostPct` is a full buy-and-sell. Each rebalance therefore pays HALF a round trip per
 * unit of weight moved: `0.5 * SUM_i |w_new_i - w_old_i| * RT_i`. A name bought and later sold
 * accumulates exactly one round trip across the two events, and a book that turns over completely
 * pays SUM|dw| = 2, i.e. one full round trip — reducing exactly to the old model in that case.
 */
function sleeveReturn(members, costMultiplier, previous = null) {
  let gross = 0, residualGross = 0;
  for (const m of members) {
    gross += m.weight * m.label.rawReturn;
    residualGross += m.weight * (isFin(m.label.residualReturn) ? m.label.residualReturn : 0);
  }

  const prevW = new Map((previous || []).map((m) => [m.ticker, m.weight]));
  const rtOf = new Map();
  for (const m of members) rtOf.set(m.ticker, costFor(m, costMultiplier).cost);
  for (const m of previous || []) if (!rtOf.has(m.ticker)) rtOf.set(m.ticker, costFor(m, costMultiplier).cost);

  let traded = 0, cost = 0;
  for (const ticker of new Set([...prevW.keys(), ...members.map((m) => m.ticker)])) {
    const wNew = (members.find((m) => m.ticker === ticker) || { weight: 0 }).weight;
    const wOld = prevW.get(ticker) || 0;
    const d = Math.abs(wNew - wOld);
    traded += d;
    cost += 0.5 * d * (rtOf.get(ticker) || 0);
  }
  return { gross, net: gross - cost, residualGross, residualNet: residualGross - cost, cost, tradedWeight: traded, names: members.length };
}

/** Turnover between two consecutive sleeves of the same tranche: half the L1 weight distance. */
function turnoverBetween(prev, next) {
  if (!prev || !prev.length) return 1;
  const a = new Map(prev.map((m) => [m.ticker, m.weight]));
  const b = new Map(next.map((m) => [m.ticker, m.weight]));
  let d = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) d += Math.abs((b.get(k) || 0) - (a.get(k) || 0));
  return d / 2;
}

/** Compound a return series into an equity curve and its max drawdown. */
function equityStats(returns, periodsPerYear) {
  if (!returns.length) return { n: 0, annReturn: null, annVol: null, sharpe: null, sortino: null, maxDrawdown: null, hitRate: null, meanPerPeriod: null };
  let eq = 1, peak = 1, maxDd = 0;
  for (const r of returns) { eq *= 1 + r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, (peak - eq) / peak); }
  const m = mean(returns), s = sd(returns);
  const downside = returns.filter((r) => r < 0);
  const ds = downside.length >= 2 ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length) : null;
  const years = returns.length / periodsPerYear;
  return {
    n: returns.length,
    totalReturn: eq - 1,
    annReturn: years > 0 ? Math.pow(eq, 1 / years) - 1 : null,
    annVol: s != null ? s * Math.sqrt(periodsPerYear) : null,
    sharpe: (m != null && s > 0) ? (m / s) * Math.sqrt(periodsPerYear) : null,
    sortino: (m != null && ds > 0) ? (m / ds) * Math.sqrt(periodsPerYear) : null,
    maxDrawdown: maxDd,
    hitRate: returns.filter((r) => r > 0).length / returns.length,
    meanPerPeriod: m,
  };
}

/**
 * Run the backtest for ONE horizon.
 *   rows: [{ decisionDate, ticker, sector, score, adv, price, label: { rawReturn, residualReturn, labelEnd } }]
 * Returns gross and net statistics, per-tranche detail, turnover, exposure and cost stress.
 */
function runBacktest(rows, cfg, { horizon, topK = null, weighting = null, costMultiplier = 1, stride = 1 } = {}) {
  const k = topK || cfg.portfolio.topK;
  const w = weighting || cfg.portfolio.weighting;

  // CALENDAR ARITHMETIC. Consecutive decision dates are `stride` TRADING SESSIONS apart (the
  // study may sample the calendar). A tranche must therefore skip `ceil(horizon / stride)`
  // decision dates for its sleeves not to overlap, and one tranche period spans
  // `trancheStep * stride` sessions — which is what annualization must use. Getting this wrong
  // (annualizing a 10-session period as if it were 5) inflates or deflates every headline number.
  const st = Math.max(1, Math.floor(stride) || 1);
  const trancheStep = Math.max(1, Math.ceil(horizon / st));
  const sessionsPerPeriod = trancheStep * st;
  const periodsPerYear = 252 / sessionsPerPeriod;
  // Fraction of the period the book is actually invested; < 1 when the sampling stride is
  // coarser than the holding period, which is a real drag on the annualized number.
  const capitalDutyCycle = Math.min(1, horizon / sessionsPerPeriod);

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.decisionDate)) byDate.set(r.decisionDate, []);
    byDate.get(r.decisionDate).push(r);
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return { ok: false, reason: 'no rows' };

  // TRANCHES ARE PRIMARY, and each is built SEQUENTIALLY so a sleeve can see what the previous
  // sleeve of the same tranche held. That is what makes the no-trade band and the traded-weight
  // cost accounting mean anything: a portfolio has memory, and pretending each rebalance starts
  // from cash is what made friction look like an unavoidable constant.
  const tranches = [];
  const active = [];
  for (let j = 0; j < trancheStep; j++) {
    const seq = [];
    let prev = null;
    for (let i = j; i < dates.length; i += trancheStep) {
      const d = dates[i];
      const sel = selectSleeve(byDate.get(d), cfg, { topK: k, weighting: w, previous: prev });
      if (!sel.members.length) { seq.push({ date: d, skipped: sel.skipped, members: [] }); continue; }
      const ret = sleeveReturn(sel.members, costMultiplier, prev);
      const sleeve = { date: d, tranche: j, members: sel.members, ...ret, turnover: turnoverBetween(prev, sel.members) };
      seq.push(sleeve);
      active.push(sleeve);
      prev = sel.members;
    }
    const filled = seq.filter((x) => x.members.length);
    if (filled.length < 3) continue;
    tranches.push({
      tranche: j, rebalances: filled.length,
      gross: equityStats(filled.map((x) => x.gross), periodsPerYear),
      net: equityStats(filled.map((x) => x.net), periodsPerYear),
      residualNet: equityStats(filled.map((x) => x.residualNet), periodsPerYear),
      meanTurnover: mean(filled.map((x) => x.turnover)),
      meanTradedWeight: mean(filled.map((x) => x.tradedWeight)),
      meanCost: mean(filled.map((x) => x.cost)),
    });
  }
  if (!active.length) return { ok: false, reason: 'every sleeve was empty' };
  const sleeves = active;

  const pooledGross = equityStats(active.map((s) => s.gross), periodsPerYear);
  const pooledNet = equityStats(active.map((s) => s.net), periodsPerYear);
  const pooledResidualNet = equityStats(active.map((s) => s.residualNet), periodsPerYear);
  const acrossTranches = (pick) => {
    const vals = tranches.map(pick).filter(isFin);
    return vals.length ? { mean: mean(vals), sd: sd(vals), min: Math.min(...vals), max: Math.max(...vals), n: vals.length } : null;
  };

  const sectorCounts = new Map();
  for (const s of active) for (const m of s.members) sectorCounts.set(m.sector || 'UNKNOWN', (sectorCounts.get(m.sector || 'UNKNOWN') || 0) + 1);
  const totalSlots = active.reduce((a, s) => a + s.members.length, 0);

  return Object.freeze({
    schema: 'ForecastBacktest', version: BACKTEST_VERSION,
    ok: true,
    horizon, topK: k, weighting: w, costMultiplier,
    calendar: { decisionDateStride: st, trancheStep, sessionsPerPeriod, periodsPerYear, capitalDutyCycle },
    longOnly: cfg.portfolio.longOnly,
    execution: cfg.execution,
    dates: { first: dates[0], last: dates[dates.length - 1], n: dates.length },
    rebalances: active.length,
    trancheCount: tranches.length,
    periodsPerYear,
    // POOLED statistics use OVERLAPPING sleeves — dependent observations, so the volatility is
    // understated and the Sharpe correspondingly overstated. Stated, not hidden. The tranche
    // distribution below is the dependence-aware view and is the one to quote.
    pooled: { overlapping: true, volatilityUnderstated: trancheStep > 1, gross: pooledGross, net: pooledNet, residualNet: pooledResidualNet },
    // TRANCHE statistics use non-overlapping sleeves and are the dependence-safe view.
    tranches,
    trancheSummary: {
      netSharpe: acrossTranches((t) => t.net.sharpe),
      netAnnReturn: acrossTranches((t) => t.net.annReturn),
      netMaxDrawdown: acrossTranches((t) => t.net.maxDrawdown),
      residualNetSharpe: acrossTranches((t) => t.residualNet.sharpe),
      turnover: acrossTranches((t) => t.meanTurnover),
      tradedWeight: acrossTranches((t) => t.meanTradedWeight),
    },
    costs: {
      model: cfg.costs.model,
      basis: 'half a round trip per unit of weight traded at each rebalance',
      noTradeBand: cfg.portfolio.noTradeBand,
      meanCostPerRebalance: mean(active.map((x) => x.cost)),
      meanTradedWeight: mean(active.map((x) => x.tradedWeight)),
      meanTurnover: mean(active.map((x) => x.turnover)),
      annualizedCostDrag: mean(active.map((x) => x.cost)) * periodsPerYear,
    },
    exposure: {
      meanNames: mean(active.map((s) => s.names)),
      sectorShare: Object.fromEntries([...sectorCounts].map(([s, n]) => [s, +(n / totalSlots).toFixed(4)])),
    },
    limitations: Object.freeze([
      'Pooled statistics use overlapping sleeves; treat the tranche distribution as the dependence-aware view.',
      'Survivorship is reduced, not proven safe — see the universe snapshot limitations.',
      'Costs are a tiered model, not realized fills.',
    ]),
  });
}

/** Cost sensitivity: the same backtest at each configured stress multiplier. */
function costStress(rows, cfg, { horizon, topK = null, weighting = null, stride = 1 } = {}) {
  const out = {};
  for (const m of cfg.costs.stressMultipliers) {
    const r = runBacktest(rows, cfg, { horizon, topK, weighting, costMultiplier: m, stride });
    out[`x${m}`] = r.ok ? { netSharpe: r.pooled.net.sharpe, netAnnReturn: r.pooled.net.annReturn, trancheNetSharpeMean: r.trancheSummary.netSharpe && r.trancheSummary.netSharpe.mean } : { error: r.reason };
  }
  return out;
}

module.exports = { BACKTEST_VERSION, runBacktest, costStress, selectSleeve, sleeveReturn, turnoverBetween, equityStats, costFor, tierForAdv };
