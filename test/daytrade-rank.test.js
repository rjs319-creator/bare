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

test('buildBestOpportunities: excludes explosive small-caps (validated-inverted) — only ml/runs', () => {
  const mlA = [mk('BIG', 4, 9, 8, { tier: 'A' })];
  const runs = [mk('RUN', 2.2, 6, 5, { pct5d: 30 })];
  assignRelScores([mlA, runs]);
  const best = buildBestOpportunities(mlA, runs);
  const sources = new Set(best.map(b => b.source));
  assert.ok(sources.has('Momentum & Liquid') || sources.has('Multi-day run'));
  assert.ok(![...sources].some(s => /explosive/i.test(s)), 'no explosive small-caps in best-of');
});

test('buildBestOpportunities: drops names that are RED today (a best pick must be green)', () => {
  const mlA = [mk('UP', 3, 7, 6, { tier: 'A' }), mk('DOWN', 3, -4, -5, { tier: 'A' })];
  assignRelScores([mlA]);
  const best = buildBestOpportunities(mlA, []);
  assert.ok(best.every(b => b.pctChange > 0), 'no red-today picks');
  assert.ok(best.some(b => b.ticker === 'UP'));
  assert.ok(!best.some(b => b.ticker === 'DOWN'));
});

test('buildBestOpportunities: ranks #1..N by relScore and caps the list', () => {
  const mlA = Array.from({ length: 10 }, (_, i) => mk('T' + i, 2 + i * 0.3, 4 + i, 3 + i, { tier: 'A' }));
  assignRelScores([mlA]);
  const best = buildBestOpportunities(mlA, [], 6);
  assert.equal(best.length, 6);
  assert.deepEqual(best.map(b => b.rank), [1, 2, 3, 4, 5, 6]);
  for (let i = 1; i < best.length; i++) assert.ok(best[i - 1].relScore >= best[i].relScore, 'sorted by relScore desc');
});

test('SCANS.momentum_building is a real relaxation of momentum_liquid (surfaces more picks)', () => {
  const b = SCANS.momentum_building, a = SCANS.momentum_liquid;
  assert.ok(b.minRelVol < a.minRelVol && b.minPct < a.minPct, 'looser thresholds');
  // a mid-strength mover clears building but not the strict liquid bar
  const m = { last: 20, avgVol: 2e6, avgDollarVol: 4e7, relVol: 1.3, pctChange: 3.5 };
  assert.equal(passesScan(m, a), false, 'fails strict');
  assert.equal(passesScan(m, b), true, 'passes building');
});
