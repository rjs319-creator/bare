'use strict';
// Display↔grading parity: the recommendation shown to the user must be provably
// the record later graded. Until now today/latest.json held only a row projection
// and was overwritten on every logged call — nothing linked a graded record back
// to a served board. boardHashOf is that link: a deterministic hash over the
// served snapRow set, recorded write-once per day.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boardHashOf, snapRow } = require('../lib/decision-routes');

const ROWS = [
  { id: 'screener|AAA', ticker: 'AAA', horizon: 'swing', state: 'actionable', rank: 1, score: 88.2 },
  { id: 'ghost|BBB', ticker: 'BBB', horizon: 'swing', state: 'watch', rank: 2, score: 71.0 },
  { id: 'daytrade|CCC', ticker: 'CCC', horizon: 'intraday', state: 'prepare', rank: 3, score: 65.5 },
];

test('the board hash is deterministic and reproducible from a stored snapshot', () => {
  const a = boardHashOf(ROWS);
  const b = boardHashOf(JSON.parse(JSON.stringify(ROWS)));   // round-tripped copy
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b, 'same rows must always produce the same hash');
});

test('ANY change to what the user saw changes the hash — rank, score, membership, order', () => {
  const base = boardHashOf(ROWS);
  const reranked = boardHashOf([{ ...ROWS[0], rank: 2 }, { ...ROWS[1], rank: 1 }, ROWS[2]]);
  const rescored = boardHashOf([{ ...ROWS[0], score: 88.3 }, ROWS[1], ROWS[2]]);
  const dropped = boardHashOf(ROWS.slice(0, 2));
  const reordered = boardHashOf([ROWS[1], ROWS[0], ROWS[2]]);
  for (const [name, h] of [['rerank', reranked], ['rescore', rescored], ['drop', dropped], ['reorder', reordered]]) {
    assert.notEqual(h, base, `${name} must change the parity hash`);
  }
});

test('key insertion order does NOT change the hash (stable serialization)', () => {
  const shuffledKeys = ROWS.map(r => ({ score: r.score, id: r.id, rank: r.rank, ticker: r.ticker, state: r.state, horizon: r.horizon }));
  assert.equal(boardHashOf(shuffledKeys), boardHashOf(ROWS));
});

test('snapRow projects exactly the graded fields — a payload field added later cannot silently enter the hash', () => {
  const row = { id: 'x', ticker: 'X', horizon: 'swing', state: 'watch', rank: 9, score: 1, freshness: 'noise', prose: 'noise' };
  assert.deepEqual(Object.keys(snapRow(row)).sort(), ['horizon', 'id', 'rank', 'score', 'state', 'ticker']);
});
