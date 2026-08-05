// Locks the insider-cluster-drawdown preregistration (PREREGISTRATION-INSIDER-
// CLUSTER-2026-08.md): the registry entry, the frozen parameters, and the PURE
// cluster-construction semantics — especially the PIT rule (event date = latest
// FILING date, never a transaction date).
const test = require('node:test');
const assert = require('node:assert');
const REG = require('../lib/research/hypothesis-registry');
const S = require('../research/69-insider-cluster');

test('insider-cluster-drawdown is registered, valid, exploratory', () => {
  const h = REG.find('insider-cluster-drawdown');
  assert.ok(h, 'missing from registry');
  const v = REG.validateHypothesis(h);
  assert.ok(v.valid, JSON.stringify(v.errors));
  assert.equal(h.mode, 'exploratory');
  assert.equal(h.familyId, 'alt-signals');
});

test('frozen parameters match the preregistration', () => {
  assert.equal(S.CLUSTER_WINDOW_DAYS, 14);
  assert.equal(S.MIN_OWNERS, 2);
  assert.equal(S.MIN_COMBINED_VALUE, 50_000);
  assert.equal(S.DRAWDOWN_FRAC, 0.70);
  assert.equal(S.MIN_PRIMARY_EVENTS, 40);
});

const buy = (date, owner, value, filingDate) => ({
  date, owner, code: 'P', shares: 1000, price: value / 1000, value, filingDate,
});

test('clusterEvents: two distinct owners within the window form ONE event dated at the LATEST filing', () => {
  const evs = S.clusterEvents([
    buy('2025-01-02', 'CEO A', 40_000, '2025-01-03'),
    buy('2025-01-09', 'CFO B', 30_000, '2025-01-13'),
  ]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].owners, 2);
  assert.equal(evs[0].combinedValue, 70_000);
  assert.equal(evs[0].eventDate, '2025-01-13', 'PIT: the cluster exists only when its LAST member files');
});

test('clusterEvents: one owner buying twice is NOT a cluster', () => {
  const evs = S.clusterEvents([
    buy('2025-01-02', 'CEO A', 60_000, '2025-01-03'),
    buy('2025-01-05', 'ceo a ', 60_000, '2025-01-06'),   // same owner, case/space noise
  ]);
  assert.equal(evs.length, 0);
});

test('clusterEvents: below the combined dollar floor is NOT a cluster', () => {
  const evs = S.clusterEvents([
    buy('2025-01-02', 'CEO A', 20_000, '2025-01-03'),
    buy('2025-01-05', 'CFO B', 20_000, '2025-01-06'),
  ]);
  assert.equal(evs.length, 0);
});

test('clusterEvents: buys outside the 14-day window do not join', () => {
  const evs = S.clusterEvents([
    buy('2025-01-02', 'CEO A', 60_000, '2025-01-03'),
    buy('2025-01-20', 'CFO B', 60_000, '2025-01-21'),
  ]);
  assert.equal(evs.length, 0, 'two solo buys 18 days apart are not a cluster');
});

test('clusterEvents: only code-P open-market buys count', () => {
  const evs = S.clusterEvents([
    { ...buy('2025-01-02', 'CEO A', 60_000, '2025-01-03'), code: 'S' },
    { ...buy('2025-01-03', 'CFO B', 60_000, '2025-01-04'), code: 'A' },   // award, not a purchase
    buy('2025-01-04', 'COO C', 60_000, '2025-01-05'),
  ]);
  assert.equal(evs.length, 0);
});

test('clusterEvents: a consumed window does not double-count (no overlapping events)', () => {
  const evs = S.clusterEvents([
    buy('2025-01-02', 'CEO A', 60_000, '2025-01-03'),
    buy('2025-01-04', 'CFO B', 60_000, '2025-01-05'),
    buy('2025-01-06', 'COO C', 60_000, '2025-01-07'),
  ]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].owners, 3);
});

test('singleBuyerEvents: excludes buys inside any cluster window, keeps solo buys, filing-dated', () => {
  const txs = [
    buy('2025-01-02', 'CEO A', 60_000, '2025-01-03'),
    buy('2025-01-04', 'CFO B', 60_000, '2025-01-05'),    // cluster with the above
    buy('2025-03-10', 'CEO A', 30_000, '2025-03-12'),    // solo
    buy('2025-05-10', 'CFO B', 10_000, '2025-05-12'),    // solo but under the $25k floor
  ];
  const clusters = S.clusterEvents(txs);
  const singles = S.singleBuyerEvents(txs, clusters);
  assert.equal(clusters.length, 1);
  assert.equal(singles.length, 1);
  assert.equal(singles[0].eventDate, '2025-03-12');
});
