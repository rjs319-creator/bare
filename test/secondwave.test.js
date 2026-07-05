'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isFirstLegCandidate, parseResult, rankItems } = require('../lib/secondwave');
const { tierFor, ret10 } = require('../lib/secondwave-routes');

test('isFirstLegCandidate: moderate up move on volume, not parabolic, liquid', () => {
  assert.equal(isFirstLegCandidate({ relVol: 1.5, avgDollarVol: 8e6 }, 12), true);
  assert.equal(isFirstLegCandidate({ relVol: 1.5, avgDollarVol: 8e6 }, 3), false);    // move too small
  assert.equal(isFirstLegCandidate({ relVol: 1.5, avgDollarVol: 8e6 }, 45), false);   // already parabolic
  assert.equal(isFirstLegCandidate({ relVol: 1.1, avgDollarVol: 8e6 }, 12), false);   // no volume
  assert.equal(isFirstLegCandidate({ relVol: 1.5, avgDollarVol: 1e6 }, 12), false);   // illiquid
  assert.equal(isFirstLegCandidate(null, 12), false);
  assert.equal(isFirstLegCandidate({ relVol: 2, avgDollarVol: 8e6 }, null), false);
});

test('ret10: ~10-session trailing return (last vs the bar 10 sessions back)', () => {
  const c = v => ({ close: v });
  // 12 candles: base = index len-11 = 1 (=100), last = index 11 (=110) → +10%.
  const candles = [c(90), c(100), c(101), c(102), c(103), c(104), c(105), c(106), c(107), c(108), c(109), c(110)];
  assert.equal(ret10(candles), 10);
  assert.equal(ret10([c(1), c(2)]), null);   // too short
});

const CANDS = [{ ticker: 'ABC' }, { ticker: 'XYZ' }];

test('parseResult: keeps allowed, clamps class/virality, drops hallucinations', () => {
  const { items } = parseResult({ items: [
    { ticker: 'abc', classification: 'PRIMED', catalyst: 'new contract', crowd_state: 'light', virality: 9, thesis: 't' },
    { ticker: 'QQQ', classification: 'PRIMED', catalyst: 'x', virality: 3, thesis: 't' },     // not a candidate → dropped
    { ticker: 'XYZ', classification: 'BOGUS', catalyst: 'y', virality: 2, thesis: 't' },        // bad class → EARLY
  ] }, CANDS);
  assert.equal(items.length, 2);
  assert.equal(items.find(x => x.ticker === 'ABC').virality, 5);          // clamped
  assert.equal(items.find(x => x.ticker === 'XYZ').classification, 'EARLY');
});

test('rankItems: PRIMED first, then EARLY, then FADED; virality breaks ties', () => {
  const items = [
    { ticker: 'F', classification: 'FADED', virality: 5 },
    { ticker: 'E', classification: 'EARLY', virality: 5 },
    { ticker: 'P1', classification: 'PRIMED', virality: 3 },
    { ticker: 'P2', classification: 'PRIMED', virality: 4 },
  ];
  assert.deepEqual(rankItems(items).map(x => x.ticker), ['P2', 'P1', 'E', 'F']);
});

test('tierFor: classification → Scoreboard tier', () => {
  assert.equal(tierFor({ classification: 'PRIMED' }), 'Primed');
  assert.equal(tierFor({ classification: 'EARLY' }), 'Early');
  assert.equal(tierFor({ classification: 'FADED' }), 'Faded');
});
