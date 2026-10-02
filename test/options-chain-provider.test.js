'use strict';
// lib/options-chain-provider — OPTIONS_PROVIDER routing, CBOE-first with Yahoo fallback,
// the 'yahoo' rollback value, 'cboe-only', stamping, and per-expiry views served from the
// memoized full CBOE body without extra network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/options-chain-provider');

const NOW = Date.UTC(2026, 9, 1, 15);
const day = (d) => Date.UTC(2026, 9, d) / 1000;
const chain = (exp) => ({ expirationDate: exp, calls: [{ strike: 100, openInterest: 1, delta: 0.5 }], puts: [] });
const FULL = { quote: { regularMarketPrice: 100 }, expirationDates: [day(3), day(10), day(31), day(60)].map((x) => x), options: [day(3), day(10), day(31), day(60)].map(chain), source: 'cboe-delayed', provider: 'cboe', greeksSource: 'vendor', chainComplete: true };
const YAHOO = { quote: { regularMarketPrice: 100 }, expirationDates: [day(3)], options: [chain(day(3))] };

function fakes({ cboeResult = FULL, cboeError = null, yahooResult = YAHOO, yahooError = null } = {}) {
  const calls = { cboe: 0, yahooResult: 0, yahooByDate: 0, yahooMulti: 0 };
  const cboe = { fetchCboeChain: async () => { calls.cboe++; if (cboeError) throw cboeError; return cboeResult; } };
  const yahooFn = (k) => async () => { calls[k]++; if (yahooError) throw yahooError; return yahooResult; };
  const yahoo = { fetchChainResult: yahooFn('yahooResult'), fetchChainByDate: yahooFn('yahooByDate'), fetchChainMultiExpiry: yahooFn('yahooMulti'), pickSwingExpiries: require('../lib/options-baseline').pickSwingExpiries };
  return { cboe, yahoo, calls };
}

test('resolveChainProvider: default is cboe→yahoo; yahoo = rollback; cboe-only = no fallback; junk is reported', () => {
  assert.deepEqual(P.resolveChainProvider({}).order, ['cboe', 'yahoo']);
  assert.equal(P.resolveChainProvider({}).hasFallback, true);
  assert.deepEqual(P.resolveChainProvider({ OPTIONS_PROVIDER: 'yahoo' }).order, ['yahoo']);
  assert.deepEqual(P.resolveChainProvider({ OPTIONS_PROVIDER: 'CBOE-ONLY' }).order, ['cboe']);
  const bad = P.resolveChainProvider({ OPTIONS_PROVIDER: 'bloomberg' });
  assert.equal(bad.mode, 'cboe'); assert.match(bad.misconfigured[0], /bloomberg/);
});

test('default mode: CBOE answers → nearest-expiry view, stamped, Yahoo never called', async () => {
  const { cboe, yahoo, calls } = fakes();
  const p = P.createChainProvider({ cboe, yahoo, env: {}, now: () => NOW });
  const r = await p.fetchChainResult('SPY');
  assert.equal(r.provider, 'cboe'); assert.equal(r.greeksSource, 'vendor'); assert.equal(r.chainComplete, false, 'one expiry is not the full chain');
  assert.equal(r.options.length, 1); assert.equal(r.options[0].expirationDate, day(3));
  assert.equal(r.expirationDates.length, 4, 'all expiries still listed for planning');
  assert.equal(calls.yahooResult, 0);
  assert.deepEqual(p.getStats().attempts, { cboe: 1, yahoo: 0 });
});

test('default mode: CBOE null → Yahoo fallback, stamped yahoo/no greeks, fallback counted', async () => {
  const { cboe, yahoo, calls } = fakes({ cboeResult: null });
  const p = P.createChainProvider({ cboe, yahoo, env: {}, now: () => NOW });
  const r = await p.fetchChainResult('SPY');
  assert.equal(r.provider, 'yahoo'); assert.equal(r.source, 'yahoo-delayed'); assert.equal(r.greeksSource, null); assert.equal(r.chainComplete, false);
  assert.equal(calls.yahooResult, 1);
  assert.equal(p.getStats().fallbacks, 1);
});

test('default mode: CBOE throws → Yahoo still answers; both throw → the error propagates; both null → null', async () => {
  const a = fakes({ cboeError: new Error('boom') });
  const pa = P.createChainProvider({ cboe: a.cboe, yahoo: a.yahoo, env: {}, now: () => NOW });
  assert.equal((await pa.fetchChainResult('SPY')).provider, 'yahoo');
  assert.equal(pa.getStats().failures.cboe, 1);
  const b = fakes({ cboeError: new Error('boom'), yahooError: new Error('yikes') });
  const pb = P.createChainProvider({ cboe: b.cboe, yahoo: b.yahoo, env: {}, now: () => NOW });
  await assert.rejects(pb.fetchChainResult('SPY'), /yikes/);
  const c = fakes({ cboeResult: null, yahooResult: null });
  const pc = P.createChainProvider({ cboe: c.cboe, yahoo: c.yahoo, env: {}, now: () => NOW });
  assert.equal(await pc.fetchChainResult('SPY'), null);
});

test('OPTIONS_PROVIDER=yahoo (rollback): CBOE is never touched', async () => {
  const { cboe, yahoo, calls } = fakes();
  const p = P.createChainProvider({ cboe, yahoo, env: { OPTIONS_PROVIDER: 'yahoo' }, now: () => NOW });
  const r = await p.fetchChainMultiExpiry('SPY', { maxExtra: 1 });
  assert.equal(r.provider, 'yahoo'); assert.equal(calls.cboe, 0); assert.equal(calls.yahooMulti, 1);
});

test('OPTIONS_PROVIDER=cboe-only: no fallback even when CBOE has nothing', async () => {
  const { cboe, yahoo, calls } = fakes({ cboeResult: null });
  const p = P.createChainProvider({ cboe, yahoo, env: { OPTIONS_PROVIDER: 'cboe-only' }, now: () => NOW });
  assert.equal(await p.fetchFullChain('SPY'), null);
  assert.equal(calls.yahooMulti, 0); assert.equal(p.getStats().fallbacks, 0);
});

test('CBOE per-expiry and multi-expiry views come from the one full body; fetchFullChain keeps chainComplete', async () => {
  const { cboe, yahoo, calls } = fakes();
  const p = P.createChainProvider({ cboe, yahoo, env: {}, now: () => NOW });
  const byDate = await p.fetchChainByDate('SPY', day(31));
  assert.equal(byDate.options.length, 1); assert.equal(byDate.options[0].expirationDate, day(31));
  assert.equal(await p.fetchChainByDate('SPY', day(4)), null, 'an unlisted expiry is null, not the nearest');
  const multi = await p.fetchChainMultiExpiry('SPY', { maxExtra: 2 });
  assert.equal(multi.options[0].expirationDate, day(3), 'nearest first');
  assert.ok(multi.options.length >= 2 && multi.options.length <= 3, 'nearest + swing/position picks');
  assert.equal(multi.chainComplete, false);
  const full = await p.fetchFullChain('SPY');
  assert.equal(full.chainComplete, true); assert.equal(full.options.length, 4);
  assert.equal(calls.yahooByDate + calls.yahooMulti + calls.yahooResult, 0);
});

test('module default instance exposes the baseline-compatible functions', () => {
  for (const k of ['fetchChainResult', 'fetchChainByDate', 'fetchChainMultiExpiry', 'fetchFullChain', 'getChainProviderStats']) assert.equal(typeof P[k], 'function', k);
});
