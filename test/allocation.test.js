'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { computeAllocation, monthlySeries, maxDrawdown, turnoverPerMonth } = require('../lib/allocation');

test('monthlySeries: averages picks within a calendar month', () => {
  const s = monthlySeries([
    { date: '2026-01-05', ret: 0.10 }, { date: '2026-01-20', ret: 0.00 },
    { date: '2026-02-10', ret: 0.04 },
  ]);
  assert.equal(s['2026-01'], 0.05);
  assert.equal(s['2026-02'], 0.04);
});

test('monthlySeries: ignores malformed records', () => {
  const s = monthlySeries([{ date: 'x', ret: 1 }, { date: '2026-01-01', ret: NaN }, null, { date: '2026-01-02', ret: 0.2 }]);
  assert.equal(s['2026-01'], 0.2);
});

test('maxDrawdown: computes peak-to-trough', () => {
  assert.ok(Math.abs(maxDrawdown([0.1, -0.2, 0.05]) - (-0.2)) < 1e-9);
  assert.equal(maxDrawdown([0.1, 0.1]), 0);
});

test('computeAllocation: returns accruing when too few months', () => {
  const a = computeAllocation({
    mom: [{ date: '2026-01-01', ret: 0.02 }, { date: '2026-02-01', ret: 0.03 }],
    gap: [{ date: '2026-01-01', ret: 0.05 }],
  });
  assert.equal(a.status, 'accruing');
  assert.equal(a.need.months, 6);
});

test('computeAllocation: accruing when only one sleeve', () => {
  const recs = {};
  recs.solo = Array.from({ length: 12 }, (_, i) => ({ date: `2026-${String(i + 1).padStart(2, '0')}-01`, ret: 0.01 }));
  const a = computeAllocation(recs);
  assert.equal(a.status, 'accruing');
});

test('computeAllocation: inverse-vol weights the lower-vol sleeve more; blend cuts vol', () => {
  // 12 aligned months: sleeve A high-vol, sleeve B low-vol, negatively correlated.
  const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
  // (won't exceed 12 months label but fine for test dates -> use day 01)
  const A = [], B = [];
  const aRets = [0.20, -0.15, 0.18, -0.20, 0.22, -0.10, 0.16, -0.18, 0.14, -0.12, 0.20, -0.16];
  const bRets = [-0.03, 0.04, -0.02, 0.05, -0.03, 0.02, -0.01, 0.04, -0.02, 0.03, -0.02, 0.03];
  months.forEach((m, i) => { A.push({ date: `${m}-01`, ret: aRets[i] }); B.push({ date: `${m}-01`, ret: bRets[i] }); });
  const a = computeAllocation({ HiVol: A, LoVol: B });
  assert.equal(a.status, 'ok');
  assert.equal(a.overlapMonths, 12);
  const hi = a.sleeves.find(s => s.name === 'HiVol');
  const lo = a.sleeves.find(s => s.name === 'LoVol');
  // risk parity => the low-vol sleeve gets the larger weight
  assert.ok(lo.weight > hi.weight, `expected LoVol weight ${lo.weight} > HiVol ${hi.weight}`);
  // weights sum ~100
  assert.ok(Math.abs(a.sleeves.reduce((s, x) => s + x.weight, 0) - 100) <= 1);
  // blended vol is below the high-vol sleeve's vol (risk reduction)
  assert.ok(a.blended.volAnn < hi.volAnn);
  // diversification ratio >= 1 when correlation is low/negative
  assert.ok(a.riskReduction.diversificationRatio >= 1);
});

test('turnoverPerMonth: average distinct picks logged per active month', () => {
  assert.equal(turnoverPerMonth([
    { date: '2026-01-05', ret: 0.1 }, { date: '2026-01-20', ret: 0.2 }, // 2 in Jan
    { date: '2026-02-10', ret: -0.1 },                                   // 1 in Feb
  ]), 1.5);
  assert.equal(turnoverPerMonth([]), null);
  assert.equal(turnoverPerMonth(null), null);
});

// Good sleeve (+ expectancy) vs bad sleeve (− expectancy), both vol>0.
const GOOD = [0.05, -0.01, 0.03, 0.06, -0.02, 0.04].map((v, i) => ({ date: `2026-0${i + 1}-01`, ret: v }));
const BAD = [-0.04, 0.02, -0.05, 0.01, -0.03, 0.00].map((v, i) => ({ date: `2026-0${i + 1}-15`, ret: v }));

test('computeAllocation: cash-when-thin funds only positive-expectancy sleeves', () => {
  const a = computeAllocation({ Good: GOOD, Bad: BAD }, { minMonths: 6 });
  assert.equal(a.status, 'ok');
  const good = a.cashAware.deployed.find(d => d.name === 'Good');
  const bad = a.cashAware.deployed.find(d => d.name === 'Bad');
  assert.equal(good.funded, true);
  assert.ok(good.weight > 0);
  assert.equal(bad.funded, false);          // negative expectancy → not funded
  assert.equal(bad.weight, 0);
  assert.ok(a.cashAware.cashWeight > 0);     // the bad sleeve's weight becomes cash
  assert.equal(a.cashAware.sitOut, false);   // at least one sleeve is fundable
});

test('computeAllocation: sits out (100% cash) when no sleeve has positive expectancy', () => {
  const bad2 = [-0.03, 0.01, -0.04, 0.00, -0.02, -0.01].map((v, i) => ({ date: `2026-0${i + 1}-20`, ret: v }));
  const a = computeAllocation({ Bad: BAD, Bad2: bad2 }, { minMonths: 6 });
  assert.equal(a.cashAware.cashWeight, 100);
  assert.equal(a.cashAware.sitOut, true);
});

test('computeAllocation: each sleeve reports its turnover per month', () => {
  const a = computeAllocation({ Good: GOOD, Bad: BAD }, { minMonths: 6 });
  assert.ok(a.sleeves.every(s => s.turnoverPerMonth != null));
});

test('computeAllocation: honest note present, no Sharpe-boost claim', () => {
  const months = Array.from({ length: 8 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
  const mk = base => months.map((m, i) => ({ date: `${m}-01`, ret: base + 0.01 * ((i % 3) - 1) }));
  const a = computeAllocation({ s1: mk(0.02), s2: mk(0.01) });
  assert.equal(a.status, 'ok');
  assert.match(a.note, /risk-reduction tool, not an alpha booster/);
});
