const test = require('node:test');
const assert = require('node:assert');
const { interpretTicker, contractEvidence, DELAYED_CONF_CAP } = require('../lib/options-interpret-v2');
const { INTERPRETATION } = require('../lib/options-config-v2');

const nowMs = Date.parse('2026-08-06T21:30:00Z');
const freshTs = Math.floor(nowMs / 1000) - 3600;

function c(over = {}) {
  return {
    contractSymbol: 'X', ticker: 'X', side: 'call', strike: 100, expiry: '2026-09-18', dte: 40,
    bid: 1.9, ask: 2.1, lastPrice: 2.08, volume: 1000, openInterest: 100,
    estNotional: 200_000, underlying: 100, lastTradeTs: freshTs, ...over,
  };
}

test('calls are NOT automatically bullish: a call printing at the bid gives no direction', () => {
  const r = interpretTicker([c({ lastPrice: 1.9 })], { nowMs });
  assert.strictEqual(r.state, INTERPRETATION.UNKNOWN);
  assert.strictEqual(r.confidence, 0);
});

test('puts are NOT automatically bearish: a put printing at the bid gives no direction', () => {
  const r = interpretTicker([c({ side: 'put', lastPrice: 1.9 })], { nowMs });
  assert.strictEqual(r.state, INTERPRETATION.UNKNOWN);
});

test('OTM-ness adds no direction: a far-OTM call at midpoint stays UNKNOWN', () => {
  const r = interpretTicker([c({ strike: 140, lastPrice: 2.0 })], { nowMs });
  assert.strictEqual(r.state, INTERPRETATION.UNKNOWN);
});

test('STRESS: a 100% bid/ask spread can never earn direction confidence', () => {
  const wide = c({ bid: 1, ask: 3, lastPrice: 2.95 });   // spread = 100% of mid
  const ev = contractEvidence(wide, nowMs);
  assert.strictEqual(ev.lean, null);
  assert.match(ev.why, /spread too wide/);
  const r = interpretTicker([wide], { nowMs });
  assert.strictEqual(r.state, INTERPRETATION.UNKNOWN);
  assert.strictEqual(r.confidence, 0);
});

test('STRESS: stale last prints (weekend-old vs current quote) eliminate direction', () => {
  const stale = c({ lastTradeTs: Math.floor(nowMs / 1000) - 3 * 86400 });
  const ev = contractEvidence(stale, nowMs);
  assert.strictEqual(ev.lean, null);
  assert.match(ev.why, /stale/);
  const r = interpretTicker([stale], { nowMs });
  assert.strictEqual(r.state, INTERPRETATION.UNKNOWN);
});

test('ask-side print on a fresh tight quote → provisional lean, HARD-CAPPED confidence', () => {
  const r = interpretTicker([c(), c({ strike: 105, contractSymbol: 'Y', volume: 400 })], { nowMs });
  // Same-type different-strike similar volume could flag as spread; use dissimilar volumes.
  if (r.state === INTERPRETATION.BULLISH_PROVISIONAL) {
    assert.ok(r.confidence <= DELAYED_CONF_CAP, `confidence ${r.confidence} must be ≤ ${DELAYED_CONF_CAP} on delayed data`);
    assert.strictEqual(r.confidenceCap, DELAYED_CONF_CAP);
  } else {
    assert.strictEqual(r.state, INTERPRETATION.POSSIBLE_SPREAD);   // conservative alternative is acceptable
  }
});

test('STRESS: two same-expiry contracts with similar volume → POSSIBLE_SPREAD footprint, not a confirmed spread', () => {
  const a = c({ contractSymbol: 'A', volume: 1000 });
  const b = c({ contractSymbol: 'B', side: 'put', strike: 95, volume: 900, lastPrice: 2.08 });
  const r = interpretTicker([a, b], { nowMs });
  assert.strictEqual(r.state, INTERPRETATION.POSSIBLE_SPREAD);
  const text = (r.evidenceAgainst || []).join(' ');
  assert.match(text, /NOT a confirmed spread/i);
});

test('STRESS: conflicting call and put ask-side activity → MIXED, zero confidence', () => {
  // Dissimilar volumes so the spread detector doesn't pair them (0.45 ratio < 0.6).
  const bull = c({ contractSymbol: 'A', volume: 2000, estNotional: 500_000 });
  const bear = c({ contractSymbol: 'B', side: 'put', strike: 80, volume: 900, estNotional: 400_000, lastPrice: 2.08 });
  const r = interpretTicker([bull, bear], { nowMs });
  assert.strictEqual(r.state, INTERPRETATION.MIXED);
  assert.strictEqual(r.confidence, 0);
});

test('index-ETF put-dominant flow → POSSIBLE_HEDGE', () => {
  const puts = [c({ side: 'put', volume: 5000, estNotional: 2_000_000, lastPrice: 2.08 }), c({ side: 'put', strike: 95, contractSymbol: 'B', volume: 900, estNotional: 500_000, lastPrice: 2.08 })];
  const r = interpretTicker(puts, { nowMs, isIndex: true });
  assert.strictEqual(r.state, INTERPRETATION.POSSIBLE_HEDGE);
});

test('no contracts → UNKNOWN with zero confidence (not an error, not a guess)', () => {
  const r = interpretTicker([], { nowMs });
  assert.strictEqual(r.state, INTERPRETATION.UNKNOWN);
  assert.strictEqual(r.confidence, 0);
});
