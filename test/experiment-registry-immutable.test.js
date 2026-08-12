const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// recordExperiment writes to the module-level REGISTRY_PATH; point it at a temp dir
// by loading the module fresh with a patched path (the kit exposes REGISTRY_PATH but
// binds it at require time, so we exercise the real file then restore it).
const kit = require('../research/lib/experiment-kit');

test('recordExperiment never overwrites a same-id row — the re-run appends with a parent link', (t) => {
  // Arrange — run against a scratch copy of the real registry, restored afterwards.
  const original = fs.existsSync(kit.REGISTRY_PATH) ? fs.readFileSync(kit.REGISTRY_PATH, 'utf8') : null;
  t.after(() => {
    if (original != null) fs.writeFileSync(kit.REGISTRY_PATH, original);
    else fs.rmSync(kit.REGISTRY_PATH, { force: true });
  });
  const id = `test-immutability-${process.pid}`;

  // Act — record the same experiment id twice with different results.
  kit.recordExperiment({ id, hypothesis: 'h', result: 'first' });
  kit.recordExperiment({ id, hypothesis: 'h', result: 'second' });

  // Assert — both rows exist; the first is untouched; the second is versioned + linked.
  const doc = JSON.parse(fs.readFileSync(kit.REGISTRY_PATH, 'utf8'));
  const rows = doc.experiments.filter(e => e.id === id || String(e.id).startsWith(`${id}.r`));
  assert.strictEqual(rows.length, 2);
  const first = rows.find(e => e.id === id);
  const rerun = rows.find(e => e.id === `${id}.r2`);
  assert.strictEqual(first.result, 'first');
  assert.strictEqual(rerun.result, 'second');
  assert.strictEqual(rerun.parentExperimentId, id);
});
