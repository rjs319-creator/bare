'use strict';
// Five subsystems self-adapt inside production strategies without consulting
// central governance (apex recalibrate, timing tune, dualread adapt, evolve
// strength tilt, alerts-fable). The disclosure module makes them visible from
// the governance payload. These tests pin the honesty contract: every layer is
// always listed, read failures are UNKNOWN (never assumed dormant), and the
// block admits governance was not consulted.
const { test } = require('node:test');
const assert = require('node:assert/strict');

// The module reads Blob docs through lib/store.readJSON; without a configured
// store readJSON rejects/short-circuits, so states come back honestly UNKNOWN
// or DORMANT — never ACTIVE.
test('all five layers are always disclosed, and no layer is ACTIVE without evidence', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const { readAdaptiveLayers, ADAPTIVE_LAYERS_VERSION } = require('../lib/adaptive-layers');

  const report = await readAdaptiveLayers();
  assert.equal(report.version, ADAPTIVE_LAYERS_VERSION);
  assert.equal(report.governanceConsulted, false, 'the block must admit governance is not consulted');
  assert.equal(report.layers.length, 5);

  const names = report.layers.map(l => l.layer).sort();
  assert.deepEqual(names, ['alerts-fable', 'apex-recalibrate', 'dualread-adapt', 'evolve-strength-tilt', 'timing-tune']);

  for (const l of report.layers) {
    assert.ok(['ACTIVE', 'DORMANT', 'UNKNOWN'].includes(l.state), `unexpected state ${l.state}`);
    assert.notEqual(l.state, 'ACTIVE', 'with no store there is no evidence of an active layer');
    assert.equal(l.governanceConsulted, false);
    assert.ok(l.detail, 'every layer must carry a human-readable detail');
  }
});
