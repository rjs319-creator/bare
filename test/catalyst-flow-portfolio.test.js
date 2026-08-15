'use strict';
// CATALYST–FLOW PORTFOLIO — the abstention contract.
//
// The rule that matters most is the one that is easiest to lose: if only four candidates
// clear the edge test, the book holds four and the rest is CASH. Filling the remaining
// slots with the least-bad names is how a ranker's tail gets quietly monetised.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/catalyst-flow/portfolio');

const cand = (symbol, score, sector, edge = 0.05, cost = 0.5) =>
  ({ symbol, score, sector, estimatedEdge: edge, estRoundTripCostPct: cost });

test('an eligible candidate needs a positive edge that CLEARS its own round-trip cost', () => {
  assert.strictEqual(P.isEligible(cand('A', 1, 'Tech', 0.05, 0.5)).ok, true);
  assert.strictEqual(P.isEligible(cand('A', 1, 'Tech', -0.01, 0.5)).reason, 'non-positive-edge');
  // 0.4% edge against a 0.5% round trip is a fee, not a position.
  assert.strictEqual(P.isEligible(cand('A', 1, 'Tech', 0.004, 0.5)).reason, 'edge-below-cost');
  assert.strictEqual(P.isEligible({ symbol: 'A', score: 1 }).reason, 'no-edge-estimate');
});

test('NO FORCED POSITIONS — four eligible names produce a four-name book and 60% cash', () => {
  const candidates = [
    cand('A', 9, 'Tech'), cand('B', 8, 'Energy'), cand('C', 7, 'Health Care'), cand('D', 6, 'Financials'),
    ...['E', 'F', 'G', 'H', 'I', 'J'].map((s, i) => cand(s, 5 - i, 'Utilities', 0.001)),   // sub-cost
  ];
  const book = P.selectBook(candidates);
  assert.strictEqual(book.filled, 4);
  assert.strictEqual(book.capacity, 10);
  assert.ok(Math.abs(book.cashWeight - 0.6) < 1e-12, 'cash is the residual of CAPACITY, not of the book');
  assert.ok(book.positions.every((p) => Math.abs(p.weight - 0.25) < 1e-12), 'equal weight across the filled names');
});

test('an entirely ineligible cohort produces an EMPTY book, not the ten best losers', () => {
  const book = P.selectBook(Array.from({ length: 30 }, (_, i) => cand(`S${i}`, 100 - i, 'Tech', -0.02)));
  assert.strictEqual(book.filled, 0);
  assert.strictEqual(book.cashWeight, 1);
  // The top ten are refused on EDGE (they were considered and failed); the rest never
  // reach the edge test because they are below the entry rank.
  const topTen = book.rejected.filter((r) => r.rank <= 10);
  assert.strictEqual(topTen.length, 10);
  assert.ok(topTen.every((r) => /non-positive-edge/.test(r.reason)));
});

test('no more than three names from one sector, even when they are the top three ranks', () => {
  const candidates = [
    ...['A', 'B', 'C', 'D', 'E'].map((s, i) => cand(s, 20 - i, 'Technology')),
    ...['F', 'G'].map((s, i) => cand(s, 10 - i, 'Energy')),
  ];
  const book = P.selectBook(candidates);
  assert.strictEqual(book.sectorCounts.Technology, 3);
  assert.strictEqual(book.sectorCounts.Energy, 2);
  assert.strictEqual(book.filled, 5);
  assert.ok(book.rejected.some((r) => r.reason === 'sector-cap'));
});

test('the book never exceeds ten names however many clear the bar', () => {
  const candidates = Array.from({ length: 60 }, (_, i) => cand(`S${i}`, 100 - i, `Sector${i % 20}`));
  const book = P.selectBook(candidates);
  assert.strictEqual(book.filled, 10);
});

test('a duplicate symbol cannot take two slots', () => {
  const book = P.selectBook([cand('A', 9, 'Tech'), cand('A', 8, 'Tech'), cand('B', 7, 'Energy')]);
  assert.strictEqual(book.filled, 2);
  assert.ok(book.rejected.some((r) => r.reason === 'duplicate-symbol'));
});

test('without hysteresis, entry needs rank ≤ 10', () => {
  const candidates = Array.from({ length: 30 }, (_, i) => cand(`S${i}`, 100 - i, `Sector${i}`));
  const book = P.selectBook(candidates);
  assert.deepStrictEqual(book.positions.map((p) => p.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('hysteresis retains an existing name down to rank 30 but will not ENTER it there', () => {
  const candidates = Array.from({ length: 40 }, (_, i) => cand(`S${i}`, 100 - i, `Sector${i}`));
  const held = new Map([['S24', true]]);   // rank 25 — retainable, not enterable

  const withH = P.selectBook(candidates, { held, hysteresis: true });
  assert.ok(withH.positions.some((p) => p.symbol === 'S24' && p.admittedVia === 'retained'));

  const withoutH = P.selectBook(candidates, { held, hysteresis: false });
  assert.ok(!withoutH.positions.some((p) => p.symbol === 'S24'));
});

test('a retained name that falls below rank 30 or below cost is released', () => {
  const candidates = Array.from({ length: 40 }, (_, i) => cand(`S${i}`, 100 - i, `Sector${i}`));
  const tooLow = P.selectBook(candidates, { held: new Map([['S35', true]]), hysteresis: true });
  assert.ok(tooLow.rejected.some((r) => r.symbol === 'S35' && r.reason === 'below-retain-rank'));

  const cheapEdge = candidates.map((c) => (c.symbol === 'S24' ? { ...c, estimatedEdge: 0.001 } : c));
  const released = P.selectBook(cheapEdge, { held: new Map([['S24', true]]), hysteresis: true });
  assert.ok(released.rejected.some((r) => r.symbol === 'S24' && /retain:edge-below-cost/.test(r.reason)));
});

test('bookOutcome treats an empty book as CASH — a zero outcome, never null', () => {
  const empty = P.bookOutcome({ positions: [] }, { realisedReturnOf: () => 0.1, benchmarkReturn: 0.02 });
  assert.strictEqual(empty.value, 0);
  assert.strictEqual(empty.basis, 'cash');
});

test('bookOutcome is equal-weight excess over the predeclared benchmark', () => {
  const book = { positions: [{ symbol: 'A' }, { symbol: 'B' }] };
  const rets = { A: 0.10, B: 0.02 };
  const out = P.bookOutcome(book, { realisedReturnOf: (p) => rets[p.symbol], benchmarkReturn: 0.04 });
  assert.ok(Math.abs(out.value - (0.06 - 0.04)) < 1e-12);
  assert.strictEqual(out.n, 2);
});

test('an unresolved position return fails the whole book rather than silently dropping a name', () => {
  const book = { positions: [{ symbol: 'A' }, { symbol: 'B' }] };
  const out = P.bookOutcome(book, { realisedReturnOf: (p) => (p.symbol === 'A' ? 0.1 : null), benchmarkReturn: 0.01 });
  assert.strictEqual(out.value, null);
  assert.strictEqual(out.reason, 'unresolved-position-return');
});
