'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseResult, rankItems, CLASSES } = require('../lib/toneshift');
const { tierFor } = require('../lib/toneshift-routes');

const CANDS = [{ ticker: 'AAA' }, { ticker: 'BBB' }];

test('parseResult: keeps allowed, clamps shift/confidence, drops hallucinations', () => {
  const { items } = parseResult({ items: [
    { ticker: 'aaa', shift: 'BRIGHTENING', change: 'dropped hedges', confidence: 9, thesis: 't' },
    { ticker: 'ZZZ', shift: 'BRIGHTENING', change: 'x', confidence: 3, thesis: 't' },   // not a candidate → dropped
    { ticker: 'BBB', shift: 'BOGUS', change: 'y', confidence: 2, thesis: 't' },           // bad enum → STABLE
  ] }, CANDS);
  assert.equal(items.length, 2);
  assert.equal(items.find(x => x.ticker === 'AAA').confidence, 5);       // clamped
  assert.equal(items.find(x => x.ticker === 'BBB').shift, 'STABLE');
  assert.ok(items.every(i => CLASSES.includes(i.shift)));
});

test('parseResult: bad input → empty', () => {
  assert.deepEqual(parseResult(null, CANDS).items, []);
});

test('rankItems: BRIGHTENING first, then STABLE, then DARKENING; confidence breaks ties', () => {
  const items = [
    { ticker: 'D', shift: 'DARKENING', confidence: 5 },
    { ticker: 'S', shift: 'STABLE', confidence: 5 },
    { ticker: 'B1', shift: 'BRIGHTENING', confidence: 3 },
    { ticker: 'B2', shift: 'BRIGHTENING', confidence: 4 },
  ];
  assert.deepEqual(rankItems(items).map(x => x.ticker), ['B2', 'B1', 'S', 'D']);
});

test('tierFor: shift → Scoreboard tier', () => {
  assert.equal(tierFor({ shift: 'BRIGHTENING' }), 'Brightening');
  assert.equal(tierFor({ shift: 'STABLE' }), 'Stable');
  assert.equal(tierFor({ shift: 'DARKENING' }), 'Darkening');
});
