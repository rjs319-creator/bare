// Tests for the Fable universe-curation parse (lib/universe-fable.js).
const test = require('node:test');
const assert = require('node:assert');
const { parseCuration, buildPrompt } = require('../lib/universe-fable');

test('parseCuration: keeps valid skips, clamps reasons, filters unknowns', () => {
  const out = parseCuration({
    skip: [
      { ticker: 'ACME', reason: 'spac' },
      { ticker: 'SHEL', reason: 'shell' },
      { ticker: 'NOPE', reason: 'spac' },        // not in valid list → dropped
      { ticker: 'weird', reason: 'banana' },     // invalid reason → 'other'
    ],
  }, ['ACME', 'SHEL', 'WEIRD']);
  assert.deepEqual(out.map(x => x.ticker).sort(), ['ACME', 'SHEL', 'WEIRD']);
  assert.equal(out.find(x => x.ticker === 'WEIRD').reason, 'other');
  assert.ok(!out.some(x => x.ticker === 'NOPE'));
});

test('parseCuration: dedupes and handles empty', () => {
  assert.deepEqual(parseCuration({ skip: [{ ticker: 'A', reason: 'spac' }, { ticker: 'A', reason: 'shell' }] }, null).length, 1);
  assert.deepEqual(parseCuration({}, null), []);
  assert.deepEqual(parseCuration(null, null), []);
});

test('buildPrompt: lists tickers and forces the tool', () => {
  const p = buildPrompt([{ symbol: 'ACME', name: 'Acme Acquisition Corp' }, { symbol: 'REAL', name: 'Real Operating Co' }]);
  assert.match(p, /ACME/);
  assert.match(p, /submit_curation/);
});
