'use strict';
// Regression: the evening evidence tick (after the close the attention universe is
// empty) wrote processed:0 over the SAME day's good afternoon snapshot, so the nightly
// peerprop chain's op=underreactionlog read an empty latest snapshot and failed
// "no-evidence-snapshot" on most nights from 2026-10-20 on.
const test = require('node:test');
const assert = require('node:assert');
const { shouldPersistSnapshot } = require('../lib/evidence-routes');

const good = { results: [{ ticker: 'RVTY' }, { ticker: 'AAPL' }] };
const empty = { results: [] };

test('an empty tick never overwrites a same-day snapshot that has results', () => {
  assert.strictEqual(shouldPersistSnapshot(good, empty), false);
});

test('an empty tick still writes when there is no earlier snapshot for the day', () => {
  assert.strictEqual(shouldPersistSnapshot(null, empty), true);
});

test('an empty tick may overwrite an earlier empty snapshot', () => {
  assert.strictEqual(shouldPersistSnapshot(empty, empty), true);
});

test('a tick with results always writes, even over an earlier non-empty snapshot', () => {
  assert.strictEqual(shouldPersistSnapshot(good, { results: [{ ticker: 'MSFT' }] }), true);
});

test('a malformed existing doc is treated as absent', () => {
  assert.strictEqual(shouldPersistSnapshot({ results: 'nope' }, empty), true);
});
