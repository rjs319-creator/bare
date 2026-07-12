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
const { screenTicker } = require('./screener');

const SECTIONSCORE_VERSION = 'conviction-v1';

// section → which real scorer reconstructs it. Everything else = proxy fallback.
const RECON = { screener: 'apex', Ghost: 'ghost' };

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

// Reconstruct per-section conviction for a batch of picks.
//   picks: [{ ticker, date, section, regime }]
//   opts.candlesFor(ticker) → candles | undefined
//   opts.spyByDate: { 'YYYY-MM-DD': spyClose }  (optional; enables the RS factor)
//   opts.proxyScore(i) → 0-100 uniform-proxy score for pick i (fallback)
// Returns an array aligned to `picks`: { score: 0-100|null, method, section }.
function reconstruct(picks, opts = {}) {
  const { candlesFor, spyByDate, proxyScore } = opts;
  const rows = (picks || []).map((p, i) => {
    const scorer = RECON[p.section];
    if (!scorer || typeof candlesFor !== 'function') return { i, scorer: null, p };
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

  const out = (picks || []).map(p => ({ score: null, method: 'none', section: p.section }));
  for (const x of scoreable) {
    if (x.scorer === 'apex') {
      const s = apex.scoreCandidate({ pct: x.pct, narrativeStrength: null, status: x.fac.status || 'Breakout' }, apexRegime(x.p.regime));
      out[x.i] = { score: s.score, method: 'apex', section: x.p.section };
    } else {
      const s = ghost.scoreGhost({ pct: x.pct, insider: null, fundamentals: null }, x.p.regime || 'neutral');
      out[x.i] = { score: s.score, method: 'ghost', section: x.p.section };
    }
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

module.exports = { SECTIONSCORE_VERSION, RECON, reconstruct, rankPct, factorsFor, idxAsOf, apexRegime };
