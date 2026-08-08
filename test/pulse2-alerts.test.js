'use strict';
// Market Pulse v2 — TRANSITION-BASED ALERTS.
// Required behavior #20: alerts emit only on state transitions and are deduplicated
// (an item merely staying in the list never re-alerts); cooldowns bound flapping.

const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/pulse2-alerts');

const T0 = '2026-06-09T14:00:00.000Z';
const trans = { eventId: 'ev_1', kind: 'trade', from: 'WATCH', to: 'ARMED', headline: 'Acme', date: '2026-06-09' };

test('#20: a transition alerts once — the identical transition is deduplicated forever after', () => {
  const first = A.deriveAlerts({ transitions: [trans], prevState: null, now: () => T0 });
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].kind, 'SETUP_ARMED');
  const second = A.deriveAlerts({ transitions: [trans], prevState: first.state, now: () => '2026-06-09T20:00:00.000Z' });
  assert.equal(second.alerts.length, 0);
  assert.equal(second.suppressed, 1);
});

test('#20b: remaining in the top list is NOT a transition — no alert without a state change', () => {
  // lifecycle churn and plain re-observation produce no alertable kind
  assert.equal(A.kindOf({ kind: 'lifecycle', from: 'NEW', to: 'SPREADING' }), null);
  const r = A.deriveAlerts({ transitions: [], prevState: null, now: () => T0 });
  assert.equal(r.alerts.length, 0);
});

test('cooldown: a different transition of the same kind+event inside the window is suppressed', () => {
  const first = A.deriveAlerts({ transitions: [trans], prevState: null, now: () => T0 });
  const flap = { ...trans, from: 'ARMED', to: 'WATCH', date: '2026-06-09' };
  const rearm = { ...trans, from: 'WATCH', to: 'ARMED', date: '2026-06-09b' };   // new transition id
  const later = A.deriveAlerts({ transitions: [flap, rearm], prevState: first.state, now: () => '2026-06-09T14:30:00.000Z' });
  // flap (SETUP_FAILED? no — ARMED→WATCH maps to null) and rearm within 60min cooldown suppressed.
  assert.equal(later.alerts.length, 0);
});

test('every alert carries the full context contract', () => {
  const ctx = { marketMode: 'ROTATION', sessionState: 'regular', marketDataFreshness: 'REALTIME', narrativeFreshness: 'CURRENT_NARRATIVE' };
  const r = A.deriveAlerts({ transitions: [{ ...trans, evidence: 'VERIFIED', trigger: 100, invalidation: 98, horizon: 'day' }], context: ctx, prevState: null, now: () => T0 });
  const a = r.alerts[0];
  for (const k of ['whatChanged', 'evidenceStatus', 'marketContext', 'tradeState', 'trigger', 'invalidation', 'horizon', 'marketDataFreshness', 'actionability']) {
    assert.ok(k in a, `alert must carry ${k}`);
  }
  assert.equal(a.marketContext, 'ROTATION');
});

test('market transitions: regime change and material breadth shifts alert; small drift does not', () => {
  const prev = { mode: { mode: 'TWO_WAY_CHOP' }, breadth: { available: true, pctAbove50dma: 50 }, sectors: { available: true, leading: ['Energy'] }, etDate: '2026-06-09' };
  const next = { mode: { mode: 'RISK_OFF_TREND' }, breadth: { available: true, pctAbove50dma: 38 }, sectors: { available: true, leading: ['Utilities'] }, etDate: '2026-06-09' };
  const t = A.marketTransitions(prev, next);
  assert.equal(t.length, 3);   // mode + breadth(12pt) + leadership
  const small = A.marketTransitions(prev, { ...next, mode: { mode: 'TWO_WAY_CHOP' }, breadth: { available: true, pctAbove50dma: 47 }, sectors: { available: true, leading: ['Energy'] } });
  assert.equal(small.length, 0);
});

test('per-cycle alert volume is bounded', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ eventId: 'ev_' + i, kind: 'appeared', to: 'NEW', headline: 'h' + i, date: '2026-06-09' }));
  const r = A.deriveAlerts({ transitions: many, prevState: null, now: () => T0 });
  assert.ok(r.alerts.length <= A.MAX_ALERTS_PER_CYCLE);
  assert.ok(r.suppressed > 0);
});
