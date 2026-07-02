// Edge-discovery research engine. Builds a point-in-time LABELED dataset — every
// setup candidate (status != null) across history, with a BROAD factor vector
// (including factors NOT currently in the pillars: RSI, ADR, base length,
// accumulation, VCP count, distance-from-high) and its realized forward outcome
// (resolveTrade against the card's own levels). Then measures which factors
// actually separate winners from losers, via rank-IC and quintile win/PF.
//
// This is honest edge-hunting: if a factor shows a monotonic quintile win-rate
// gradient and a non-trivial rank-IC, it carries signal worth gating on. If
// nothing does, that's a real (if unwelcome) finding.
const { fetchDailyHistory, screenTicker, smaAt } = require('./screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
const { MAX_HOLD } = require('./outcome');
const { buildMacroLookup } = require('./macro');
const apex = require('./apex');

const MIN_HISTORY = 150;

// Factors to test — pulled from screenTicker's factors + metrics. Several of
// these are NOT in the Apex pillars, which is the point (find new edge).
const FACTORS = [
  ['mom21', 'Momentum 1mo', r => r.factors.mom21],
  ['mom63', 'Momentum 3mo', r => r.factors.mom63],
  ['mom126', 'Momentum 6mo', r => r.factors.mom126],
  ['volAdjMom', 'Vol-adj momentum', r => r.factors.volAdjMom],
  ['trendTemplate', 'Trend template', r => r.factors.trendTemplate],
  ['proximity', 'Proximity to 52w high', r => r.factors.proximity],
  ['baseQuality', 'Base quality', r => r.factors.baseQuality],
  ['volSurge', 'Volume surge', r => r.factors.volSurge],
  ['rsi', 'RSI (14)', r => r.metrics.rsi],
  ['adrPct', 'ADR % (volatility)', r => r.metrics.adrPct],
  ['baseWeeks', 'Base length (wks)', r => r.metrics.baseWeeks],
  ['accumRatio', 'Accumulation ratio', r => r.metrics.accumRatio],
  ['udVol', 'Up/Down volume', r => r.metrics.udVol],
  ['vdu', 'Volume dry-up %', r => r.metrics.vdu],
  ['pctFrom52wHigh', '% from 52w high', r => r.metrics.pctFrom52wHigh],
  ['vcpContractions', 'VCP contractions', r => r.metrics.vcpContractions],
];

function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(arr.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++; const avg = (i + j - 1) / 2 + 1; for (let k = i; k < j; k++) out[idx[k][1]] = avg; i = j; }
  return out;
}
function pearson(a, b) {
  const n = a.length; if (n < 2) return 0;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
}
function aggOutcome(rows) {
  const n = rows.length, wins = rows.filter(r => r.won).length;
  let w = 0, l = 0; rows.forEach(r => { if (r.r > 0) w += r.r; else l += Math.abs(r.r); });
  return { n, winRate: n ? Math.round((wins / n) * 100) : null, pf: l > 0 ? +(w / l).toFixed(2) : (w > 0 ? 99 : 0), avgR: n ? +((rows.reduce((a, r) => a + r.r, 0) / n) * 100).toFixed(2) : null };
}

// Per-factor: rank-IC vs realized return + quintile outcome gradient + monotonicity.
function factorReport(records, getVal) {
  const pairs = records.map(r => [getVal(r), r]).filter(p => p[0] != null && !isNaN(p[0]));
  if (pairs.length < 60) return null;
  const ic = pearson(ranks(pairs.map(p => p[0])), ranks(pairs.map(p => p[1].r)));
  pairs.sort((a, b) => a[0] - b[0]);
  const q = 5, quints = [];
  for (let i = 0; i < q; i++) {
    const seg = pairs.slice(Math.floor((pairs.length * i) / q), Math.floor((pairs.length * (i + 1)) / q)).map(p => p[1]);
    quints.push({ q: i + 1, ...aggOutcome(seg) });
  }
  const wr = quints.map(x => x.winRate);
  const spread = wr[wr.length - 1] - wr[0]; // top-quintile minus bottom-quintile win rate
  let mono = true; for (let i = 1; i < wr.length; i++) if (wr[i] < wr[i - 1]) { mono = false; break; }
  let monoDesc = true; for (let i = 1; i < wr.length; i++) if (wr[i] > wr[i - 1]) { monoDesc = false; break; }
  return { n: pairs.length, rankIC: +ic.toFixed(3), winRateSpread: spread, monotonic: mono || monoDesc, quintiles: quints };
}

async function runResearch({ scope = 'large', step = 10, months = 12, limit = 0, deadlineMs = 50000 } = {}) {
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let tickers = [...new Set(list)];
  if (limit > 0) tickers = tickers.slice(0, limit);

  // Point-in-time macro (VIX + credit) so the per-regime breakdown matches the
  // LIVE regime blend (SPY/breadth OR macro-risk-off), not SPY-200DMA alone.
  const macroLookup = await buildMacroLookup('2y').catch(() => null);
  const spy = await fetchDailyHistory('SPY', '2y');
  const spyCandles = spy ? spy.candles : [];
  const spyCloses = spyCandles.map(x => x.close);
  const spyByDate = {}; spyCandles.forEach(x => { spyByDate[x.date] = x.close; });
  const spyIdxOf = {}; spyCandles.forEach((x, i) => { spyIdxOf[x.date] = i; });

  const hist = new Map();
  let fi = 0;
  const fworker = async () => { while (fi < tickers.length) { const t = tickers[fi++]; try { const d = await fetchDailyHistory(t, '2y'); if (d) hist.set(t, { candles: d.candles, meta: { ...d.meta, symbol: t } }); } catch {} } };
  await Promise.all(Array.from({ length: 16 }, fworker));

  const span = Math.min(spyCandles.length - 1, months * 21);
  const dates = [];
  for (let k = span; k >= MAX_HOLD; k -= step) dates.push(spyCandles[spyCandles.length - 1 - k].date);

  const records = [];                 // every scanned name, with factors + forward-return label
  const byRegime = {};
  let screenCalls = 0, stoppedEarly = false;

  for (const date of dates) {
    if (Date.now() - t0 > deadlineMs) { stoppedEarly = true; break; }
    const cohort = [];
    for (const [t, { candles, meta }] of hist) {
      let idx = -1;
      for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= date) { idx = k; break; } }
      if (idx < MIN_HISTORY || candles.length - 1 - idx < MAX_HOLD) continue;
      const r = screenTicker(candles.slice(0, idx + 1), meta, { spyByDate });
      screenCalls++;
      if (!r || !r.factors) continue;
      cohort.push({ t, idx, candles, r });
    }
    if (cohort.length < 20) continue;
    const si = spyIdxOf[date];
    let above200 = null;
    if (si != null) { const s200 = smaAt(spyCloses, 200, si); above200 = s200 != null ? spyCloses[si] > s200 : null; }
    const breadth = Math.round((cohort.filter(x => x.r.above50).length / cohort.length) * 100);
    const mac = macroLookup ? macroLookup.at(date) : null;
    const regime = apex.rawRegime({
      bearish: above200 === false || breadth < 40 || !!(mac && mac.riskOff),
      riskOn: above200 === true && breadth >= 45 && (!mac || mac.riskOn),
    });
    // Cross-sectional excess return — strip out the cohort's average drift so the
    // study measures DIFFERENTIATION (alpha), not the market's beta on the day.
    const cohortRets = cohort.map(c => (c.candles[c.idx + MAX_HOLD].close - c.candles[c.idx].close) / c.candles[c.idx].close);
    const mean = cohortRets.reduce((a, b) => a + b, 0) / cohortRets.length;

    cohort.forEach((c, i) => {
      const r = cohortRets[i] - mean; // excess (cross-sectional) forward return
      const rec = { factors: c.r.factors, metrics: c.r.metrics, status: c.r.status, regime, r, won: r > 0 };
      records.push(rec);
      (byRegime[regime] = byRegime[regime] || []).push(rec);
    });
  }

  const factors = FACTORS.map(([key, label, getVal]) => ({ key, label, ...(factorReport(records, getVal) || { n: 0 }) }))
    .filter(f => f.n >= 60)
    .sort((a, b) => Math.abs(b.rankIC) - Math.abs(a.rankIC));

  const byRegimeReport = Object.entries(byRegime).map(([regime, rows]) => ({ regime, ...aggOutcome(rows) }))
    .filter(x => x.n >= 30).sort((a, b) => b.n - a.n);

  return {
    n: records.length, screenCalls, stoppedEarly, elapsedMs: Date.now() - t0,
    macroEnabled: !!macroLookup,
    note: 'outcome = cross-sectional (excess) forward return over 63 sessions; winRate = % beating cohort average',
    factors,
    byRegime: byRegimeReport,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runResearch };
