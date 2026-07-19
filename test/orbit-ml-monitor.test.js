'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Mon = require('../lib/orbit-ml-monitor');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

// Resolved ORBIT-ML ledger: `sign`>0 predictive rankScore, <0 inverted.
function resolvedLedger(nDates, nNames, seed, sign = 1) {
  const rnd = lcg(seed); const map = {};
  for (let d = 0; d < nDates; d++) {
    const date = new Date(new Date('2025-01-06T00:00:00Z').getTime() + d * 7 * 86400000).toISOString().slice(0, 10);
    for (let t = 0; t < nNames; t++) {
      const rankScore = rnd();
      const net = sign * (rankScore - 0.5) * 0.2 + sign * 0.012 + (rnd() - 0.5) * 0.02;
      map[`T${t}:${date}`] = { ticker: `T${t}`, decisionTs: date, rankScore, horizons: { days21: { resolved: true, positiveResidual: net > 0 ? 1 : 0, netReturn: +net.toFixed(4), residualReturn: +net.toFixed(4), severeLoss: net <= -0.08 ? 1 : 0 } } };
    }
  }
  return map;
}

test('monitorOrbitMl composes health + grade + shadow status', () => {
  const out = Mon.monitorOrbitMl(resolvedLedger(30, 12, 1, +1), { horizon: 'days21' });
  assert.strictEqual(out.shadow.affectsLiveRank, false);
  assert.strictEqual(out.shadow.specialist, 'idiosyncraticPersistence');
  assert.ok(out.health.byHorizon.days21, 'health per horizon');
  assert.ok(out.grades.days21, 'grade per horizon');
});

test('healthy resolved set → HEALTHY at 21d; grade not A without survivorship-safe', () => {
  const out = Mon.monitorOrbitMl(resolvedLedger(30, 12, 2, +1), { horizon: 'days21' });
  assert.strictEqual(out.health.byHorizon.days21.status, 'HEALTHY');
  assert.notStrictEqual(out.grades.days21.grade, 'A', 'A requires survivorship-safe + prospective');
});

test('too little data → INSUFFICIENT_DATA and grade C', () => {
  const out = Mon.monitorOrbitMl(resolvedLedger(4, 5, 3), { horizon: 'days21' });
  assert.strictEqual(out.health.byHorizon.days21.status, 'INSUFFICIENT_DATA');
  assert.ok(['C', 'F'].includes(out.grades.days21.grade));
});

test('incremental leave-one-out is reported when a joint cross-section is supplied', () => {
  const rnd = lcg(4); const joint = [];
  for (let d = 0; d < 20; d++) for (let t = 0; t < 10; t++) {
    const orbit = rnd(), peer = rnd();
    joint.push({ date: `2025-03-${String(1 + d).padStart(2, '0')}`, ticker: `T${t}`, outcome: (orbit - 0.5) * 0.2, scores: { momentumIgnition: peer, idiosyncraticPersistence: orbit } });
  }
  const out = Mon.monitorOrbitMl(resolvedLedger(20, 10, 5), { jointPredictions: joint });
  assert.ok(out.incremental.leaveOneOut && out.incremental.leaveOneOut.ready);
  assert.ok(out.incremental.leaveOneOut.marginalDelta > 0);
});
