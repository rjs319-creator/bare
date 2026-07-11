// CROSS-SLEEVE ALLOCATION — inverse-vol (risk-parity) blend of the app's edge sleeves.
//
// EVIDENCE (research/ALPHA-RESEARCH-2026-07 "Round 4", steps 30-32). Combining low-
// correlation edges does NOT reliably raise Sharpe (the naive lift was a within-month-
// averaging artifact; hardened combined-minus-best-single Sharpe 90% CI [-0.89,+0.51]).
// What DOES survive is RISK REDUCTION: an inverse-vol blend earns ~the same Sharpe as the
// best sleeve at materially lower volatility + drawdown (Gap&Go ~30%->~17% vol). So this
// view is framed honestly as a RISK-REDUCTION / allocation tool, NOT an alpha booster —
// and it leans weight toward the lower-vol sleeves (risk parity), which in practice is
// the validated Gap&Go event sleeve.
//
// Pure: sleeve return records in -> allocation object out. The route supplies the records
// (resolved forward returns per sleeve from the ledgers); nothing here touches the network.

const MIN_MONTHS = 6;      // need this many overlapping months for a stable estimate
const MIN_SLEEVES = 2;
const ANN = Math.sqrt(12); // monthly -> annualized
// Cash-when-thin: a sleeve only earns capital if its expected monthly return clears
// this floor; otherwise that weight is held as CASH rather than force-deployed. 0 =
// "don't fund a sleeve that hasn't made money in-window" (costs would raise the bar).
const MIN_DEPLOY_EDGE = 0;

// Turnover proxy: average distinct picks a sleeve logs per active month. High turnover
// means more round-trips → more of the cost-v1 haircut eats the edge. Descriptive
// (a count), not a fabricated net — pairs with the Scoreboard's per-pick cost model.
function turnoverPerMonth(records) {
  const byMonth = {};
  for (const r of records || []) {
    if (r && typeof r.date === 'string') byMonth[r.date.slice(0, 7)] = (byMonth[r.date.slice(0, 7)] || 0) + 1;
  }
  const ms = Object.keys(byMonth);
  if (!ms.length) return null;
  return +(ms.reduce((a, m) => a + byMonth[m], 0) / ms.length).toFixed(1);
}

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

// [{date:'YYYY-MM-DD', ret:Number(fraction)}] -> { 'YYYY-MM': meanReturn } (equal capital
// across that month's signals — the sleeve's realized monthly return).
function monthlySeries(records) {
  const by = {};
  for (const r of records || []) {
    if (!r || typeof r.date !== 'string' || !Number.isFinite(r.ret)) continue;
    const ym = r.date.slice(0, 7);
    (by[ym] = by[ym] || []).push(r.ret);
  }
  const out = {};
  for (const ym of Object.keys(by)) out[ym] = mean(by[ym]);
  return out;
}

function corr(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : 0;
}

function maxDrawdown(monthlyRets) {
  let eq = 1, peak = 1, dd = 0;
  for (const r of monthlyRets) { eq *= (1 + r); peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
  return dd;
}

function sleeveStats(name, series, months) {
  const rets = months.map(m => series[m]).filter(Number.isFinite);
  const vol = std(rets) * ANN;
  const avg = mean(rets);
  return {
    name,
    months: rets.length,
    monthlyRets: months.map(m => (Number.isFinite(series[m]) ? series[m] : 0)),
    volAnn: +(vol * 100).toFixed(1),
    avgMonthly: +(avg * 100).toFixed(2),
    sharpe: vol > 0 ? +((avg * 12) / vol).toFixed(2) : null,
    maxDD: +(maxDrawdown(rets) * 100).toFixed(1),
  };
}

// sleevesRaw: { name: [{date, ret}] }. Returns the allocation object (or an accruing state).
function computeAllocation(sleevesRaw, opts = {}) {
  const minMonths = opts.minMonths || MIN_MONTHS;
  const series = {};
  for (const [name, recs] of Object.entries(sleevesRaw || {})) {
    const s = monthlySeries(recs);
    if (Object.keys(s).length) series[name] = s;
  }
  const names = Object.keys(series);
  // common months across all sleeves (an inverse-vol blend needs a shared window)
  let common = null;
  for (const n of names) {
    const ms = new Set(Object.keys(series[n]));
    common = common == null ? ms : new Set([...common].filter(m => ms.has(m)));
  }
  const months = common ? [...common].sort() : [];
  if (names.length < MIN_SLEEVES || months.length < minMonths) {
    return {
      status: 'accruing',
      sleeves: names.map(n => ({ name: n, months: Object.keys(series[n]).length })),
      overlapMonths: months.length,
      need: { sleeves: MIN_SLEEVES, months: minMonths },
    };
  }

  const stats = names.map(n => sleeveStats(n, series[n], months));
  // inverse-vol (risk parity) weights; guard zero-vol
  const invs = stats.map(s => (s.volAnn > 0 ? 1 / s.volAnn : 0));
  const invSum = invs.reduce((a, b) => a + b, 0) || 1;
  const weights = invs.map(v => v / invSum);

  // blended monthly series + its stats
  const blended = months.map((_, i) => stats.reduce((s, st, k) => s + weights[k] * st.monthlyRets[i], 0));
  const blendVol = std(blended) * ANN;
  const blendAvg = mean(blended);
  const blendDD = maxDrawdown(blended);

  // diversification ratio = weighted-avg sleeve vol / blended vol  (>1 = risk reduced)
  const waVol = stats.reduce((s, st, k) => s + weights[k] * (st.volAnn / 100), 0);
  const divRatio = blendVol > 0 ? waVol / blendVol : null;

  // pairwise correlations
  const correlations = [];
  for (let a = 0; a < names.length; a++)
    for (let b = a + 1; b < names.length; b++)
      correlations.push({ a: names[a], b: names[b], corr: +(corr(stats[a].monthlyRets, stats[b].monthlyRets)).toFixed(2) });

  // risk contribution: w_i * cov(sleeve_i, blend) / var(blend)
  const varBlend = blendVol > 0 ? (blendVol / ANN) ** 2 : 0;
  const riskContrib = stats.map((st, k) => {
    const covIB = corr(st.monthlyRets, blended) * std(st.monthlyRets) * std(blended);
    return varBlend > 0 ? +(weights[k] * covIB / varBlend * 100).toFixed(0) : 0;
  });

  const worstSleeveDD = Math.min(...stats.map(s => s.maxDD / 100));
  const bestSleeveVol = Math.min(...stats.map(s => s.volAnn));

  // Turnover per sleeve (picks/month) from the raw records.
  const turnover = {};
  for (const n of names) turnover[n] = turnoverPerMonth(sleevesRaw[n]);

  // CASH-WHEN-THIN: only fund sleeves whose expected monthly return clears the floor;
  // a sleeve below it has its risk-parity weight reallocated to CASH instead of being
  // force-deployed. When NOTHING clears the floor, the honest call is to sit in cash.
  const funded = stats.map((s, k) => s.avgMonthly > MIN_DEPLOY_EDGE ? +(weights[k] * 100).toFixed(0) : 0);
  const cashWeight = +(100 - funded.reduce((a, b) => a + b, 0)).toFixed(0);
  const cashAware = {
    minEdgePctMonthly: MIN_DEPLOY_EDGE,
    cashWeight,
    sitOut: cashWeight >= 99,
    deployed: stats.map((s, k) => ({ name: s.name, weight: funded[k], funded: funded[k] > 0 })),
    note: cashWeight >= 99
      ? 'No sleeve has a positive expected return in-window — the honest call is to hold cash, not force a trade.'
      : `Fund only the sleeves with positive expected return (risk-parity weighted); hold ${cashWeight}% cash rather than deploying into the rest. Gross expectancy — cost-v1 friction would raise the bar further.`,
  };

  return {
    status: 'ok',
    overlapMonths: months.length,
    window: [months[0], months[months.length - 1]],
    sleeves: stats.map((s, k) => ({
      name: s.name, months: s.months, volAnn: s.volAnn, avgMonthly: s.avgMonthly,
      sharpe: s.sharpe, maxDD: s.maxDD, weight: +(weights[k] * 100).toFixed(0), riskContrib: riskContrib[k],
      turnoverPerMonth: turnover[s.name],
    })),
    cashAware,
    correlations,
    blended: {
      volAnn: +(blendVol * 100).toFixed(1),
      avgMonthly: +(blendAvg * 100).toFixed(2),
      sharpe: blendVol > 0 ? +((blendAvg * 12) / blendVol).toFixed(2) : null,
      maxDD: +(blendDD * 100).toFixed(1),
    },
    riskReduction: {
      diversificationRatio: divRatio != null ? +divRatio.toFixed(2) : null,
      volVsWeightedAvg: +((blendVol - waVol) * 100).toFixed(1),  // negative = lower vol than the components
      maxDDvsWorstSleeve: +((blendDD - worstSleeveDD) * 100).toFixed(1),
      bestSleeveVolAnn: bestSleeveVol,
    },
    // The honest framing baked into the payload so the UI can't overclaim.
    note: 'Inverse-vol (risk-parity) blend of the app’s edge sleeves. Per research it REDUCES volatility & drawdown at ~equal Sharpe — a risk-reduction tool, not an alpha booster. Weight leans to the lower-vol (validated event) sleeves.',
  };
}

module.exports = { computeAllocation, monthlySeries, maxDrawdown, turnoverPerMonth, MIN_MONTHS, MIN_SLEEVES, MIN_DEPLOY_EDGE };
