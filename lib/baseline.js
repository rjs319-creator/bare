// BASELINE READER — turns the daily options+attention archive (archive/<date>.json,
// read via store.readAllArchive) into a per-ticker picture of what's NORMAL, so the
// options-flow and attention signals can flag TODAY as unusual relative to a name's
// own recent history. The archive was collecting this data since June but nothing
// consumed it; this is the missing consumer.
//
// Method (deliberately simple): for each ticker+metric, take its chronological series
// across archived days, hold out the most recent observation, compute mean/sd over the
// PRIOR observations, then z-score the latest value against that baseline. A name is
// "unusual" when it has enough prior history (minObs) and |z| clears the threshold.
// Holding out the latest keeps today's spike from inflating its own baseline.

// The metrics we baseline. Each pulls one number off an archive record.
const METRICS = [
  { key: 'mentions', label: 'StockTwits mentions',    get: r => num(r.mentions) },
  { key: 'optVol',   label: 'Total option volume',    get: r => r.options && num(r.options.totalVol) },
  { key: 'atmIV',    label: 'ATM implied volatility',  get: r => r.options && num(r.options.atmIV) },
  { key: 'pcVol',    label: 'Put/call volume ratio',   get: r => r.options && num(r.options.pcVolRatio) },
];

function num(v) { return (v == null || typeof v !== 'number' || !isFinite(v)) ? null : v; }

// Population mean + standard deviation of a numeric series.
function stats(series) {
  const n = series.length;
  if (!n) return { n: 0, mean: null, sd: null };
  const mean = series.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(series.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
  return { n, mean: +mean.toFixed(4), sd: +sd.toFixed(4) };
}

/**
 * @param {{date:string, records:Array}[]} days  readAllArchive() output (any order)
 * @param {{minObs?:number, z?:number, window?:number}} [opts]
 *   minObs — min prior observations required to score a metric (default 8)
 *   z      — |z-score| at/above which "today" is flagged unusual (default 2)
 *   window — only use the most recent `window` archived days (default 60)
 * @returns {{asOf, days, minObs, zThreshold, tickers, unusual}}
 */
function computeBaselines(days, { minObs = 8, z = 2, window = 60 } = {}) {
  const sorted = (Array.isArray(days) ? days : [])
    .filter(d => d && d.date && Array.isArray(d.records))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!sorted.length) return { asOf: null, days: 0, minObs, zThreshold: z, tickers: {}, unusual: [] };

  const trimmed = sorted.slice(-window);
  const asOf = trimmed[trimmed.length - 1].date;

  // Build per-ticker, per-metric chronological series of { date, v }.
  const byTicker = new Map();
  for (const day of trimmed) {
    for (const r of day.records) {
      const t = String(r && r.ticker || '').toUpperCase();
      if (!t) continue;
      let m = byTicker.get(t);
      if (!m) { m = {}; byTicker.set(t, m); }
      for (const met of METRICS) {
        const v = met.get(r);
        if (v != null) (m[met.key] ??= []).push({ date: day.date, v });
      }
    }
  }

  const tickers = {}; const unusual = [];
  for (const [t, mets] of byTicker) {
    const out = {};
    for (const met of METRICS) {
      const series = mets[met.key];
      if (!series || !series.length) continue;
      const latest = series[series.length - 1];
      const prior = series.slice(0, -1).map(x => x.v);
      const s = stats(prior);
      // Only score names whose latest observation is the most recent archived day
      // (a genuine "today" reading) and that have enough prior history.
      if (latest.date !== asOf || s.n < minObs || s.sd == null) {
        out[met.key] = { latest: latest.v, n: s.n, scored: false };
        continue;
      }
      const zScore = s.sd > 0 ? +((latest.v - s.mean) / s.sd).toFixed(2) : 0;
      const pctile = +((prior.filter(v => v <= latest.v).length / s.n) * 100).toFixed(0);
      const rec = { latest: latest.v, mean: s.mean, sd: s.sd, n: s.n, z: zScore, pctile, scored: true };
      out[met.key] = rec;
      if (Math.abs(zScore) >= z) {
        unusual.push({ ticker: t, metric: met.key, label: met.label, direction: zScore > 0 ? 'high' : 'low', ...rec });
      }
    }
    tickers[t] = out;
  }
  unusual.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return { asOf, days: trimmed.length, minObs, zThreshold: z, tickers, unusual };
}

module.exports = { computeBaselines, stats, METRICS };
