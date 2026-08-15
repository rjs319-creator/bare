'use strict';
// CATALYST–FLOW LABELS — executable prices, cost cases, and within-date relevance grades.
// The grade tests are the important ones: a percentile boundary computed across dates
// imports the future into today's cohort, and a "small cohort" silently falling back to the
// same percentile call would hide that it had no resolution to make the cut.
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/catalyst-flow/labels');

function bars(n, { start = 100, step = 1 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const px = start + i * step;
    return { date: `2024-01-${String(i + 1).padStart(2, '0')}`, open: px, high: px * 1.02, low: px * 0.98, close: px * 1.005, volume: 1e6 };
  });
}

test('costFraction reports all three declared cases, and the stress case is the dearest', () => {
  const dv = 5e7;
  const fixed = L.costFraction('fixed10bps', { dollarVolumeAtDecision: dv });
  const liq = L.costFraction('liquidityAware', { dollarVolumeAtDecision: dv });
  const stress = L.costFraction('stress25bps', { dollarVolumeAtDecision: dv });
  assert.strictEqual(fixed, 0.002);
  assert.strictEqual(stress, 0.005);
  assert.ok(liq > 0);
  assert.ok(stress > fixed);
  assert.strictEqual(L.costFraction('made-up-case', {}), null);
});

test('the liquidity-aware cost is dearer for an illiquid name than a liquid one', () => {
  assert.ok(L.costFraction('liquidityAware', { dollarVolumeAtDecision: 1e6 })
          > L.costFraction('liquidityAware', { dollarVolumeAtDecision: 1e8 }));
});

test('a VWAP entry convention REFUSES when intraday bars are absent — it never falls back to the open', () => {
  const b = bars(20);
  const open = L.entryPrice(b, 5, 'next-open');
  assert.strictEqual(open.price, b[5].open);

  const vwapMissing = L.entryPrice(b, 5, 'vwap-0935-0945', null);
  assert.strictEqual(vwapMissing.price, null);
  assert.strictEqual(vwapMissing.reason, 'vwap-window-unavailable');

  const vwapOk = L.entryPrice(b, 5, 'vwap-0935-0945', { vwap0935to0945: 123.45 });
  assert.strictEqual(vwapOk.price, 123.45);
});

test('holdReturn spans EXACTLY five sessions from the entry price to the fifth close', () => {
  const b = bars(20);
  const r = L.holdReturn(b, 5, 5, 'next-open');
  assert.strictEqual(r.ret, b[9].close / b[5].open - 1, 'entry idx 5 → exit idx 9 is five sessions inclusive');
});

test('a horizon past the end of history returns null, never a partial hold', () => {
  const b = bars(8);
  assert.strictEqual(L.holdReturn(b, 5, 5).ret, null);
  assert.strictEqual(L.holdReturn(b, 5, 5).reason, 'horizon-beyond-history');
});

test('netTarget subtracts the SECTOR benchmark and the cost, and winsorises the stock leg', () => {
  const stock = bars(20, { start: 100, step: 20 });    // a >30% move over the hold
  const bench = bars(20, { start: 100, step: 0 });     // flat benchmark
  const t = L.netTarget({
    bars: stock, benchmarkBars: bench, entryIdx: 5, benchmarkEntryIdx: 5,
    dollarVolumeAtDecision: 5e7, costCase: 'fixed10bps',
  });
  assert.strictEqual(t.reason, null);
  assert.strictEqual(t.parts.winsorisedReturn, L.WINSOR, 'a >30% move is clipped to the preregistered bound');
  assert.ok(t.parts.rawReturn > L.WINSOR);
  assert.ok(Math.abs(t.value - (L.WINSOR - t.parts.benchmarkReturn - 0.002)) < 1e-12);
});

test('an unresolvable benchmark makes the target null — there is no SPY fallback', () => {
  const stock = bars(20);
  const t = L.netTarget({ bars: stock, benchmarkBars: bars(6), entryIdx: 5, benchmarkEntryIdx: 5, costCase: 'fixed10bps' });
  assert.strictEqual(t.value, null);
  assert.match(t.reason, /^benchmark:/);
});

test('grades use percentile bins only when the cohort can actually resolve a 0.5% bin', () => {
  const big = Array.from({ length: 400 }, (_, i) => ({ key: `S${i}`, target: i / 400 }));
  const g = L.gradeCohort(big);
  assert.strictEqual(g.rule, 'percentile-bins');
  assert.strictEqual(g.grades[g.grades.length - 1].grade, 4, 'the very best row is grade 4');
  assert.strictEqual(g.grades[0].grade, 0);
  // Grades must be monotone in the target — a ranking label that is not is meaningless.
  const gs = g.grades.map((x) => x.grade);
  assert.deepStrictEqual(gs, [...gs].sort((a, b) => a - b));
});

test('a small cohort uses the DETERMINISTIC RANK FALLBACK, and says so', () => {
  const small = Array.from({ length: 20 }, (_, i) => ({ key: `S${i}`, target: i }));
  const g = L.gradeCohort(small);
  assert.strictEqual(g.rule, 'deterministic-rank-fallback');
  assert.strictEqual(g.grades[19].grade, 4, 'ordering is preserved: the best row still gets the top grade');
  assert.strictEqual(g.grades[0].grade, 0);
  const gs = g.grades.map((x) => x.grade);
  assert.deepStrictEqual(gs, [...gs].sort((a, b) => a - b));
});

test('grading is deterministic under ties — the same cohort regrades identically', () => {
  const tied = Array.from({ length: 30 }, (_, i) => ({ key: `S${i}`, target: i < 15 ? 0 : 1 }));
  const a = L.gradeCohort(tied).grades;
  const b = L.gradeCohort([...tied].reverse()).grades;
  assert.deepStrictEqual(
    a.map((x) => `${x.key}:${x.grade}`).sort(),
    b.map((x) => `${x.key}:${x.grade}`).sort(),
  );
});

test('rows with no target are dropped from grading rather than graded as zero', () => {
  const g = L.gradeCohort([{ key: 'A', target: 1 }, { key: 'B', target: null }, { key: 'C', target: 2 }]);
  assert.strictEqual(g.n, 2);
  assert.ok(!g.grades.some((x) => x.key === 'B'));
});
