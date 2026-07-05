'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildTriggers, parseGraph, alreadyMovedFlag, rankItems, benchFor, batchTriggers, mergeGraphs, MAX_TRIGGERS, MAX_TRIGGERS_RAW, BATCH_SIZE } = require('../lib/readthrough');
const { tierFor } = require('../lib/readthrough-routes');

test('batchTriggers: splits into <=BATCH_SIZE chunks for parallel calls', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ ticker: 'T' + i }));
  const b = batchTriggers(six);
  assert.equal(b.length, Math.ceil(6 / BATCH_SIZE));
  assert.ok(b.every(chunk => chunk.length <= BATCH_SIZE));
  assert.equal(b.flat().length, 6);                       // no triggers lost
  assert.deepEqual(batchTriggers([]), []);
});

test('mergeGraphs: concats items, dedups beneficiary to highest directness, joins notes', () => {
  const merged = mergeGraphs([
    { items: [{ beneficiary_ticker: 'AAA', directness: 3 }, { beneficiary_ticker: 'BBB', directness: 2 }], notes: 'n1' },
    { items: [{ beneficiary_ticker: 'AAA', directness: 5 }, { beneficiary_ticker: 'CCC', directness: 4 }], notes: 'n2' },
    { items: [], notes: '' },
  ]);
  assert.equal(merged.items.length, 3);                   // AAA/BBB/CCC
  assert.equal(merged.items.find(x => x.beneficiary_ticker === 'AAA').directness, 5);  // kept the stronger AAA
  assert.match(merged.notes, /n1/);
  assert.match(merged.notes, /n2/);
});

test('buildTriggers: honors a custom cap (Stage-1 raw count > default)', () => {
  const picks = Array.from({ length: 8 }, (_, i) => ({ ticker: 'T' + i, gapPct: 20 - i, cause: 'FDA' }));
  assert.equal(buildTriggers({ picks }).length, MAX_TRIGGERS);               // default cap
  assert.equal(buildTriggers({ picks }, MAX_TRIGGERS_RAW).length, MAX_TRIGGERS_RAW);
  assert.ok(MAX_TRIGGERS_RAW >= MAX_TRIGGERS);                               // raw cap >= default
  assert.deepEqual(buildTriggers({ picks }, 2).map(t => t.ticker), ['T0', 'T1']);
});

test('benchFor: GICS sector → sector ETF, else null', () => {
  assert.equal(benchFor('Energy'), 'XLE');
  assert.equal(benchFor('Health Care'), 'XLV');
  assert.equal(benchFor('Technology'), 'XLK');
  assert.equal(benchFor('Not A Sector'), null);
  assert.equal(benchFor(null), null);
  assert.equal(benchFor(undefined), null);
});

test('parseGraph: carries a valid sector → bench ETF, nulls an invalid one', () => {
  const { items } = parseGraph({ items: [
    { beneficiary_ticker: 'BKR', trigger_ticker: 'APD', mechanism: 'compression supplier', directness: 3, beneficiary_sector: 'Energy', thesis: 't' },
    { beneficiary_ticker: 'ZZZ', trigger_ticker: 'APD', mechanism: 'x', directness: 3, beneficiary_sector: 'Bogus', thesis: 't' },
  ], notes: '' }, [{ ticker: 'APD' }]);
  assert.equal(items.length, 2);
  const bkr = items.find(x => x.beneficiary_ticker === 'BKR');
  assert.equal(bkr.beneficiary_sector, 'Energy');
  assert.equal(bkr.bench, 'XLE');
  const zzz = items.find(x => x.beneficiary_ticker === 'ZZZ');
  assert.equal(zzz.beneficiary_sector, null);
  assert.equal(zzz.bench, null);
});

test('tierFor: Fresh / Moved / Unknown from the tape flag', () => {
  assert.equal(tierFor({ moved: { alreadyMoved: false } }), 'Fresh');
  assert.equal(tierFor({ moved: { alreadyMoved: true } }), 'Moved');
  assert.equal(tierFor({ moved: { alreadyMoved: null } }), 'Unknown');
  assert.equal(tierFor({}), 'Unknown');
});

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
