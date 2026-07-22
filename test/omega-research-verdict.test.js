'use strict';
// OMEGA research-verdict surface tests: op=omegamodel exposes the RECORDED survivorship-free
// verdict honestly (survivorshipSafe true = research-side; promotable false; no fabricated pass).
const { test } = require('node:test');
const assert = require('node:assert');
const { researchVerdict } = require('../lib/omega-research-verdict');

test('the committed research verdict is present and self-describing', () => {
  const v = researchVerdict();
  assert.strictEqual(v.available, true, 'the survivorship-free artifact is committed');
  assert.strictEqual(v.version, 'omega-research-verdict-v1');
  assert.match(v.experiment, /53-omega-survivorship-free/);
  assert.ok(v.generatedAt && v.doc, 'carries provenance (when + which doc)');
});

test('survivorshipSafe is scoped to the RESEARCH evidence, not the live app replay', () => {
  const v = researchVerdict();
  assert.strictEqual(v.survivorshipSafe, true, 'research-side is survivorship-complete');
  assert.match(v.scope, /research-side survivorship-complete/i);
  assert.match(v.scope, /distinct from the app-side/i);
});

test('the recorded verdict is honest: no-edge, not passed, not promotable', () => {
  const v = researchVerdict();
  assert.strictEqual(v.verdict, 'no-edge');
  assert.strictEqual(v.passed, false);
  assert.strictEqual(v.promotable, false, 'no fabricated promotion');
  assert.strictEqual(v.historicalLiveParity, false);
});

test('the universe was survivorship-complete (delisted names included)', () => {
  const v = researchVerdict();
  assert.ok(v.universe.delisted > 0, 'delisted names were in the panel');
  assert.ok(v.universe.nameDates > 0);
});

test('metrics show the score below the momentum baseline (consistent with no-edge)', () => {
  const v = researchVerdict();
  assert.ok(Number.isFinite(v.metrics.scoreIC_survivorshipFree));
  assert.ok(Number.isFinite(v.metrics.momentumBaselineIC));
  assert.ok(v.metrics.scoreIC_survivorshipFree <= v.metrics.momentumBaselineIC, 'does not beat momentum');
  assert.strictEqual(v.gates.survivorshipSafe, true);
});
