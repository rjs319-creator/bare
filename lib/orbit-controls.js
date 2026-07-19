// Negative-controls / leakage-detection harness (orbit-controls-v1).
//
// A model only earns trust if its apparent edge SURVIVES adversarial controls and
// DISAPPEARS when the signal is destroyed. This harness runs that battery over the
// ORBIT walk-forward samples, reusing lib/orbit-ml-model (rankWalkForward) and
// lib/pit-contract (forward-leak detection). All controls are DETERMINISTIC — the
// "shuffle" is a fixed rotation, not Math.random — so results are reproducible.
//
//   • shuffled-label control  — destroy the feature→label link; IC must collapse to ~0.
//                               A non-zero IC on shuffled labels ⇒ leakage/overfit.
//   • future-feature detection — any feature near-perfectly correlated with the label.
//   • random-ranker baseline  — a fixed pseudo-random score; IC must be ~0 (sanity floor).
//   • doubled-cost control    — recompute top-decile net at 2× costs; fragile edge flips.
//   • drop-best-year control  — remove the best year; edge must not depend on one year.
//
// One-bar-delay and worst-regime-alone require candle re-resolution / regime tags that
// the samples don't carry; the hooks are documented but the samples-level battery above
// is what runs here (see docs/orbit-historical-learning.md).

const MLModel = require('./orbit-ml-model');
const WF = require('./orbit-walkforward');
const PIT = require('./pit-contract');
const M = require('./orbit-math');

const CONTROLS_VERSION = 'orbit-controls-v1';

// Rotate each decision-date group's label (`horizons`) across names — a deterministic
// permutation that breaks the feature→label pairing while preserving the label marginal.
function shuffleLabels(samples) {
  const byDate = new Map();
  for (const s of samples) { if (!byDate.has(s.decisionDate)) byDate.set(s.decisionDate, []); byDate.get(s.decisionDate).push(s); }
  const out = [];
  for (const [, group] of byDate) {
    const n = group.length;
    const shift = n > 1 ? Math.max(1, Math.floor(n / 2)) : 0;
    group.forEach((s, i) => out.push({ ...s, horizons: group[(i + shift) % n].horizons }));
  }
  return out;
}

// Deterministic pseudo-random score per (date,ticker) from a stable hash — no Math.random.
function hashScore(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }

function icOf(wf) { return wf && wf.ok && wf.purged && wf.purged.overall ? wf.purged.overall.ic : null; }

// Shuffled-label control.
function shuffledLabelControl(samples, opts = {}) {
  const horizon = opts.horizon || 'days21';
  const cfg = { horizon, targetField: 'residualReturn', features: opts.features, outerBlocks: opts.outerBlocks || 6 };
  const realIC = icOf(MLModel.rankWalkForward(samples, cfg));
  const shuffledIC = icOf(MLModel.rankWalkForward(shuffleLabels(samples), cfg));
  // Small-sample shuffled IC is noisy (±0.05 over a few dozen dates); real leakage
  // shows shuffled IC near the REAL IC (often 0.1+). 0.06 avoids false positives.
  const leakThreshold = opts.leakThreshold != null ? opts.leakThreshold : 0.06;
  return {
    control: 'shuffled-label', realIC, shuffledIC,
    leakSuspected: shuffledIC != null && Math.abs(shuffledIC) > leakThreshold,
    note: 'Shuffled labels should give IC ≈ 0. A non-trivial IC here signals leakage or overfitting to the fold structure.',
  };
}

// Future-feature detection over the resolved cross-section.
function futureFeatureControl(samples, opts = {}) {
  const horizon = opts.horizon || 'days21';
  const rows = [];
  for (const s of samples) { const h = s.horizons && s.horizons[horizon]; if (!h || !h.resolved) continue; const t = h.residualReturn != null ? h.residualReturn : h.netReturn; if (t == null) continue; rows.push({ features: s.features, label: t }); }
  const res = PIT.suspiciousForwardCorrelation(rows, 'label', { threshold: opts.threshold != null ? opts.threshold : 0.9 });
  return { control: 'future-feature', ...res, leakSuspected: res.flagged.length > 0 };
}

// Random-ranker baseline: grouped IC of a fixed pseudo-random score must be ~0.
function randomRankerControl(samples, opts = {}) {
  const horizon = opts.horizon || 'days21';
  const preds = [];
  for (const s of samples) { const h = s.horizons && s.horizons[horizon]; if (!h || !h.resolved) continue; const net = h.netReturn; if (net == null) continue; preds.push({ date: s.decisionDate, score: hashScore(`${s.ticker}|${s.decisionDate}`), net }); }
  const g = WF.groupedIC(preds);
  // ±0.08 band: a random ranker's per-date IC averages to ~0 but over a few dozen
  // dates the mean wanders within noise; a |IC| beyond this signals a biased eval.
  return { control: 'random-ranker', ic: g.ic, nDates: g.nDates, ok: g.ic == null || Math.abs(g.ic) < 0.08, note: 'A random ranker should have IC ≈ 0. If not, the evaluation itself is biased.' };
}

// Doubled-cost control: top-decile net at 2× the round-trip cost.
function doubledCostControl(samples, opts = {}) {
  const horizon = opts.horizon || 'days21';
  const rows = [];
  for (const s of samples) {
    const h = s.horizons && s.horizons[horizon]; if (!h || !h.resolved) continue;
    if (h.grossReturn == null || h.netReturn == null) continue;
    const cost = h.grossReturn - h.netReturn;               // implied one-model cost
    rows.push({ score: s.features && s.features.residMom63 || 0, base: h.netReturn, doubled: h.grossReturn - 2 * cost });
  }
  if (rows.length < 20) return { control: 'doubled-cost', ready: false };
  rows.sort((a, b) => b.score - a.score);
  const decN = Math.max(1, Math.floor(rows.length / 10));
  const baseTop = M.mean(rows.slice(0, decN).map(r => r.base));
  const dblTop = M.mean(rows.slice(0, decN).map(r => r.doubled));
  return { control: 'doubled-cost', baseTopDecileNet: +baseTop.toFixed(4), doubledTopDecileNet: +dblTop.toFixed(4), survivesDoubledCost: dblTop > 0 };
}

// Drop-best-year robustness: overall IC must not collapse when the best year is removed.
function dropBestYearControl(samples, opts = {}) {
  const horizon = opts.horizon || 'days21';
  const years = [...new Set(samples.map(s => s.decisionDate.slice(0, 4)))].sort();
  if (years.length < 2) return { control: 'drop-best-year', ready: false, reason: 'need ≥2 years' };
  const cfg = { horizon, targetField: 'residualReturn', features: opts.features, outerBlocks: opts.outerBlocks || 4 };
  let bestYear = null, bestIC = -Infinity;
  for (const y of years) { const ic = icOf(MLModel.rankWalkForward(samples.filter(s => s.decisionDate.slice(0, 4) === y), cfg)); if (ic != null && ic > bestIC) { bestIC = ic; bestYear = y; } }
  const withoutBest = icOf(MLModel.rankWalkForward(samples.filter(s => s.decisionDate.slice(0, 4) !== bestYear), cfg));
  const fullIC = icOf(MLModel.rankWalkForward(samples, cfg));
  return { control: 'drop-best-year', fullIC, bestYear, withoutBestYearIC: withoutBest, robust: withoutBest != null && fullIC != null && withoutBest >= fullIC * 0.5 };
}

// Run the full battery → a single honest verdict.
function runControls(samples, opts = {}) {
  const shuffled = shuffledLabelControl(samples, opts);
  const futureFeat = futureFeatureControl(samples, opts);
  const randomRanker = randomRankerControl(samples, opts);
  const doubledCost = doubledCostControl(samples, opts);
  const dropYear = dropBestYearControl(samples, opts);

  const leak = shuffled.leakSuspected || futureFeat.leakSuspected || (randomRanker.ok === false);
  const realIC = shuffled.realIC;
  let verdict, reason;
  // The controls only need to DEFEND a positive OOS edge. A non-positive purged IC
  // (≈0, or negative from overfitting noise) means there is nothing to promote.
  if (leak) { verdict = 'FAIL-LEAKAGE'; reason = 'A negative control found spurious signal (shuffled-label IC ≠ 0, a future-leak feature, or a biased evaluation).'; }
  else if (realIC == null || realIC <= 0.02) { verdict = 'NO-EDGE'; reason = 'No leakage detected AND no positive out-of-sample edge to defend (purged IC ≤ 0.02) — controls are clean, but there is nothing to promote.'; }
  else if (doubledCost.ready && !doubledCost.survivesDoubledCost) { verdict = 'FRAGILE-COST'; reason = 'Apparent edge does not survive doubled costs.'; }
  else if (dropYear.ready !== false && !dropYear.robust) { verdict = 'FRAGILE-REGIME'; reason = 'Apparent edge depends on a single best year.'; }
  else { verdict = 'ROBUST'; reason = 'Real edge survives all negative controls (still requires prospective shadow confirmation before promotion).'; }

  return {
    version: CONTROLS_VERSION, verdict, reason,
    realIC, controls: { shuffled, futureFeat, randomRanker, doubledCost, dropYear },
    unimplemented: ['one-bar-delay (needs candle re-resolution)', 'worst-regime-alone (needs regime tags on samples)'],
  };
}

module.exports = {
  CONTROLS_VERSION, shuffleLabels, hashScore,
  shuffledLabelControl, futureFeatureControl, randomRankerControl, doubledCostControl, dropBestYearControl, runControls,
};
