// PER-SECTION CONVICTION RECONSTRUCTION — the FAITHFUL cross-sectional score. Instead of
// scoring every pick with one generic momentum proxy (lib/pickscore uscore-v1), this
// reconstructs each pick's conviction with ITS OWN SECTION'S REAL SCORER, run on the
// point-in-time candles the Scoreboard already fetched:
//   • screener (Breakout) → lib/apex.scoreCandidate  (the real 4-pillar Apex composite)
//   • Ghost               → lib/ghost.scoreGhost      (the real 6-pillar accumulation score)
// Both consume the SAME factor set (rs/mom/trend/base/prox/accum/ud/volAdj/vol) that
// lib/screener.screenTicker produces from candles — so we reconstruct the exact factor
// vector as-of each pick's date, percentile-rank it CROSS-SECTIONALLY across the pick
// cohort (the `c.pct` shape apex/ghost expect), and run the section's own scorer.
//
// Sections with no candle-reconstructable scorer (CERN, Read-Through, Anomaly, Tone,
// Biotech catalyst, momentum's proprietary read, …) fall back to the uniform momentum
// proxy — each pick is TAGGED with the method used, so the board is honest about fidelity.
//
// HONEST caveat: the percentile reference is the logged-pick cohort, not the full daily
// universe the live screener ranked against — so absolute scores differ from what showed
// live, but the FACTOR SET, PILLAR STRUCTURE and WEIGHTS are each section's real model.
//
// Pure (candles + picks in → scores out) → unit-testable, no network.

'use strict';

const apex = require('./apex');
const ghost = require('./ghost');
const { calcEMA, calcRSI, calcMACD, calcAvgVolume, calcVWAP, calcATR, buildLiveSignal } = require('./signal');
const daytrade = require('./daytrade');
const coil = require('./coil');
const { screenTicker } = require('./screener');

const SECTIONSCORE_VERSION = 'conviction-v1';

// section → which real scorer reconstructs it. Everything else = proxy fallback.
//   apex/ghost   — pct-based: need the cohort's cross-sectional factor percentiles.
//   momentum     — signal.buildLiveSignal composite (EMA/VWAP/MACD/RSI/volume), self-contained.
//   daytrade     — daytrade.rankScore(dayMetrics()) burst score, self-contained.
//   coil         — coil.scoreCohort() cross-sectional z-score of compression features.
const RECON = { screener: 'apex', Ghost: 'ghost', momentum: 'momentum', daytrade: 'daytrade', coil: 'coil' };
// Which scorers score each name on its own (no cohort percentile needed).
const SELF_CONTAINED = new Set(['momentum', 'daytrade']);

function idxAsOf(candles, date) {
  let i = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= date) i = k; else break; }
  return i;
}

// Percentile-rank an array of (possibly null) numbers → 0-100 (average-rank; ties share;
// nulls map to 50 = neutral so a missing factor neither helps nor hurts).
function rankPct(values) {
  const present = values.map((v, i) => [v, i]).filter(x => x[0] != null && Number.isFinite(x[0]));
  const out = values.map(() => 50);
  const n = present.length;
  if (n <= 1) return out;
  present.sort((a, b) => a[0] - b[0]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && present[j + 1][0] === present[i][0]) j++;
    const p = Math.round(((i + j) / 2 / (n - 1)) * 100);
    for (let k = i; k <= j; k++) out[present[k][1]] = p;
    i = j + 1;
  }
  return out;
}

// Reconstruct one pick's raw point-in-time factor vector via the real screener engine.
// Returns { f (factors), m (metrics), status } or null when there isn't enough history.
function factorsFor(candles, date, ticker, spyByDate) {
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const idx = idxAsOf(candles, date);
  if (idx < 55) return null;
  let r;
  try { r = screenTicker(candles.slice(0, idx + 1), { symbol: ticker }, spyByDate ? { spyByDate } : {}); }
  catch { return null; }
  if (!r || !r.factors) return null;
  return { f: r.factors, m: r.metrics || {}, status: r.status };
}

// macro regime bucket → the label each scorer expects.
const apexRegime = b => (b === 'risk-off' ? 'RISK_OFF' : b === 'risk-on' ? 'RISK_ON' : 'NEUTRAL');

// Momentum conviction — the REAL momentum scorer (lib/signal.buildLiveSignal: stacked-EMA
// + VWAP + MACD + RSI + volume composite, the same one api/momentum classifies StrongBuy/
// Sell with) reconstructed as-of the pick date from the same indicators analyze() builds.
// Directional: a StrongSell pick's conviction is the negated score (strong short = weak tape).
function momentumScore(candles, pick) {
  if (!Array.isArray(candles)) return null;
  const idx = idxAsOf(candles, pick.date);
  if (idx < 50) return null;              // need a real trend read (EMA50)
  const slice = candles.slice(0, idx + 1);
  let live;
  try {
    const closes = slice.map(c => c.close);
    const volumes = slice.map(c => c.volume);
    const ema9 = calcEMA(closes, 9), ema21 = calcEMA(closes, 21), ema50 = calcEMA(closes, 50);
    const rsi = calcRSI(closes, 14), macd = calcMACD(closes), avgVol = calcAvgVolume(volumes, 20);
    const vwap = calcVWAP(slice), atr = calcATR(slice, 14);
    live = buildLiveSignal(slice, ema9, ema21, ema50, vwap, rsi, macd, avgVol, atr, closes[closes.length - 1]);
  } catch { return null; }
  if (!live || !Number.isFinite(live.score)) return null;
  const dir = (pick.tier === 'StrongSell' || pick.short) ? -1 : 1;
  return dir * live.score;
}

// Day-trade conviction — the REAL intraday ranker (relVol·10 + %change + gap·0.5) on the
// reconstructed daily bar as-of the pick date. Long-biased (intraday continuation).
function daytradeScore(candles, pick) {
  if (!Array.isArray(candles)) return null;
  const idx = idxAsOf(candles, pick.date);
  if (idx < 21) return null;
  let m;
  try { m = daytrade.dayMetrics(candles.slice(0, idx + 1), null); } catch { return null; }
  if (!m) return null;
  const rs = daytrade.rankScore(m);
  return Number.isFinite(rs) ? rs : null;
}

// Reconstruct per-section conviction for a batch of picks.
//   picks: [{ ticker, date, section, regime }]
//   opts.candlesFor(ticker) → candles | undefined
//   opts.spyByDate: { 'YYYY-MM-DD': spyClose }  (optional; enables the RS factor)
//   opts.proxyScore(i) → 0-100 uniform-proxy score for pick i (fallback)
// Returns an array aligned to `picks`: { score: 0-100|null, method, section }.
function reconstruct(picks, opts = {}) {
  const { candlesFor, spyByDate, proxyScore } = opts;
  const out = (picks || []).map(p => ({ score: null, method: 'none', section: p.section }));
  const hasCandles = typeof candlesFor === 'function';

  // ── Self-contained scorers (momentum / daytrade): each name scores on its own, so
  // no cohort percentile is needed — reconstruct the score directly per pick.
  (picks || []).forEach((p, i) => {
    const scorer = RECON[p.section];
    if (!SELF_CONTAINED.has(scorer) || !hasCandles) return;
    const candles = candlesFor(p.ticker);
    if (!candles) return;
    const s = scorer === 'momentum' ? momentumScore(candles, p) : daytradeScore(candles, p);
    if (s != null && Number.isFinite(s)) out[i] = { score: +s.toFixed(2), method: scorer, section: p.section };
  });

  // ── pct-based scorers (apex / ghost): need the cohort's cross-sectional factor
  // percentiles, so gather every reconstructable pick's factors first.
  const rows = (picks || []).map((p, i) => {
    const scorer = RECON[p.section];
    if (scorer !== 'apex' && scorer !== 'ghost' || !hasCandles) return { i, scorer: null, p };
    const candles = candlesFor(p.ticker);
    const fac = candles ? factorsFor(candles, p.date, p.ticker, spyByDate) : null;
    return { i, scorer, fac, p };
  });
  const scoreable = rows.filter(x => x.scorer && x.fac);

  // Cross-sectional percentiles of each factor across the reconstructable cohort — the
  // `c.pct` shape apex/ghost pillarsOf() read. Mirrors lib/backfill's construction.
  const col = fn => rankPct(scoreable.map(x => fn(x.fac.f, x.fac.m)));
  const pMom63 = col(f => f.mom63);
  const pMom126 = col(f => f.mom126);
  const pTrend = col(f => f.trendTemplate);
  const pVolAdj = col(f => f.volAdjMom);
  const pBase = col(f => f.baseQuality);
  const pVol = col(f => f.volSurge);
  const pProx = col(f => f.proximity);
  const pAccum = col((f, m) => m.accumRatio);
  const pUd = col((f, m) => m.udVol);
  scoreable.forEach((x, k) => {
    x.pct = {
      rs: pMom126[k], mom: Math.round((pMom63[k] + pMom126[k]) / 2),
      trend: pTrend[k], volAdj: pVolAdj[k], base: pBase[k], vol: pVol[k],
      prox: pProx[k], accum: pAccum[k], ud: pUd[k],
    };
  });

  for (const x of scoreable) {
    if (x.scorer === 'apex') {
      const s = apex.scoreCandidate({ pct: x.pct, narrativeStrength: null, status: x.fac.status || 'Breakout' }, apexRegime(x.p.regime));
      out[x.i] = { score: s.score, method: 'apex', section: x.p.section };
    } else {
      const s = ghost.scoreGhost({ pct: x.pct, insider: null, fundamentals: null }, x.p.regime || 'neutral');
      out[x.i] = { score: s.score, method: 'ghost', section: x.p.section };
    }
  }
  // ── Coil (Bollinger-squeeze-rank): its OWN cross-sectional scorer — reconstruct each
  // coil pick's point-in-time compression features, then z-score them across the coil
  // cohort exactly as the live ranker does (coil.scoreCohort). Higher = more coiled.
  const coilRows = [];
  (picks || []).forEach((p, i) => {
    if (RECON[p.section] !== 'coil' || !hasCandles) return;
    const candles = candlesFor(p.ticker);
    const idx = candles ? idxAsOf(candles, p.date) : -1;
    const feats = (candles && idx >= 60) ? coil.coilFeatures(candles.slice(0, idx + 1)) : null;
    coilRows.push({ i, feats });
  });
  if (coilRows.length) {
    const scores = coil.scoreCohort(coilRows.map(r => r.feats));
    coilRows.forEach((r, k) => {
      if (r.feats && Number.isFinite(scores[k])) out[r.i] = { score: +scores[k].toFixed(3), method: 'coil', section: picks[r.i].section };
    });
  }

  // Proxy fallback for every pick a real scorer couldn't reconstruct.
  if (typeof proxyScore === 'function') {
    out.forEach((o, i) => {
      if (o.method === 'none') {
        const ps = proxyScore(i);
        if (ps != null && Number.isFinite(ps)) out[i] = { score: ps, method: 'proxy', section: picks[i].section };
      }
    });
  }
  return out;
}

module.exports = { SECTIONSCORE_VERSION, RECON, SELF_CONTAINED, reconstruct, rankPct, factorsFor, momentumScore, daytradeScore, idxAsOf, apexRegime };
