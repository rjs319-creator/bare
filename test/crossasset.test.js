'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseResult, rankItems, CLASSES } = require('../lib/crossasset');
const { tierFor } = require('../lib/crossasset-routes');

test('parseResult: clamps class/confidence, dedups, drops items missing lead_asset', () => {
  const { items } = parseResult({ items: [
    { ticker: 'fcx', lead_asset: 'copper +4%', linkage: 'largest US copper miner', classification: 'LEAD', confidence: 9, thesis: 't' },
    { ticker: 'FCX', lead_asset: 'copper again', classification: 'INLINE', confidence: 2, thesis: 't' },   // dup → dropped
    { ticker: 'XYZ', classification: 'LEAD', confidence: 3, thesis: 't' },                                  // no lead_asset → dropped
    { ticker: 'CCJ', lead_asset: 'uranium +6%', linkage: 'x', classification: 'BOGUS', confidence: 4, thesis: 't' },  // bad class → WEAK
  ] });
  assert.equal(items.length, 2);
  const fcx = items.find(x => x.ticker === 'FCX');
  assert.equal(fcx.classification, 'LEAD');
  assert.equal(fcx.confidence, 5);                       // clamped
  assert.equal(items.find(x => x.ticker === 'CCJ').classification, 'WEAK');
  assert.ok(items.every(i => CLASSES.includes(i.classification)));
});

test('parseResult: bad input → empty', () => {
  assert.deepEqual(parseResult(null).items, []);
  assert.deepEqual(parseResult({ items: 5 }).items, []);
});

test('rankItems: LEAD first, then INLINE, then WEAK; confidence breaks ties', () => {
  const items = [
    { ticker: 'W', classification: 'WEAK', confidence: 5 },
    { ticker: 'I', classification: 'INLINE', confidence: 5 },
    { ticker: 'L1', classification: 'LEAD', confidence: 3 },
    { ticker: 'L2', classification: 'LEAD', confidence: 4 },
  ];
  assert.deepEqual(rankItems(items).map(x => x.ticker), ['L2', 'L1', 'I', 'W']);
});

test('tierFor: classification → Scoreboard tier', () => {
  assert.equal(tierFor({ classification: 'LEAD' }), 'Lead');
  assert.equal(tierFor({ classification: 'INLINE' }), 'Inline');
  assert.equal(tierFor({ classification: 'WEAK' }), 'Weak');
});
