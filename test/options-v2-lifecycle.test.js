const test = require('node:test');
const assert = require('node:assert');
const lc = require('../lib/options-lifecycle-v2');

const NOW = () => '2026-08-06T21:30:00Z';

function item(over = {}) {
  return {
    ticker: 'TST', side: 'bullish',
    anomaly: { anomalyScore: 85, anomalyPercentile: 97, activityStatus: 'HIGHLY_UNUSUAL', dataQuality: 90, liquidityQuality: 80, baselineSampleSize: 12, absoluteSizeTier: 'large' },
    interpretation: { state: 'BULLISH_PROVISIONAL', confidence: 40 },
    gate: { tradeStatus: 'WATCH_FOR_PRICE_TRIGGER', gateVersion: 'trade-gate-v2.0.0' },
    underlying: 100, estNotional: 500_000,
    contracts: [{ contractSymbol: 'TSTC100', side: 'call', strike: 100, expiry: '2026-09-18', openInterest: 200, volume: 1500 }],
    setup: { valid: true, direction: 'long', trigger: 101, invalidation: 96, target: 111, rr: 2 },
    ...over,
  };
}

test('opening an event writes an immutable first-seen snapshot with the decision-session state', () => {
  const r = lc.foldEventsV2({ events: [] }, [item()], { session: '2026-08-06', now: NOW });
  assert.strictEqual(r.events.length, 1);
  const ev = r.events[0];
  assert.strictEqual(ev.firstSeen.session, '2026-08-06');
  assert.strictEqual(ev.firstSeen.anomalyScore, 85);
  assert.strictEqual(ev.oiConfirmation.status, 'PENDING');
});

test('NO FUTURE INFORMATION: re-folding with different data never rewrites first-seen', () => {
  const r1 = lc.foldEventsV2({ events: [] }, [item()], { session: '2026-08-06', now: NOW });
  const snap = JSON.stringify(r1.events[0].firstSeen);
  const r2 = lc.foldEventsV2(r1, [item({ anomaly: { ...item().anomaly, anomalyScore: 99, activityStatus: 'EXCEPTIONAL' } })], { session: '2026-08-07', now: () => '2026-08-07T21:30:00Z' });
  assert.strictEqual(JSON.stringify(r2.events[0].firstSeen), snap, 'first-seen must be immutable');
  assert.strictEqual(r2.events[0].appearances, 2);
});

test('LATER OI ATTACHES TO THE ORIGINAL EVENT: forSession = decision session, attachedSession = later session', () => {
  const r1 = lc.foldEventsV2({ events: [] }, [item()], { session: '2026-08-06', now: NOW });
  const idx = { TSTC100: { openInterest: 1500 } };   // built +1300 vs recorded 200
  const att = lc.attachOiConfirmations(r1.events, idx, { session: '2026-08-07' });
  const oc = att.events[0].oiConfirmation;
  assert.strictEqual(oc.status, 'CONFIRMED_BUILDING');
  assert.strictEqual(oc.forSession, '2026-08-06');
  assert.strictEqual(oc.attachedSession, '2026-08-07');
  assert.ok(att.transitions.some(t => t.kind === 'oi_confirmed'));
});

test('OI attribution: same-session data cannot attach; PENDING shown until a later session exists', () => {
  const r1 = lc.foldEventsV2({ events: [] }, [item()], { session: '2026-08-06', now: NOW });
  const att = lc.attachOiConfirmations(r1.events, { TSTC100: { openInterest: 9999 } }, { session: '2026-08-06' });
  assert.strictEqual(att.events[0].oiConfirmation.status, 'PENDING');
});

test('OI attribution: never-reobserved contracts become UNAVAILABLE (not guessed) after the window', () => {
  const r1 = lc.foldEventsV2({ events: [] }, [item()], { session: '2026-08-06', now: NOW });
  const soon = lc.attachOiConfirmations(r1.events, {}, { session: '2026-08-07' });
  assert.strictEqual(soon.events[0].oiConfirmation.status, 'PENDING', 'still within the window → wait');
  const late = lc.attachOiConfirmations(r1.events, {}, { session: '2026-08-20' });
  assert.strictEqual(late.events[0].oiConfirmation.status, 'UNAVAILABLE');
});

test('DISAPPEARANCE NEVER DELETES: an unseen event goes stale and stays in the ledger', () => {
  const r1 = lc.foldEventsV2({ events: [] }, [item()], { session: '2026-08-06', now: NOW });
  const r2 = lc.foldEventsV2(r1, [], { session: '2026-08-14', now: () => '2026-08-14T21:30:00Z' });
  assert.strictEqual(r2.events.length, 1, 'event retained');
  assert.strictEqual(r2.events[0].status, 'closed_stale');
  assert.ok(r2.events[0].transitions.some(t => t.kind === 'stale'));
});

test('ALERT DEDUP: a retried fold of the same session emits no duplicate alerts (idempotent transitionIds)', () => {
  const r1 = lc.foldEventsV2({ events: [] }, [item()], { session: '2026-08-06', now: NOW });
  assert.ok(r1.alerts.some(a => a.kind === 'opened'), 'HIGHLY_UNUSUAL open alerts');
  // Retry: same session, same items, ledger already contains the event + emitted ids.
  const r2 = lc.foldEventsV2(r1, [item()], { session: '2026-08-06', now: NOW });
  assert.strictEqual(r2.alerts.length, 0, 'retry must not re-alert');
});

test('a plain UNUSUAL row appearing again in another scan is NOT an alert; meaningful transitions are', () => {
  const quiet = item({ anomaly: { ...item().anomaly, activityStatus: 'UNUSUAL', anomalyScore: 66 } });
  const r1 = lc.foldEventsV2({ events: [] }, [quiet], { session: '2026-08-06', now: NOW });
  assert.strictEqual(r1.alerts.filter(a => a.kind === 'opened').length, 0, 'plain UNUSUAL open is not alert-worthy');
  // Next session: upgrade to EXCEPTIONAL → that IS a meaningful transition.
  const hot = item({ anomaly: { ...item().anomaly, activityStatus: 'EXCEPTIONAL', anomalyScore: 95 } });
  const r2 = lc.foldEventsV2(r1, [hot], { session: '2026-08-07', now: () => '2026-08-07T21:30:00Z' });
  assert.ok(r2.alerts.some(a => a.kind === 'activity_upgrade'));
  const al = r2.alerts.find(a => a.kind === 'activity_upgrade');
  assert.ok(al.whatChanged && al.tradeStatus != null && al.dataDelayed === true);
  assert.ok(al.notActionableWhy, 'a non-confirmed event says why it is not actionable');
});

test('trade-status transitions to PRICE_CONFIRMED alert with trigger + invalidation attached', () => {
  const r1 = lc.foldEventsV2({ events: [] }, [item()], { session: '2026-08-06', now: NOW });
  const confirmed = item({ gate: { tradeStatus: 'PRICE_CONFIRMED', gateVersion: 'trade-gate-v2.0.0' } });
  const r2 = lc.foldEventsV2(r1, [confirmed], { session: '2026-08-07', now: () => '2026-08-07T21:30:00Z' });
  const al = r2.alerts.find(a => a.kind === 'trade_status_change');
  assert.ok(al, 'PRICE_CONFIRMED transition alerts');
  assert.strictEqual(al.trigger, 101);
  assert.strictEqual(al.invalidation, 96);
});

test('a direction flip is a direction_change transition on the SAME ticker cluster', () => {
  const r1 = lc.foldEventsV2({ events: [] }, [item()], { session: '2026-08-06', now: NOW });
  const flipped = item({ interpretation: { state: 'MIXED', confidence: 0 } });
  const r2 = lc.foldEventsV2(r1, [flipped], { session: '2026-08-07', now: () => '2026-08-07T21:30:00Z' });
  // side stays keyed by the original cluster; the interpretation change is recorded.
  assert.ok(r2.transitions.some(t => t.kind === 'direction_change'));
});
