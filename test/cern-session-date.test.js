'use strict';
// CERN STAMPED THE DETECTOR'S CLOCK, NOT A MARKET SESSION.
//
// lib/cern.js created every event with `dateMs: nowMs`, and cernPicksFrom turned
// that into a Scoreboard decision date with `new Date(dateMs).toISOString()`.
// The `capture` warm chain (op=cerntick) runs DAILY INCLUDING WEEKENDS, so
// weekend runs minted weekend decision dates. In production, 10 of the events
// section's 27 dates (37%) landed on non-trading days:
//
//     2026-07-12  Sun  +52.50   <- the peak, and the single observation behind
//                                  the only surviving prosecutor conviction
//     2026-07-04  Sat  +27.37   <- also US Independence Day
//     2026-05-30  Sat  +11.37   ... 8 Sundays and 2 Saturdays in all
//
// With `entry: null` the grader resolves `candle.date <= '2026-07-12'` to
// FRIDAY's bar, so a Sunday-stamped event is silently graded from the prior
// Friday. Not a look-ahead — but the label is fiction, and a Friday-stamped and
// a Sunday-stamped event map to the SAME bar while counting as TWO independent
// decision dates. effectiveN, the CI, blockStability and the prosecutor's
// verdict all inherit that.
//
// FIX FORWARD, MARK THE PAST. New events carry `sessionDate` (the last completed
// regular session). Historical events have no such field, so their legacy date is
// preserved rather than silently restated — this repo does not rewrite evidence
// records — and they are flagged `sessionAligned: false` so the rows can be
// excluded or recomputed deliberately.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cernPicksFrom } = require('../lib/apex-routes');
const MS = require('../lib/market-session');

const ev = (o) => ({ type: 'LOCKUP_EXPIRY', symbol: 'AAA', direction: -1, ...o });
// 2026-07-12 is a Sunday; 2026-07-04 a Saturday; 2026-07-08 a Wednesday.
const SUNDAY_MS = Date.UTC(2026, 6, 12, 22, 1, 0);
const WEDNESDAY_MS = Date.UTC(2026, 6, 8, 22, 1, 0);

// ── marking the legacy rows ────────────────────────────────────────────────
test('a legacy weekend-stamped event keeps its date but is flagged', () => {
  const [row] = cernPicksFrom({ ledger: [ev({ dateMs: SUNDAY_MS })] });
  assert.equal(row.date, '2026-07-12', 'the historical date is preserved, not restated');
  assert.equal(row.sessionAligned, false);
});

test('a legacy weekday-stamped event is not flagged', () => {
  const [row] = cernPicksFrom({ ledger: [ev({ dateMs: WEDNESDAY_MS, symbol: 'BBB' })] });
  assert.equal(row.date, '2026-07-08');
  assert.equal(row.sessionAligned, true);
});

test('a market holiday on a weekday is caught too, not just weekends', () => {
  // Whichever full holidays the session calendar knows, a stamp on one is not
  // a tradable decision date either.
  const holiday = [...MS.FULL_HOLIDAYS][0];
  assert.ok(holiday, 'the session calendar must define full holidays');
  const [y, m, d] = holiday.split('-').map(Number);
  const [row] = cernPicksFrom({ ledger: [ev({ dateMs: Date.UTC(y, m - 1, d, 22, 1, 0), symbol: 'CCC' })] });
  assert.equal(row.date, holiday);
  assert.equal(row.sessionAligned, false);
});

// ── fixing forward ─────────────────────────────────────────────────────────
test('a new event carrying sessionDate uses it and counts as aligned', () => {
  const [row] = cernPicksFrom({ ledger: [ev({ dateMs: SUNDAY_MS, sessionDate: '2026-07-10', symbol: 'DDD' })] });
  assert.equal(row.date, '2026-07-10', 'the last completed session, not the detector clock');
  assert.equal(row.sessionAligned, true);
});

test('sessionDate wins over the raw timestamp even when they disagree', () => {
  const [row] = cernPicksFrom({ ledger: [ev({ dateMs: SUNDAY_MS, sessionDate: '2026-07-09', symbol: 'EEE' })] });
  assert.equal(row.date, '2026-07-09');
});

// ── the engine stamps it going forward ─────────────────────────────────────
test('the session helper resolves a weekend clock to the prior session', () => {
  // Sunday 2026-07-12 22:01 UTC -> the last COMPLETED regular session is Friday.
  const s = MS.lastCompletedRegularSession(new Date(SUNDAY_MS));
  assert.equal(s, '2026-07-10');
});

test('cern stamps sessionDate on the events it creates', () => {
  // BEHAVIOURAL, not a source grep. The first version of this test asserted the
  // module text mentioned lastCompletedRegularSession — which kept passing when
  // the stamping was deleted, because the surviving `require` line still matched.
  // A test that cannot fail is not a test; this drives the real engine.
  const { CERN } = require('../lib/cern');
  const c = new CERN();
  const type = Object.keys(c.s.types)[0];
  assert.ok(type, 'the engine must define at least one event type');
  assert.equal(c.addEvent({ type, symbol: 'ZZZ', dateMs: SUNDAY_MS, direction: -1 }), true);
  const stored = c.s.ledger.find(e => e.symbol === 'ZZZ');
  assert.ok(stored, 'the event must be in the ledger');
  assert.equal(stored.sessionDate, '2026-07-10',
    'a Sunday detection belongs to the last completed session, not to Sunday');
});

test('an explicit sessionDate is never overwritten by the engine', () => {
  const { CERN } = require('../lib/cern');
  const c = new CERN();
  const type = Object.keys(c.s.types)[0];
  c.addEvent({ type, symbol: 'YYY', dateMs: SUNDAY_MS, direction: -1, sessionDate: '2026-07-09' });
  assert.equal(c.s.ledger.find(e => e.symbol === 'YYY').sessionDate, '2026-07-09');
});

// ── the flag is visible where it matters ───────────────────────────────────
test('rows carry the flag through so a group can count them', () => {
  const rows = cernPicksFrom({
    ledger: [ev({ dateMs: SUNDAY_MS, symbol: 'F1' }), ev({ dateMs: WEDNESDAY_MS, symbol: 'F2' })],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(r => r.sessionAligned === false).length, 1);
});

test('the Scoreboard counts unaligned rows per group', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/apex-routes'), 'utf8');
  assert.match(src, /sessionUnaligned = \(g\.sessionUnaligned \|\| 0\) \+ 1/);
  assert.match(src, /sessionUnaligned: g\.sessionUnaligned \|\| 0/);
});
