'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gr = require('../lib/alerts-grade');

// Ascending daily candles from a list of closes (open = prior close for simplicity).
function candles(closes, start = '2026-06-01') {
  const d = new Date(start + 'T00:00:00Z');
  return closes.map((c, i) => {
    const date = new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10);
    return { date, open: i ? closes[i - 1] : c, high: c * 1.01, low: c * 0.99, close: c, volume: 1e6 };
  });
}

const flat = n => candles(Array.from({ length: n }, () => 100));

test('grades at the NEXT open, never the decision-day close', () => {
  // decision on day index 5; entry must be day 6 open.
  const c = candles([100, 100, 100, 100, 100, 100, 110, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120]);
  const ep = { id: 'e1', ticker: 'AAA', side: 'long', firstSeenDate: c[5].date, execRef: 100 };
  const g = gr.gradeEpisode(ep, { candles: c, spy: flat(30) });
  assert.equal(g.graded, true);
  assert.equal(g.entryDate, c[6].date);
  assert.equal(g.entryPx, c[6].open);   // = day 5 close (100), the next open — not the day-6 close (110)
});

test('produces 1/3/5/10/21-session outcomes', () => {
  const c = candles(Array.from({ length: 40 }, (_, i) => 100 + i));  // steady uptrend
  const ep = { id: 'e', ticker: 'AAA', side: 'long', firstSeenDate: c[2].date, execRef: 100 };
  const g = gr.gradeEpisode(ep, { candles: c, spy: flat(40) });
  for (const h of [1, 3, 5, 10, 21]) assert.ok(g.horizons[h] && g.horizons[h].rawReturn != null, `horizon ${h} present`);
});

test('SPY-relative excess strips the market move', () => {
  const up = candles(Array.from({ length: 30 }, (_, i) => 100 + i));     // stock +
  const ep = { id: 'e', ticker: 'AAA', side: 'long', firstSeenDate: up[2].date, execRef: 100 };
  const withFlatSpy = gr.gradeEpisode(ep, { candles: up, spy: flat(30) });
  const withHotSpy = gr.gradeEpisode(ep, { candles: up, spy: candles(Array.from({ length: 30 }, (_, i) => 100 + i)) });
  assert.ok(withHotSpy.horizons[5].excessVsSpy < withFlatSpy.horizons[5].excessVsSpy);
});

test('short episodes carry a borrow cost that longs do not', () => {
  const c = candles(Array.from({ length: 30 }, () => 100));
  const long = gr.gradeEpisode({ id: 'l', ticker: 'A', side: 'long', firstSeenDate: c[2].date, execRef: 100 }, { candles: c, spy: flat(30) });
  const short = gr.gradeEpisode({ id: 's', ticker: 'A', side: 'short', firstSeenDate: c[2].date, execRef: 100 }, { candles: c, spy: flat(30) });
  assert.equal(long.horizons[5].borrowCostPct, 0);
  assert.ok(short.horizons[5].borrowCostPct > 0);
});

test('cost adjustment: directional return is net of round-trip cost', () => {
  const c = candles(Array.from({ length: 30 }, () => 100));  // truly flat
  const g = gr.gradeEpisode({ id: 'e', ticker: 'A', side: 'long', firstSeenDate: c[2].date, execRef: 100 }, { candles: c, spy: flat(30) });
  assert.ok(g.horizons[5].directional < 0);   // flat price still loses the cost
});

test('non-directional episode is not graded', () => {
  const g = gr.gradeEpisode({ id: 'e', ticker: 'A', side: null, firstSeenDate: '2026-06-03' }, { candles: flat(30), spy: flat(30) });
  assert.equal(g.graded, false);
});

test('chase: preMovePct captures how much of the move happened before the realistic entry', () => {
  // Alert posted when price was 100 (execRef), but by the next open the stock is 120 (candle
  // opens = prior close), so 20% of the move is already gone for a long entering at 120.
  const c = candles([100, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145]);
  const g = gr.gradeEpisode({ id: 'e', ticker: 'A', side: 'long', firstSeenDate: c[1].date, execRef: 100 }, { candles: c, spy: flat(30) });
  assert.equal(g.entryPx, 120);        // next open = prior close (120), not the alert price (100)
  assert.ok(g.preMovePct >= 15);
});
