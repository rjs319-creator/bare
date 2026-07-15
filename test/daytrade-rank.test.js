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

test('buildBestOpportunities: fade-avoidance gate drops below-base-rate carry (explosive fades out)', () => {
  // A clean liquid name (carry ≥ floor, not overextended) is admitted; a below-base-rate
  // explosive name is now EXCLUDED by the carry floor — no more "flows through, discounted".
  const pool = [
    mk('LIQCLEAN', 4, 9, 8, { scan: 'momentum_liquid', tier: 'A', carry: 55 }),
    mk('EXPWEAK', 3, 12, 10, { scan: 'explosive_small', carry: 45 }),   // < 50 base rate → dropped
  ];
  assignRelScores([pool]);
  const best = buildBestOpportunities(pool);
  assert.deepEqual(best.map(b => b.ticker), ['LIQCLEAN'], 'only the above-base-rate name survives');
});

test('buildBestOpportunities: gate excludes overextended blow-offs and dilution/M&A pops', () => {
  const pool = [
    mk('CLEAN', 3, 7, 6, { scan: 'momentum_liquid', tier: 'A', carry: 55 }),
    mk('BLOWOFF', 6, 30, 28, { scan: 'momentum_liquid', tier: 'A', carry: 55, overextended: true }),
    mk('DILUTE', 3, 8, 7, { scan: 'momentum_liquid', tier: 'A', carry: 55, catalyst: 'FADE_OFFERING' }),
    mk('MERGER', 3, 8, 7, { scan: 'momentum_liquid', tier: 'A', carry: 55, catalyst: 'MA' }),
  ];
  assignRelScores([pool]);
  const best = buildBestOpportunities(pool);
  assert.deepEqual(best.map(b => b.ticker), ['CLEAN'], 'only the non-fade name passes the gate');
});

test('buildBestOpportunities: drops RED, unscored, and low-carry names', () => {
  const pool = [
    mk('UP', 3, 7, 6, { scan: 'momentum_liquid', tier: 'A', carry: 52 }),
    mk('DOWN', 3, -4, -5, { scan: 'momentum_liquid', tier: 'A', carry: 52 }),   // red → out
    mk('NOCARRY', 3, 5, 4, { scan: 'momentum_liquid', tier: 'A' }),             // no carry → out
    mk('LOWCARRY', 3, 5, 4, { scan: 'momentum_liquid', tier: 'A', carry: 48 }), // < floor → out
  ];
  assignRelScores([pool]);
  const best = buildBestOpportunities(pool);
  assert.deepEqual(best.map(b => b.ticker), ['UP']);
});

test('buildBestOpportunities: empty pool of fade traps returns [] (honest empty state)', () => {
  const pool = [
    mk('X', 5, 25, 24, { scan: 'explosive_small', carry: 44, overextended: true }),
    mk('Y', 3, 6, 5, { scan: 'momentum_liquid', tier: 'A', carry: 46 }),
  ];
  assignRelScores([pool]);
  assert.deepEqual(buildBestOpportunities(pool), [], 'nothing clean → empty, not backfilled');
});

test('buildBestOpportunities: ranks #1..N by carry odds and caps the list', () => {
  // all above the carry floor so the cap (not the gate) governs the length
  const pool = Array.from({ length: 12 }, (_, i) => mk('T' + i, 2 + i * 0.3, 4 + i, 3 + i, { scan: 'momentum_liquid', tier: 'A', carry: 50 + i }));
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
