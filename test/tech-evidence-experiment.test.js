'use strict';
// Prevents: an empty or underpowered panel printing NULL/NO_ALPHA (the cardinal sin),
// gates read from rounded display fields, an FDR family that quietly reshapes itself,
// and VALIDATED being auto-assigned.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/tech-evidence/experiment');
const SCHEMA = require('../lib/tech-evidence/schema');

const row = (d, netFrac, over = {}) => ({
  d, t: over.t || 'MDB', arm: over.arm || 'npm', dir: over.dir || 'positive',
  z: over.z ?? 2, basis: 'live', e: d,
  g: [netFrac, netFrac, netFrac], b: [0, 0, 0], n: [netFrac, netFrac, netFrac],
  cost: 0.0016, tier: 'liquid', bench: 'IGV',
});

function tradingDates(n) {
  const out = [];
  let d = new Date('2024-01-02T00:00:00Z');
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

test('REGRESSION: an empty experiment can never return NULL or any negative verdict', () => {
  const out = E.evaluateAll([], { observedArms: new Set() });
  assert.equal(out.arms.length, SCHEMA.SCORED_ARMS.length * SCHEMA.HORIZONS.length);
  for (const a of out.arms) {
    assert.equal(a.state, SCHEMA.ARM_STATES.INSUFFICIENT_DATA);
    assert.ok(a.stateReason.length > 10, 'the exact reason must be stated');
    assert.notEqual(a.state, 'NULL');
  }
});

test('arms with observations but no resolutions are COLLECTING, not NULL', () => {
  const out = E.evaluateAll([], { observedArms: new Set(['npm']) });
  const npm5 = out.arms.find(a => a.arm === 'npm' && a.horizon === 5);
  const sec5 = out.arms.find(a => a.arm === 'sec' && a.horizon === 5);
  assert.equal(npm5.state, SCHEMA.ARM_STATES.COLLECTING);
  assert.equal(sec5.state, SCHEMA.ARM_STATES.INSUFFICIENT_DATA);
});

test('below the prespecified floor the state is COLLECTING even with resolved events', () => {
  const rows = tradingDates(30).map((d, i) => row(d, 0.01 + 0.001 * (i % 5)));
  const out = E.evaluateAll(rows, { observedArms: new Set(['npm']) });
  const npm5 = out.arms.find(a => a.arm === 'npm' && a.horizon === 5);
  assert.equal(npm5.state, SCHEMA.ARM_STATES.COLLECTING);
  assert.match(npm5.stateReason, /30\/100/);
});

test('at the floor with a consistently positive panel the gate can pass → PROMISING_RESEARCH, never VALIDATED', () => {
  const rows = tradingDates(120).map((d, i) => row(d, 0.008 + 0.004 * Math.sin(i)));
  const out = E.evaluateAll(rows, { observedArms: new Set(['npm']) });
  const npm5 = out.arms.find(a => a.arm === 'npm' && a.horizon === 5);
  assert.ok([SCHEMA.ARM_STATES.PROMISING_RESEARCH, SCHEMA.ARM_STATES.NULL].includes(npm5.state), 'floor reached → verdict allowed');
  assert.equal(npm5.state, SCHEMA.ARM_STATES.PROMISING_RESEARCH, `expected pass, got ${npm5.stateReason}`);
  assert.notEqual(npm5.state, SCHEMA.ARM_STATES.VALIDATED, 'VALIDATED is reserved for the repo promotion policy');
  assert.ok(npm5.gate.fdrSurvives, 'gate must consume the `survives` field from evidence-stats');
});

test('a zero-mean panel at the floor is NULL with the failed checks named', () => {
  const rows = tradingDates(120).map((d, i) => row(d, 0.01 * Math.sin(i * 2.1)));
  const out = E.evaluateAll(rows, { observedArms: new Set(['npm']) });
  const npm5 = out.arms.find(a => a.arm === 'npm' && a.horizon === 5);
  assert.equal(npm5.state, SCHEMA.ARM_STATES.NULL);
  assert.match(npm5.stateReason, /gate failed/);
});

test('the FDR family is exactly scored-arms × {5,10}; 1-session rows are descriptive', () => {
  const out = E.evaluateAll([], { observedArms: new Set() });
  assert.deepEqual(out.family.sort(), ['github:10', 'github:5', 'npm:10', 'npm:5', 'sec:10', 'sec:5']);
  for (const a of out.arms.filter(x => x.horizon === 1)) assert.equal(a.inFamily, false);
});

test('outlier trim: a mean carried entirely by 5 big wins fails outlierRobust', () => {
  const dates = tradingDates(120);
  const rows = dates.map((d, i) => row(d, i < 5 ? 0.8 : -0.002 + 0.0005 * Math.sin(i)));
  const out = E.evaluateAll(rows, { observedArms: new Set(['npm']) });
  const npm5 = out.arms.find(a => a.arm === 'npm' && a.horizon === 5);
  assert.equal(npm5.state, SCHEMA.ARM_STATES.NULL);
  assert.equal(npm5.gate.outlierRobust, false);
});

test('same-day events cluster to one date observation (dedupeToDateSeries wiring)', () => {
  const rows = [
    ...tradingDates(50).map(d => row(d, 0.01)),
    ...tradingDates(50).map(d => row(d, 0.01, { t: 'DDOG' })), // same dates, second name
  ];
  const out = E.evaluateAll(rows, { observedArms: new Set(['npm']) });
  const npm5 = out.arms.find(a => a.arm === 'npm' && a.horizon === 5);
  assert.equal(npm5.resolvedEvents, 100);
  assert.equal(npm5.resolvedDates, 50, 'a shared market day is ONE independent observation, not two');
});
