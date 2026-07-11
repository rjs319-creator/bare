const { fetchWithTimeout } = require('./http');
// Point-in-time fundamentals for the backtestable BONUS pillar.
//
// Finnhub's stock/metric?metric=all returns a `series.quarterly` block with
// historical per-share sales (salesPerShare) and EPS, each as [{period, v}] where
// period is the fiscal-quarter END date. That's a multi-year history in ONE call,
// so we can reconstruct revenue/EPS growth + acceleration AS OF any past date —
// the candle-side of the harness can't see fundamentals, so this unlocks BONUS.
//
// Lookahead guard: a quarter ending on `period` isn't public until it's REPORTED,
// typically ~4-6 weeks later. We only count a quarter as known once period + LAG
// days have passed, so the backtest never uses numbers that weren't yet released.
const KEY = process.env.FINNHUB_API_KEY;
const REPORT_LAG_DAYS = 45;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const addDays = (iso, d) => new Date(new Date(iso + 'T00:00:00').getTime() + d * 864e5).toISOString().slice(0, 10);

// Fetch the historical quarterly series for one ticker → [{ period, sps, eps }].
async function fetchQuarterlySeries(ticker) {
  if (!KEY) return null;
  const sym = ticker.toUpperCase();
  try {
    const r = await fetchWithTimeout(`https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${KEY}`);
    if (!r.ok) return null;
    const q = ((await r.json()).series || {}).quarterly || {};
    const sps = q.salesPerShare || [];
    const eps = q.eps || q.epsBasicExclExtraItems || q.epsInclExtraItems || [];
    const byPeriod = {};
    for (const x of sps) if (x && x.period) (byPeriod[x.period] = byPeriod[x.period] || {}).sps = x.v;
    for (const x of eps) if (x && x.period) (byPeriod[x.period] = byPeriod[x.period] || {}).eps = x.v;
    const series = Object.keys(byPeriod).sort().map(period => ({ period, sps: byPeriod[period].sps ?? null, eps: byPeriod[period].eps ?? null }));
    return series.length ? series : null;
  } catch { return null; }
}

// YoY growth (%) of the latest vs 4-quarters-prior value in a {period,v}-like list.
function yoy(arr, key, n) {
  if (n < 4) return null;
  const a = arr[n][key], b = arr[n - 4][key];
  if (a == null || b == null || b === 0) return null;
  return +(((a / b) - 1) * 100).toFixed(1);
}
// YoY-of-YoY acceleration (percentage points). Needs ≥6 quarters.
function accel(arr, key, n) {
  if (n < 5) return null;
  const latest = yoyAt(arr, key, n), prior = yoyAt(arr, key, n - 1);
  if (latest == null || prior == null) return null;
  return +((latest - prior) * 100).toFixed(1);   // fractions → percentage points
}
function yoyAt(arr, key, i) {
  if (i < 4) return null;
  const a = arr[i][key], b = arr[i - 4][key];
  if (a == null || b == null || b === 0) return null;
  return (a / b) - 1;
}

// Point-in-time fundamentals as-of `asOf` (YYYY-MM-DD): only quarters reported
// (period + lag) on/before asOf are visible. Returns a fundamentals object shaped
// for ghost.pillarsOf (so the harness BONUS uses the SAME scoring as live), or null.
function pitFundamentals(series, asOf, lagDays = REPORT_LAG_DAYS) {
  if (!Array.isArray(series) || !series.length) return null;
  const visible = series.filter(q => addDays(q.period, lagDays) <= asOf);
  const n = visible.length - 1;
  if (n < 4) return null;                          // need ≥5 quarters for a YoY
  const revGrowth = yoy(visible, 'sps', n);
  const epsGrowth = yoy(visible, 'eps', n);
  const revAccel = accel(visible, 'sps', n);
  const epsAccel = accel(visible, 'eps', n);
  if (revGrowth == null && epsGrowth == null) return null;
  return { revGrowth, epsGrowth, revAccel, epsAccel };
}

module.exports = { fetchQuarterlySeries, pitFundamentals, REPORT_LAG_DAYS };
