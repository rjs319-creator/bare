'use strict';
// ATLAS-X: THE VALIDATED RANKER WAS NOT THE SHIPPED RANKER (alpha-research pass 3).
//
// lib/atlasx-ranking.js claimed "ONE weight source, shared by both consumers". The
// WEIGHTS were shared; the TRANSFORM was not:
//   • production (predictDistribution -> contributionsOf) summed WEIGHTS[k] x RAW value
//   • research   (atlasxRanker.score)  summed WEIGHTS[k] x Z-STANDARDIZED value
// Because residMom5/10/20 are winsorized to DIFFERENT caps (WINSOR_K·√h — a 20-session
// residual is deliberately allowed to be larger than a 5-session one), the two produced
// different RANK ORDERS on identical candidates. docs/model-promotion-policy.md #6
// requires train/serve parity: identical feature vector from one implementation.
//
// Secondary defect, present in BOTH scorers: a missing feature contributed 0 with no
// renormalization, and residMom* is SIGNED — so a candidate MISSING residMom20 outranked
// one carrying a genuinely NEGATIVE residMom20. Missing data beat bad data.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/atlasx-ranking');

const FLAT = {
  residMom5: 0, residMom10: 0, residMom20: 0, residAccel: 0,
  transitionStrength: 0, pathQuality: 0, expertApplicability: 0,
};
const row = (f) => ({ features: { ...FLAT, ...f } });

// The red-team's original fixture: differently-scaled residual horizons are what made
// the two transforms disagree.
const COHORT = [
  ['A', row({ residMom5: 0.30, residMom10: 0.10, residMom20: 0.05 })],
  ['B', row({ residMom5: 0.05, residMom10: 0.30, residMom20: 0.25 })],
  ['C_missing_resid20', row({ residMom5: 0.10, residMom10: 0.12, residMom20: null })],
  ['D_bad_resid20', row({ residMom5: 0.10, residMom10: 0.12, residMom20: -0.30 })],
];
const orderOf = (pairs) => pairs.slice()
  .sort((x, y) => (y[1] ?? -Infinity) - (x[1] ?? -Infinity)).map(p => p[0]).join(' > ');

// ── train/serve parity ───────────────────────────────────────────────────────────

test('the shipped scorer and the validated scorer produce the SAME rank order', () => {
  const model = R.atlasxRanker.fit(COHORT.map(c => c[1]));
  const shipped = COHORT.map(([n, r]) => [n, R.scoreFeatures(r.features).score]);
  const validated = COHORT.map(([n, r]) => [n, R.atlasxRanker.score(model, r)]);
  assert.equal(orderOf(shipped), orderOf(validated));
});

test('both consumers route through the one shared scorer', () => {
  // Not a wording assertion: the distribution's score must equal scoreFeatures' score
  // for the same feature vector, which can only hold if one function produces both.
  const f = { ...FLAT, residMom5: 0.12, residMom10: 0.20, residMom20: 0.08, pathQuality: 0.3 };
  const direct = R.scoreFeatures(f).score;
  const model = R.atlasxRanker.fit([{ features: f }]);
  assert.equal(R.atlasxRanker.score(model, { features: f }), direct);
});

test('fitted stats no longer transform the score — the ranker is fit-invariant', () => {
  // The old score divided by a TRAIN sample std, so the same candidate scored
  // differently depending on which cohort the model was fitted on. That is precisely
  // how the validated ranker drifted from the shipped one.
  const f = { ...FLAT, residMom5: 0.10, residMom10: 0.15, residMom20: 0.05 };
  const narrow = R.atlasxRanker.fit([{ features: f }, { features: { ...f, residMom10: 0.16 } }]);
  const wide = R.atlasxRanker.fit(COHORT.map(c => c[1]));
  assert.equal(R.atlasxRanker.score(narrow, { features: f }), R.atlasxRanker.score(wide, { features: f }),
    'the same candidate must score identically regardless of the fitting cohort');
});

// ── missing data must not beat bad data ──────────────────────────────────────────

test('a candidate missing a REQUIRED residual horizon is unrankable, not mid-pack', () => {
  const s = R.scoreFeatures({ ...FLAT, residMom5: 0.10, residMom10: 0.12, residMom20: null });
  assert.equal(s.score, null);
  assert.equal(s.sufficient, false);
  assert.deepEqual(s.missingRequired, ['residMom20']);
});

test('a genuinely NEGATIVE value now ranks ABOVE a missing one', () => {
  const missing = R.scoreFeatures({ ...FLAT, residMom5: 0.10, residMom10: 0.12, residMom20: null });
  const bad = R.scoreFeatures({ ...FLAT, residMom5: 0.10, residMom10: 0.12, residMom20: -0.30 });
  assert.equal(bad.sufficient, true);
  assert.ok((bad.score ?? -Infinity) > (missing.score ?? -Infinity),
    'absence of evidence must not outrank evidence of weakness');
});

test('the research ranker sorts an unrankable row to the bottom, never to average', () => {
  const model = R.atlasxRanker.fit(COHORT.map(c => c[1]));
  const s = R.atlasxRanker.score(model, { features: { ...FLAT, residMom20: null } });
  assert.equal(s, -Infinity);
});

// ── coverage renormalization ─────────────────────────────────────────────────────

test('a fully-covered candidate is numerically unchanged (weights sum to 1)', () => {
  const f = { ...FLAT, residMom5: 0.10, residMom10: 0.20, residMom20: 0.10, residAccel: 0.1,
    transitionStrength: 0.2, pathQuality: 0.3, expertApplicability: 0.1 };
  const s = R.scoreFeatures(f);
  assert.equal(s.coverage, 1);
  assert.equal(s.score, s.rawScore, 'renormalization must be a no-op at full coverage');
});

test('a partial (but sufficient) vector is scored on the weight it actually carries', () => {
  const f = { ...FLAT, residMom5: 0.10, residMom10: 0.10, residMom20: 0.10, pathQuality: null };
  const s = R.scoreFeatures(f);
  assert.ok(s.sufficient);
  assert.ok(s.coverage < 1 && s.coverage > 0.9);
  assert.ok(Math.abs(s.score) > Math.abs(s.rawScore),
    'the covered weight is scaled onto the full budget, not left flattered by zeros');
});

test('below the coverage floor a candidate abstains', () => {
  // Required horizons present, but almost nothing else — under MIN_FEATURE_COVERAGE.
  const s = R.scoreFeatures({ residMom5: 0.1, residMom10: 0.1, residMom20: 0.1,
    residAccel: null, transitionStrength: null, pathQuality: null, expertApplicability: null });
  assert.ok(R.MIN_FEATURE_COVERAGE > 0.5);
  assert.equal(s.sufficient, true, 'the residual core alone (0.75 of weight) clears the floor');
  // ...but stripping a required horizon does not.
  const s2 = R.scoreFeatures({ ...FLAT, residMom10: null });
  assert.equal(s2.sufficient, false);
});

// ── the distribution surface ─────────────────────────────────────────────────────

test('predictDistribution reports rankability and coverage, and nulls the score when unrankable', () => {
  const d = R.predictDistribution({
    residual: { byHorizon: { 5: { residual: 0.1 }, 10: { residual: 0.1 } }, vol: 0.02 },
  });
  assert.equal(d.rankable, false, 'residMom20 is absent from this residual artifact');
  assert.equal(d.score, null);
  assert.ok(Number.isFinite(d.featureCoverage));
  // The band stays describable and ordered even when the name cannot be ranked.
  assert.ok(d.p10 <= d.median && d.median <= d.p90);
});

test('a fully-covered candidate still ranks and still satisfies the quantile invariant', () => {
  const d = R.predictDistribution({
    residual: { byHorizon: { 5: { residual: 0.05 }, 10: { residual: 0.08 }, 20: { residual: 0.10 } }, vol: 0.02, residualAccel: 0.001 },
    transition: { scores: { compressionToExpansion: 0.7 } },
    path: { features: { smoothness: 0.6, spikeShare: 0.1 } },
    expert: { applicability: 0.8 },
  });
  assert.equal(d.rankable, true);
  assert.ok(Number.isFinite(d.score));
  assert.ok(d.p10 <= d.median && d.median <= d.p90);
});
