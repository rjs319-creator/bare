'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildTriggers, parseGraph, alreadyMovedFlag, rankItems, MAX_TRIGGERS } = require('../lib/readthrough');

test('buildTriggers: dedups, sorts by gap desc, caps at MAX_TRIGGERS', () => {
  const gapDay = { picks: [
    { ticker: 'aaa', cause: 'FDA', gapPct: 6 },
    { ticker: 'BBB', cause: 'CONTRACT', gapPct: 12 },
    { ticker: 'AAA', cause: 'FDA', gapPct: 6 },      // dup
    { ticker: 'CCC', cause: 'GUIDE', gapPct: 3 },
    { ticker: 'DDD', gapPct: 8 }, { ticker: 'EEE', gapPct: 9 }, { ticker: 'FFF', gapPct: 5 },
  ]};
  const t = buildTriggers(gapDay);
  assert.equal(t.length, MAX_TRIGGERS);
  assert.equal(t[0].ticker, 'BBB');                  // biggest gap first
  assert.equal(t[0].cause, 'CONTRACT');
  assert.deepEqual(t.map(x => x.ticker), ['BBB', 'EEE', 'DDD'].slice(0, MAX_TRIGGERS));  // top-N by gap
  assert.ok(t.filter(x => x.ticker === 'AAA').length <= 1);   // deduped + uppercased (case-variant merged)
});

test('buildTriggers: empty / malformed → []', () => {
  assert.deepEqual(buildTriggers(null), []);
  assert.deepEqual(buildTriggers({}), []);
  assert.deepEqual(buildTriggers({ picks: [{}] }), []);
});

const TRIGGERS = [{ ticker: 'CVNA' }, { ticker: 'SMCI' }];

test('parseGraph: keeps a specific link, clamps directness, uppercases tickers', () => {
  const { items } = parseGraph({ items: [
    { beneficiary_ticker: 'root', beneficiary_name: 'Root Inc', trigger_ticker: 'cvna', link_type: 'partner', mechanism: 'exclusive embedded-insurance partner', directness: 9, already_priced_guess: false, thesis: 'lags CVNA' },
  ]}, TRIGGERS);
  assert.equal(items.length, 1);
  assert.equal(items[0].beneficiary_ticker, 'ROOT');
  assert.equal(items[0].trigger_ticker, 'CVNA');
  assert.equal(items[0].directness, 5);              // clamped 9→5
});

test('parseGraph: drops directness-1 (loose theme), self-links, and unknown triggers', () => {
  const { items } = parseGraph({ items: [
    { beneficiary_ticker: 'XYZ', trigger_ticker: 'CVNA', mechanism: 'both are AI', directness: 1 },       // loose theme
    { beneficiary_ticker: 'CVNA', trigger_ticker: 'CVNA', mechanism: 'itself', directness: 5 },           // self-link
    { beneficiary_ticker: 'ABC', trigger_ticker: 'NOTFED', mechanism: 'x supplies y', directness: 4 },    // trigger not fed
    { beneficiary_ticker: 'DEF', trigger_ticker: 'SMCI', mechanism: 'sole supplier', directness: 3, already_priced_guess: true, thesis: 't' },
  ]}, TRIGGERS);
  assert.equal(items.length, 1);
  assert.equal(items[0].beneficiary_ticker, 'DEF');
});

test('parseGraph: dedups a beneficiary to its highest-directness link', () => {
  const { items } = parseGraph({ items: [
    { beneficiary_ticker: 'DEF', trigger_ticker: 'CVNA', mechanism: 'weak link', directness: 2, thesis: 't' },
    { beneficiary_ticker: 'DEF', trigger_ticker: 'SMCI', mechanism: 'strong link', directness: 4, thesis: 't' },
  ]}, TRIGGERS);
  assert.equal(items.length, 1);
  assert.equal(items[0].directness, 4);
  assert.equal(items[0].trigger_ticker, 'SMCI');
});

test('parseGraph: bad input → empty items', () => {
  assert.deepEqual(parseGraph(null, TRIGGERS).items, []);
  assert.deepEqual(parseGraph({ items: 'nope' }, TRIGGERS).items, []);
});

test('alreadyMovedFlag: threshold at 4%', () => {
  assert.deepEqual(alreadyMovedFlag({ pctChange: 6.2 }), { movedPct: 6.2, alreadyMoved: true });
  assert.deepEqual(alreadyMovedFlag({ pctChange: 1.1 }), { movedPct: 1.1, alreadyMoved: false });
  assert.deepEqual(alreadyMovedFlag({ pctChange: -5 }), { movedPct: -5, alreadyMoved: true });   // abs move
  assert.deepEqual(alreadyMovedFlag(null), { movedPct: null, alreadyMoved: null });              // unknown
});

test('rankItems: un-moved first, then unknown, then already-moved; directness breaks ties', () => {
  const items = [
    { beneficiary_ticker: 'MOVED', directness: 5, moved: { alreadyMoved: true } },
    { beneficiary_ticker: 'UNK', directness: 5, moved: { alreadyMoved: null } },
    { beneficiary_ticker: 'FRESH_LO', directness: 3, moved: { alreadyMoved: false } },
    { beneficiary_ticker: 'FRESH_HI', directness: 4, moved: { alreadyMoved: false } },
  ];
  assert.deepEqual(rankItems(items).map(x => x.beneficiary_ticker), ['FRESH_HI', 'FRESH_LO', 'UNK', 'MOVED']);
});
