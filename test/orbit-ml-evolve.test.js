'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const A = require('../lib/orbit-ml-evolve');
const Evolve = require('../lib/evolve');

test('shadow contract: shadow/true, affectsLiveRank/false, routerWeight/0, unmapped', () => {
  const s = A.shadowStatus();
  assert.strictEqual(s.shadow, true);
  assert.strictEqual(s.affectsLiveRank, false);
  assert.strictEqual(s.routerWeight, 0);
  assert.strictEqual(s.sourceMapped, false);
});

test('LIVE-RANK FIREWALL: specialist is registered but has NO source mapping', () => {
  // Registered as an archetype (legend/health)...
  assert.ok(Evolve.SPECIALISTS.includes('idiosyncraticPersistence'), 'in SPECIALISTS');
  assert.ok(Evolve.SPECIALIST_META.idiosyncraticPersistence, 'has meta');
  // ...but sourceToSpecialists can never return it → it never fires on a live candidate.
  const allSources = ['ghost', 'screener', 'momentum', 'coil', 'biotech', 'confluence', 'readthrough', 'anomaly', 'daytrade', 'gapgo', 'cern', 'tone', 'fade'];
  const fired = Evolve.sourceToSpecialists(allSources);
  assert.ok(!fired.includes('idiosyncraticPersistence'), 'never fires on any live source');
});

test('specialistRows converts resolved predictions to redundancy rows (residual excess)', () => {
  const resolved = {
    'A:2024-01-02': { ticker: 'A', decisionTs: '2024-01-02', horizons: { days21: { resolved: true, residualReturn: 0.03, netReturn: 0.02 } } },
    'B:2024-01-02': { ticker: 'B', decisionTs: '2024-01-02', horizons: { days21: { resolved: false } } },
    'C:2024-01-03': { ticker: 'C', decisionTs: '2024-01-03', horizons: { days21: { resolved: true, netReturn: 0.01 } } },
  };
  const rows = A.specialistRows(resolved, { horizon: 'days21' });
  assert.strictEqual(rows.length, 2, 'only resolved horizons');
  assert.ok(rows.every(r => r.algorithm === 'idiosyncraticPersistence'));
  assert.strictEqual(rows.find(r => r.ticker === 'A').excess, 0.03, 'prefers residual return');
  assert.strictEqual(rows.find(r => r.ticker === 'C').excess, 0.01, 'falls back to net return');
});

test('toShadowRecord carries the specialist tag + shadow flags', () => {
  const rec = A.toShadowRecord({ ticker: 'X', decisionTs: '2024-01-02', classification: 'WATCH', horizon: { days21: { rankScore: 0.7, pResidualUp: 0.55, expectedNetReturn: 0.01 } } });
  assert.strictEqual(rec.specialist, 'idiosyncraticPersistence');
  assert.strictEqual(rec.affectsLiveRank, false);
  assert.strictEqual(rec.rankScore, 0.7);
});
