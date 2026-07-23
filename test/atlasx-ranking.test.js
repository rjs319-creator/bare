'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const {
  ATLASX_FEATURE_KEYS,
  WEIGHTS,
  featureRow,
  predictDistribution,
  atlasxRanker,
  researchInterface,
} = require('../lib/atlasx-ranking');
const { validateDistributional } = require('../lib/atlasx-contracts');
const { VERSIONS } = require('../lib/atlasx-config');

// ── fixture builders (pure, deterministic — no RNG) ───────────────────────────
function mkResidual({ r5 = 0, r10 = 0, r20 = 0, accel = 0, vol = 0.02 } = {}) {
  return {
    beta: 1, vol, residualAccel: accel,
    byHorizon: {
      1: { residual: r5 * 0.2 }, 3: { residual: r5 * 0.6 }, 5: { residual: r5 },
      10: { residual: r10 }, 20: { residual: r20 }, 63: { residual: r20 * 1.2 },
    },
  };
}
const mkTransition = (s = 0.6) => ({ scores: { compressionToExpansion: s }, features: { resid10: s } });
const mkPath = (smoothness = 0.8, spikeShare = 0.1) => ({ features: { smoothness, spikeShare } });
const mkExpert = (applicability = 0.7) => ({ expert: 'catalystDrift', applicability });

const STRONG = {
  residual: mkResidual({ r5: 0.06, r10: 0.09, r20: 0.12, accel: 0.004, vol: 0.02 }),
  transition: mkTransition(0.8), path: mkPath(0.85, 0.05), expert: mkExpert(0.8),
};
const WEAK = {
  residual: mkResidual({ r5: -0.02, r10: -0.01, r20: 0.0, accel: -0.002, vol: 0.02 }),
  transition: mkTransition(0.3), path: mkPath(0.3, 0.5), expert: mkExpert(0.4),
};

function hasPercentString(obj) {
  return Object.values(obj).some((v) => typeof v === 'string' && v.includes('%'));
}

// ── quantile ordering ─────────────────────────────────────────────────────────
test('p10 <= median <= p90 across varied inputs, including degenerate/missing residual', () => {
  const cases = [
    predictDistribution(STRONG),
    predictDistribution(WEAK),
    predictDistribution({ residual: mkResidual({ r5: 0, r10: 0, r20: 0, vol: 0.05 }) }),
    predictDistribution({}),                                    // everything missing
    predictDistribution({ residual: null, transition: null, path: null, expert: null }),
  ];
  for (const d of cases) {
    assert.ok(d.p10 <= d.median, `p10(${d.p10}) <= median(${d.median})`);
    assert.ok(d.median <= d.p90, `median(${d.median}) <= p90(${d.p90})`);
  }
});

test('degenerate/missing residual still yields an ordered but WIDE interval', () => {
  const d = predictDistribution({});
  assert.equal(d.median, 0, 'no finite features → central estimate 0');
  assert.equal(d.volUsed, false, 'fell back to VOL_FALLBACK');
  assert.ok(d.p10 <= d.median && d.median <= d.p90);
  assert.ok(d.p90 - d.p10 > 0.2, `interval should be wide, got ${d.p90 - d.p10}`);
});

// ── monotonicity of the central estimate ──────────────────────────────────────
test('stronger residual momentum yields a higher median and score', () => {
  const strong = predictDistribution(STRONG);
  const weak = predictDistribution(WEAK);
  assert.ok(strong.median > weak.median, `strong median(${strong.median}) > weak(${weak.median})`);
  assert.ok(strong.score > weak.score, `strong score(${strong.score}) > weak(${weak.score})`);
});

// ── contract compliance ───────────────────────────────────────────────────────
test('predictDistribution output passes validateDistributional', () => {
  for (const input of [STRONG, WEAK, {}]) {
    const res = validateDistributional(predictDistribution(input));
    assert.ok(res.ok, `validation errors: ${JSON.stringify(res.errors)}`);
  }
});

test('calibrationStatus is uncalibrated and NO field is a percentage string', () => {
  const d = predictDistribution(STRONG);
  assert.equal(d.calibrationStatus, 'uncalibrated');
  assert.equal(d.version, VERSIONS.ranking);
  assert.equal(hasPercentString(d), false, 'no field may be a percentage string');
  assert.equal(hasPercentString(d.contributions), false);
});

// ── expected shortfall is worse than p10 ──────────────────────────────────────
test('expectedShortfall <= p10 (the sub-p10 tail is worse than the 10th pct)', () => {
  for (const input of [STRONG, WEAK, {}]) {
    const d = predictDistribution(input);
    assert.ok(d.expectedShortfall <= d.p10, `ES(${d.expectedShortfall}) <= p10(${d.p10})`);
  }
});

// ── harness ranker contract ───────────────────────────────────────────────────
function rowFrom(input, extra = {}) {
  return { features: featureRow(input), decisionTs: '2024-01-02', outcome: 0, ...extra };
}

test('atlasxRanker.fit uses only train rows — test rows never change the fitted model', () => {
  const trainInputs = [];
  for (let i = 0; i < 30; i++) {
    const s = (i - 15) / 100; // spread of residual-momentum strengths
    trainInputs.push({ residual: mkResidual({ r5: s, r10: s * 1.2, r20: s * 1.4, accel: s / 10, vol: 0.02 }) });
  }
  const trainRows = trainInputs.map((x) => rowFrom(x));
  const testRows = [rowFrom(STRONG), rowFrom(WEAK)];

  const modelA = atlasxRanker.fit(trainRows);
  const modelB = atlasxRanker.fit(trainRows); // deterministic re-fit on same train
  assert.deepEqual(modelA.stats, modelB.stats, 'fit is deterministic on identical train');

  // Scoring different test rows must not mutate the model (frozen + pure).
  const before = JSON.stringify(modelA.stats);
  atlasxRanker.score(modelA, testRows[0]);
  atlasxRanker.score(modelA, testRows[1]);
  assert.equal(JSON.stringify(modelA.stats), before, 'scoring test rows left the model unchanged');

  // The fitted mean is the TRAIN mean of the feature (proves train-only origin).
  const trainR10 = trainRows.map((r) => r.features.residMom10);
  const expectedMean = trainR10.reduce((a, b) => a + b, 0) / trainR10.length;
  assert.ok(Math.abs(modelA.stats.residMom10.mean - expectedMean) < 1e-9, 'stats derived from train only');
});

test('atlasxRanker.score is deterministic and monotonic in residual momentum', () => {
  const train = [];
  for (let i = 0; i < 30; i++) {
    const s = (i - 15) / 100;
    train.push(rowFrom({ residual: mkResidual({ r5: s, r10: s * 1.2, r20: s * 1.4, accel: s / 10, vol: 0.02 }) }));
  }
  const model = atlasxRanker.fit(train);
  const strong = rowFrom(STRONG);
  const weak = rowFrom(WEAK);

  const s1 = atlasxRanker.score(model, strong);
  const s2 = atlasxRanker.score(model, strong);
  assert.equal(s1, s2, 'score is deterministic');
  assert.ok(atlasxRanker.score(model, strong) > atlasxRanker.score(model, weak), 'stronger residual ranks higher');
});

// ── shape / DRY sanity ────────────────────────────────────────────────────────
test('featureRow exposes exactly the declared keys and WEIGHTS covers them', () => {
  const f = featureRow(STRONG);
  assert.deepEqual(Object.keys(f).sort(), [...ATLASX_FEATURE_KEYS].sort());
  for (const k of ATLASX_FEATURE_KEYS) assert.ok(Number.isFinite(WEIGHTS[k]), `weight for ${k}`);
});

test('missing residual features stay null (never fabricated to 0)', () => {
  const f = featureRow({ residual: null, transition: null, path: null, expert: null });
  for (const k of ATLASX_FEATURE_KEYS) assert.equal(f[k], null, `${k} should be null`);
});

test('researchInterface is an honest out-of-scope stub, not a model', () => {
  const ri = researchInterface();
  assert.equal(ri.status, 'out-of-scope');
  assert.match(ri.promotionRule, /beat atlasx-baseline/);
  assert.ok(Array.isArray(ri.gatedBy) && ri.gatedBy.length > 0);
});
