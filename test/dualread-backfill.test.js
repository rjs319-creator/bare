// Tests for the point-in-time dual-read backfill replay (lib/dualread-backfill.js).
const test = require('node:test');
const assert = require('node:assert');
const { replayTicker } = require('../lib/dualread-backfill');

// Build a daily series of `n` bars from a close-generating fn.
const mk = (n, fn, start = 0) => Array.from({ length: n }, (_, i) => ({ date: `2024-${String(1 + Math.floor((start + i) / 28) % 12).padStart(2, '0')}-${String(1 + (start + i) % 28).padStart(2, '0')}`, close: fn(i) }));

test('replayTicker: strong uptrend vs flat SPY → bullish signals, positive excess', () => {
  const stock = mk(320, i => 50 + i * 0.3);      // steadily rising
  const spy = mk(320, () => 400);                 // flat
  const rows = replayTicker(stock, spy, { horizon: 21, step: 21, ticker: 'UP' });
  assert.ok(rows.length >= 3, `expected several rows, got ${rows.length}`);
  const r = rows[rows.length - 1];
  assert.equal(r.ticker, 'UP');
  assert.ok(r.signals.trend200 === 1, 'should read above the 200-day');
  assert.ok(r.fwd > 0, `rising stock vs flat SPY should have positive excess (${r.fwd})`);
  assert.ok(['lowvol', 'midvol', 'highvol', 'other'].includes(r.group));
});

test('replayTicker: no lookahead — fwd depends only on bars in [i, i+H]', () => {
  const base = i => 100 + i;                       // linear
  const stock = mk(300, base);
  const spy = mk(300, () => 500);
  const rows1 = replayTicker(stock, spy, { horizon: 21, step: 21 });
  // Mutate bars AFTER the last sampled read's forward window; earlier rows must not change.
  const stock2 = stock.map((c, i) => ({ ...c, close: i > 290 ? c.close * 5 : c.close }));
  const rows2 = replayTicker(stock2, spy, { horizon: 21, step: 21 });
  assert.deepEqual(rows1.slice(0, rows1.length - 1), rows2.slice(0, rows2.length - 1));
});

test('replayTicker: too little history → no rows', () => {
  const stock = mk(120, i => 100 + i);
  const spy = mk(120, () => 500);
  assert.equal(replayTicker(stock, spy, { horizon: 21 }).length, 0);
});

test('replayTicker: missing SPY → no rows (excess undefined)', () => {
  const stock = mk(300, i => 100 + i);
  assert.equal(replayTicker(stock, null, { horizon: 21 }).length, 0);
});

test('replayTicker: rows carry signals, group, date, numeric fwd', () => {
  const rows = replayTicker(mk(300, i => 80 + Math.sin(i / 10) * 5 + i * 0.05), mk(300, () => 450), { horizon: 21, step: 21 });
  for (const r of rows) {
    assert.ok(r.signals && typeof r.signals === 'object');
    assert.ok(typeof r.date === 'string');
    assert.ok(Number.isFinite(r.fwd));
  }
});
