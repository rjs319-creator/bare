'use strict';
// FACTOR-ADJUSTED SCOREBOARD ALPHA (factor-alpha-v1) — proposal #18, weight-0 SHADOW.
//
// "Beats the market" on the Scoreboard is excess vs SPY: implicitly a one-factor model
// with β_mkt pinned at 1. This block relaxes that: for every lane × horizon, the lane's
// DATE-LEVEL equal-weight cost-net forward return is regressed on the factor returns
// over the SAME windows —
//     Fama-French 5 + MOM (minus RF on the left-hand side)   when French data covers the window,
//     style-ETF proxies (lib/factors/etf-proxies.js)          for the live, not-yet-published month —
// with ridge shrinkage (betas over ~60–200 dates on correlated factors are unstable),
// an n ≥ 60 date guard, and a HAC (Newey-West) t-statistic on the intercept. `alphaFF`
// is that intercept, in percent per window, next to `excessSPY`.
//
// It lives in a SIBLING block of scoreboard/summary.json (`factorAlpha`), never inside
// `groups`: evidenceHash is hashed over groups only, so a field added there would
// invalidate every version-matched promotion artifact. The preregistered gate
// ("alphaFF ≥ 0 with q ≤ 0.10") runs in shadow for 6 months; the proxy fit is only
// trusted for a live column once its betas correlate > 0.8 with the FF betas on the
// windows both cover — computed and persisted here as `proxyBetaCorrelation`.
const FM = require('../orbit-factor-model');
const HAC = require('./hac');
const EP = require('./etf-proxies');
const S3 = require('../research/stats-v3');
const ES = require('../evidence-stats');
const M = require('../orbit-math');

const FACTOR_ALPHA_VERSION = 'factor-alpha-v1';
const HYPOTHESIS_ID = 'factor-adjusted-scoreboard-alpha';
const MIN_DATES = 60;                       // independent decision dates per lane × horizon
const RIDGE_LAMBDA = 1.0;                   // in standardised factor space (orbit-factor-model)
const BETA_CAP = 10;                        // multi-session windows can carry |β| > ORBIT's 3.5 daily cap
const FDR_ALPHA = 0.10;
const PROXY_CORRELATION_THRESHOLD = 0.8;
const MIN_CORRELATION_PAIRS = 10;           // 2 lanes × 5 mapped factors — below this r is noise
const SHADOW_UNTIL = '2027-04-02';          // 6 months from registration (2026-10-02)
const FF_KEYS = EP.FF_KEYS;
const PROXY_KEYS = EP.PROXY_KEYS;

const round = (v, d) => (Number.isFinite(v) ? +v.toFixed(d) : null);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// One equal-weight observation per decision date: y = mean cost-net return (minus the RF
// window return for the FF source), f = mean factor window returns. A pick missing its
// value or ANY requested factor is dropped (no zero-filling).
function dateLevelFactorRows(rows, { source, factorKeys, pickValue = (r) => r.net } = {}) {
  const byDate = new Map();
  for (const r of rows || []) {
    const fx = r && r.fx && r.fx[source];
    const v = r && pickValue(r);
    if (!fx || !Number.isFinite(v)) continue;
    if (factorKeys.some(k => !Number.isFinite(fx[k]))) continue;
    const rf = source === 'ff' && Number.isFinite(fx.rf) ? fx.rf : 0;
    const bucket = byDate.get(r.date) || { ys: [], fs: Object.fromEntries(factorKeys.map(k => [k, []])) };
    byDate.set(r.date, {
      ys: [...bucket.ys, v - rf],
      fs: Object.fromEntries(factorKeys.map(k => [k, [...bucket.fs[k], fx[k]]])),
    });
  }
  return [...byDate.keys()].sort().map(date => {
    const b = byDate.get(date);
    return { date, y: mean(b.ys), f: Object.fromEntries(factorKeys.map(k => [k, mean(b.fs[k])])), picks: b.ys.length };
  });
}

function insufficientCell(n, minN, extra = {}) {
  return { insufficient: true, reason: `${n} usable dates < ${minN}`, n, alpha: null, se: null, t: null, p: null, q: null, betas: null, ...extra };
}

// Ridge fit + HAC inference on the intercept for one date-level series.
function fitFactorAlpha(dateRows, factorKeys, { horizonBars = null, lambda = RIDGE_LAMBDA, minN = MIN_DATES } = {}) {
  const n = dateRows.length;
  if (n < minN) return insufficientCell(n, minN);
  const y = dateRows.map(r => r.y);
  const factors = Object.fromEntries(factorKeys.map(k => [k, dateRows.map(r => r.f[k])]));
  const fit = FM.residualWindow(y, factors, { factorKeys, window: n, minObs: minN, lambda, betaCap: BETA_CAP });
  if (!fit.sufficient) return { ...insufficientCell(n, minN), reason: fit.reason };
  const used = fit.factorsUsed;
  const X = fit.residualIdx.map(i => [1, ...used.map(k => factors[k][i])]);
  const coefs = [fit.exposures.alpha, ...used.map(k => fit.exposures[k])];
  const lags = HAC.defaultLags(n, horizonBars);
  const { se, t } = HAC.hacTStats(coefs, X, fit.residuals, { lags });
  const df = Math.max(1, n - used.length - 1);
  const alpha = coefs[0], seA = se[0], tA = t[0];
  const p = Number.isFinite(tA) ? S3.pFromT(tA, df) : null;
  const tCrit = ES.tCritical95(df);
  const ci95 = Number.isFinite(seA) ? { lo: alpha - tCrit * seA, hi: alpha + tCrit * seA } : null;
  return {
    n, alpha: round(alpha, 2), se: round(seA, 4), t: round(tA, 2), p: round(p, 4), q: null,
    betas: Object.fromEntries(used.map((k, i) => [k, round(coefs[i + 1], 4)])),
    r2: fit.r2, hacLags: lags, df, lambda, factorsUsed: used,
    ci95: ci95 ? { lo: round(ci95.lo, 2), hi: round(ci95.hi, 2) } : null,
    // Full-precision copies (evidence-stats v2 convention): gates compute on these, the
    // rounded fields above are display values.
    exact: { alpha, se: seA, t: tA, p, ci95 },
  };
}

function cellFor(rows, horizonBars) {
  const ffRows = dateLevelFactorRows(rows, { source: 'ff', factorKeys: FF_KEYS });
  const pxRows = dateLevelFactorRows(rows, { source: 'proxy', factorKeys: PROXY_KEYS });
  const ffFit = fitFactorAlpha(ffRows, FF_KEYS, { horizonBars });
  const pxFit = fitFactorAlpha(pxRows, PROXY_KEYS, { horizonBars });
  const meta = { ffDates: ffRows.length, proxyDates: pxRows.length };
  if (!ffFit.insufficient) return { ...ffFit, source: 'ff', ...meta, proxy: pxFit.insufficient ? null : pxFit };
  if (!pxFit.insufficient) return { ...pxFit, source: 'proxy', ...meta, proxy: null };
  return { ...insufficientCell(Math.max(ffRows.length, pxRows.length), MIN_DATES), source: null, ...meta, proxy: null };
}

// Pearson r between proxy betas and the FF betas they stand in for, pooled over every
// cell where both fits exist. The threshold the live column must clear.
function proxyBetaCorrelation(cells) {
  const a = [], b = [];
  for (const c of cells) {
    if (!c || c.source !== 'ff' || !c.proxy || !c.proxy.betas) continue;
    for (const k of PROXY_KEYS) {
      const pb = c.proxy.betas[k], fb = c.betas[EP.PROXY_TO_FF[k]];
      if (Number.isFinite(pb) && Number.isFinite(fb)) { a.push(pb); b.push(fb); }
    }
  }
  const r = a.length >= 3 ? M.pearson(a, b) : null;
  return { r: round(r, 3), pairs: a.length, threshold: PROXY_CORRELATION_THRESHOLD, minPairs: MIN_CORRELATION_PAIRS, passes: Number.isFinite(r) && a.length >= MIN_CORRELATION_PAIRS && r > PROXY_CORRELATION_THRESHOLD };
}

function attachFdr(cellsById) {
  const items = [...cellsById.entries()].map(([id, c]) => ({ id, p: c.exact ? c.exact.p : null }));
  const { benjaminiHochberg } = require('../research/hypothesis-registry');
  for (const row of benjaminiHochberg(items)) {
    const c = cellsById.get(row.id);
    if (!c || row.q == null) continue;
    c.q = round(row.q, 4);
    c.exact.q = row.q;
    c.passesGate = c.exact.alpha >= 0 && row.q <= FDR_ALPHA;
  }
}

// `groups` = apex-routes' internal map { 'section:tier:scope' → { section, tier, scope, h: { hk: rows } } },
// rows carrying `fx` from etf-proxies.factorWindowReturns. `horizons` = [[hk, bars], …].
function buildFactorAlphaBlock(groups, horizons, { ff = {} } = {}) {
  const out = {};
  const cellsById = new Map();
  let fitted = 0, cells = 0;
  for (const [gkey, g] of Object.entries(groups || {})) {
    const perH = {};
    for (const [hk, bars] of horizons) {
      const rows = (g.h && g.h[hk]) || [];
      if (!rows.length) continue;                 // no graded rows yet → no cell (the UI shows —)
      const cell = cellFor(rows, bars);
      cells++;
      if (!cell.insufficient) { fitted++; cellsById.set(`${gkey}|${hk}`, cell); }
      perH[hk] = cell;
    }
    out[gkey] = perH;
  }
  attachFdr(cellsById);
  return {
    version: FACTOR_ALPHA_VERSION, hypothesisId: HYPOTHESIS_ID, state: 'SHADOW', weight: 0,
    basis: 'date-level equal-weight cost-net forward return (minus the RF window return for the French source) regressed on factor window returns over the SAME graded window; ridge λ=1 in standardised factor space with an unpenalised intercept; alphaFF = intercept in % per window; HAC (Bartlett, lags = horizonBars−1) standard error; Student-t p at df = dates − factors − 1',
    gate: { rule: `alphaFF ≥ 0 with Benjamini-Hochberg q ≤ ${FDR_ALPHA} across every lane × horizon cell; shadow (affects no grade, weight 0) until ${SHADOW_UNTIL}`, fdrAlpha: FDR_ALPHA, minDates: MIN_DATES, shadowUntil: SHADOW_UNTIL },
    ff: { available: !!ff.available, lastDate: ff.lastDate || null, lagDays: Number.isFinite(ff.lagDays) ? ff.lagDays : null, stale: !!ff.stale, factors: [...FF_KEYS] },
    proxies: Object.fromEntries(PROXY_KEYS.map(k => [k, EP.PROXY_FACTORS[k].short ? `${EP.PROXY_FACTORS[k].long}−${EP.PROXY_FACTORS[k].short}` : EP.PROXY_FACTORS[k].long])),
    cells, fitted,
    proxyBetaCorrelation: proxyBetaCorrelation([...cellsById.values()]),
    groups: out,
  };
}

module.exports = {
  FACTOR_ALPHA_VERSION, HYPOTHESIS_ID, MIN_DATES, RIDGE_LAMBDA, FDR_ALPHA, PROXY_CORRELATION_THRESHOLD, SHADOW_UNTIL, FF_KEYS, PROXY_KEYS,
  dateLevelFactorRows, fitFactorAlpha, cellFor, proxyBetaCorrelation, buildFactorAlphaBlock,
};
