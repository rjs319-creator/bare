'use strict';
// Market Pulse v2 — EVENT IDENTITY + MEASURED LIFECYCLES.
// Required behaviors #11-#15: earnings vs product stories for one ticker are different
// events; a new event months later does not inherit an old first-seen date; missing
// narratives cool/resolve after configured observations; a direction flip is a material
// transition; first-seen evidence is immutable.

const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/pulse2-events');

const ctx = (date, cycleId) => ({ date, generation: date + 'T12:00:00Z', cycleId, now: () => date + 'T12:00:00.000Z' });

const earnObs = {
  headline: 'NVDA raises datacenter outlook after blowout quarter',
  tickers: ['NVDA'], claim: 'NVDA raised its datacenter revenue outlook',
  eventFamily: 'guidance', eventDate: '2026-06-09', direction: 'BULLISH',
  evidence: 'VERIFIED', claims: [], independentLineages: 2,
};
const productObs = {
  headline: 'NVDA unveils next-gen consumer GPU lineup',
  tickers: ['NVDA'], claim: 'NVDA announced a new consumer GPU generation',
  eventFamily: 'product', eventDate: '2026-09-20', direction: 'BULLISH',
  evidence: 'SUPPORTED', claims: [], independentLineages: 1,
};

test('#11: earnings and product stories for the SAME ticker create DIFFERENT events', () => {
  const r1 = E.foldObservations([], [earnObs], ctx('2026-06-09', 'c1'));
  const r2 = E.foldObservations(r1.events, [productObs], ctx('2026-09-20', 'c2'));
  assert.equal(r2.events.length, 2);
  assert.notEqual(r2.events[0].id, r2.events[1].id);
});

test('#12: a new story months later does NOT inherit the old first-seen date', () => {
  const r1 = E.foldObservations([], [earnObs], ctx('2026-06-09', 'c1'));
  const r2 = E.foldObservations(r1.events, [productObs], ctx('2026-09-20', 'c2'));
  const productEv = r2.events.find(e => e.family === 'product');
  assert.equal(productEv.firstSeenDate, '2026-09-20');   // its own date, not June's
});

test('re-observing the SAME story continues the SAME event (no phantom twin)', () => {
  const r1 = E.foldObservations([], [earnObs], ctx('2026-06-09', 'c1'));
  const r2 = E.foldObservations(r1.events, [{ ...earnObs, headline: 'NVDA guidance hike keeps trending' }], ctx('2026-06-10', 'c2'));
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].observationCount, 2);
  assert.equal(r2.events[0].firstSeenDate, '2026-06-09');
});

test('#15: first-seen fields are IMMUTABLE across later observations', () => {
  const r1 = E.foldObservations([], [{ ...earnObs, evidence: 'SINGLE_SOURCE', independentLineages: 1 }], ctx('2026-06-09', 'c1'));
  const before = JSON.parse(JSON.stringify({
    firstSeen: r1.events[0].firstSeen, firstSeenDate: r1.events[0].firstSeenDate,
    firstSeenEvidence: r1.events[0].firstSeenEvidence, firstSeenDirection: r1.events[0].firstSeenDirection,
    firstSeenLineages: r1.events[0].firstSeenLineages,
  }));
  const r2 = E.foldObservations(r1.events, [{ ...earnObs, evidence: 'VERIFIED', independentLineages: 3 }], ctx('2026-06-10', 'c2'));
  const ev = r2.events[0];
  assert.deepEqual({
    firstSeen: ev.firstSeen, firstSeenDate: ev.firstSeenDate,
    firstSeenEvidence: ev.firstSeenEvidence, firstSeenDirection: ev.firstSeenDirection,
    firstSeenLineages: ev.firstSeenLineages,
  }, before);
  assert.equal(ev.evidence, 'VERIFIED');   // the mutable tail DID update
});

test('#13: an event missing from consecutive cycles transitions COOLING then RESOLVED', () => {
  let events = E.foldObservations([], [earnObs], ctx('2026-06-09', 'c1')).events;
  for (let i = 0; i < E.MISSED_CYCLES_COOLING; i++) {
    events = E.foldObservations(events, [], ctx('2026-06-10', 'c' + (i + 2))).events;
  }
  assert.equal(events[0].narrativeLifecycle, 'COOLING');
  for (let i = 0; i < E.MISSED_CYCLES_RESOLVED - E.MISSED_CYCLES_COOLING; i++) {
    events = E.foldObservations(events, [], ctx('2026-06-11', 'd' + i)).events;
  }
  assert.equal(events[0].narrativeLifecycle, 'RESOLVED');
});

test('a reappearing event resets its missed-cycle streak', () => {
  let events = E.foldObservations([], [earnObs], ctx('2026-06-09', 'c1')).events;
  events = E.foldObservations(events, [], ctx('2026-06-10', 'c2')).events;
  assert.equal(events[0].missedCycles, 1);
  events = E.foldObservations(events, [earnObs], ctx('2026-06-11', 'c3')).events;
  assert.equal(events[0].missedCycles, 0);
});

test('#14: a direction flip emits a material direction-flip transition and bumps thesis version', () => {
  const r1 = E.foldObservations([], [earnObs], ctx('2026-06-09', 'c1'));
  const r2 = E.foldObservations(r1.events, [{ ...earnObs, direction: 'BEARISH' }], ctx('2026-06-10', 'c2'));
  const flip = r2.transitions.find(t => t.kind === 'direction-flip');
  assert.ok(flip, 'direction-flip transition must be emitted');
  assert.equal(flip.from, 'BULLISH');
  assert.equal(flip.to, 'BEARISH');
  assert.equal(r2.events[0].thesisVersion, 2);
  assert.equal(r2.events[0].firstSeenDirection, 'BULLISH');   // original thesis preserved
});

test('a denial invalidates the event (INVALIDATED lifecycle)', () => {
  const r1 = E.foldObservations([], [earnObs], ctx('2026-06-09', 'c1'));
  const r2 = E.foldObservations(r1.events, [{ ...earnObs, denied: true }], ctx('2026-06-10', 'c2'));
  assert.equal(r2.events[0].invalidated, true);
  assert.equal(r2.events[0].narrativeLifecycle, 'INVALIDATED');
  assert.ok(r2.transitions.some(t => t.kind === 'invalidated'));
});

test('long-unobserved events expire (bounded active ledger)', () => {
  let events = E.foldObservations([], [earnObs], ctx('2026-06-09', 'c1')).events;
  for (let i = 0; i < E.MISSED_CYCLES_EXPIRED; i++) {
    events = E.foldObservations(events, [], ctx('2026-07-01', 'x' + i)).events;
  }
  assert.equal(events[0].expired, true);
});

test('fingerprints separate by family and claim; macro themes key on their slug', () => {
  const a = E.eventFingerprint({ entity: 'NVDA', family: 'earnings', claim: 'beat and raise', eventDate: '2026-06-09', direction: 'BULLISH' });
  const b = E.eventFingerprint({ entity: 'NVDA', family: 'product', claim: 'beat and raise', eventDate: '2026-06-09', direction: 'BULLISH' });
  assert.notEqual(a, b);
  assert.ok(E.entityOf({ tickers: [], headline: 'CPI comes in hot' }).startsWith('MACRO:'));
});

test('bounded fuzzy fallback never crosses families', () => {
  const ev = { entity: 'NVDA', family: 'guidance', claim: 'raised datacenter revenue outlook', expired: false };
  assert.equal(E.fuzzyMatch(ev, { tickers: ['NVDA'], eventFamily: 'product', claim: 'raised datacenter revenue outlook' }), false);
  assert.equal(E.fuzzyMatch(ev, { tickers: ['NVDA'], eventFamily: 'guidance', claim: 'datacenter outlook raised again' }), true);
});
