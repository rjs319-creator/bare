const test = require('node:test');
const assert = require('node:assert');
const { diffGovernance, recordGovernanceTransitions, GOV_TRANSITIONS_VERSION } = require('../lib/governance-transitions');

test('diffGovernance emits nothing when status and version are unchanged', () => {
  // Arrange
  const prev = [{ id: 'screener', status: 'paper', version: 'scr-v5', weight: 0 }];
  const next = [{ id: 'screener', status: 'paper', version: 'scr-v5', weight: 0 }];

  // Act
  const out = diffGovernance(prev, next);

  // Assert
  assert.deepStrictEqual(out, []);
});

test('diffGovernance records old state, new state, versions, weights and reason on a status change', () => {
  // Arrange
  const prev = [{ id: 'screener', status: 'production', version: 'scr-v5', weight: 1 }];
  const next = [{ id: 'screener', status: 'disabled', version: 'scr-v5', weight: 0, reason: 'resolved record underperforms benchmark' }];

  // Act
  const out = diffGovernance(prev, next);

  // Assert
  assert.strictEqual(out.length, 1);
  const t = out[0];
  assert.strictEqual(t.from, 'production');
  assert.strictEqual(t.to, 'disabled');
  assert.strictEqual(t.fromVersion, 'scr-v5');
  assert.strictEqual(t.toVersion, 'scr-v5');
  assert.strictEqual(t.fromWeight, 1);
  assert.strictEqual(t.toWeight, 0);
  assert.match(t.reason, /underperforms/);
});

test('diffGovernance records a version change even when status is unchanged', () => {
  // Arrange — a scoring-version bump is a governance event: old evidence no longer applies.
  const prev = [{ id: 'coil', status: 'paper', version: 'coil-v2', weight: 0 }];
  const next = [{ id: 'coil', status: 'paper', version: 'coil-v3', weight: 0, versionReset: true }];

  // Act
  const out = diffGovernance(prev, next);

  // Assert
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].fromVersion, 'coil-v2');
  assert.strictEqual(out[0].toVersion, 'coil-v3');
  assert.strictEqual(out[0].versionReset, true);
});

test('diffGovernance treats first sight and disappearance as transitions', () => {
  // Arrange
  const prev = [{ id: 'gone', status: 'paper', version: 'g-v1', weight: 0 }];
  const next = [{ id: 'new', status: 'paper', version: 'n-v1', weight: 0 }];

  // Act
  const out = diffGovernance(prev, next);

  // Assert
  const gone = out.find(t => t.id === 'gone');
  const fresh = out.find(t => t.id === 'new');
  assert.strictEqual(gone.to, null);
  assert.strictEqual(gone.from, 'paper');
  assert.strictEqual(fresh.from, null);
  assert.strictEqual(fresh.to, 'paper');
});

test('diffGovernance stamps approval context on a move into production', () => {
  // Arrange
  const prev = [{ id: 's', status: 'paper', version: 'v1', weight: 0 }];
  const next = [{ id: 's', status: 'production', version: 'v1', weight: 1, reason: 'artifact approved' }];

  // Act
  const out = diffGovernance(prev, next);

  // Assert
  assert.strictEqual(out[0].approval.artifactRequired, true);
});

test('recordGovernanceTransitions returns count 0 and does not attempt an append when nothing changed', async () => {
  // Arrange
  const doc = { strategies: [{ id: 'a', status: 'paper', version: 'v1', weight: 0 }] };

  // Act
  const report = await recordGovernanceTransitions(doc, doc, {});

  // Assert
  assert.strictEqual(report.count, 0);
  assert.strictEqual(report.logged, false);
  assert.strictEqual(report.error, null);
  assert.strictEqual(report.version, GOV_TRANSITIONS_VERSION);
});

test('recordGovernanceTransitions surfaces a failed ledger append instead of throwing', async (t) => {
  // Arrange — no BLOB_READ_WRITE_TOKEN in the test env ⇒ immutable-ledger append throws.
  const saved = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  t.after(() => { if (saved !== undefined) process.env.BLOB_READ_WRITE_TOKEN = saved; });
  const prev = { strategies: [{ id: 'a', status: 'paper', version: 'v1', weight: 0 }] };
  const next = { strategies: [{ id: 'a', status: 'probation', version: 'v1', weight: 0.25 }] };

  // Act
  const report = await recordGovernanceTransitions(prev, next, {});

  // Assert
  assert.strictEqual(report.count, 1);
  assert.strictEqual(report.logged, false);
  assert.match(String(report.error), /Blob storage not configured/);
});
