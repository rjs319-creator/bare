'use strict';
// PIT security-master core tests. The invariant that makes this survivorship-safe: a delisted name
// must be a universe member BEFORE its last trading day and absent AFTER it — a survivor-only list
// silently drops exactly those names, which is the bias. Also: membership never peeks (cap uses
// report-lagged shares; a stale tail is not a member), and candlesFor produces ascending OHLCV.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SM = require('../research/lib/secmaster');

// FMP-shape daily rows (newest-first is fine — priceSeries sorts). `to` is the LAST trading day.
function bars(toISO, n, { close = 10, volume = 1_000_000 } = {}) {
  const rows = []; const d = new Date(toISO + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    rows.push({ symbol: 'X', date: d.toISOString().slice(0, 10), open: close, high: close, low: close, close, volume });
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return rows; // newest-first
}
// One income row so the cap band has report-lagged shares available. cap = close × shares.
const income = (shares, filingDate = '2021-03-01') => [{ date: '2020-12-31', filingDate, weightedAverageShsOut: shares }];

const CUTOFF = SM.ACTIVE_CUTOFF_MS;                    // 2026-04-01
const ms = (iso) => Date.parse(iso + 'T00:00:00Z');

// ── buildRecord: listing window + delisted classification ─────────────────────
test('buildRecord derives the listing window and flags delisted by last bar', () => {
  const dead = SM.buildRecord({ sym: 'SIVB', price: bars('2023-03-09', 60), income: income(1e8) });
  assert.equal(dead.lastDate, '2023-03-09');
  assert.equal(dead.delisted, true, 'a name whose last bar predates the cutoff is delisted');
  assert.equal(dead.delistDate, '2023-03-09');

  const alive = SM.buildRecord({ sym: 'AAPL', price: bars('2026-05-20', 60), income: income(1e8) });
  assert.equal(alive.delisted, false, 'a name still trading past the cutoff is active');
  assert.equal(alive.delistDate, null);
});

test('buildRecord returns null without usable price history', () => {
  assert.equal(SM.buildRecord({ sym: 'X', price: [] }), null);
  assert.equal(SM.buildRecord(null), null);
});

// ── the survivorship invariant ────────────────────────────────────────────────
test('a delisted name is a member BEFORE its last bar and excluded AFTER', () => {
  // In-band: close 10 × 1e8 shares = $1.0B cap (300M–10B), $10M/day ADV (≥ $3M).
  const rec = { sym: 'SIVB', price: bars('2023-03-09', 400, { close: 10, volume: 1_000_000 }), income: income(1e8) };
  const before = SM.memberAsOf(rec, ms('2023-01-16'));
  assert.ok(before && before.sym === 'SIVB', 'tradeable + in-band while listed → member');
  assert.ok(before.cap >= 300e6 && before.cap <= 10e9);
  // A year after it stopped trading: outside the listing window → NOT a member.
  assert.equal(SM.memberAsOf(rec, ms('2024-01-16')), null, 'a delisted name must drop out after its last bar');
  // Before it ever listed: also not a member.
  assert.equal(SM.memberAsOf(rec, ms('2020-01-16')), null, 'not a member before the first bar');
});

test('memberAsOf applies the cap band and can skip it with band=null', () => {
  // cap = 10 × 1e9 = $10B... push out of band with huge share count → $100B.
  const huge = { sym: 'MEGA', price: bars('2026-05-20', 400, { close: 10, volume: 1_000_000 }), income: income(1e10) };
  assert.equal(SM.memberAsOf(huge, ms('2026-03-16')), null, 'above the cap band → not a member');
  assert.ok(SM.memberAsOf(huge, ms('2026-03-16'), null), 'band=null → listing-window membership only');
});

// ── universeFrom: delisted-inclusive cross-section ────────────────────────────
test('universeFrom includes a since-delisted name at an in-window date, drops it later', () => {
  const map = {
    SIVB: { sym: 'SIVB', price: bars('2023-03-09', 400, { close: 10, volume: 1_000_000 }), income: income(1e8) },
    // Long-lived name: ~1400 bars so it is listed across BOTH query dates (2023 and 2026).
    AAPL: { sym: 'AAPL', price: bars('2026-05-20', 1400, { close: 10, volume: 1_000_000 }), income: income(1e8) },
  };
  const early = SM.universeFrom(map, ms('2023-01-16')).map(r => r.sym);
  assert.deepEqual(early, ['AAPL', 'SIVB'], 'both tradeable in Jan-2023 → survivorship-free cross-section');
  const late = SM.universeFrom(map, ms('2026-03-16')).map(r => r.sym);
  assert.deepEqual(late, ['AAPL'], 'by 2026 SIVB is gone — a survivor-only list would have hidden that it once existed');
});

// ── candlesFor: harness-shaped, ascending ─────────────────────────────────────
test('candlesFor returns ascending OHLCV candles the NSL harnesses accept', () => {
  const c = SM.candlesFor({ price: bars('2023-03-09', 5, { close: 10 }) });
  assert.equal(c.length, 5);
  assert.ok(c[0].date < c[c.length - 1].date, 'ascending by date');
  assert.ok(['date', 'open', 'high', 'low', 'close', 'volume'].every(k => k in c[0]));
});
