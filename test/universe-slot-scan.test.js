'use strict';
// Audit 2026-08-14 (M1): the nightly universe chains ran back-to-back
// `op=universescan&cursor=1` steps, but a Blob cursor overwrite propagates with a
// 10-30s+ read-back lag — the second step read the pre-write cursor and silently
// re-scanned the same 200-name slice, halving the "1,600 names/night" design claim.
// ?slot=N derives the slice deterministically from (epoch day, slot): no stored
// cursor, nothing to lag, same-night slots can never collide.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { slotStart, slotEpochDay, SLOTS_PER_NIGHT } = require('../lib/universe-routes');

const L = 1234, LIM = 150;
const day = 20680; // fixed epoch day so the test is deterministic

test('same night, different slots → distinct, non-overlapping slices', () => {
  const starts = Array.from({ length: SLOTS_PER_NIGHT }, (_, s) => slotStart({ slot: s, listLength: L, limit: LIM, epochDay: day }));
  assert.equal(new Set(starts).size, SLOTS_PER_NIGHT, `collision within one night: ${starts}`);
  for (const st of starts) assert.equal(st % LIM, 0, 'starts align to slice boundaries');
});

test('same slot, same day is stable; the next day advances by the full nightly stride', () => {
  const a = slotStart({ slot: 0, listLength: L, limit: LIM, epochDay: day });
  assert.equal(a, slotStart({ slot: 0, listLength: L, limit: LIM, epochDay: day }));
  const slices = Math.ceil(L / LIM);
  const next = slotStart({ slot: 0, listLength: L, limit: LIM, epochDay: day + 1 });
  assert.equal(next, ((Math.floor(a / LIM) + SLOTS_PER_NIGHT) % slices) * LIM);
});

test('the rotation covers EVERY slice of the list over consecutive days (wraps, no dead zones)', () => {
  const slices = Math.ceil(L / LIM);
  const seen = new Set();
  for (let d = 0; d < slices; d++) {
    for (let s = 0; s < SLOTS_PER_NIGHT; s++) seen.add(slotStart({ slot: s, listLength: L, limit: LIM, epochDay: day + d }));
  }
  assert.equal(seen.size, slices, 'every slice must be reachable');
});

test('degenerate inputs stay in range', () => {
  assert.equal(slotStart({ slot: 0, listLength: 0, limit: LIM, epochDay: day }), 0);
  const st = slotStart({ slot: 999, listLength: 40, limit: LIM, epochDay: day });
  assert.ok(st >= 0 && st < Math.max(1, Math.ceil(40 / LIM)) * LIM);
});

// Review 2026-08-15: epochDay defaulted to floor(Date.now()/86400000) PER REQUEST — a
// nightly chain straddling 00:00 UTC (22:00 UTC cron + hours of documented GitHub throttle
// delay) advanced the stride mid-chain, so the post-midnight slots jumped a full
// SLOTS_PER_NIGHT forward and ~8 slices were silently skipped that night. The epoch day is
// now anchored so the whole 18:00Z → (next-day) 17:59Z cron night maps to ONE day.
test('slotEpochDay: a chain straddling 00:00 UTC stays on ONE epoch day; the next night advances it', () => {
  const night = slotEpochDay(Date.parse('2026-08-14T23:59:00Z'));
  assert.equal(slotEpochDay(Date.parse('2026-08-15T00:30:00Z')), night,
    'post-midnight throttled steps must not jump the stride mid-chain');
  assert.equal(slotEpochDay(Date.parse('2026-08-15T17:59:00Z')), night,
    'the whole 18:00Z → 17:59Z window is one epoch day');
  assert.equal(slotEpochDay(Date.parse('2026-08-15T18:00:00Z')), night + 1,
    'the next cron night (18:00Z boundary) advances by exactly one epoch day');
});

test('slotStart defaults its epochDay to the night-anchored slotEpochDay', () => {
  const before = slotEpochDay();
  const start = slotStart({ slot: 3, listLength: L, limit: LIM });
  const after = slotEpochDay();
  if (before === after) {   // guard the vanishing race of crossing 18:00Z between the calls
    assert.equal(start, slotStart({ slot: 3, listLength: L, limit: LIM, epochDay: before }));
  }
});

test('the nightly chains dispatch exactly SLOTS_PER_NIGHT distinct slots (no cursor steps left)', () => {
  const WC = require('../lib/warm-chains');
  const scanSteps = Object.entries(WC.CHAINS)
    .filter(([name]) => /^universescan\d$/.test(name))
    .flatMap(([, steps]) => steps);
  assert.equal(scanSteps.length, SLOTS_PER_NIGHT, 'chain step count must match the stride');
  const slots = scanSteps.map(s => { const m = s.match(/slot=(\d+)/); assert.ok(m, `cursor-mode step reintroduced: ${s}`); return Number(m[1]); }).sort((a, b) => a - b);
  assert.deepEqual(slots, Array.from({ length: SLOTS_PER_NIGHT }, (_, i) => i), 'slots must be 0..N-1, each exactly once');
});
