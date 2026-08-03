'use strict';
// Smoke tests for the research data-quality gate (scripts/audit-research-data.js):
// a coherent fixture panel PASSES (exit 0), a poisoned one FAILS (exit 1), and
// an absent panel SKIPS (exit 0) so CI never breaks on a fresh clone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'audit-research-data.js');
const MF = require('../research/lib/manifest');

function run(dataDir) {
  try {
    const out = execFileSync('node', [SCRIPT], { encoding: 'utf8', env: { ...process.env, RESEARCH_DATA_DIR: dataDir } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function fixtureDir(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixture-'));
  const panel = {
    '2024-01': [
      { s: 'AAA', cs: 'AAA', lid: 'L1', dt: '2024-01-31', cap: 5e8, adv: 5e6, m121: 0.1, f21: 0.05, s21: 'm', le21: '2024-02-28', f63: null, s63: 'p', le63: null, f126: null, s126: 'p', le126: null },
      { s: 'BBB', cs: 'BBB', lid: 'L2', dt: '2024-01-31', cap: 6e8, adv: 4e6, m121: -0.05, f21: -0.02, s21: 'm', le21: '2024-02-27', f63: null, s63: 'p', le63: null, f126: null, s126: 'p', le126: null },
    ],
  };
  const doc = {
    panelVersion: 'panel-v3.1-fixture', datasetHash: MF.normalizedPanelHash(panel),
    securityMasterBuiltAt: new Date().toISOString(),
    panel,
    manifest: MF.buildSnapshotManifest({
      snapshotId: 'fix', datasetHash: MF.normalizedPanelHash(panel), generatedAt: 'T',
      securityMasterHash: 'x', universeDefinitionHash: 'y', sources: [],
      featureAvailabilityCutoff: '2024-03-01', lastDecisionTimestamp: '2024-01-31',
      labelObservationCutoff: '2024-03-01', lastFullyMatureDecisionDate: { 21: '2024-01-31', 63: null, 126: null },
      priceAdjustmentBasis: 'fixture', corporateActionStatus: 'fixture', sectorClassificationBasis: 'fixture',
      rowCount: 2, securityCount: 2, labelStateCounts: {},
    }),
  };
  if (mutate) mutate(doc);
  fs.writeFileSync(path.join(dir, 'panel-features-v3.json'), JSON.stringify(doc));
  for (const f of ['identity-quality-v3.json', 'extreme-returns-v3.json', 'universe-coverage-v3.json', 'panel-v3-manifest.json']) {
    fs.writeFileSync(path.join(dir, f), JSON.stringify({ fixture: true, quarantinedGroups: 0, events: 0, byClass: {}, monthlyFunnel: {} }));
  }
  return dir;
}

test('audit gate: absent panel → SKIPPED, exit 0 (CI-safe)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-empty-'));
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /SKIPPED/);
});

test('audit gate: coherent panel + manifest → PASS, exit 0', () => {
  const r = run(fixtureDir());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS/);
});

test('audit gate: duplicate (lid, dt) keys → FAIL, exit 1', () => {
  const dir = fixtureDir((doc) => {
    doc.panel['2024-01'].push({ ...doc.panel['2024-01'][0], s: 'AAA2' });
    doc.manifest = { ...doc.manifest, rowCount: 3, datasetHash: MF.normalizedPanelHash(doc.panel) };
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
