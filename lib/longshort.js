// Long/short market-neutral test. Every result so far has been dominated by
// market beta (regime). This isolates SECURITY SELECTION: at each historical
// date, rank the cohort by the Apex composite, go long the top fraction and
// short the bottom fraction, and measure the forward 63-day spread (long − short).
// Both legs carry the same market beta, so it cancels — a positive, regime-robust
// spread means the composite genuinely separates winners from losers. If the
// spread also collapses in risk-off, then even the cross-sectional signal is beta.
const { fetchDailyHistory, screenTicker, smaAt } = require('./screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
const apex = require('./apex');

const MIN_HISTORY = 150, HOLD = 63;

function ranker(values) {
  const vals = values.filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
  return x => { if (x == null || isNaN(x) || !vals.length) return 0; let lo = 0, hi = vals.length; while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] <= x) lo = m + 1; else hi = m; } return Math.round((lo / vals.length) * 100); };
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
function spreadStats(arr) { // arr of per-date spreads (decimal)
  const n = arr.length; if (!n) return { n: 0 };
  const m = mean(arr), sd = Math.sqrt(mean(arr.map(x => (x - m) ** 2))) || 1e-9;
  return { n, meanPct: +(m * 100).toFixed(2), hitRate: Math.round((arr.filter(x => x > 0).length / n) * 100), tStat: +(m / (sd / Math.sqrt(n))).toFixed(2) };
}

async function runLongShort({ scope = 'large', step = 21, months = 54, range = '5y', fracs = [0.1, 0.2], limit = 0, deadlineMs = 50000 } = {}) {
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let tickers = [...new Set(list)]; if (limit > 0) tickers = tickers.slice(0, limit);
  const spy = await fetchDailyHistory('SPY', range); const sc = spy ? spy.candles : []; const scl = sc.map(x => x.close);
  const sbd = {}; sc.forEach(x => { sbd[x.date] = x.close; }); const sIdx = {}; sc.forEach((x, i) => { sIdx[x.date] = i; });
  const hist = new Map(); let fi = 0;
  const fw = async () => { while (fi < tickers.length) { const t = tickers[fi++]; try { const d = await fetchDailyHistory(t, range); if (d) hist.set(t, { candles: d.candles, meta: { ...d.meta, symbol: t } }); } catch {} } };
  await Promise.all(Array.from({ length: 16 }, fw));
  const span = Math.min(sc.length - 1, months * 21); const dates = [];
  for (let k = span; k >= HOLD; k -= step) dates.push(sc[sc.length - 1 - k].date);

  // Per fraction: arrays of per-date spreads, long-leg excess, short-leg excess, tagged with regime/quarter.
  const data = {}; fracs.forEach(f => { data[f] = { spreads: [], longEx: [], shortEx: [], byReg: {}, byQ: {} }; });
  const qOf = d => `${d.slice(0, 4)}-Q${Math.floor(+d.slice(5, 7) / 3 - 0.01) + 1}`;
  let datesUsed = 0;

  for (const date of dates) {
    if (Date.now() - t0 > deadlineMs) break;
    const cohort = [];
    for (const [t, { candles, meta }] of hist) {
      let idx = -1; for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= date) { idx = k; break; } }
      if (idx < MIN_HISTORY || candles.length - 1 - idx < HOLD) continue;
      const r = screenTicker(candles.slice(0, idx + 1), meta, { spyByDate: sbd });
      if (!r || !r.factors) continue;
      const fwd = (candles[idx + HOLD].close - candles[idx].close) / candles[idx].close;
      cohort.push({ r, fwd });
    }
    if (cohort.length < 40) continue;
    datesUsed++;
    const si = sIdx[date]; let a200 = null; if (si != null) { const s2 = smaAt(scl, 200, si); a200 = s2 != null ? scl[si] > s2 : null; }
    const breadth = Math.round((cohort.filter(x => x.r.above50).length / cohort.length) * 100);
    const regime = apex.rawRegime({ bearish: a200 === false || breadth < 40, riskOn: a200 === true && breadth >= 45 });
    const preset = apex.PRESETS[regime];
    const rk = {
      mom63: ranker(cohort.map(c => c.r.factors.mom63)), mom126: ranker(cohort.map(c => c.r.factors.mom126)),
      trend: ranker(cohort.map(c => c.r.factors.trendTemplate)), volAdj: ranker(cohort.map(c => c.r.factors.volAdjMom)),
      base: ranker(cohort.map(c => c.r.factors.baseQuality)), prox: ranker(cohort.map(c => c.r.factors.proximity)),
      accum: ranker(cohort.map(c => c.r.metrics.accumRatio)), ud: ranker(cohort.map(c => c.r.metrics.udVol)),
    };
    cohort.forEach(c => {
      const f = c.r.factors, m = c.r.metrics;
      const pct = { rs: rk.mom126(f.mom126), mom: Math.round((rk.mom63(f.mom63) + rk.mom126(f.mom126)) / 2), trend: rk.trend(f.trendTemplate), volAdj: rk.volAdj(f.volAdjMom), base: rk.base(f.baseQuality), prox: rk.prox(f.proximity), accum: rk.accum(m.accumRatio), ud: rk.ud(m.udVol) };
      c.score = apex.composite(apex.pillarsOf({ pct, narrativeStrength: null }), preset);
    });
    cohort.sort((a, b) => b.score - a.score);
    const cohMean = mean(cohort.map(c => c.fwd));
    for (const frac of fracs) {
      const k = Math.max(3, Math.floor(cohort.length * frac));
      const longRet = mean(cohort.slice(0, k).map(c => c.fwd));
      const shortRet = mean(cohort.slice(-k).map(c => c.fwd));
      const spread = longRet - shortRet;
      const d = data[frac];
      d.spreads.push(spread); d.longEx.push(longRet - cohMean); d.shortEx.push(cohMean - shortRet);
      (d.byReg[regime] = d.byReg[regime] || []).push(spread);
      (d.byQ[qOf(date)] = d.byQ[qOf(date)] || []).push(spread);
    }
  }

  const out = { scope, range, datesUsed, elapsedMs: Date.now() - t0, hold: HOLD, fractions: {} };
  for (const frac of fracs) {
    const d = data[frac];
    out.fractions[frac] = {
      overall: { ...spreadStats(d.spreads), longExcessPct: +(mean(d.longEx) * 100).toFixed(2), shortExcessPct: +(mean(d.shortEx) * 100).toFixed(2) },
      byRegime: Object.fromEntries(Object.entries(d.byReg).filter(([, a]) => a.length >= 5).map(([R, a]) => [R, spreadStats(a)])),
      byQuarter: Object.keys(d.byQ).sort().filter(q => d.byQ[q].length >= 2).map(q => ({ quarter: q, ...spreadStats(d.byQ[q]) })),
    };
  }
  return out;
}

module.exports = { runLongShort };
