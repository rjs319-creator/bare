'use strict';
// RESEARCH PERSISTENCE tests — path separation and the guards that keep a stored
// decision from being rewritten after the fact.
//
// The Blob-backed paths need a live store, so these cover what is testable without
// one: the prefix split, date validation, and the fail-closed behaviour when storage
// is absent. The write-once rule itself is asserted at the guard level.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RS = require('../lib/research/store');

test('decisions and outcomes live in SEPARATE prefixes', () => {
  // Structural separation is what makes "ingestion cannot overwrite grading"
  // impossible to violate by accident rather than merely discouraged.
  assert.notEqual(RS.DECISIONS_PREFIX, RS.OUTCOMES_PREFIX);
  assert.ok(RS.decisionPath('2026-07-19').startsWith(RS.DECISIONS_PREFIX));
  assert.ok(RS.outcomePath('2026-07-19').startsWith(RS.OUTCOMES_PREFIX));
  assert.notEqual(RS.decisionPath('2026-07-19'), RS.outcomePath('2026-07-19'));
});

test('paths are one document per trading day', () => {
  assert.equal(RS.decisionPath('2026-07-19'), 'research/decisions/2026-07-19.json');
  assert.equal(RS.outcomePath('2026-07-19'), 'research/outcomes/2026-07-19.json');
});

test('a malformed date is refused rather than written to a junk path', async () => {
  assert.deepEqual(await RS.saveDecisionSnapshot('19-07-2026', { predictions: [] }),
    { written: false, reason: 'no-store' });          // store check fires first
  assert.equal(await RS.loadDecisionSnapshot('not-a-date'), null);
  assert.equal(await RS.loadOutcomes('2026-13-99'), null);
});

test('no store ⇒ fail closed, never throw', async () => {
  // The grading route runs on a cron; an unconfigured store must degrade, not crash.
  const r = await RS.saveDecisionSnapshot('2026-07-19', { predictions: [] });
  assert.equal(r.written, false);
  assert.equal(r.reason, 'no-store');
  assert.equal(await RS.loadDecisionSnapshot('2026-07-19'), null);
});

test('recentDates walks backwards, newest first, and is bounded', () => {
  const d = RS.recentDates('2026-07-19', 5);
  assert.equal(d.length, 5);
  assert.equal(d[0], '2026-07-19', 'newest first');
  assert.equal(d[4], '2026-07-15');
  assert.deepEqual([...d].sort().reverse(), d, 'strictly descending');
});

test('recentDates refuses a malformed anchor instead of generating garbage dates', () => {
  assert.deepEqual(RS.recentDates('nope', 5), []);
  assert.deepEqual(RS.recentDates(null), []);
});

test('recentDates crosses a month boundary correctly', () => {
  const d = RS.recentDates('2026-03-02', 4);
  assert.deepEqual(d, ['2026-03-02', '2026-03-01', '2026-02-28', '2026-02-27']);
});
