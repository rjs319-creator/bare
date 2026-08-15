'use strict';
// CATALYST–FLOW CLOCK — session arithmetic, the conservative confirmation rule, and the
// one-position-per-symbol gate. The tests deliberately use a session axis with GAPS, since
// every place this repo has used calendar-day arithmetic for a trading horizon it has been
// wrong, and a gapless axis would hide exactly that class of bug.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/catalyst-flow/clock');

// Mon–Fri, then a holiday-shortened week: 12/25 and 01/01 are absent.
const SESSIONS = [
  '2024-12-20', '2024-12-23', '2024-12-24', '2024-12-26', '2024-12-27',
  '2024-12-30', '2024-12-31', '2025-01-02', '2025-01-03', '2025-01-06',
  '2025-01-07', '2025-01-08', '2025-01-09', '2025-01-10',
];

test('the confirmation session is the first session STRICTLY AFTER the announcement', () => {
  const c = C.eventClock(SESSIONS, '2024-12-24');
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.confirmationSession, '2024-12-26', 'Christmas Day is not a session');
  assert.strictEqual(c.decisionDate, '2024-12-26');
  assert.strictEqual(c.entrySession, '2024-12-27');
});

test('an announcement on a NON-session resolves from the last session at or before it', () => {
  const c = C.eventClock(SESSIONS, '2024-12-25');      // a holiday
  assert.strictEqual(c.confirmationSession, '2024-12-26');
});

test('the five-session hold is counted in SESSIONS, so it steps over the New Year holiday', () => {
  const c = C.eventClock(SESSIONS, '2024-12-24');
  // entry 12/27, then 12/30, 12/31, 01/02, 01/03 — five sessions, and 01/01 is skipped.
  assert.strictEqual(c.exitSession, '2025-01-03');
  assert.strictEqual(c.exitIdx - c.entryIdx, 4, 'five sessions inclusive of the entry session');
});

test('a horizon running past the observed axis is REFUSED, never truncated', () => {
  const c = C.eventClock(SESSIONS, '2025-01-09');
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.reason, 'horizon-beyond-session-axis');
});

test('an announcement before the axis begins is refused', () => {
  assert.strictEqual(C.eventClock(SESSIONS, '2020-01-01').reason, 'announcement-precedes-session-axis');
});

test('an unknown entry convention is refused rather than defaulting to the open', () => {
  const c = C.eventClock(SESSIONS, '2024-12-20', { entryConvention: 'closing-auction' });
  assert.strictEqual(c.ok, false);
  assert.match(c.reason, /unknown-entry-convention/);
});

test('postponement shifts the WHOLE clock forward — a late source never backfills', () => {
  const base = C.eventClock(SESSIONS, '2024-12-23');
  const late = C.postponeToNextDecision(SESSIONS, '2024-12-23');
  assert.strictEqual(base.decisionDate, '2024-12-24');
  assert.strictEqual(late.decisionDate, '2024-12-26', 'the decision moves, the data does not move back');
  assert.strictEqual(late.postponements, 1);
  assert.ok(late.entryIdx > base.entryIdx && late.exitIdx > base.exitIdx);
});

test('isAvailableByCutoff rejects an overnight file for the PRIOR close', () => {
  // Cboe EOD lands after the confirmation close: usable tomorrow morning, not tonight.
  assert.strictEqual(C.isAvailableByCutoff('2024-12-27T02:00:00Z', '2024-12-26T21:00:00Z'), false);
  assert.strictEqual(C.isAvailableByCutoff('2024-12-27T02:00:00Z', '2024-12-27T21:00:00Z'), true);
  assert.strictEqual(C.isAvailableByCutoff(null, '2024-12-27T21:00:00Z'), false);
});

test('a symbol already in an open five-session position cannot be re-entered', () => {
  const clocks = [
    { symbol: 'AAA', entryIdx: 0, exitIdx: 4 },
    { symbol: 'AAA', entryIdx: 2, exitIdx: 6 },   // overlaps the open position
    { symbol: 'AAA', entryIdx: 5, exitIdx: 9 },   // clear of it
    { symbol: 'BBB', entryIdx: 1, exitIdx: 5 },   // different symbol, unaffected
  ];
  const { admitted, rejected } = C.admitOnePositionPerSymbol(clocks);
  assert.strictEqual(admitted.length, 3);
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].rejectReason, 'symbol-already-in-open-position');
  assert.deepStrictEqual(admitted.map((c) => `${c.symbol}@${c.entryIdx}`), ['AAA@0', 'BBB@1', 'AAA@5']);
});

test('admission is order-independent — shuffling the input cannot change who gets in', () => {
  const clocks = [
    { symbol: 'AAA', entryIdx: 5, exitIdx: 9 },
    { symbol: 'AAA', entryIdx: 0, exitIdx: 4 },
    { symbol: 'AAA', entryIdx: 2, exitIdx: 6 },
  ];
  const a = C.admitOnePositionPerSymbol(clocks).admitted.map((c) => c.entryIdx);
  const b = C.admitOnePositionPerSymbol([...clocks].reverse()).admitted.map((c) => c.entryIdx);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, [0, 5]);
});
