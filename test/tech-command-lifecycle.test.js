'use strict';
// Persistent candidate lifecycle: nothing disappears silently, the ORIGINAL rationale
// is frozen, alerts fire only on meaningful transitions, and repeats are deduplicated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const LIFE = require('../lib/tech-command-lifecycle');

const NOW1 = new Date('2026-08-05T14:00:00Z');
const NOW2 = new Date('2026-08-05T14:20:00Z');
const NOW3 = new Date('2026-08-05T15:30:00Z');
const DAY = '2026-08-05';

const row = (o) => ({ ticker: 'AAAA', action: 'WATCH', subsector: 'semiconductors', rationale: 'building above VWAP', contradicting: [], ...o });

test('a new candidate records first-seen and freezes its original rationale', () => {
  const a = LIFE.advance({ horizon: 'swing', rows: [row()], now: NOW1, sessionDay: DAY });
  const rec = a.records.AAAA;
  assert.equal(rec.firstSeenAt, NOW1.toISOString());
  assert.equal(rec.originalRationale, 'building above VWAP');
  assert.equal(rec.originalAction, 'WATCH');

  const b = LIFE.advance({ prior: a, horizon: 'swing', rows: [row({ action: 'READY', rationale: 'trigger armed' })], now: NOW2, sessionDay: DAY });
  const rec2 = b.records.AAAA;
  assert.equal(rec2.firstSeenAt, NOW1.toISOString(), 'first-seen must never move');
  assert.equal(rec2.originalRationale, 'building above VWAP', 'the original rationale must never be rewritten');
  assert.equal(rec2.currentRationale, 'trigger armed');
  assert.equal(rec2.priorAction, 'WATCH');
});

test('an unchanged state produces no transition and no alert', () => {
  const a = LIFE.advance({ horizon: 'swing', rows: [row()], now: NOW1, sessionDay: DAY });
  const b = LIFE.advance({ prior: a, horizon: 'swing', rows: [row()], now: NOW2, sessionDay: DAY });
  assert.equal(b.transitions.length, 0);
  assert.equal(b.alerts.length, 0);
  assert.equal(b.records.AAAA.history.length, 1, 'a no-op re-evaluation must not append history');
});

test('meaningful transitions alert, and the same transition never alerts twice in a session', () => {
  const a = LIFE.advance({ horizon: 'swing', rows: [row({ action: 'WATCH' })], now: NOW1, sessionDay: DAY });
  const b = LIFE.advance({ prior: a, horizon: 'swing', rows: [row({ action: 'ENTER' })], now: NOW2, sessionDay: DAY });
  assert.equal(b.alerts.length, 1);
  assert.equal(b.alerts[0].kind, 'trigger-confirmed');
  assert.equal(b.alerts[0].priority, 'high');

  // Flap back and forth: the same (ticker, kind, day) must not re-alert.
  const c = LIFE.advance({ prior: b, horizon: 'swing', rows: [row({ action: 'WATCH' })], now: NOW3, sessionDay: DAY });
  const d = LIFE.advance({ prior: c, horizon: 'swing', rows: [row({ action: 'ENTER' })], now: NOW3, sessionDay: DAY });
  assert.equal(d.alerts.filter(x => x.kind === 'trigger-confirmed').length, 0, 're-alerted the same transition inside one session');
});

test('an invalidation is high priority and distinct from a target', () => {
  const a = LIFE.advance({ horizon: 'swing', rows: [row({ action: 'ENTER' })], now: NOW1, sessionDay: DAY });
  const inv = LIFE.advance({ prior: a, horizon: 'swing', rows: [row({ action: 'EXIT_INVALIDATE' })], now: NOW2, sessionDay: DAY });
  assert.equal(inv.alerts[0].kind, 'invalidation');
  assert.equal(inv.alerts[0].priority, 'high');

  const tgt = LIFE.advance({ prior: a, horizon: 'daytrade', rows: [row({ action: 'TARGET_REACHED' })], now: NOW2, sessionDay: DAY });
  assert.equal(tgt.alerts[0].kind, 'target-reached');
});

test('a candidate that leaves the board is RETAINED with an explicit exit reason', () => {
  const a = LIFE.advance({ horizon: 'swing', rows: [row({ action: 'READY' })], now: NOW1, sessionDay: DAY });
  const b = LIFE.advance({ prior: a, horizon: 'swing', rows: [], now: NOW2, sessionDay: DAY });
  const rec = b.records.AAAA;
  assert.ok(rec, 'the candidate disappeared silently');
  assert.equal(rec.present, false);
  assert.match(rec.exitReason, /without triggering/);
  assert.equal(b.departed.length, 1);
});

test('a "what changed?" sentence is produced for every transition', () => {
  const a = LIFE.advance({ horizon: 'swing', rows: [row()], now: NOW1, sessionDay: DAY });
  assert.match(a.transitions[0].whatChanged, /New candidate at WATCH/);
  const b = LIFE.advance({ prior: a, horizon: 'swing', rows: [row({ action: 'READY', catalyst: 'analyst day scheduled' })], now: NOW2, sessionDay: DAY });
  assert.match(b.transitions[0].whatChanged, /WATCH → READY/);
  assert.match(b.transitions[0].whatChanged, /new catalyst/);
});

test('a new contradiction, a changed options read and stale data are all reportable without a state change', () => {
  const a = LIFE.advance({ horizon: 'swing', rows: [row({ optionsState: 'MIXED' })], now: NOW1, sessionDay: DAY });
  const b = LIFE.advance({
    prior: a, horizon: 'swing', now: NOW2, sessionDay: DAY,
    rows: [row({ optionsState: 'CONTRADICTS_SETUP', contradicting: ['relative strength rolled over'], stale: true })],
  });
  assert.equal(b.transitions.length, 1);
  const t = b.transitions[0];
  assert.equal(t.from, t.to, 'the action did not change');
  assert.equal(t.contradictionAdded, true);
  assert.equal(t.optionsChanged, true);
  assert.equal(t.becameStale, true);
  assert.ok(b.alerts.length >= 1);
});

test('A PROVIDER BLIP MUST NOT MANUFACTURE ALERTS', () => {
  // The defect this pins, found by running two real ticks minutes apart: the
  // long-term catalyst was keyed on nextProofPoints[0].what, which flips between
  // "Next earnings report" and the generic "Next revenue-growth print…" depending on
  // whether the earnings-calendar call answered. One rate-limited provider rewrote
  // the catalyst for EVERY name at once — 18 transitions and 9 alerts on a board
  // where nothing had moved.
  const t1 = LIFE.advance({ horizon: 'longterm', rows: [row({ action: 'ACCUMULATE', catalyst: 'earnings 2026-08-25' })], now: NOW1, sessionDay: DAY });
  assert.equal(t1.transitions.length, 1, 'first sight is a new candidate');

  // Provider blips: the field comes back unknown. Nothing changed about the company.
  const t2 = LIFE.advance({ prior: t1, horizon: 'longterm', rows: [row({ action: 'ACCUMULATE', catalyst: null })], now: NOW2, sessionDay: DAY });
  assert.equal(t2.transitions.length, 0, 'a missing field is not a change');
  assert.equal(t2.alerts.length, 0);
  assert.equal(t2.records.AAAA.catalyst, 'earnings 2026-08-25', 'the known value must carry forward, not be erased');

  // Provider recovers with the SAME value — must not read as "a new catalyst".
  const t3 = LIFE.advance({ prior: t2, horizon: 'longterm', rows: [row({ action: 'ACCUMULATE', catalyst: 'earnings 2026-08-25' })], now: NOW3, sessionDay: DAY });
  assert.equal(t3.transitions.length, 0, 'rediscovering what we already knew is not news');
  assert.equal(t3.alerts.length, 0);

  // A GENUINE catalyst change still reports.
  const t4 = LIFE.advance({ prior: t3, horizon: 'longterm', rows: [row({ action: 'ACCUMULATE', catalyst: 'earnings 2026-11-04' })], now: NOW3, sessionDay: DAY });
  assert.equal(t4.transitions.length, 1);
  assert.equal(t4.transitions[0].catalystAdded, true);
});

test('a candidate that is ALREADY stale on first sight does not alert as "became stale"', () => {
  // Observed live: 76 prior-session day-trade names, all with currentSessionFresh
  // false, each firing data-became-stale the moment they entered the lifecycle.
  // Becoming stale is a transition; arriving stale is just a fact about the row.
  const a = LIFE.advance({ horizon: 'daytrade', rows: [row({ action: 'WATCH', stale: true })], now: NOW1, sessionDay: DAY });
  assert.equal(a.alerts.filter(x => x.kind === 'data-became-stale').length, 0);
  assert.equal(a.records.AAAA.stale, true, 'the fact is still recorded');

  // Fresh -> stale IS a transition and must still alert.
  const b = LIFE.advance({ horizon: 'daytrade', rows: [row({ action: 'WATCH', stale: false })], now: NOW1, sessionDay: DAY });
  const c = LIFE.advance({ prior: b, horizon: 'daytrade', rows: [row({ action: 'WATCH', stale: true })], now: NOW2, sessionDay: DAY });
  assert.equal(c.alerts.filter(x => x.kind === 'data-became-stale').length, 1);
});

test('an options/attention blip is carried forward the same way', () => {
  const t1 = LIFE.advance({ horizon: 'swing', rows: [row({ action: 'READY', optionsState: 'MIXED', attentionState: 'STICKY_ATTENTION' })], now: NOW1, sessionDay: DAY });
  const t2 = LIFE.advance({ prior: t1, horizon: 'swing', rows: [row({ action: 'READY', optionsState: null, attentionState: null })], now: NOW2, sessionDay: DAY });
  assert.equal(t2.transitions.length, 0, 'an unavailable overlay is not a state change');
  assert.equal(t2.records.AAAA.optionsState, 'MIXED');
  assert.equal(t2.records.AAAA.attentionState, 'STICKY_ATTENTION');
});

test('each horizon keeps its OWN lifecycle — they never share records', () => {
  const sw = LIFE.advance({ horizon: 'swing', rows: [row({ action: 'ENTER' })], now: NOW1, sessionDay: DAY });
  const lt = LIFE.advance({ horizon: 'longterm', rows: [row({ action: 'ACCUMULATE' })], now: NOW1, sessionDay: DAY });
  assert.equal(sw.records.AAAA.horizon, 'swing');
  assert.equal(lt.records.AAAA.horizon, 'longterm');
  assert.notEqual(sw.records.AAAA.currentAction, lt.records.AAAA.currentAction);
});

test('the alert index is bounded so it cannot grow forever', () => {
  const old = Date.now() - 10 * 86400000;
  const { alertIndex } = LIFE.emitAlerts([], { 'swing|OLD|trigger-confirmed|2026-07-01': old }, { now: new Date(), day: DAY });
  assert.equal(Object.keys(alertIndex).length, 0, 'expired alert keys must be pruned');
});

test('history is capped and ordered', () => {
  let prior = null;
  for (let i = 0; i < 60; i++) {
    prior = LIFE.advance({
      prior, horizon: 'swing', now: new Date(NOW1.getTime() + i * 60000), sessionDay: DAY,
      rows: [row({ action: i % 2 ? 'READY' : 'WATCH' })],
    });
  }
  assert.ok(prior.records.AAAA.history.length <= 40);
});
