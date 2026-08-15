'use strict';
// CATALYST–FLOW ELIGIBILITY — the survivorship-safe universe rule.
//
// The universe is rebuilt from what existed on each date. The tests that matter are the
// refusals: an unknown security type is REJECTED rather than assumed to be a common share,
// a partial liquidity window is not a measurement, and the $5 floor is applied to the
// UNADJUSTED close (a split-adjusted series would silently drop names that really traded
// well above $5 at the time).
const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/catalyst-flow/eligibility');

const bars = (n, { close = 50, volume = 1e6 } = {}) =>
  Array.from({ length: n }, (_, i) => ({ date: `2024-01-${String(i + 1).padStart(2, '0')}`, open: close, high: close, low: close, close, volume }));

test('the liquidity screen uses the MEDIAN, so one halt-and-reopen print cannot carry a name over the floor', () => {
  const quiet = bars(30, { close: 50, volume: 1000 });         // ~$50k/day — far below the floor
  quiet[29] = { ...quiet[29], volume: 1e9 };                    // one enormous session
  const med = E.trailingMedianDollarVolume(quiet, 29);
  assert.ok(med < 1e6, 'the median ignores the outlier');

  const meanish = quiet.slice(10, 30).reduce((s, b) => s + b.close * b.volume, 0) / 20;
  assert.ok(meanish > med * 100, 'a MEAN would have been dragged over the floor by that one print');
});

test('a partial liquidity window is null, not a short-window estimate', () => {
  assert.strictEqual(E.trailingMedianDollarVolume(bars(30), 5), null, 'idx 5 has fewer than 20 prior sessions');
  assert.ok(E.trailingMedianDollarVolume(bars(30), 19) > 0);
});

test('an unknown security type is REJECTED — never admitted on the assumption it is a common share', () => {
  assert.strictEqual(E.isOperatingCommonShare('ABC', {}).reason, 'security-type-unknown');
  assert.strictEqual(E.isOperatingCommonShare('ABC', { quoteType: 'EQUITY' }).ok, true);
});

test('ETFs, funds and mutual funds are excluded by type', () => {
  assert.strictEqual(E.isOperatingCommonShare('XLK', { quoteType: 'ETF' }).reason, 'quote-type-etf');
  assert.strictEqual(E.isOperatingCommonShare('VFIAX', { quoteType: 'MUTUALFUND' }).reason, 'quote-type-mutualfund');
  assert.strictEqual(E.isOperatingCommonShare('ABC', { quoteType: 'EQUITY', isFund: true }).reason, 'fund');
});

test('warrants, units, rights and preferreds are excluded by symbol shape', () => {
  for (const sym of ['ABC.WS', 'ABC-WT', 'ABC.U', 'ABC-UN', 'ABC.RT', 'ABC-PR']) {
    assert.strictEqual(E.isOperatingCommonShare(sym, { quoteType: 'EQUITY' }).reason, 'instrument-suffix-excluded', sym);
  }
  assert.strictEqual(E.isOperatingCommonShare('ABC', { quoteType: 'EQUITY' }).ok, true);
});

test('the $5 floor is applied to the UNADJUSTED prior close supplied by the caller', () => {
  const b = bars(30, { close: 50, volume: 1e6 });
  const cheap = E.screenCandidate({ symbol: 'ABC', meta: { quoteType: 'EQUITY' }, bars: b, idx: 29, priorCloseUnadjusted: 4.5 });
  assert.strictEqual(cheap.eligible, false);
  assert.strictEqual(cheap.reason, 'price-below-floor');

  const ok = E.screenCandidate({ symbol: 'ABC', meta: { quoteType: 'EQUITY' }, bars: b, idx: 29, priorCloseUnadjusted: 50 });
  assert.strictEqual(ok.eligible, true);
});

test('a missing unadjusted close is a refusal, not a fall-through to the adjusted series', () => {
  const r = E.screenCandidate({ symbol: 'ABC', meta: { quoteType: 'EQUITY' }, bars: bars(30), idx: 29, priorCloseUnadjusted: null });
  assert.strictEqual(r.reason, 'no-unadjusted-prior-close');
});

test('buildEligibleUniverse ranks by liquidity, caps at the declared size, and COUNTS every exclusion', () => {
  const candidates = [
    ...Array.from({ length: 5 }, (_, i) => ({
      symbol: `LIQ${i}`, meta: { quoteType: 'EQUITY' },
      bars: bars(30, { close: 50, volume: 1e6 * (i + 1) }), idx: 29, priorCloseUnadjusted: 50,
    })),
    { symbol: 'ETFX', meta: { quoteType: 'ETF' }, bars: bars(30), idx: 29, priorCloseUnadjusted: 50 },
    { symbol: 'CHEAP', meta: { quoteType: 'EQUITY' }, bars: bars(30), idx: 29, priorCloseUnadjusted: 2 },
    { symbol: 'THIN', meta: { quoteType: 'EQUITY' }, bars: bars(30, { close: 50, volume: 10 }), idx: 29, priorCloseUnadjusted: 50 },
  ];
  const u = E.buildEligibleUniverse(candidates, { maxUniverse: 3 });
  assert.deepStrictEqual(u.universe, ['LIQ4', 'LIQ3', 'LIQ2'], 'most liquid first');
  assert.strictEqual(u.liquidityRank.LIQ4, 1);
  assert.strictEqual(u.scanned, 8);
  assert.strictEqual(u.attrition['quote-type-etf'], 1);
  assert.strictEqual(u.attrition['price-below-floor'], 1);
  assert.strictEqual(u.attrition['dollar-volume-below-floor'], 1);
  assert.strictEqual(u.attrition['beyond-liquidity-rank-cap'], 2);
});

test('universe membership is DETERMINISTIC — shuffling the candidate order cannot change it', () => {
  const mk = (i) => ({ symbol: `S${i}`, meta: { quoteType: 'EQUITY' }, bars: bars(30, { close: 50, volume: 1e6 }), idx: 29, priorCloseUnadjusted: 50 });
  const cands = Array.from({ length: 10 }, (_, i) => mk(i));
  const a = E.buildEligibleUniverse(cands, { maxUniverse: 4 }).universe;
  const b = E.buildEligibleUniverse([...cands].reverse(), { maxUniverse: 4 }).universe;
  assert.deepStrictEqual(a, b, 'ties break on symbol, so a re-run reproduces byte-identical membership');
});
