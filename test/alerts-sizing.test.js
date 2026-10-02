'use strict';
// ALERTS SIZING INPUTS — per-lane (side × graded horizon) Kelly / drawdown evidence built from
// the graded-episode ledger on the cron, and the per-decision realised-vol / vol-target stamp.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AS = require('../lib/alerts-sizing');
const RK = require('../lib/risk-kelly');
const pipeline = require('../lib/alerts-pipeline');

function graded(n, { side = 'long', horizon = 'swing', excess = (i) => (i % 3 ? 3 : -2), r = (i) => (i % 3 ? 1.5 : -1) } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    graded: true, episodeId: `e${side}${horizon}${i}`, side, intendedHorizon: horizon,
    decisionDate: `2026-0${1 + (i % 9)}-${String(1 + (i % 27)).padStart(2, '0')}`,
    excess: excess(i), rMultiple: r(i),
  }));
}

test('laneKeyOf normalises side × horizon the way the grader does', () => {
  assert.equal(AS.laneKeyOf('long', 'swing'), 'long:5');
  assert.equal(AS.laneKeyOf('short', 'day'), 'short:1');
  assert.equal(AS.laneKeyOf('long', 'position'), 'long:21');
  assert.equal(AS.laneKeyOf('long', null), 'long:5', 'unknown horizon → the standard swing lane');
  assert.equal(AS.laneKeyOf(null, 'swing'), null, 'non-directional has no lane');
});

test('buildLaneSizing: a lane with a measured edge publishes inputs, quarter Kelly and a drawdown band', () => {
  const doc = AS.buildLaneSizing(graded(60), { now: Date.parse('2026-10-02T00:00:00Z') });
  assert.equal(doc.version, AS.ALERTS_SIZING_VERSION);
  assert.equal(doc.generatedAt, '2026-10-02T00:00:00.000Z');
  const lane = doc.lanes['long:5'];
  assert.ok(lane, 'lane present');
  assert.equal(lane.inputs.n, 60);
  assert.ok(Math.abs(lane.inputs.winRate - 40 / 60) < 1e-9);
  assert.ok(Math.abs(lane.inputs.avgWin - 0.03) < 1e-9, 'percent excess → fraction');
  assert.ok(Math.abs(lane.inputs.avgLoss - -0.02) < 1e-9);
  assert.equal(lane.inputs.cost, 0, 'graded excess is already cost-adjusted');
  assert.equal(lane.inputs.rMultiples.length, 60);
  assert.ok(lane.kelly > 0);
  assert.ok(lane.size > 0 && lane.size <= RK.MAX_POSITION_FRACTION);
  assert.equal(lane.maxPositionFraction, RK.MAX_POSITION_FRACTION);
  assert.ok(lane.drawdown && lane.drawdown.quantilesR.length === 101);
});

test('buildLaneSizing: a losing lane is published with size null and "no measured edge"', () => {
  const doc = AS.buildLaneSizing(graded(40, { excess: (i) => (i % 2 ? 1 : -3), r: (i) => (i % 2 ? 0.3 : -1) }));
  const lane = doc.lanes['long:5'];
  assert.equal(lane.size, null);
  assert.equal(lane.reason, 'no measured edge');
  assert.ok(lane.kelly <= 0);
  assert.equal(lane.inputs.n, 40);
});

test('buildLaneSizing: thin lanes refuse, lanes are separated by side and horizon, R list is capped and recent', () => {
  const rows = [
    ...graded(60, { side: 'long', horizon: 'swing' }),
    ...graded(10, { side: 'short', horizon: 'swing' }),
    ...graded(140, { side: 'long', horizon: 'day', r: (i) => i }),
    { graded: false, reason: 'no-forward-data' },
    { graded: true, side: 'long', intendedHorizon: 'swing', excess: null, rMultiple: 1 },
  ];
  const doc = AS.buildLaneSizing(rows);
  assert.deepEqual(Object.keys(doc.lanes).sort(), ['long:1', 'long:5', 'short:5']);
  assert.equal(doc.lanes['short:5'].size, null);
  assert.match(doc.lanes['short:5'].reason, /insufficient/);
  assert.equal(doc.lanes['long:5'].inputs.n, 60, 'ungraded / excess-less rows do not count');
  const day = doc.lanes['long:1'];
  assert.equal(day.inputs.rMultiples.length, AS.RECENT_R_CAP);
  assert.equal(day.inputs.rN, 140);
  assert.ok(day.inputs.rMultiples.includes(139), 'the most recent resolved R-multiples are kept');
  assert.ok(!day.inputs.rMultiples.includes(0), 'the oldest are dropped');
});

test('buildLaneSizing never mutates its input rows', () => {
  const rows = graded(25);
  const snapshot = JSON.stringify(rows);
  AS.buildLaneSizing(rows);
  assert.equal(JSON.stringify(rows), snapshot);
  assert.deepEqual(AS.buildLaneSizing(null).lanes, {});
});

test('buildDecisions stamps each decision with its sizing lane, realised vol and a capped vol-target', () => {
  const candles = Array.from({ length: 60 }, (_, i) => ({ date: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`, open: 100, high: 101, low: 99, close: 100 + (i % 2 ? 2 : -2), volume: 1e6 }));
  const ep = { id: 'e1', ticker: 'AAA', side: 'long', status: 'WAITING', key: 'AAA:long', intendedHorizon: 'swing', firstSeen: '2026-07-28T14:00:00Z', lastSeen: '2026-07-28T14:00:00Z', firstSeenDate: '2026-07-28', lastSeenDate: '2026-07-28', contributors: [] };
  const { decisions } = pipeline.buildDecisions([ep], { candlesByTicker: new Map([['AAA', candles]]), now: Date.parse('2026-07-29T00:00:00Z') });
  const d = decisions[0];
  assert.equal(d.sizingLane, 'long:5');
  assert.ok(Number.isFinite(d.realizedVol20d) && d.realizedVol20d > 0);
  assert.ok(d.volTarget && d.volTarget.fraction <= RK.MAX_POSITION_FRACTION);
  // no candles ⇒ explicit nulls, never a default vol
  const bare = pipeline.buildDecisions([ep], { now: Date.parse('2026-07-29T00:00:00Z') }).decisions[0];
  assert.equal(bare.realizedVol20d, null);
  assert.equal(bare.volTarget, null);
  assert.equal(bare.sizingLane, 'long:5');
});
