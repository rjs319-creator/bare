'use strict';
// Tests for the research data-quality gate (scripts/audit-research-data.js, v2):
// a coherent fixture panel PASSES (exit 0), a poisoned one FAILS (exit 1), an
// absent panel SKIPS (exit 0), and each v2 detection (partial cohort declared
// eligible, evidence beyond the last fully observed cohort, null code commit,
// future-path quality classes, unverified cost evidence) FAILS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'audit-research-data.js');
const MF = require('../research/lib/manifest');
const CAL = require('../research/lib/calendar');
const COHORT = require('../research/lib/cohort');
const SV = require('../lib/research/survivorship');

const DAY = 86400000;
const D0 = Date.UTC(2024, 0, 2);
const iso = (i) => new Date(D0 + i * DAY).toISOString().slice(0, 10);
const HEX = (c) => c.repeat(64);

function run(dataDir) {
  try {
    const out = execFileSync('node', [SCRIPT], { encoding: 'utf8', env: { ...process.env, RESEARCH_DATA_DIR: dataDir } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// Fixture: two mature 21s rows on 2024-01-31 (fully observed cohort) and one
// pending row on 2024-02-29 (ineligible cohort). Calendar = daily sessions.
function fixtureDir(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixture-'));
  const calendar = CAL.buildSessionCalendar(Array.from({ length: 120 }, (_, i) => iso(i)), { source: 'fixture' });
  const panel = {
    '2024-01': [
      { s: 'AAA', cs: 'AAA', lid: 'L1', dt: '2024-01-31', cap: 5e8, adv: 5e6, m121: 0.1, f21: 0.05, s21: 'm', le21: '2024-02-28', f63: null, s63: 'p', le63: null, f126: null, s126: 'p', le126: null },
      { s: 'BBB', cs: 'BBB', lid: 'L2', dt: '2024-01-31', cap: 6e8, adv: 4e6, m121: -0.05, f21: -0.02, s21: 'm', le21: '2024-02-27', f63: null, s63: 'p', le63: null, f126: null, s126: 'p', le126: null },
    ],
    '2024-02': [
      { s: 'AAA', cs: 'AAA', lid: 'L1', dt: '2024-02-29', cap: 5e8, adv: 5e6, m121: 0.1, f21: null, s21: 'p', le21: null, f63: null, s63: 'p', le63: null, f126: null, s126: 'p', le126: null },
    ],
  };
  const ledger = COHORT.computeCohortLedger({ panelByMonth: panel, calendar, horizons: [21, 63, 126], labelObservationCutoff: '2024-03-01' });
  const manifest = MF.buildSnapshotManifest({
    snapshotId: 'fix', datasetHash: MF.normalizedPanelHash(panel), generatedAt: 'T',
    sourceHashes: {
      securityMasterPayloadHash: HEX('a'), universePayloadHash: HEX('b'),
      corpactionsMerkleRoot: HEX('c'), priceCacheMerkleRoot: HEX('d'),
      marketCalendarHash: calendar.calendarHash, cohortEligibilityHash: ledger.ledgerHash,
    },
    build: {
      codeCommit: HEX('e').slice(0, 40), worktreeDirty: false, dirtyDiffHash: null,
      buildCommand: 'node fixture', generationParams: {}, sourceSchemaVersions: {},
    },
    sources: [],
    featureAvailabilityCutoff: '2024-03-01', lastDecisionTimestamp: '2024-02-29',
    labelObservationCutoff: '2024-03-01',
    lastLabelReadyDecisionDateByHorizon: { 21: '2024-01-31', 63: null, 126: null },
    lastFullyObservedCohortDateByHorizon: Object.fromEntries(Object.entries(ledger.byHorizon).map(([h, v]) => [h, v.lastFullyObservedCohortDate])),
    cohortEligibilityByHorizon: COHORT.ledgerManifestSummary(ledger),
    cohortCoveragePolicy: { minOutcomeCoverage: COHORT.DEFAULT_MIN_OUTCOME_COVERAGE },
    ineligibleCohortCounts: Object.fromEntries(Object.entries(ledger.byHorizon).map(([h, v]) => [h, v.ineligibleCounts])),
    priceAdjustmentBasis: 'fixture', corporateActionStatus: 'fixture', sectorClassificationBasis: 'fixture',
    survivorship: SV.makeSurvivorshipContract({ historicalListingSource: 'fixture payload', delistedSecuritiesCovered: 1 }),
    rowCount: 3, securityCount: 2, labelStateCounts: {},
  });
  const doc = {
    panelVersion: 'panel-v3.2-fixture', datasetHash: manifest.datasetHash,
    securityMasterBuiltAt: new Date().toISOString(),
    panel, manifest,
  };
  const files = {
    'market-calendar-v1.json': CAL.calendarArtifact(calendar),
    'cohort-eligibility-v3.json': ledger,
    'identity-quality-v3.json': { fixture: true, quarantinedGroups: 0 },
    'extreme-returns-v3.json': { fixture: true, events: 0, byClass: {}, persistenceDiagnostics: {}, poisonedLabels: 0 },
    'universe-coverage-v3.json': { fixture: true, monthlyFunnel: {} },
    'panel-v3-manifest.json': { manifest },
  };
  if (mutate) mutate(doc, files, { calendar, ledger });
  fs.writeFileSync(path.join(dir, 'panel-features-v3.json'), JSON.stringify(doc));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  return dir;
}

test('audit gate: absent panel → SKIPPED, exit 0 (CI-safe)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-empty-'));
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /SKIPPED/);
});

test('audit gate: coherent panel + manifest + cohort ledger → PASS, exit 0', () => {
  const r = run(fixtureDir());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS/);
});

test('audit gate: duplicate (lid, dt) keys → FAIL, exit 1', () => {
  const dir = fixtureDir((doc) => {
    doc.panel['2024-01'].push({ ...doc.panel['2024-01'][0], s: 'AAA2' });
    doc.manifest = { ...doc.manifest, rowCount: 4, datasetHash: MF.normalizedPanelHash(doc.panel) };
    doc.datasetHash = doc.manifest.datasetHash;
  });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /duplicate/);
});

test('audit gate: numeric label on a non-trainable state → FAIL, exit 1', () => {
  const dir = fixtureDir((doc) => {
    doc.panel['2024-01'][0].f63 = 0.07;          // s63 is 'p' — pending must be null
    doc.manifest = { ...doc.manifest, datasetHash: MF.normalizedPanelHash(doc.panel) };
    doc.datasetHash = doc.manifest.datasetHash;
  });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /non-trainable/);
});

test('audit gate: tampered rows (hash mismatch) → FAIL, exit 1', () => {
  const dir = fixtureDir((doc) => { doc.panel['2024-01'][0].f21 = 0.5; });   // manifest hash now stale
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /datasetHash mismatch/);
});

test('audit gate: a partial cohort declared fully observed → FAIL (the May-2026 defect)', () => {
  // Manifest claims the pending Feb cohort is fully observed for 21s.
  const dir = fixtureDir((doc) => {
    doc.manifest = { ...doc.manifest, lastFullyObservedCohortDateByHorizon: { ...doc.manifest.lastFullyObservedCohortDateByHorizon, 21: '2024-02-29' } };
  });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /later than the calendar permits|partial cohort/);
});

test('audit gate: missing calendar artifact → FAIL (cohorts unverifiable)', () => {
  const dir = fixtureDir((doc, files) => { delete files['market-calendar-v1.json']; });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /calendar/);
});

test('audit gate: null code commit → FAIL (confirmatory reproducibility impossible)', () => {
  const dir = fixtureDir((doc) => {
    doc.manifest = { ...doc.manifest, build: { ...doc.manifest.build, codeCommit: null, reproducibility: MF.REPRODUCIBILITY.NON_REPRODUCIBLE } };
  });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /codeCommit/);
});

test('audit gate: future-path classes in the data-cleaning layer → FAIL', () => {
  const dir = fixtureDir((doc, files) => {
    files['extreme-returns-v3.json'] = { events: 3, byClass: { 'spike-revert': 2, ambiguous: 1 }, poisonedLabels: 3 };
  });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /future-path/);
});

test('audit gate: current-hash evidence evaluated beyond the last fully observed cohort → FAIL', () => {
  const dir = fixtureDir();
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'panel-features-v3.json'), 'utf8'));
  fs.mkdirSync(path.join(dir, 'evidence', 'test-hypothesis'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence', 'test-hypothesis', 'aaaa.json'), JSON.stringify({
    schema: 'EvidenceRecord', recordId: 'aaaa', hypothesisId: 'test-hypothesis',
    datasetHash: `panel-features-v3:${doc.datasetHash.slice(0, 16)}`,
    periodStart: '2024-01-31', periodEnd: '2024-02-29',   // beyond lastFullyObserved 21s = 2024-01-31
    horizon: '21d', mode: 'confirmatory', verdict: 'inconclusive', metrics: {},
  }));
  const r = run(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /exceeds last fully observed/);
});

test('audit gate: unverifiable cost evidence in a current-hash record → FAIL', () => {
  const dir = fixtureDir();
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'panel-features-v3.json'), 'utf8'));
  fs.mkdirSync(path.join(dir, 'evidence', 'cost-hypothesis'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence', 'cost-hypothesis', 'bbbb.json'), JSON.stringify({
    schema: 'EvidenceRecord', recordId: 'bbbb', hypothesisId: 'cost-hypothesis',
    datasetHash: `panel-features-v3:${doc.datasetHash.slice(0, 16)}`,
    periodStart: '2024-01-31', periodEnd: '2024-01-31', horizon: '21d',
    mode: 'confirmatory', verdict: 'inconclusive',
    metrics: { costEvidence: { net: 0.02, doubledCostNet: 0.01, stressedLiquidityNet: 0.005 } },   // hand-invented numbers
  }));
  const r = run(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cost evidence rejected/);
});

test('audit gate: evidence triage — superseded records with a current rerun are INFO, without one a WARNING (still exit 0)', () => {
  const dir = fixtureDir();
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'panel-features-v3.json'), 'utf8'));
  // Hypothesis A: old + current record → expected history.
  fs.mkdirSync(path.join(dir, 'evidence', 'hyp-a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence', 'hyp-a', 'old1.json'), JSON.stringify({ recordId: 'old1', hypothesisId: 'hyp-a', datasetHash: 'panel-features-v3:0000000000000000', periodStart: '2024-01-31', periodEnd: '2024-01-31', horizon: '21d', mode: 'confirmatory', verdict: 'not-confirmed', metrics: {} }));
  fs.writeFileSync(path.join(dir, 'evidence', 'hyp-a', 'new1.json'), JSON.stringify({ recordId: 'new1', hypothesisId: 'hyp-a', datasetHash: `panel-features-v3:${doc.datasetHash.slice(0, 16)}`, periodStart: '2024-01-31', periodEnd: '2024-01-31', horizon: '21d', mode: 'confirmatory', verdict: 'not-confirmed', metrics: {} }));
  // Hypothesis B: only an old record → needs a rerun.
  fs.mkdirSync(path.join(dir, 'evidence', 'hyp-b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence', 'hyp-b', 'old2.json'), JSON.stringify({ recordId: 'old2', hypothesisId: 'hyp-b', datasetHash: 'panel-features-v3:1111111111111111', periodStart: '2024-01-31', periodEnd: '2024-01-31', horizon: '21d', mode: 'confirmatory', verdict: 'not-confirmed', metrics: {} }));
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /hyp-b/);          // warned: needs rerun
  assert.ok(!/warning:.*hyp-a/.test(r.out), 'hypothesis with a current rerun is not warned about');
});
