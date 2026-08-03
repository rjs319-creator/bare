'use strict';
// Adversarial tests for harness-v3.1: purged+embargoed walk-forward folds and
// the three-tier cost-gated verdict contract. Each test constructs the leak or
// null-pass the upgrade exists to prevent and proves it is caught.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const H3 = require('../lib/research/harness-v3');
const EX = require('../lib/research/execution');
const SV = require('../lib/research/survivorship');

// v3.2: cost evidence must come from the execution engine. Build a real
// artifact from synthetic bars whose exit close yields the wanted gross.
// ADV 100e6 → 'large' tier → base round-trip 12bps (commission 1bp/side).
function engineEvidence(exitClose) {
  const DAY = 86400000;
  const bars = Array.from({ length: 30 }, (_, i) => ({
    ms: Date.UTC(2026, 0, 2) + i * DAY, open: 100, high: 101, low: 99, close: i === 25 ? exitClose : 100,
  }));
  const fill = EX.executableOutcome({ bars, decisionIdx: 4, horizonSessions: 21, adv: 100e6 });
  return EX.buildCostEvidence({ fills: [fill], strategyId: 'test', datasetHash: 'h1', horizonSessions: 21 });
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// v3.2: every experiment needs an explicit eligible-cohort map.
const allElig = (rows) => ({ eligibleDates: [...new Set(rows.map((r) => r.decisionTs))], source: 'test-synthetic-fully-observed' });

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
  const out = H3.runExperimentV3(rows, [], { folds: 4, seed: 1, embargoBars: 2, cohortEligibility: allElig(rows) }, { generatedAt: 'T' });
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
  const rows = strongPanel();
  const out = H3.runExperimentV3(rows, [sigRanker], { folds: 4, seed: 5, cohortEligibility: allElig(rows) }, { generatedAt: 'T' });
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
  // Exit 100.15 → gross 15bps: positive at base 12bps, negative at 24bps.
  const rows = strongPanel();
  const out = H3.runExperimentV3(rows, [sigRanker], {
    folds: 4, seed: 5, cohortEligibility: allElig(rows),
    costEvidenceByRanker: { cand: engineEvidence(100.15) },
  }, { generatedAt: 'T' });
  const v = out.verdicts.cand;
  assert.equal(v.costEvidence.measured, true);
  assert.equal(v.costEvidence.passes, false);
  if (v.tier !== H3.TIERS.NOT_CONFIRMED) assert.equal(v.tier, H3.TIERS.STATISTICAL);
});

test('tiers: full measured cost evidence + statistical pass → ECONOMICALLY_VIABLE_CANDIDATE, never promotion', () => {
  // Exit 103 → gross ~3%: positive under base, doubled and stressed costs.
  const rows = strongPanel();
  const out = H3.runExperimentV3(rows, [sigRanker], {
    folds: 4, seed: 5, cohortEligibility: allElig(rows),
    costEvidenceByRanker: { cand: engineEvidence(103) },
  }, { generatedAt: 'T' });
  const v = out.verdicts.cand;
  if (v.tier !== H3.TIERS.NOT_CONFIRMED) {
    assert.equal(v.tier, H3.TIERS.ECONOMIC);
    assert.match(v.verdict, /prospective/);
  }
});

// The full promotion-gate requirement set (v3.2): dataset currency, model
// version, proven-safe survivorship, timestamped prospective sample,
// calibration, and a HASH-VERIFIED human-review artifact — a nonempty string
// is no longer sufficient.
function promotionFixtures() {
  const reviewContent = 'Reviewed 2026-08-02: prospective log matches, costs verified, approve for registry review.';
  return {
    cost: { cand: engineEvidence(103) },
    survivorship: SV.makeSurvivorshipContract({
      historicalListingSource: 'exchange-monthly-listings',
      historicalListingSourceAuthoritative: true,
      monthlyExpectedListingCount: { '2026-01': 100, '2026-02': 100 },
      monthlyCoveredListingCount: { '2026-01': 100, '2026-02': 99 },
      delistedSecuritiesExpected: 20, delistedSecuritiesCovered: 20,
      totalSecurities: 100,
    }),
    prospective: {
      agreementVerified: true, predictionsTimestampedBeforeOutcomes: true,
      sampleSize: 40, probabilitiesUsed: false,
    },
    review: { artifactContent: reviewContent, artifactHash: sha(reviewContent) },
  };
}

test('tiers: promotion requires the FULL gate — each missing requirement blocks it', () => {
  const fx = promotionFixtures();
  assert.equal(fx.survivorship.status, 'proven-safe', 'fixture sanity');
  const run = (optsOver = {}, metaOver = {}) => {
    const rows = strongPanel();
    return H3.runExperimentV3(rows, [sigRanker], {
      folds: 4, seed: 5, cohortEligibility: allElig(rows),
      costEvidenceByRanker: fx.cost,
      currentDatasetHash: 'h1',
      prospectiveEvidence: fx.prospective,
      humanReviewArtifact: fx.review,
      ...optsOver,
    }, {
      generatedAt: 'T', datasetHash: 'h1', modelVersion: 'frozen-v1',
      survivorship: fx.survivorship,
      ...metaOver,
    });
  };
  const full = run();
  const v = full.verdicts.cand;
  if (v.tier !== H3.TIERS.NOT_CONFIRMED) {
    assert.equal(v.tier, H3.TIERS.PROMOTION);
    assert.equal(v.promotionGate.eligible, true);
    assert.match(v.promotionGate.note, /registry/);
  }
  // Each single missing requirement caps the tier at ECONOMIC.
  const degraded = [
    run({ humanReviewArtifact: { artifactContent: fx.review.artifactContent, artifactHash: 'wrong' } }),
    run({ humanReviewArtifact: null }),
    run({ prospectiveEvidence: { ...fx.prospective, sampleSize: 3 } }),
    run({ prospectiveEvidence: { ...fx.prospective, predictionsTimestampedBeforeOutcomes: false } }),
    run({ prospectiveEvidence: { ...fx.prospective, probabilitiesUsed: true, calibrationPassed: false } }),
    run({ currentDatasetHash: 'DIFFERENT' }),
    run({}, { modelVersion: null }),
    run({}, { survivorship: SV.makeSurvivorshipContract({ historicalListingSource: 'symbols.json', delistedSecuritiesCovered: 5 }) }),
    run({}, { survivorship: { schema: 'SurvivorshipContract', status: 'proven-safe' } }),   // forged claim without measurements
  ];
  for (const out of degraded) {
    const dv = out.verdicts.cand;
    if (dv.tier !== H3.TIERS.NOT_CONFIRMED) {
      assert.equal(dv.tier, H3.TIERS.ECONOMIC, `missing requirement must block promotion (failed: ${dv.promotionGate.failed.join(',') || 'none'})`);
      assert.ok(dv.promotionGate.failed.length > 0);
    }
  }
});

test('costEvidenceCheck: arbitrary caller-supplied numbers are unmeasured and never pass', () => {
  assert.equal(H3.costEvidenceCheck(null).passes, false);
  // The old defect: bare positive numbers claimed as "measured".
  const bare = H3.costEvidenceCheck({ net: 0.02, doubledCostNet: 0.01, stressedLiquidityNet: 0.001 });
  assert.equal(bare.measured, false, 'no engine artifact → unmeasured');
  assert.equal(bare.passes, false);
  // Tampered artifact: flip a number after hashing → rejected.
  const good = engineEvidence(103);
  const tampered = { ...good, net: 0.5 };
  assert.equal(H3.costEvidenceCheck(tampered).measured, false);
  // Signal-close entry basis can never satisfy the economic gate.
  const { artifactHash, ...payload } = good;
  const signalClose = { ...payload, entryBasis: 'signal-day-close' };
  signalClose.artifactHash = sha(JSON.stringify(signalClose));   // even a "consistent" hash cannot save the wrong basis
  const sc = H3.costEvidenceCheck(signalClose);
  assert.equal(sc.measured, false);
  assert.match(sc.detail, /never an executable entry|not produced/);
  // A genuine engine artifact IS measured.
  const ok = H3.costEvidenceCheck(good);
  assert.equal(ok.measured, true);
  assert.equal(ok.passes, true);
});
