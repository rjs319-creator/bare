'use strict';
// Research honesty: PIT record building, purged/embargoed splits, the proven gate's
// fail-closed conditions, and the rule that sample sufficiency alone can never prove.
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/patterns/research');

function rec(date, { family = 'BULL_FLAG', direction = 'LONG', timeframe = '20d', ticker = 'ABC', targetFirst = true, net = 1, idx = 0 } = {}) {
  return {
    ticker, asOfDate: date, asOfIdx: idx, timeframe, family, direction, regime: 'RISK_ON',
    outcome: { filled: true, targetFirst, netReturnPct: net },
  };
}

test('research: same-ticker overlapping windows are purged (no overlap inflation)', () => {
  const rs = [rec('2025-01-01', { idx: 100 }), rec('2025-01-05', { idx: 103 }), rec('2025-03-01', { idx: 140 })];
  const purged = R.purgeOverlaps(rs, 21);
  assert.strictEqual(purged.length, 2, 'the 3-bar-later duplicate is dropped');
});

test('research: chronological split is anchored with an embargo gap', () => {
  const rs = [];
  for (let i = 0; i < 100; i++) {
    const d = new Date(Date.parse('2024-01-01') + i * 5 * 86400000).toISOString().slice(0, 10);
    rs.push(rec(d, { idx: i * 5, ticker: 'T' + i }));
  }
  const s = R.splitChronology(rs, { embargoDays: 30 });
  assert.ok(s.train.length && s.calibration.length && s.evaluation.length);
  const trainMax = s.train.map(r => r.asOfDate).sort().pop();
  const calMin = s.calibration.map(r => r.asOfDate).sort()[0];
  assert.ok(Date.parse(calMin) - Date.parse(trainMax) >= 0, 'train strictly precedes calibration');
});

test('research: provenGate fails closed on a small sample — sufficiency alone can NEVER prove', () => {
  const cell = {
    effectiveN: 500, calibrationN: 200,               // huge sample ("analog.sufficient")
    netLift: null, incrementalLift: null,             // …but no control comparison
    wilsonCI: null, brier: null, brierBaseline: null,
    fdrPass: false, stability: { halves: [], byYear: {} },
  };
  const v = R.provenGate(cell);
  assert.strictEqual(v.proven, false, 'sample size alone must never mark a family proven');
  assert.ok(v.reasons.some(r => /matched controls/.test(r)));
});

test('research: provenGate rejects each missing condition with its own reason', () => {
  const v = R.provenGate({ effectiveN: 10, calibrationN: 5, netLift: -0.5, incrementalLift: -0.1, wilsonCI: [0.4, 0.6], controlTargetRate: 0.5, brier: 0.3, brierBaseline: 0.25, fdrPass: false, stability: { halves: [1, -1], byYear: { 2025: { netMean: 1 } } } });
  assert.strictEqual(v.proven, false);
  assert.ok(v.reasons.length >= 4, `expected several reasons, got ${JSON.stringify(v.reasons)}`);
});

test('research: provenGate passes ONLY when every condition holds', () => {
  const cell = {
    effectiveN: 80, calibrationN: 40,
    targetRate: 0.62, controlTargetRate: 0.45, controlN: 200,
    incrementalLift: 0.17, netLift: 0.9,
    calibrationRate: 0.6,
    wilsonCI: [0.51, 0.72],
    brier: 0.22, brierBaseline: 0.26,
    fdrPass: true,
    stability: { halves: [0.8, 1.0], byYear: { 2024: { n: 40, netMean: 0.7 }, 2025: { n: 40, netMean: 1.1 } } },
  };
  const v = R.provenGate(cell);
  assert.deepStrictEqual(v.reasons, []);
  assert.strictEqual(v.proven, true);
  // …and flipping any single condition kills it.
  assert.strictEqual(R.provenGate({ ...cell, netLift: 0 }).proven, false);
  assert.strictEqual(R.provenGate({ ...cell, fdrPass: false }).proven, false);
  assert.strictEqual(R.provenGate({ ...cell, wilsonCI: [0.42, 0.72] }).proven, false);
  assert.strictEqual(R.provenGate({ ...cell, brier: 0.3 }).proven, false);
  assert.strictEqual(R.provenGate({ ...cell, stability: { halves: [0.8, 1], byYear: { 2025: { n: 80, netMean: 1 } } } }).proven, false, 'single-year record cannot be proven');
});

test('research: evaluateCells reports per-cell metrics against matched controls with FDR', () => {
  const records = [];
  const controls = [];
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.parse('2024-01-01') + i * 6 * 86400000).toISOString().slice(0, 10);
    records.push(rec(d, { ticker: 'W' + i, targetFirst: i % 10 < 7, net: i % 10 < 7 ? 2 : -1.5 }));  // ~70%
    controls.push(rec(d, { ticker: 'C' + i, family: 'CONTROL', targetFirst: i % 10 < 4, net: i % 10 < 4 ? 2 : -1.5 })); // ~40%
  }
  const ev = R.evaluateCells({ records, controls });
  const cell = ev.cells['BULL_FLAG|LONG|20d'];
  assert.ok(cell, 'cell evaluated');
  assert.ok(cell.effectiveN > 0);
  assert.ok(typeof cell.incrementalLift === 'number' && cell.incrementalLift > 0);
  assert.ok('fdrPass' in cell);
  assert.ok(ev.split.evaluation > 0 && ev.split.calibration > 0 && ev.split.train > 0, 'three purged periods');
});

test('research: buildEvidenceTable stamps version + per-cell proven verdicts with reasons', () => {
  const table = R.buildEvidenceTable({ cells: { 'X|LONG|20d': { effectiveN: 3 } }, split: {}, control: {}, fdrCut: 0 }, { builtAt: 't' });
  assert.strictEqual(table.version, R.EVIDENCE_VERSION);
  assert.strictEqual(table.cells['X|LONG|20d'].proven, false);
  assert.ok(table.cells['X|LONG|20d'].reasons.length);
});
