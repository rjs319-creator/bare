const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, tapeState, liquidity, DOWNDAY_REALITY } = require('../lib/downday');

// Build candles from a close-price path. open/high/low bracket each close; volume set
// so 20d $-vol clears the $25M liquidity floor (price ~ tens, vol ~1M → tens of $M).
function candlesFrom(closes, vol = 1_000_000) {
  return closes.map((c, i) => {
    const prev = i ? closes[i - 1] : c;
    const hi = Math.max(c, prev) * 1.01, lo = Math.min(c, prev) * 0.99;
    return { date: `2026-01-${String((i % 27) + 1).padStart(2, '0')}`, open: prev, high: hi, low: lo, close: c, volume: vol };
  });
}

// A V-reversal: long flat seed → prior high → sharp ≥20% drop into an oversold pivot
// → a FRESH turn (~10% off the low, room left to the target) that reclaims the 20-EMA.
function vReversalPath() {
  const p = [];
  for (let i = 0; i < 55; i++) p.push(100 + Math.sin(i / 3) * 1.5);        // seed
  for (let i = 0; i < 6; i++) p.push(100 + i);                             // run to prior high ~106
  for (let i = 0; i < 13; i++) p.push(106 - i * 1.65);                     // sharp drop to ~86 (−19%)
  for (let i = 0; i < 8; i++) p.push(86 + i * 0.7);                        // fresh recovery to ~91 (~7% off low)
  return p;
}

// An inverted-V (blow-off top → rollover): flat seed → sharp ≥20% run-up into an
// overbought peak → a FRESH rollover (~7% off the high, room left to the downside).
function invertedVPath() {
  const p = [];
  for (let i = 0; i < 45; i++) p.push(80 + Math.sin(i / 3) * 1.2);         // deep prior low ~80
  for (let i = 0; i < 26; i++) p.push(80 + i * 1.6);                       // run to peak ~122 (+52%)
  for (let i = 0; i < 10; i++) p.push(122 - i * 1.3);                      // rollover to ~110 (~10% off high)
  return p;
}

test('classifies a capitulation → turn as an Oversold Bounce long', () => {
  const c = classify(candlesFrom(vReversalPath()));
  assert.ok(c, 'should classify');
  assert.equal(c.bucket, 'bounce');
  assert.equal(c.side, 'long');
  assert.equal(c.signals.side, 'long');
  assert.ok(c.downScore >= 0 && c.downScore <= 100);
  assert.ok(c.signals.entry > 0 && c.signals.stop < c.signals.entry, 'long: stop below entry');
});

test('classifies a blow-off top → rollover as an Overheated short', () => {
  const c = classify(candlesFrom(invertedVPath()));
  assert.ok(c, 'should classify');
  assert.equal(c.bucket, 'fade');
  assert.equal(c.side, 'short');
  assert.ok(c.signals.stop > c.signals.entry, 'short: stop above entry');
});

test('returns null on a name with no reversal pattern (steady drift)', () => {
  const flat = Array.from({ length: 120 }, (_, i) => 50 + Math.sin(i / 5));
  assert.equal(classify(candlesFrom(flat)), null);
});

test('liquidity gate rejects sub-$5 price and thin $-volume', () => {
  const path = vReversalPath();
  assert.equal(classify(candlesFrom(path.map(x => x / 20))), null, 'sub-$5 rejected');   // ~$5 → below floor
  assert.equal(classify(candlesFrom(path, 100)), null, 'thin volume rejected');           // ~100 shares
  assert.ok(liquidity(candlesFrom(path)), 'liquid name passes');
});

test('bounce passes the tradeability gates (R:R, risk %, freshness) and scores in range', () => {
  const c = classify(candlesFrom(vReversalPath()));
  assert.ok(c.signals.rr >= 1.2, 'R:R floor enforced');
  assert.ok(c.signals.riskPct <= 20, 'stop is tradeable');
  assert.ok(c.geometry.rallyOffLowPct <= 18, 'turn caught early, not over-extended');
  assert.ok(c.downScore >= 0 && c.downScore <= 100);
});

test('a stale, over-extended bounce (already rallied to target) is filtered out', () => {
  // Deep drop then a full recovery back near the prior high → tiny reward left / expired.
  const p = [];
  for (let i = 0; i < 55; i++) p.push(100 + Math.sin(i / 3) * 1.5);
  for (let i = 0; i < 6; i++) p.push(100 + i);              // prior high ~106
  for (let i = 0; i < 12; i++) p.push(106 - i * 1.6);       // drop to ~88
  for (let i = 0; i < 25; i++) p.push(88 + i * 0.9);        // rally all the way back to ~110
  const c = classify(candlesFrom(p));
  assert.ok(!c || c.bucket !== 'bounce', 'over-recovered reversal not surfaced as a fresh bounce');
});

test('tapeState flags a red / risk-off tape and grades severity', () => {
  assert.equal(tapeState(-1.9, 'neutral').severity, 'heavy');
  assert.equal(tapeState(-1.0, 'neutral').severity, 'moderate');
  assert.equal(tapeState(-0.5, 'neutral').severity, 'light');
  assert.equal(tapeState(0.3, 'risk-on').down, false);
  const off = tapeState(0.1, 'risk-off');
  assert.equal(off.down, true, 'macro risk-off counts as a down tape even if SPY flat');
});

test('reality constants carry provenance and the honest leader verdict', () => {
  assert.equal(DOWNDAY_REALITY.leaderVerdict, 'mean-revert down');
  assert.ok(DOWNDAY_REALITY.bounceNormalDayExcessH3 < 0, 'bounce edge is red-tape-specific');
  assert.match(DOWNDAY_REALITY.source, /next-day open/);
});
