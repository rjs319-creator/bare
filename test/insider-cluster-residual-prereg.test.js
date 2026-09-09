'use strict';
// Locks the preregistered design of research/98-insider-cluster-residual.js to the
// registry entry + research/PREREGISTRATION-INSIDER-CLUSTER-RESIDUAL-2026-09.md, and
// pins the pure helpers so a "small fix" cannot quietly move a frozen parameter.
const test = require('node:test');
const assert = require('node:assert/strict');
const REG = require('../lib/research/hypothesis-registry');
const S = require('../research/98-insider-cluster-residual');

test('insider-cluster-residual is registered, valid, exploratory, and distinct from the drawdown hypothesis', () => {
  const h = REG.find(S.HYP_ID);
  assert.ok(h, 'registered');
  assert.equal(REG.validateHypothesis(h).valid, true);
  assert.equal(h.mode, 'exploratory');
  assert.equal(h.familyId, 'alt-signals');
  assert.match(h.hypothesis, /matched non-event controls/);
  assert.match(h.note, /insider-cluster-drawdown/, 'the prior no-edge result is declared as known');
  assert.ok(REG.find('insider-cluster-drawdown'), 'the prior hypothesis remains in the registry untouched');
});

test('frozen parameters match the preregistration', () => {
  const F = S.FROZEN;
  assert.equal(Object.isFrozen(F), true);
  assert.deepEqual(F.holds, [5, 21, 63]);
  assert.equal(F.primaryCell, 'RES_21');
  assert.equal(F.momLookback, 126); assert.equal(F.momSkip, 5); assert.equal(F.advLookback, 60);
  assert.equal(F.minAdv, 5e5); assert.equal(F.maxAdv, 2e7); assert.equal(F.minPrice, 1);
  assert.equal(F.cooldownSessions, 21); assert.equal(F.controlsPerEvent, 20); assert.equal(F.minControls, 5);
  assert.equal(F.poolSize, 3000); assert.equal(F.seed, 20260909); assert.equal(F.placeboShift, 126);
  assert.equal(F.minEvents, 200); assert.equal(F.minDates, 60); assert.equal(F.fdrAlpha, 0.10);
  assert.equal(F.eventFrom, '2022-01-03'); assert.equal(F.eventTo, '2026-03-20');
  assert.equal(F.declaredBeforeReadingResults, true);
});

const mkEntry = (closes, { open = null, volume = 1e5 } = {}) => S.slimSeries(
  // stored newest-first, like the cache
  closes.map((c, k) => ({ date: `2024-${String(1 + Math.floor(k / 28)).padStart(2, '0')}-${String(1 + (k % 28)).padStart(2, '0')}`, open: open ? open[k] : c, close: c, volume })).reverse(),
);

test('slimSeries / advAt / momentumAt: ascending order, prefix ADV, 6-1 momentum', () => {
  const closes = Array.from({ length: 200 }, (_, k) => 10 + k * 0.1);
  const e = mkEntry(closes);
  assert.equal(e.candles[0].close, 10);
  assert.ok(Math.abs(e.candles[199].close - 29.9) < 1e-9, 'ascending: the newest bar is last');
  // ADV over the last 60 bars = mean(close × volume)
  const i = 199, expected = closes.slice(140, 200).reduce((s, c) => s + c * 1e5, 0) / 60;
  assert.ok(Math.abs(S.advAt(e, i) - expected) < 1e-6);
  assert.equal(S.momentumAt(e, 100), null, 'needs 126 bars');
  const m = S.momentumAt(e, 150);
  assert.ok(Math.abs(m - (closes[145] / closes[24] - 1)) < 1e-12);
});

test('decisionIndex: last bar on or before the filing date; never a later bar', () => {
  const e = mkEntry(Array.from({ length: 60 }, () => 5));
  assert.equal(S.decisionIndex(e, '2024-01-15'), 14);
  assert.equal(S.decisionIndex(e, '2024-01-01'), 0);
  assert.equal(S.decisionIndex(e, '2023-12-31'), -1);
});

test('tierOf mirrors the app cost tiers; quintileOf is stable at the edges', () => {
  assert.equal(S.tierOf(3e7), 'liquid');
  assert.equal(S.tierOf(6e6), 'small');
  assert.equal(S.tierOf(1e6), 'micro');
  const sorted = [-0.5, -0.2, 0, 0.1, 0.3, 0.6, 0.9, 1.2, 1.5, 2];
  assert.equal(S.quintileOf(-0.5, sorted), 0);
  assert.equal(S.quintileOf(2, sorted), 4);
  assert.equal(S.quintileOf(0.1, sorted), 1);
  assert.equal(S.quintileOf(null, sorted), null);
});

test('verdictOf: frozen gates — fail closed on thin data, require FDR + blocks + placebo', () => {
  const good = { avg: 1.2, se: 0.3, ci95: { lo: 0.6, hi: 1.8 }, blockStability: { usable: true, positive: 3, blocks: 4 } };
  const nullPlacebo = { avg: 0.1, ci95: { lo: -0.5, hi: 0.7 } };
  assert.equal(S.verdictOf({ nEvents: 150, nDates: 80, primary: good, primaryFdr: { survives: true }, placebo: nullPlacebo }), 'insufficient-data');
  assert.equal(S.verdictOf({ nEvents: 300, nDates: 50, primary: good, primaryFdr: { survives: true }, placebo: nullPlacebo }), 'insufficient-data');
  assert.equal(S.verdictOf({ nEvents: 300, nDates: 80, primary: good, primaryFdr: { survives: true }, placebo: nullPlacebo }), 'research-promising');
  assert.equal(S.verdictOf({ nEvents: 300, nDates: 80, primary: good, primaryFdr: { survives: false }, placebo: nullPlacebo }), 'not-confirmed');
  assert.equal(S.verdictOf({ nEvents: 300, nDates: 80, primary: { ...good, blockStability: { usable: true, positive: 2, blocks: 4 } }, primaryFdr: { survives: true }, placebo: nullPlacebo }), 'not-confirmed');
  // A placebo of comparable size means the "effect" is the matching, not the event.
  assert.equal(S.verdictOf({ nEvents: 300, nDates: 80, primary: good, primaryFdr: { survives: true }, placebo: { avg: 0.9, ci95: { lo: -0.2, hi: 2 } } }), 'not-confirmed');
  assert.equal(S.verdictOf({ nEvents: 300, nDates: 80, primary: good, primaryFdr: { survives: true }, placebo: null }), 'not-confirmed', 'no placebo → no claim');
  assert.equal(S.verdictOf({ nEvents: 300, nDates: 80, primary: { ...good, avg: -0.4 }, primaryFdr: { survives: true }, placebo: nullPlacebo }), 'not-confirmed');
});

test('pickControls: same tier, same momentum quintile, seeded and capped, never an event name near its event', () => {
  const pool = new Map();
  const closes = Array.from({ length: 200 }, (_, k) => 10 + k * 0.05);
  for (let n = 0; n < 40; n++) pool.set(`C${n}`, S.slimSeries(closes.map((c, k) => ({ date: `2024-${String(1 + Math.floor(k / 28)).padStart(2, '0')}-${String(1 + (k % 28)).padStart(2, '0')}`, open: c * (1 + n / 1000), close: c * (1 + n / 100), volume: 2e5 + n * 1e4 })).reverse()));
  const eventIdx = new Map([['C7', [150]]]);
  const byTier = S.poolOnDate(pool, pool.get('C0').candles[150].date, eventIdx, new Map());
  const tiers = Object.keys(byTier);
  assert.ok(tiers.length >= 1);
  const t = tiers[0];
  assert.ok(!byTier[t].some(r => r.sym === 'C7'), 'event name within ±21 sessions excluded from the control pool');
  const rnd = S.lcg(7);
  const picked = S.pickControls(byTier, t, byTier[t][0].mom, rnd, 5);
  assert.ok(picked.length <= 5 && picked.length >= 1);
  const q0 = S.quintileOf(byTier[t][0].mom, byTier[t].sorted);
  assert.ok(picked.every(r => S.quintileOf(r.mom, byTier[t].sorted) === q0 && r.tier === t));
  const again = S.pickControls(byTier, t, byTier[t][0].mom, S.lcg(7), 5);
  assert.deepEqual(again.map(r => r.sym), picked.map(r => r.sym), 'seeded → reproducible');
});
