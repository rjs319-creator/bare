'use strict';
// Adversarial tests for harness-v3.1: purged+embargoed walk-forward folds and
// the three-tier cost-gated verdict contract. Each test constructs the leak or
// null-pass the upgrade exists to prevent and proves it is caught.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H3 = require('../lib/research/harness-v3');

const dates = Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(3, '0')}`);
const row = (d, labelEnd, extra = {}) => ({
  securityId: 's1', decisionTs: dates[d],
  labelEndDate: labelEnd == null ? null : dates[labelEnd],
  features: { mom121: 0.1 }, outcome: 0.01, ...extra,
});

// ── purge/embargo unit contract ───────────────────────────────────────────────

test('purge: a training label still open at the test boundary is excluded (leakage caught)', () => {
  // Test fold starts at index 10; embargo 3 → boundary d007.
  const rows = [
    row(2, 4),     // closed d004 < d007 → kept
    row(5, 9),     // closed d009 ≥ d007 → PURGED (label overlaps the embargoed zone)
    row(8, 12),    // decision before test start but label ends INSIDE the test fold → PURGED
    row(11, 13),   // decision inside test fold → never training
  ];
  const p = H3.purgeTrainingRows(rows, dates, 10, 3);
  assert.deepEqual(p.kept.map((r) => r.decisionTs), ['d002']);
  assert.equal(p.purged, 2);
  assert.equal(p.boundaryDate, 'd007');
});

test('purge: overlapping long-horizon labels are excluded dynamically (horizon-aware by exact end date)', () => {
  // Same decision date, different horizons: the 2-bar label closes in time, the
  // 63-bar-style label (ends far later) must be purged even though its
  // decision date is deep in the past.
  const rows = [row(1, 3), row(1, 15)];
  const p = H3.purgeTrainingRows(rows, dates, 10, 3);
  assert.equal(p.kept.length, 1);
  assert.equal(p.kept[0].labelEndDate, 'd003');
  assert.equal(p.purged, 1);
});

test('purge: a row that cannot prove when its label closed never trains (fail closed)', () => {
  const rows = [row(2, null), row(3, 5)];
  const p = H3.purgeTrainingRows(rows, dates, 10, 3);
  assert.equal(p.kept.length, 1);
  assert.equal(p.noLabelEnd, 1);
});

test('purge: embargo widens the exclusion zone', () => {
  const rows = [row(5, 8)];
  assert.equal(H3.purgeTrainingRows(rows, dates, 10, 0).kept.length, 1);   // d008 < d010
  assert.equal(H3.purgeTrainingRows(rows, dates, 10, 3).kept.length, 0);   // d008 ≥ d007
});

// ── end-to-end: intentionally constructed overlap is excluded from training ──

test('runExperimentV3: fold definitions record purge counts and every overlapping label is excluded', () => {
  const rows = [];
  for (let d = 0; d < 20; d++) {
    for (let k = 0; k < 4; k++) {
      rows.push({
        securityId: `s${k}`, decisionTs: dates[d],
        // half the rows carry a pathologically long label that overlaps everything
        labelEndDate: k < 2 ? dates[Math.min(19, d + 1)] : dates[19],
        features: { mom121: k * 0.1 }, outcome: k * 0.01,
      });
    }
  }
  const out = H3.runExperimentV3(rows, [], { folds: 4, seed: 1, embargoBars: 2 }, { generatedAt: 'T' });
  assert.ok(out.foldDefinitions.length > 0);
  for (const f of out.foldDefinitions) {
    assert.ok(Number.isFinite(f.purgedRows), 'purged count recorded per fold');
    assert.equal(f.embargoBars, 2);
    assert.ok(f.embargoBoundary, 'exact embargo boundary recorded');
  }
  assert.ok(out.leakageControls.totalPurged > 0, 'the never-closing labels were purged from training');
  assert.equal(out.leakageControls.embargoBars, 2);
});

// ── three-tier verdicts: cost evidence is mandatory for economic claims ──────

function strongPanel() {
  // Deterministic strong signal so the statistical gate passes.
  const rows = [];
  for (let d = 0; d < 40; d++) {
    for (let k = 0; k < 8; k++) {
      const sig = ((k * 7919 + d * 104729) % 97) / 97 - 0.5;
      rows.push({
        securityId: `s${k}`, decisionTs: `d${String(d).padStart(3, '0')}`,
        labelEndDate: `d${String(d + 2).padStart(3, '0')}`,
        features: { sig, mom121: ((k * 31 + d * 17) % 89) / 89 - 0.5 },
        outcome: sig,
      });
    }
  }
  return rows;
}
const sigRanker = { name: 'cand', fit: () => null, score: (_m, r) => r.features.sig };

test('tiers: statistical pass WITHOUT cost evidence is capped at STATISTICAL_SIGNAL_CANDIDATE', () => {
  const out = H3.runExperimentV3(strongPanel(), [sigRanker], { folds: 4, seed: 5 }, { generatedAt: 'T' });
  const v = out.verdicts.cand;
  assert.equal(v.checks.costEvidenceMeasured, false);
  assert.equal(v.checks.costNetPositiveUnderStress, false, 'missing cost evidence FAILS the check — never null');
  if (v.tier !== H3.TIERS.NOT_CONFIRMED) {
    assert.equal(v.tier, H3.TIERS.STATISTICAL);
    assert.match(v.verdict, /MISSING/);
    assert.match(v.verdict, /NOT established/);
  }
});

test('tiers: measured cost evidence that fails under doubled costs blocks the economic tier', () => {
  const out = H3.runExperimentV3(strongPanel(), [sigRanker], {
    folds: 4, seed: 5,
    costEvidenceByRanker: { cand: { net: 0.02, doubledCostNet: -0.01, stressedLiquidityNet: 0.01 } },
  }, { generatedAt: 'T' });
  const v = out.verdicts.cand;
  assert.equal(v.costEvidence.measured, true);
  assert.equal(v.costEvidence.passes, false);
  if (v.tier !== H3.TIERS.NOT_CONFIRMED) assert.equal(v.tier, H3.TIERS.STATISTICAL);
});

test('tiers: full measured cost evidence + statistical pass → ECONOMICALLY_VIABLE_CANDIDATE, never promotion', () => {
  const out = H3.runExperimentV3(strongPanel(), [sigRanker], {
    folds: 4, seed: 5,
    costEvidenceByRanker: { cand: { net: 0.02, doubledCostNet: 0.01, stressedLiquidityNet: 0.005 } },
  }, { generatedAt: 'T' });
  const v = out.verdicts.cand;
  if (v.tier !== H3.TIERS.NOT_CONFIRMED) {
    assert.equal(v.tier, H3.TIERS.ECONOMIC);
    assert.match(v.verdict, /prospective/);
  }
});

test('tiers: promotion eligibility requires BOTH verified prospective agreement AND a human-review artifact', () => {
  const cost = { cand: { net: 0.02, doubledCostNet: 0.01, stressedLiquidityNet: 0.005 } };
  const noArtifact = H3.runExperimentV3(strongPanel(), [sigRanker], {
    folds: 4, seed: 5, costEvidenceByRanker: cost,
    prospectiveEvidence: { agreementVerified: true, humanReviewArtifact: '' },
  }, { generatedAt: 'T' });
  if (noArtifact.verdicts.cand.tier !== H3.TIERS.NOT_CONFIRMED) {
    assert.equal(noArtifact.verdicts.cand.tier, H3.TIERS.ECONOMIC, 'no artifact → no promotion tier');
  }
  const full = H3.runExperimentV3(strongPanel(), [sigRanker], {
    folds: 4, seed: 5, costEvidenceByRanker: cost,
    prospectiveEvidence: { agreementVerified: true, humanReviewArtifact: 'research/data/evidence/review-2026-08.json' },
  }, { generatedAt: 'T' });
  if (full.verdicts.cand.tier !== H3.TIERS.NOT_CONFIRMED) {
    assert.equal(full.verdicts.cand.tier, H3.TIERS.PROMOTION);
    assert.match(full.verdicts.cand.verdict, /human/);
  }
});

test('costEvidenceCheck: partial evidence is unmeasured and never passes', () => {
  assert.equal(H3.costEvidenceCheck(null).passes, false);
  assert.equal(H3.costEvidenceCheck({ net: 0.02 }).measured, false);
  assert.equal(H3.costEvidenceCheck({ net: 0.02, doubledCostNet: 0.01 }).measured, false);
  const ok = H3.costEvidenceCheck({ net: 0.02, doubledCostNet: 0.01, stressedLiquidityNet: 0.001 });
  assert.equal(ok.measured, true);
  assert.equal(ok.passes, true);
});
