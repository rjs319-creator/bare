'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const oc = require('../lib/options-classify');

// ── honest kind labels (replace the unsupported tape vocabulary) ────────────
test('kindLabel: sweep/block/large map to honest, non-tape labels', () => {
  assert.equal(oc.kindLabel('sweep'), 'High-turnover contract');
  assert.equal(oc.kindLabel('block'), 'Large estimated notional');
  assert.equal(oc.kindLabel('large'), 'Estimated premium activity');
  assert.equal(oc.kindLabel('anything-else'), 'Unusual options activity');
});

// ── DTE buckets (swing-relevant) ────────────────────────────────────────────
test('dteBucket: swing-horizon classification', () => {
  assert.equal(oc.dteBucket(0), '0-7');
  assert.equal(oc.dteBucket(7), '0-7');
  assert.equal(oc.dteBucket(8), '8-20');
  assert.equal(oc.dteBucket(30), '21-45');
  assert.equal(oc.dteBucket(60), '46-75');
  assert.equal(oc.dteBucket(120), '75+');
  assert.equal(oc.dteBucket(null), null);
  assert.equal(oc.dteBucket(undefined), null);
});

// ── ZERO-OI FIX: bounded, never Infinity/null, flag preserved ───────────────
test('volOiBounded: zero OI yields a bounded cap, never Infinity', () => {
  assert.equal(oc.volOiBounded(50, 0), oc.VOLOI_ZERO_OI_CAP);   // vol>0 on zero OI → capped
  assert.equal(oc.volOiBounded(0, 0), 0);                        // no activity → 0
  assert.equal(oc.volOiBounded(300, 100), 3);                    // normal ratio
  assert.equal(oc.volOiBounded(1e9, 1), oc.VOLOI_MAX);           // hard ceiling
  assert.ok(Number.isFinite(oc.volOiBounded(50, 0)));
});

test('isNewOnZeroOi: preserves the "vol on zero OI" fact as a flag', () => {
  assert.equal(oc.isNewOnZeroOi(50, 0), true);
  assert.equal(oc.isNewOnZeroOi(0, 0), false);
  assert.equal(oc.isNewOnZeroOi(50, 100), false);
});

// ── spread % + aggressor reliability ────────────────────────────────────────
test('spreadPct: relative to mid, null without a usable quote', () => {
  assert.equal(oc.spreadPct(1.0, 2.0), 66.7);   // (1)/(1.5)
  assert.equal(oc.spreadPct(1.9, 2.0), 5.1);
  assert.equal(oc.spreadPct(null, 2.0), null);
  assert.equal(oc.spreadPct(2.0, 1.0), null);   // crossed
});

test('aggressorReliable: needs a real two-sided, non-crossed quote', () => {
  assert.equal(oc.aggressorReliable(1.0, 2.0), true);
  assert.equal(oc.aggressorReliable(2.0, 2.0), false);   // zero width
  assert.equal(oc.aggressorReliable(null, 2.0), false);
});

// ── the honest per-contract directional state ───────────────────────────────
test('directionState: only ask-side buying on a reliable quote earns a lean', () => {
  // Call bought at the ask → provisional bullish.
  assert.equal(oc.directionState({ side: 'call', aggressor: 'ask', bid: 1, ask: 2 }), oc.DIRECTION.BULLISH);
  // Put bought at the ask → provisional bearish.
  assert.equal(oc.directionState({ side: 'put', aggressor: 'ask', bid: 1, ask: 2 }), oc.DIRECTION.BEARISH);
});

test('directionState: bid/mid/no-quote/ambiguous all resolve to UNKNOWN', () => {
  // Calls are NOT automatically bullish — a call at the bid could be selling/closing.
  assert.equal(oc.directionState({ side: 'call', aggressor: 'bid', bid: 1, ask: 2 }), oc.DIRECTION.UNKNOWN);
  assert.equal(oc.directionState({ side: 'call', aggressor: 'mid', bid: 1, ask: 2 }), oc.DIRECTION.UNKNOWN);
  assert.equal(oc.directionState({ side: 'call', aggressor: 'ask', bid: null, ask: 2 }), oc.DIRECTION.UNKNOWN);
  assert.equal(oc.directionState({ side: 'call', aggressor: 'ask', bid: 1, ask: 2, ambiguous: true }), oc.DIRECTION.UNKNOWN);
});

// ── multi-leg / spread detection ────────────────────────────────────────────
test('detectMultiLeg: opposing types, same expiry, similar volume → both flagged', () => {
  const contracts = [
    { side: 'call', strike: 105, expiry: '2026-08-21', volume: 1000 },
    { side: 'put', strike: 95, expiry: '2026-08-21', volume: 1000 },   // combo footprint
  ];
  const flagged = oc.detectMultiLeg(contracts);
  assert.equal(flagged.size, 2);
});

test('detectMultiLeg: a lone contract or dissimilar volume is not flagged', () => {
  assert.equal(oc.detectMultiLeg([{ side: 'call', strike: 100, expiry: '2026-08-21', volume: 1000 }]).size, 0);
  const dissimilar = [
    { side: 'call', strike: 105, expiry: '2026-08-21', volume: 1000 },
    { side: 'put', strike: 95, expiry: '2026-08-21', volume: 50 },   // volumes too different
  ];
  assert.equal(oc.detectMultiLeg(dissimilar).size, 0);
});

// ── contract flags (data-quality / ambiguity penalties, never dropped) ──────
test('contractFlags: wide spread, far OTM, very short DTE, zero OI, index hedge', () => {
  const f = oc.contractFlags({ bid: 1, ask: 2, strike: 200, underlying: 100, dte: 1, volume: 10, openInterest: 0, ticker: 'SPY' });
  assert.ok(f.includes('wideSpread'));
  assert.ok(f.includes('farOtm'));
  assert.ok(f.includes('veryShortDte'));
  assert.ok(f.includes('newOnZeroOi'));
  assert.ok(f.includes('indexHedge'));
});

// ── normalized observation: the source-of-truth record ──────────────────────
test('normalizeObservation: always delayed, carries honest state + DTE bucket', () => {
  const obs = oc.normalizeObservation(
    { ticker: 'NVDA', side: 'call', strike: 120, underlying: 118, dte: 30, bid: 3.6, ask: 4.0, aggressor: 'ask', volume: 500, openInterest: 100, premium: 200000, kind: 'sweep' },
    { dataTs: '2026-07-21T14:00:00Z' },
  );
  assert.equal(obs.dataDelayed, true);
  assert.equal(obs.directionState, oc.DIRECTION.BULLISH);
  assert.equal(obs.dteBucket, '21-45');
  assert.equal(obs.kindLabel, 'High-turnover contract');
  assert.equal(obs.dataTs, '2026-07-21T14:00:00Z');
  assert.ok(Number.isFinite(obs.volOiBounded));
});

test('normalizeObservation: ctx.ambiguous forces UNKNOWN + suspectedMultiLeg flag', () => {
  const obs = oc.normalizeObservation(
    { ticker: 'NVDA', side: 'call', strike: 120, underlying: 118, dte: 30, bid: 3.6, ask: 4.0, aggressor: 'ask', volume: 500, openInterest: 100 },
    { ambiguous: true },
  );
  assert.equal(obs.directionState, oc.DIRECTION.UNKNOWN);
  assert.ok(obs.ambiguityFlags.includes('suspectedMultiLeg'));
});

// ── aggregate direction: MIXED and UNKNOWN emerge honestly ──────────────────
test('aggregateDirection: opposing provisional evidence → MIXED, not a net lean', () => {
  const obs = [
    oc.normalizeObservation({ side: 'call', aggressor: 'ask', bid: 1, ask: 2, premium: 1e6 }),
    oc.normalizeObservation({ side: 'put', aggressor: 'ask', bid: 1, ask: 2, premium: 1e6 }),
  ];
  assert.equal(oc.aggregateDirection(obs).state, oc.DIRECTION.MIXED);
});

test('aggregateDirection: all bid/mid activity → DIRECTION_UNKNOWN', () => {
  const obs = [
    oc.normalizeObservation({ side: 'call', aggressor: 'bid', bid: 1, ask: 2, premium: 1e6 }),
    oc.normalizeObservation({ side: 'put', aggressor: 'mid', bid: 1, ask: 2, premium: 1e6 }),
  ];
  assert.equal(oc.aggregateDirection(obs).state, oc.DIRECTION.UNKNOWN);
});

test('aggregateDirection: dominant ask-side calls → PROVISIONAL_BULLISH', () => {
  const obs = [
    oc.normalizeObservation({ side: 'call', aggressor: 'ask', bid: 1, ask: 2, premium: 5e6 }),
    oc.normalizeObservation({ side: 'call', aggressor: 'ask', bid: 1, ask: 2, premium: 5e6 }),
    oc.normalizeObservation({ side: 'put', aggressor: 'ask', bid: 1, ask: 2, premium: 5e5 }),
  ];
  assert.equal(oc.aggregateDirection(obs).state, oc.DIRECTION.BULLISH);
});

test('aggregateDirection: empty set is UNKNOWN, never throws', () => {
  assert.equal(oc.aggregateDirection([]).state, oc.DIRECTION.UNKNOWN);
});
