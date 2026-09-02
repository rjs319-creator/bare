'use strict';
// CROSS-SECTIONAL TRANSFORMS & CONTEXT (forecast-xsection-v1)
//
// Two distinct jobs, deliberately kept apart because they have different leakage rules:
//
//   A. WITHIN-DATE transforms (percentile rank, robust z, breadth, dispersion, sector context).
//      These are computed from ONE decision date's cross-section, all of it observable at that
//      date's close, so they are point-in-time safe by construction and need no train fit.
//
//   B. TRAIN-FITTED transforms (winsorization limits, standardization mean/sd, median
//      imputation). These are FITTED ON TRAINING ROWS ONLY and then applied unchanged to
//      validation/test rows. `fitScaler` records the rows it was fitted from so a leakage test
//      can assert no evaluation row contributed.
//
// Pure & deterministic.

const { CONTINUOUS_KEYS, FEATURE_KEYS, DATE_CONSTANT_KEYS } = require('./features');

const XSECTION_VERSION = 'forecast-xsection-v1';

const isFin = Number.isFinite;

/** Average-tie percentile ranks in [0,1]. Nulls stay null and do not consume rank mass. */
function percentileRanks(values) {
  const idx = [];
  for (let i = 0; i < values.length; i++) if (isFin(values[i])) idx.push(i);
  const out = new Array(values.length).fill(null);
  const n = idx.length;
  if (n === 0) return out;
  if (n === 1) { out[idx[0]] = 0.5; return out; }
  idx.sort((a, b) => values[a] - values[b]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]] === values[idx[i]]) j++;
    const avgRank = (i + j) / 2;                 // 0-based average rank across the tie block
    const p = n > 1 ? avgRank / (n - 1) : 0.5;
    for (let k = i; k <= j; k++) out[idx[k]] = +p.toFixed(6);
    i = j + 1;
  }
  return out;
}

function medianOf(xs) {
  const s = xs.filter(isFin).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Robust z: (x - median) / (1.4826 * MAD). Null when MAD is 0 (a degenerate cross-section). */
function robustZ(values) {
  const med = medianOf(values);
  if (med == null) return values.map(() => null);
  const mad = medianOf(values.map((v) => (isFin(v) ? Math.abs(v - med) : null)));
  const scale = mad != null ? 1.4826 * mad : null;
  if (!(scale > 0)) return values.map(() => null);
  return values.map((v) => (isFin(v) ? +(Math.max(-8, Math.min(8, (v - med) / scale))).toFixed(6) : null));
}

/**
 * Apply within-date transforms to one date's rows in place-free fashion.
 *   rows: [{ ticker, sector, features: {key -> num|null}, ... }]
 * Returns a NEW array of rows whose `features` gained `xs_<key>` (and `z_<key>` when enabled),
 * plus a per-date `context` object shared by every row.
 *
 * `minNames` guards the degenerate case: below it the ranks carry no information, so they are
 * emitted as null and the date is flagged `thinCrossSection`.
 */
function applyCrossSection(rows, cfg, { keys = CONTINUOUS_KEYS, transforms = ['rank'], scope = null } = {}) {
  const minNames = cfg.features.crossSectionMinNames;
  const thin = rows.length < minNames;
  const useScope = scope || cfg.features.crossSectionScope || 'market';

  const columns = new Map();
  for (const k of keys) columns.set(k, rows.map((r) => (r.features && isFin(r.features[k]) ? r.features[k] : null)));

  // SCOPE OF THE WITHIN-DATE TRANSFORM.
  //
  // 'market'  rank each feature against every name on the date.
  // 'sector'  rank it against the names in its OWN sector.
  //
  // The argument for 'sector': the TARGET is market- and sector-neutralized, so the part of a
  // feature's market-wide rank that merely says "this is an energy name" describes a dimension the
  // target has already removed. Ranking within sector makes the features and the target consistent.
  //
  // The argument against: the neutralization uses ESTIMATED betas, so it is imperfect, and some
  // genuine cross-sector information survives in the residual that within-sector ranking discards.
  // Which effect dominates is an empirical question, so both are supported and neither is assumed.
  //
  // A sector too small to rank within falls back to the market-wide rank for those rows rather
  // than emitting nulls — a thin sector is a coverage problem, not a reason to blank a name.
  const groupsOf = () => {
    if (useScope !== 'sector') return null;
    const bySector = new Map();
    rows.forEach((r, i) => {
      const sec = r.sector || 'UNKNOWN';
      if (!bySector.has(sec)) bySector.set(sec, []);
      bySector.get(sec).push(i);
    });
    return bySector;
  };
  const groups = groupsOf();
  const scopeCounts = { sector: 0, market: 0 };

  const scoped = (col, fn) => {
    if (!groups) { scopeCounts.market += col.length; return fn(col); }
    const out = new Array(col.length).fill(null);
    const fallbackIdx = [];
    for (const [, idx] of groups) {
      if (idx.length < minNames) { fallbackIdx.push(...idx); continue; }
      const sub = fn(idx.map((i) => col[i]));
      idx.forEach((i, p) => { out[i] = sub[p]; });
    }
    if (fallbackIdx.length) {
      const sub = fn(fallbackIdx.map((i) => col[i]));
      fallbackIdx.forEach((i, p) => { out[i] = sub[p]; });
    }
    scopeCounts.sector += col.length - fallbackIdx.length;
    scopeCounts.market += fallbackIdx.length;
    return out;
  };

  const ranked = new Map(), zed = new Map();
  for (const k of keys) {
    const col = columns.get(k);
    if (transforms.includes('rank')) ranked.set(k, thin ? col.map(() => null) : scoped(col, percentileRanks));
    if (transforms.includes('z')) zed.set(k, thin ? col.map(() => null) : scoped(col, robustZ));
  }

  // Date-level context: breadth, dispersion, and per-sector aggregates. All from this date only.
  const ret5 = rows.map((r) => (r.features && isFin(r.features.ret5) ? r.features.ret5 : null)).filter(isFin);
  const ret21 = rows.map((r) => (r.features && isFin(r.features.ret21) ? r.features.ret21 : null)).filter(isFin);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const sd = (a) => {
    if (a.length < 2) return null;
    const m = mean(a);
    return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1));
  };

  const bySector = new Map();
  for (const r of rows) {
    const s = r.sector || 'UNKNOWN';
    if (!bySector.has(s)) bySector.set(s, []);
    if (r.features && isFin(r.features.ret21)) bySector.get(s).push(r.features.ret21);
  }
  const sectorMean = new Map([...bySector].map(([s, v]) => [s, mean(v)]));

  const nKeys = Math.max(1, keys.length * transforms.length);
  const context = Object.freeze({
    names: rows.length,
    thinCrossSection: thin,
    crossSectionScope: useScope,
    // How many name-columns were ranked within sector vs fell back to market-wide — a thin
    // sector is reported, not hidden.
    scopeCounts: Object.freeze({ sector: Math.round(scopeCounts.sector / nKeys), market: Math.round(scopeCounts.market / nKeys) }),
    breadthUp5: ret5.length ? +(ret5.filter((x) => x > 0).length / ret5.length).toFixed(5) : null,
    breadthUp21: ret21.length ? +(ret21.filter((x) => x > 0).length / ret21.length).toFixed(5) : null,
    dispersion5: sd(ret5) != null ? +sd(ret5).toFixed(6) : null,
    dispersion21: sd(ret21) != null ? +sd(ret21).toFixed(6) : null,
    medianRet21: medianOf(ret21),
    sectorMeanRet21: Object.fromEntries([...sectorMean].map(([s, v]) => [s, v == null ? null : +v.toFixed(6)])),
  });

  const out = rows.map((r, i) => {
    const f = { ...r.features };
    for (const k of keys) {
      if (ranked.has(k)) f[`xs_${k}`] = ranked.get(k)[i];
      if (zed.has(k)) f[`z_${k}`] = zed.get(k)[i];
    }
    f.ctxBreadthUp5 = context.breadthUp5;
    f.ctxDispersion21 = context.dispersion21;
    f.ctxNames = context.names;
    const sm = sectorMean.get(r.sector || 'UNKNOWN');
    f.ctxSectorRet21 = sm == null ? null : +sm.toFixed(6);
    f.ctxRelToSector21 = (isFin(f.ret21) && isFin(sm)) ? +(f.ret21 - sm).toFixed(6) : null;
    return { ...r, features: f };
  });

  return { rows: out, context };
}

// Date-level context columns. The first three are IDENTICAL for every name on a decision date;
// the last two vary (by sector, and by name relative to its sector) and are informative within a
// date. Kept apart so `modelFeatureKeys` can drop only the uninformative ones.
const CONTEXT_KEYS = Object.freeze(['ctxBreadthUp5', 'ctxDispersion21', 'ctxNames', 'ctxSectorRet21', 'ctxRelToSector21']);
const DATE_CONSTANT_CONTEXT_KEYS = Object.freeze(['ctxBreadthUp5', 'ctxDispersion21', 'ctxNames']);

/** Every column a row carries after cross-sectional expansion. */
function expandedFeatureKeys({ keys = CONTINUOUS_KEYS, transforms = ['rank'] } = {}) {
  const out = [...FEATURE_KEYS];
  for (const k of keys) {
    if (transforms.includes('rank')) out.push(`xs_${k}`);
    if (transforms.includes('z')) out.push(`z_${k}`);
  }
  out.push(...CONTEXT_KEYS);
  return Object.freeze(out);
}

/**
 * The columns a WITHIN-DATE ranking model may actually train on.
 *
 * Date-constant columns are dropped by default: they cannot change a within-date ordering, but a
 * tree can split on them to fit date-specific means — a pure overfitting channel measured at
 * in-sample rank IC 0.31 vs 0.035 inner-held-out. Set `includeDateConstant` to keep them (for a
 * deliberately regime-conditional model, say).
 */
function modelFeatureKeys({ keys = CONTINUOUS_KEYS, transforms = ['rank'], includeDateConstant = false } = {}) {
  const all = expandedFeatureKeys({ keys, transforms });
  if (includeDateConstant) return all;
  const drop = new Set([...DATE_CONSTANT_KEYS, ...DATE_CONSTANT_CONTEXT_KEYS]);
  return Object.freeze(all.filter((k) => !drop.has(k)));
}

// ── B. TRAIN-FITTED transforms ───────────────────────────────────────────────

/**
 * Fit winsorization limits, median imputation values and standardization from TRAINING ROWS
 * ONLY. The returned scaler records `fittedOnRows` / `fittedThroughDate` so a leakage test can
 * assert nothing later than the training cutoff contributed.
 */
function fitScaler(trainRows, featureKeys, cfg) {
  const p = cfg.features.winsorizeP;
  const limits = Object.create(null), center = Object.create(null), scale = Object.create(null), impute = Object.create(null);
  let maxDate = null;
  for (const r of trainRows) if (r.decisionDate && (maxDate === null || r.decisionDate > maxDate)) maxDate = r.decisionDate;

  for (const k of featureKeys) {
    const col = [];
    for (const r of trainRows) { const v = r.features ? r.features[k] : null; if (isFin(v)) col.push(v); }
    if (col.length < 10) { limits[k] = null; center[k] = 0; scale[k] = 1; impute[k] = 0; continue; }
    col.sort((a, b) => a - b);
    const lo = col[Math.floor(p * (col.length - 1))];
    const hi = col[Math.ceil((1 - p) * (col.length - 1))];
    limits[k] = [lo, hi];
    const clipped = col.map((v) => Math.max(lo, Math.min(hi, v)));
    const m = clipped.reduce((a, b) => a + b, 0) / clipped.length;
    const s = Math.sqrt(clipped.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, clipped.length - 1));
    center[k] = m;
    scale[k] = s > 1e-12 ? s : 1;
    impute[k] = medianOf(clipped) ?? m;
  }
  return Object.freeze({
    schema: 'ForecastScaler', version: XSECTION_VERSION,
    featureKeys: Object.freeze([...featureKeys]),
    limits, center, scale, impute,
    fittedOnRows: trainRows.length,
    fittedThroughDate: maxDate,
    winsorizeP: p,
  });
}

/** Apply a fitted scaler. Missing values become the TRAIN median, with a missingness indicator. */
function applyScaler(row, scaler, { standardize = true, withIndicators = false } = {}) {
  const out = new Float64Array(scaler.featureKeys.length * (withIndicators ? 2 : 1));
  const f = row.features || {};
  for (let i = 0; i < scaler.featureKeys.length; i++) {
    const k = scaler.featureKeys[i];
    const raw = f[k];
    const present = isFin(raw);
    let v = present ? raw : scaler.impute[k];
    const lim = scaler.limits[k];
    if (lim) v = Math.max(lim[0], Math.min(lim[1], v));
    out[i] = standardize ? (v - scaler.center[k]) / scaler.scale[k] : v;
    if (withIndicators) out[scaler.featureKeys.length + i] = present ? 0 : 1;
  }
  return out;
}

module.exports = {
  XSECTION_VERSION, percentileRanks, robustZ, medianOf,
  applyCrossSection, expandedFeatureKeys, modelFeatureKeys, CONTEXT_KEYS, DATE_CONSTANT_CONTEXT_KEYS, fitScaler, applyScaler,
};
