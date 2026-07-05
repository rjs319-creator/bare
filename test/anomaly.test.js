'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isAnomalyCandidate, parseResult, rankItems, CLASSES } = require('../lib/anomaly');
const { tierFor } = require('../lib/anomaly-routes');

test('isAnomalyCandidate: quiet up-mover on volume, no gap, liquid', () => {
  assert.equal(isAnomalyCandidate({ pct5d: 9, relVol: 2, gapPct: 1, avgDollarVol: 5e6 }), true);
  assert.equal(isAnomalyCandidate({ pct5d: 4, relVol: 2, gapPct: 1, avgDollarVol: 5e6 }), false);   // move too small
  assert.equal(isAnomalyCandidate({ pct5d: 9, relVol: 1.1, gapPct: 1, avgDollarVol: 5e6 }), false);  // no volume
  assert.equal(isAnomalyCandidate({ pct5d: 9, relVol: 2, gapPct: 8, avgDollarVol: 5e6 }), false);    // it's a gap (has news)
  assert.equal(isAnomalyCandidate({ pct5d: 9, relVol: 2, gapPct: 1, avgDollarVol: 1e6 }), false);    // illiquid
  assert.equal(isAnomalyCandidate(null), false);
  assert.equal(isAnomalyCandidate({ pct5d: null }), false);
});

const CANDS = [{ ticker: 'EXPI' }, { ticker: 'PESI' }, { ticker: 'VSCO' }];

test('parseResult: keeps allowed tickers, clamps class/confidence, drops hallucinations', () => {
  const { items } = parseResult({ items: [
    { ticker: 'expi', classification: 'ACCUMULATION', reason_found: 'none found', confidence: 9, thesis: 't' },
    { ticker: 'PESI', classification: 'EXPLAINED', reason_found: 'DOE contract', confidence: 4, thesis: 't' },
    { ticker: 'ZZZZ', classification: 'ACCUMULATION', reason_found: 'x', confidence: 3, thesis: 't' },   // not a candidate → dropped
    { ticker: 'VSCO', classification: 'BOGUS', reason_found: 'x', confidence: 2, thesis: 't' },           // bad class → NOISE
  ] }, CANDS);
  assert.equal(items.length, 3);
  const expi = items.find(x => x.ticker === 'EXPI');
  assert.equal(expi.classification, 'ACCUMULATION');
  assert.equal(expi.confidence, 5);                                // clamped 9→5
  assert.equal(items.find(x => x.ticker === 'VSCO').classification, 'NOISE');  // invalid enum → NOISE
  assert.ok(CLASSES.includes(items[0].classification));
});

test('parseResult: bad input → empty', () => {
  assert.deepEqual(parseResult(null, CANDS).items, []);
  assert.deepEqual(parseResult({ items: 'x' }, CANDS).items, []);
});

test('rankItems: ACCUMULATION first, then Explained, then Noise; confidence breaks ties', () => {
  const items = [
    { ticker: 'N', classification: 'NOISE', confidence: 5 },
    { ticker: 'E', classification: 'EXPLAINED', confidence: 5 },
    { ticker: 'A1', classification: 'ACCUMULATION', confidence: 3 },
    { ticker: 'A2', classification: 'ACCUMULATION', confidence: 4 },
  ];
  assert.deepEqual(rankItems(items).map(x => x.ticker), ['A2', 'A1', 'E', 'N']);
});

test('tierFor: classification → Scoreboard tier', () => {
  assert.equal(tierFor({ classification: 'ACCUMULATION' }), 'Accumulation');
  assert.equal(tierFor({ classification: 'EXPLAINED' }), 'Explained');
  assert.equal(tierFor({ classification: 'NOISE' }), 'Noise');
});
