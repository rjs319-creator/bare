'use strict';
// GRIDLOCK lifecycle machine: deterministic-evidence transitions + history.
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/gridlock-lifecycle');
const { LIFECYCLE } = require('../lib/gridlock-schema');

const ev = (over = {}) => ({
  id: 't', lifecycle: LIFECYCLE.NEW, certainty: 'ANNOUNCED',
  independentSourceCount: 1, announcedAt: '2026-07-01',
  sourceEvidence: [{ retrievedAt: '2026-07-01' }], ...over,
});

test('legal transition applies immutably and records history', () => {
  const e0 = ev();
  const r = L.applyTransition(e0, LIFECYCLE.EMERGING, { kind: 'independent-source-added', at: '2026-07-02' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.event.lifecycle, LIFECYCLE.EMERGING);
  assert.strictEqual(e0.lifecycle, LIFECYCLE.NEW);                    // original untouched
  assert.strictEqual(r.event.lifecycleHistory.length, 1);
  assert.deepStrictEqual(
    { from: r.event.lifecycleHistory[0].from, to: r.event.lifecycleHistory[0].to },
    { from: 'NEW', to: 'EMERGING' });
});

test('illegal transitions and terminal states are rejected', () => {
  assert.strictEqual(L.applyTransition(ev(), LIFECYCLE.COMPLETED, { kind: 'project-completed', at: '2026-07-02' }).ok, false); // NEW→COMPLETED illegal
  const done = ev({ lifecycle: LIFECYCLE.CANCELLED });
  assert.strictEqual(L.applyTransition(done, LIFECYCLE.BUILDING, { kind: 'new-filing', at: '2026-07-02' }).ok, false);
  assert.strictEqual(L.isTerminal(LIFECYCLE.CANCELLED), true);
  assert.strictEqual(L.isTerminal(LIFECYCLE.BUILDING), false);
});

test('a transition without deterministic evidence is rejected', () => {
  assert.strictEqual(L.applyTransition(ev(), LIFECYCLE.EMERGING, { kind: 'model-opinion', at: '2026-07-02' }).ok, false);
  assert.strictEqual(L.applyTransition(ev(), LIFECYCLE.EMERGING, { kind: 'new-filing' }).ok, false); // no timestamp
});

test('autoAdvance: second publisher → EMERGING; contracted → BUILDING; operating → COMPLETED', () => {
  const r1 = L.autoAdvance(ev({ independentSourceCount: 2 }), { todayIso: '2026-07-03' });
  assert.strictEqual(r1.event.lifecycle, LIFECYCLE.EMERGING);
  const r2 = L.autoAdvance(ev({ lifecycle: LIFECYCLE.EMERGING, certainty: 'CONTRACTED' }), { todayIso: '2026-07-03' });
  assert.strictEqual(r2.event.lifecycle, LIFECYCLE.BUILDING);
  const r3 = L.autoAdvance(ev({ lifecycle: LIFECYCLE.BUILDING, certainty: 'OPERATING' }), { todayIso: '2026-07-03' });
  assert.strictEqual(r3.event.lifecycle, LIFECYCLE.COMPLETED);
});

test('autoAdvance: stale NEW event fades; fresh one does not', () => {
  const stale = L.autoAdvance(ev(), { todayIso: '2026-09-01', staleDays: 45 });
  assert.strictEqual(stale.event.lifecycle, LIFECYCLE.FADING);
  const fresh = L.autoAdvance(ev(), { todayIso: '2026-07-05', staleDays: 45 });
  assert.strictEqual(fresh.changed, false);
});

test('delayed and cancelled paths exist (PROJECT_DELAY / PROJECT_CANCELLATION handling)', () => {
  const d = L.applyTransition(ev({ lifecycle: LIFECYCLE.BUILDING }), LIFECYCLE.DELAYED, { kind: 'project-delay', at: '2026-07-04' });
  assert.strictEqual(d.ok, true);
  const back = L.applyTransition(d.event, LIFECYCLE.BUILDING, { kind: 'construction-progress', at: '2026-07-10' });
  assert.strictEqual(back.ok, true);
  const c = L.applyTransition(d.event, LIFECYCLE.CANCELLED, { kind: 'project-cancellation', at: '2026-07-11' });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(L.isTerminal(c.event.lifecycle), true);
});
