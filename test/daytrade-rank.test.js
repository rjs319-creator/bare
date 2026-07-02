'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assignRelScores, buildBestOpportunities } = require('../lib/screener-routes');
const { SCANS, passesScan } = require('../lib/daytrade');

const mk = (ticker, relVol, pctChange, excessPct, extra = {}) => ({ ticker, relVol, pctChange, excessPct, last: 10, score: relVol * 10 + pctChange, ...extra });

test('assignRelScores: assigns 0-100 with the strongest pick at 100 and weakest at 0', () => {
  const ml = [mk('A', 5, 12, 11), mk('B', 1.3, 3, 2)];
  const es = [mk('C', 3, 20, 19)];
  assignRelScores([ml, es]);
  const all = [...ml, ...es];
  assert.ok(all.every(p => p.relScore >= 0 && p.relScore <= 100), 'scores in range');
  const top = all.reduce((a, b) => (a.relScore > b.relScore ? a : b));
  const bot = all.reduce((a, b) => (a.relScore < b.relScore ? a : b));
  assert.equal(top.relScore, 100);
  assert.equal(bot.relScore, 0);
  assert.equal(top.ticker, 'C', 'the strongest mover scores highest');
});

test('assignRelScores: single pick gets a valid score, no divide-by-zero', () => {
  const one = [mk('X', 2, 5, 4)];
  assignRelScores([one]);
  assert.ok(Number.isFinite(one[0].relScore));
});

test('buildBestOpportunities: ranks the whole green pool by carry odds (explosive flows through, discounted)', () => {
  // explosive with HIGH carry should still rank ahead of a liquid name with LOW carry —
  // no hard exclusion; the carry odds do the discounting.
  const pool = [
    mk('LIQLOW', 4, 9, 8, { scan: 'momentum_liquid', tier: 'A', carry: 42 }),
    mk('EXPHI', 3, 12, 10, { scan: 'explosive_small', carry: 55 }),
  ];
  assignRelScores([pool]);
  const best = buildBestOpportunities(pool);
  assert.equal(best[0].ticker, 'EXPHI', 'higher carry ranks first regardless of scan');
  assert.equal(best[0].source, 'Explosive small-cap');
});

test('buildBestOpportunities: drops names that are RED today or unscored', () => {
  const pool = [
    mk('UP', 3, 7, 6, { scan: 'momentum_liquid', tier: 'A', carry: 52 }),
    mk('DOWN', 3, -4, -5, { scan: 'momentum_liquid', tier: 'A', carry: 52 }),
    mk('NOCARRY', 3, 5, 4, { scan: 'momentum_liquid', tier: 'A' }),   // no carry → excluded
  ];
  assignRelScores([pool]);
  const best = buildBestOpportunities(pool);
  assert.ok(best.every(b => b.pctChange > 0 && b.carry != null));
  assert.ok(best.some(b => b.ticker === 'UP'));
  assert.ok(!best.some(b => b.ticker === 'DOWN' || b.ticker === 'NOCARRY'));
});

test('buildBestOpportunities: ranks #1..N by carry odds and caps the list', () => {
  const pool = Array.from({ length: 12 }, (_, i) => mk('T' + i, 2 + i * 0.3, 4 + i, 3 + i, { scan: 'momentum_liquid', tier: 'A', carry: 40 + i }));
  assignRelScores([pool]);
  const best = buildBestOpportunities(pool, 8);
  assert.equal(best.length, 8);
  assert.deepEqual(best.map(b => b.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (let i = 1; i < best.length; i++) assert.ok(best[i - 1].carry >= best[i].carry, 'sorted by carry desc');
});

test('SCANS.momentum_building is a real relaxation of momentum_liquid (surfaces more picks)', () => {
  const b = SCANS.momentum_building, a = SCANS.momentum_liquid;
  assert.ok(b.minRelVol < a.minRelVol && b.minPct < a.minPct, 'looser thresholds');
  // a mid-strength mover clears building but not the strict liquid bar
  const m = { last: 20, avgVol: 2e6, avgDollarVol: 4e7, relVol: 1.3, pctChange: 3.5 };
  assert.equal(passesScan(m, a), false, 'fails strict');
  assert.equal(passesScan(m, b), true, 'passes building');
});
