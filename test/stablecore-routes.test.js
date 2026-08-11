'use strict';
// corebuild universe-refresh fallback — the pure decision behind op=corebuild.
//
// Regression pinned: from 2026-08-07 the nightly op=corebuild answered 502 on EVERY cron
// run. The universe had gone >7d stale, the cron-time FMP fetch failed once, and the old
// code returned 502 on any refresh error — which also skipped the chunked feature
// refresh, so the staleness (and the 502) became permanent. A failed refresh with a
// usable prior universe must degrade, not abort.
const test = require('node:test');
const assert = require('node:assert');
const { applyUniverseRefresh } = require('../lib/stablecore-routes');

const TODAY = '2026-08-11';
const prevState = {
  universeAsOf: '2026-07-30',
  symbols: ['AAA', 'BBB'],
  meta: { AAA: { sector: 'Tech' }, BBB: { sector: 'Energy' } },
  cursor: 250,
};

test('a successful refresh replaces the universe and resets the cursor', () => {
  const uni = [{ symbol: 'CCC', sector: 'Tech', marketCap: 1e9, price: 10, company: 'C Corp' }];
  const r = applyUniverseRefresh(prevState, { ok: true, uni }, TODAY);
  assert.equal(r.refreshedUniverse, true);
  assert.equal(r.refreshError, null);
  assert.equal(r.fatal, false);
  assert.deepStrictEqual(r.state.symbols, ['CCC']);
  assert.equal(r.state.universeAsOf, TODAY);
  assert.equal(r.state.cursor, 0);
  assert.equal(r.state.meta.CCC.company, 'C Corp');
});

test('a FAILED refresh with a prior universe keeps building on the stale list', () => {
  const r = applyUniverseRefresh(prevState, { ok: false, error: '429 rate limited' }, TODAY);
  assert.equal(r.fatal, false, 'must not abort the chunked feature refresh');
  assert.equal(r.refreshedUniverse, false);
  assert.match(r.refreshError, /429 rate limited/);
  assert.strictEqual(r.state, prevState, 'the stale universe is the fallback');
});

test('an EMPTY successful response is treated as a failure, not an empty universe', () => {
  // Replacing a 900-name universe with [] because the screener answered thin would
  // wedge the build behind "empty universe" — same failure class, same fallback.
  const r = applyUniverseRefresh(prevState, { ok: true, uni: [] }, TODAY);
  assert.equal(r.fatal, false);
  assert.equal(r.refreshedUniverse, false);
  assert.strictEqual(r.state, prevState);
});

test('a failed refresh with NOTHING to fall back to is fatal (the honest 502)', () => {
  for (const prev of [null, {}, { symbols: [] }]) {
    const r = applyUniverseRefresh(prev, { ok: false, error: 'boom' }, TODAY);
    assert.equal(r.fatal, true, `prev=${JSON.stringify(prev)} has no usable universe`);
    assert.match(r.refreshError, /boom/);
  }
});
