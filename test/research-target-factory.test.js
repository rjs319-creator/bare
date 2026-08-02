'use strict';
// TARGET FACTORY tests. The invariants that matter:
//   1. Every variant derives from the SAME graded rung — raw keeps costs out,
//      residual variants subtract the right benchmark, cost-adjusted equals the
//      rung's residualReturn exactly.
//   2. rank-cost-residual is a within-decision-date percentile: tie-aware, and
//      absent entirely below the minimum cross-section (no rank of 2 names).
//   3. target-before-stop FAILS CLOSED: MFE/MAE cannot order events inside the
//      window, so without a caller-supplied path-dependent barrier it is null.
//   4. Pending rungs and unbuildable labels are DROPPED from training rows,
//      never zero-filled; every emitted row carries labelEndDate for exact purge.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/research/target-factory');

function vector(ticker, { net = 2, gross = 3, bench = 1, sector = 0.5, resolved = true } = {}) {
  const residual = +(net - sector).toFixed(3);
  return {
    ticker, fillTs: '2025-06-02', fillStatus: 'filled',
    horizons: [{
      bars: 21, status: resolved ? 'resolved' : 'pending', exitTs: '2025-07-01',
      grossReturn: gross, costs: +(gross - net).toFixed(3), netReturn: net,
      benchmarkReturn: bench, sectorReturn: sector, residualReturn: residual,
      mfe: 5, mae: -2, beatBenchmark: residual > 0, positiveNet: net > 0, severeLoss: net <= -15,
    }],
  };
}

test('variant math derives from the same rung', () => {
  const v = vector('AAA', { net: 2, gross: 3, bench: 1, sector: 0.5 });
  const rung = T.rungAt(v, 21);
  assert.equal(T.targetValue(rung, 'raw'), 3);
  assert.equal(T.targetValue(rung, 'market-residual'), 1);          // net 2 − bench 1
  assert.equal(T.targetValue(rung, 'sector-residual'), 1.5);        // net 2 − sector 0.5
  assert.equal(T.targetValue(rung, 'cost-adjusted-residual'), 1.5); // the rung's residualReturn
});

test('sector-residual falls back to the market benchmark when sector is missing', () => {
  const v = vector('AAA');
  v.horizons[0] = { ...v.horizons[0], sectorReturn: null, residualReturn: +(2 - 1).toFixed(3) };
  assert.equal(T.targetValue(T.rungAt(v, 21), 'sector-residual'), 1);
});

test('rank-cost-residual: tie-aware within-date percentile; empty below min cross-section', () => {
  const vs = [vector('A', { net: 5, sector: 0 }), vector('B', { net: 3, sector: 0 }), vector('C', { net: 1, sector: 0 })];
  const ranks = T.rankWithinDate(vs, 21);
  assert.ok(ranks.A > ranks.B && ranks.B > ranks.C);
  assert.equal(Object.keys(T.rankWithinDate(vs.slice(0, 2), 21)).length, 0, 'two names cannot make a cross-sectional rank');
});

test('target-before-stop fails closed without a real barrier outcome', () => {
  const vs = [vector('A'), vector('B'), vector('C')];
  const none = T.buildTargetRows(vs, { bars: 21, variant: 'target-before-stop', decisionTs: '2025-06-02' });
  assert.equal(none.length, 0, 'no barrier supplied → no rows, never a guess from MFE/MAE');
  const withBarrier = T.buildTargetRows(vs, {
    bars: 21, variant: 'target-before-stop', decisionTs: '2025-06-02',
    barriersOf: t => ({ won: t === 'A' }),
  });
  assert.equal(withBarrier.length, 3);
  assert.equal(withBarrier.find(r => r.ticker === 'A').outcome, 1);
  assert.equal(withBarrier.find(r => r.ticker === 'B').outcome, 0);
});

test('pending rungs are dropped, and every row carries labelEndDate', () => {
  const vs = [vector('A'), vector('B'), vector('PEND', { resolved: false }), vector('C')];
  const rows = T.buildTargetRows(vs, { bars: 21, variant: 'cost-adjusted-residual', decisionTs: '2025-06-02' });
  assert.equal(rows.length, 3);
  assert.ok(!rows.find(r => r.ticker === 'PEND'));
  for (const r of rows) {
    assert.equal(r.labelEndDate, '2025-07-01');
    assert.equal(r.targetVariant, 'cost-adjusted-residual');
  }
});

test('hybrid target is bounded [0,1] and blends rank with magnitude', () => {
  const vs = [vector('A', { net: 9, sector: 0 }), vector('B', { net: 2, sector: 0 }), vector('C', { net: -4, sector: 0 }), vector('D', { net: 1, sector: 0 })];
  const rows = T.buildTargetRows(vs, { bars: 21, variant: 'hybrid-rank-magnitude', decisionTs: '2025-06-02' });
  assert.equal(rows.length, 4);
  for (const r of rows) assert.ok(r.outcome >= 0 && r.outcome <= 1, `out of bounds: ${r.outcome}`);
  const byT = Object.fromEntries(rows.map(r => [r.ticker, r.outcome]));
  assert.ok(byT.A > byT.B && byT.B > byT.C);
});

test('an unknown variant throws — no silent private label definitions', () => {
  assert.throws(() => T.buildTargetRows([], { variant: 'my-secret-target' }), /unknown target variant/);
  assert.equal(T.PREFERRED_TARGET, 'rank-cost-residual');
});
