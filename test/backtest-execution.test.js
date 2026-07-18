'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const BT = require('../api/backtest');
const { STOP_ATR, TGT_ATR } = BT;

// Build a candle series. `open`/`high`/`low`/`close` explicit so we control the fill bar.
const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c, volume: 1e6 });

// A monotonic uptrend so a long ATR target resolves; the signal is at index `i`.
function series(n = 40, start = 100, step = 1) {
  const out = [];
  let t = Date.UTC(2026, 0, 5);
  for (let k = 0; k < n; k++) {
    const c = start + k * step;
    out.push(bar(new Date(t).toISOString().slice(0, 10), c - 0.3, c + 0.6, c - 0.6, c));
    t += 86400000;
  }
  return out;
}

test('simAtrTrade enters at the NEXT session open, not the signal-day close', () => {
  const c = series();
  const closes = c.map(x => x.close), highs = c.map(x => x.high), lows = c.map(x => x.low);
  const i = 20;
  const trade = BT.simAtrTrade(c, closes, highs, lows, 1.0, i, 'liquid');
  assert.ok(trade, 'expected a fillable trade');
  assert.equal(trade.fillDate, c[i + 1].date);                 // next session
  // liquid entry-side slippage nudges the fill just above the raw next open
  assert.ok(trade.entry >= c[i + 1].open, `entry ${trade.entry} ≥ next open ${c[i + 1].open}`);
  assert.ok(trade.entry < c[i + 1].open * 1.01, 'slippage is small, not a fabricated jump');
  assert.notEqual(trade.entry, closes[i]);                     // NOT the signal-day close
});

test('simAtrTrade stop/target are computed off the realistic entry', () => {
  const c = series();
  const closes = c.map(x => x.close), highs = c.map(x => x.high), lows = c.map(x => x.low);
  const trade = BT.simAtrTrade(c, closes, highs, lows, 1.0, 20, 'liquid');
  assert.ok(Math.abs(trade.stop - (trade.entry - STOP_ATR * 1.0)) < 1e-9);
  assert.ok(Math.abs(trade.target - (trade.entry + TGT_ATR * 1.0)) < 1e-9);
});

test('simAtrTrade returns null when the signal is on the LAST bar (cannot fill)', () => {
  const c = series();
  const closes = c.map(x => x.close), highs = c.map(x => x.high), lows = c.map(x => x.low);
  const trade = BT.simAtrTrade(c, closes, highs, lows, 1.0, c.length - 1, 'liquid');
  assert.equal(trade, null);   // no next session → no fabricated same-close fill
});

test('a downtrend hits the stop and yields a loss off the next-open entry', () => {
  const c = series(40, 140, -1);   // falling series
  const closes = c.map(x => x.close), highs = c.map(x => x.high), lows = c.map(x => x.low);
  const trade = BT.simAtrTrade(c, closes, highs, lows, 1.0, 15, 'liquid');
  assert.ok(trade);
  assert.equal(trade.won, false);
  assert.ok(trade.r < 0, `expected a negative return, got ${trade.r}`);
});
