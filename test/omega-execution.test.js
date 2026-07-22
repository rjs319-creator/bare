'use strict';
// OMEGA-SWING execution tests (Phase 3 / Phase 16): next-open + conditional fills, opening-gap
// invalidation, max-acceptable-entry, same-bar conservatism, deterministic + no same-close fill.
const { test } = require('node:test');
const assert = require('node:assert');
const OX = require('../lib/omega-execution');

// Build a candle series; the LAST bar is the signal, an extra bar is the tradeable next session.
function bars(closes, nextOpenPct = null, opts = {}) {
  let d = new Date('2025-01-01T00:00:00Z');
  const out = closes.map((close) => {
    const date = d.toISOString().slice(0, 10); d = new Date(d.getTime() + 86400000);
    return { date, open: close, high: close * 1.01, low: close * 0.99, close, volume: 5e6 };
  });
  if (nextOpenPct != null) {
    const date = d.toISOString().slice(0, 10);
    const prev = closes[closes.length - 1];
    const open = +(prev * (1 + nextOpenPct)).toFixed(2);
    const hi = Math.max(open, opts.nextHigh != null ? opts.nextHigh : open * 1.02);
    const lo = Math.min(open, opts.nextLow != null ? opts.nextLow : open * 0.98);
    out.push({ date, open, high: hi, low: lo, close: +(open * 1.005).toFixed(2), volume: 5e6 });
  }
  return out;
}
const f = { atrPct: 3, dollarVol: 5e7 };

test('BUY_NOW plans ELIGIBLE_NEXT_OPEN and fills at next open + slippage (never the signal close)', () => {
  const c = bars([100, 101, 102], 0.005);              // next open +0.5%
  const sigDate = c[c.length - 2].date;
  const p = OX.planOmegaEntry({ candles: c, signalDate: sigDate, entryClass: 'BUY_NOW', f, stop: 96, target1: 110, tier: 'liquid' });
  assert.strictEqual(p.executableState, OX.EXECUTABLE_STATES.FILLED);
  assert.strictEqual(p.fillStatus, 'filled');
  assert.ok(p.assumedFillPrice > 102, 'fills above the signal close (next open + slippage), not AT the close');
  assert.ok(p.assumedFillDate > sigDate, 'fill is strictly after the signal date');
  assert.strictEqual(p.signalReferencePrice, 102);
});

test('opening gap beyond tolerance is GAP_TOO_LARGE_SKIP (unfilled)', () => {
  const c = bars([100, 101, 102], 0.06);               // +6% gap > 4% default
  const p = OX.planOmegaEntry({ candles: c, signalDate: c[c.length - 2].date, entryClass: 'BUY_NOW', f, stop: 96, target1: 110 });
  assert.strictEqual(p.executableState, OX.EXECUTABLE_STATES.GAP_TOO_LARGE_SKIP);
  assert.strictEqual(p.fillStatus, 'unfilled');
  assert.strictEqual(p.noFillReason, 'opening-gap-too-large');
});

test('BUY_ON_BREAKOUT with a trigger the next bar never reaches → NO_FILL', () => {
  const c = bars([100, 101, 102], -0.01, { nextHigh: 102.5 }); // high 102.5 < trigger
  const p = OX.planOmegaEntry({ candles: c, signalDate: c[c.length - 2].date, entryClass: 'BUY_ON_BREAKOUT', f, levels: { resistance: 105 }, stop: 96, target1: 112 });
  assert.strictEqual(p.trigger, 105);
  assert.strictEqual(p.executableState, OX.EXECUTABLE_STATES.NO_FILL);
  assert.strictEqual(p.fillStatus, 'unfilled');
});

test('BUY_ON_FIRST_PULLBACK fills only when price pulls back to the limit', () => {
  const c = bars([100, 101, 102], 0.0, { nextLow: 98 });  // low 98 reaches a 98.5 limit
  const p = OX.planOmegaEntry({ candles: c, signalDate: c[c.length - 2].date, entryClass: 'BUY_ON_FIRST_PULLBACK', f, levels: { support: 98.5 }, stop: 95, target1: 110 });
  assert.strictEqual(p.trigger, 98.5);
  assert.strictEqual(p.fillStatus, 'filled');
  assert.ok(p.assumedFillPrice <= 98.5 + 0.01, 'limit fill at or better than the limit');
});

test('R:R is recomputed AT THE FILL, not at the signal close', () => {
  const c = bars([100, 101, 102], 0.005);
  const p = OX.planOmegaEntry({ candles: c, signalDate: c[c.length - 2].date, entryClass: 'BUY_NOW', f, stop: 98, target1: 108 });
  const expected = +((108 - p.assumedFillPrice) / (p.assumedFillPrice - 98)).toFixed(2);
  assert.strictEqual(p.rrAtFill, expected);
});

test('LIVE (no next session) returns the PLAN with pending fill — never a fabricated fill', () => {
  const c = bars([100, 101, 102]);                     // no next bar
  const p = OX.planOmegaEntry({ candles: c, signalDate: c[c.length - 1].date, entryClass: 'BUY_NOW', f, stop: 96, target1: 110 });
  assert.strictEqual(p.executableState, OX.EXECUTABLE_STATES.ELIGIBLE_NEXT_OPEN);
  assert.strictEqual(p.fillStatus, 'pending');
  assert.strictEqual(p.assumedFillPrice, null);
  assert.ok(p.maxAcceptableEntryPrice > 102, 'a max acceptable entry is planned');
});

test('WATCH / SKIP intents are AVOID (not tradeable)', () => {
  const c = bars([100, 101, 102], 0.005);
  for (const cls of ['WATCH', 'SKIP']) {
    const p = OX.planOmegaEntry({ candles: c, signalDate: c[c.length - 2].date, entryClass: cls, f });
    assert.strictEqual(p.executableState, OX.EXECUTABLE_STATES.AVOID);
  }
});

test('tierForDollarVol buckets by liquidity', () => {
  assert.strictEqual(OX.tierForDollarVol(1e6), 'micro');
  assert.strictEqual(OX.tierForDollarVol(1e7), 'small');
  assert.strictEqual(OX.tierForDollarVol(5e7), 'liquid');
});
