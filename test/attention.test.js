'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyAttention } = require('../lib/attention');

// Build archive days where `present[t]` maps ticker -> mentions (omit = not trending).
function days(list) {
  return list.map(([date, present]) => ({
    date,
    records: Object.entries(present).map(([ticker, mentions]) => ({ ticker, mentions, trendRank: 1 })),
  }));
}
const D = ['2026-06-21', '2026-06-22', '2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26'];

test('classifyAttention: sustained multi-day presence → Sticky', () => {
  // STICK present all 6 days, mentions holding/rising.
  const ds = days(D.map((d, i) => [d, { STICK: 100 + i * 5 }]));
  const out = classifyAttention(ds, { window: 6 });
  assert.equal(out.byTicker.STICK.class, 'Sticky');
  assert.equal(out.byTicker.STICK.presence, 6);
  assert.equal(out.summary.sticky, 1);
});

test('classifyAttention: single recent spike → Fast', () => {
  // HYPE appears only on the last day with a big count.
  const ds = days(D.map((d, i) => [d, i === D.length - 1 ? { HYPE: 900 } : {}]));
  const out = classifyAttention(ds, { window: 6 });
  assert.equal(out.byTicker.HYPE.class, 'Fast');
  assert.equal(out.byTicker.HYPE.presence, 1);
});

test('classifyAttention: spiked then fell well off its peak → Fast (hype giving back)', () => {
  // Present 4 days: peaks at 1000 then decays to 200 (< 0.55 * peak).
  const seq = { '2026-06-23': 1000, '2026-06-24': 700, '2026-06-25': 350, '2026-06-26': 200 };
  const ds = days(D.map(d => [d, seq[d] != null ? { FADE: seq[d] } : {}]));
  const out = classifyAttention(ds, { window: 6 });
  assert.equal(out.byTicker.FADE.class, 'Fast');
  assert.equal(out.byTicker.FADE.fadingFromPeak, true);
});

test('classifyAttention: present 3+ days holding near peak → Sticky, not Fast', () => {
  const seq = { '2026-06-24': 300, '2026-06-25': 320, '2026-06-26': 310 };
  const ds = days(D.map(d => [d, seq[d] != null ? { HOLD: seq[d] } : {}]));
  const out = classifyAttention(ds, { window: 6 });
  assert.equal(out.byTicker.HOLD.class, 'Sticky');
});

test('classifyAttention: attention gone cold (not recent) → dropped', () => {
  // OLD trended only on the first two days, nothing in the recent window.
  const ds = days(D.map((d, i) => [d, i < 2 ? { OLD: 500 } : {}]));
  const out = classifyAttention(ds, { window: 6, recentDays: 3 });
  assert.equal(out.byTicker.OLD, undefined); // not an active signal
});

test('classifyAttention: trustworthy flips with enough archived days', () => {
  assert.equal(classifyAttention(days(D.slice(0, 4).map(d => [d, { X: 10 }])), {}).trustworthy, false);
  const long = Array.from({ length: 12 }, (_, i) => [`2026-06-${String(i + 1).padStart(2, '0')}`, { X: 10 }]);
  assert.equal(classifyAttention(days(long), {}).trustworthy, true);
});

test('classifyAttention: empty input is safe', () => {
  const out = classifyAttention([], {});
  assert.deepEqual(out.byTicker, {});
  assert.equal(out.trustworthy, false);
});
