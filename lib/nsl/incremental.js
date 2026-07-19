'use strict';
// NOVEL SIGNAL LAB — incremental-value evaluator (nsl-incremental-v1).
//
// The decisive test in the spec: a new signal earns its place ONLY if it improves the EXISTING
// system on untouched observations — never on a strong standalone historical result. This module
// compares, over resolved cross-sectional samples grouped by decision date (each date is an
// independent, purged observation):
//   (1) baseline      — the existing app composite alone,
//   (2) augmented      — existing composite + the new signal (equal-weight in z-space),
//   (3) signal-alone   — the new signal by itself,
//   (4) incremental    — the signal's component ORTHOGONAL to the baseline (its marginal
//                        predictive contribution conditional on the existing feature set).
//
// The verdict rests on (4): if the baseline-orthogonalised signal has no positive, significant
// forward rank-IC, the signal is redundant no matter how good it looks alone. A false-discovery
// control (Bonferroni over the number of variants the operator tested) guards against fishing.
// Pure & deterministic.

const { rankIC, mean, sd } = require('./stats');

const zwithin = (xs) => { const m = mean(xs.filter(Number.isFinite)); const s = sd(xs.filter(Number.isFinite)) || 1; return xs.map(v => (Number.isFinite(v) ? (v - m) / s : 0)); };

// Ordinary-least-squares residual of y on x (both raw arrays); returns y - (a + b·x).
function residualize(y, x) {
  const n = y.length; const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const b = sxx === 0 ? 0 : sxy / sxx, a = my - b * mx;
  return y.map((v, i) => v - (a + b * x[i]));
}

// samples = [{ date, baseline:number, signal:number, outcome:number }]. `variantsTested` is the
// number of signal variants the operator explored (for the false-discovery correction).
function evaluateIncremental(samples, { minPerDate = 8, minDates = 8, variantsTested = 1 } = {}) {
  const byDate = new Map();
  for (const s of samples || []) {
    if (!s || !s.date || !Number.isFinite(s.baseline) || !Number.isFinite(s.signal) || !Number.isFinite(s.outcome)) continue;
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  const perDate = { baseline: [], augmented: [], alone: [], incremental: [] };
  let usedDates = 0;
  for (const rows of byDate.values()) {
    if (rows.length < minPerDate) continue;
    usedDates++;
    const base = rows.map(r => r.baseline), sig = rows.map(r => r.signal), out = rows.map(r => r.outcome);
    const zb = zwithin(base), zs = zwithin(sig);
    const aug = zb.map((v, i) => v + zs[i]);
    const resid = residualize(zs, zb); // signal orthogonal to baseline (within the date)
    push(perDate.baseline, rankIC(base, out));
    push(perDate.augmented, rankIC(aug, out));
    push(perDate.alone, rankIC(sig, out));
    push(perDate.incremental, rankIC(resid, out));
  }
  if (usedDates < minDates) return { insufficient: true, usedDates };

  const stat = (arr) => { const a = arr.filter(Number.isFinite); const m = mean(a); const s = sd(a); const t = s > 0 ? m / (s / Math.sqrt(a.length)) : 0; return { ic: m == null ? null : +m.toFixed(4), t: +t.toFixed(2), n: a.length }; };
  const baseline = stat(perDate.baseline), augmented = stat(perDate.augmented), alone = stat(perDate.alone), incremental = stat(perDate.incremental);
  const deltaIC = (augmented.ic != null && baseline.ic != null) ? +(augmented.ic - baseline.ic).toFixed(4) : null;

  // False-discovery control: Bonferroni-adjust the significance bar for the incremental IC.
  const alpha = 0.05 / Math.max(1, variantsTested);
  const tCrit = alpha <= 0.0125 ? 2.5 : 2.0; // coarse two-sided z for Bonferroni at these variant counts
  const incrementalSignificant = incremental.ic != null && incremental.ic > 0 && incremental.t >= tCrit;

  let verdict, recommendation;
  if (incrementalSignificant && deltaIC != null && deltaIC > 0) { verdict = 'adds-incremental-value'; recommendation = 'advance-to-prospective-shadow'; }
  else if (alone.ic != null && alone.ic > 0.02 && !incrementalSignificant) { verdict = 'redundant-with-existing'; recommendation = 'reject'; }
  else if (incremental.ic != null && incremental.ic <= 0) { verdict = 'no-edge'; recommendation = 'reject'; }
  else { verdict = 'inconclusive'; recommendation = 'observe'; }

  return {
    insufficient: false, usedDates,
    baseline, augmented, alone, incremental, deltaIC,
    variantsTested, bonferroniTCrit: tCrit, incrementalSignificant,
    verdict, recommendation,
  };
}

function push(arr, v) { if (Number.isFinite(v)) arr.push(v); }

module.exports = { evaluateIncremental, residualize };
