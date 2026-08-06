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
