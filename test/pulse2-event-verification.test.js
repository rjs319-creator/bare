'use strict';
// Market Pulse v2 — VERIFIED EVENT EVIDENCE (review prompt 3, findings P3-E1/E3/E5/E6).
//
// The live defect: one model-written item "FOMC minutes and CPI" dated Oct 14 carried a
// "Verified fact" badge, because the playbook stamped EVERY future-dated headline
// VERIFIED_FACT. The official calendars put the minutes on Oct 7 and CPI / the Beige Book
// on Oct 14 — three separate events. Every date below lives in a FIXTURE; production
// logic never hardcodes a release date.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/pulse2-events');
const P = require('../lib/pulse2-provenance');
const M = require('../lib/pulse2-market-state');
const R = require('../lib/pulse2-routes');

const TODAY = '2026-10-04';
const NOW = '2026-10-04T15:00:00.000Z';
const ctx = (date, cycleId, at) => ({ date, generation: (at || date + 'T15:00:00.000Z'), cycleId, now: () => at || date + 'T15:00:00.000Z' });

// ── fixtures: real citations the search provider "returned" ──────────────────
const CITES = [
  { url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', title: 'FOMC meeting calendars and information page', publishedAt: '2026-10-01T14:00:00Z' },
  { url: 'https://www.bls.gov/schedule/news_release/cpi.htm', title: 'Schedule of releases for the Consumer Price Index', publishedAt: '2026-10-01T12:30:00Z' },
  { url: 'https://www.reuters.com/markets/us/week-ahead-2026-10-04/', title: 'Wall Street week ahead inflation data and Fed minutes loom', publishedAt: '2026-10-04T10:00:00Z' },
  { url: 'https://www.cnbc.com/2026/10/04/week-ahead.html', title: 'Stocks face a heavy macro week with CPI and the Fed', publishedAt: '2026-10-04T11:00:00Z' },
];
const index = () => P.buildSourceIndex(CITES, { discoveredAt: NOW, now: NOW });

function obsFrom(raw, idx = index()) {
  const scheduled = E.isScheduledMacro(raw, TODAY);
  const claims = P.sanitizeClaims(raw.claims, idx, { scheduled });
  const times = P.summarizeClaimSources(claims, idx);
  return {
    headline: raw.headline, tickers: raw.tickers || [], claim: claims[0] ? claims[0].text : raw.headline,
    eventFamily: raw.eventFamily, eventDate: raw.eventDate, eventDateSource: raw.eventDate ? 'model' : null,
    direction: 'NON_DIRECTIONAL', publishedAt: times.publishedAt, dateConfidence: times.dateConfidence,
    sourceCount: times.sourceCount, evidence: P.rollupEvidence(claims), claims,
    sources: P.sourceCardsFor(claims, idx), hasPrimarySource: P.hasPrimarySource(claims.flatMap(c => c.sourceRefs), idx),
    independentLineages: P.independentLineageCount(claims.flatMap(c => c.sourceRefs), idx),
    cancelled: raw.cancelled === true, denied: raw.denied === true,
  };
}

const FED = CITES[0].url, BLS = CITES[1].url, REUTERS = CITES[2].url, CNBC = CITES[3].url;
const MINUTES_OCT7 = { headline: 'Fed releases minutes of its September policy meeting', eventFamily: 'rates', eventDate: '2026-10-07', claims: [{ text: 'The Federal Reserve publishes the September FOMC minutes at 2pm ET', sourceUrls: [FED, REUTERS] }] };
const CPI_OCT14 = { headline: 'September consumer price index report due from the Labor Department', eventFamily: 'macro', eventDate: '2026-10-14', claims: [{ text: 'BLS publishes September CPI at 8:30am ET', sourceUrls: [BLS, REUTERS] }] };
const BEIGE_OCT14 = { headline: 'Federal Reserve Beige Book regional conditions survey published', eventFamily: 'macro', eventDate: '2026-10-14', claims: [{ text: 'The Fed publishes the Beige Book at 2pm ET', sourceUrls: [FED, CNBC] }] };
// The live defect: one model-written, model-dated item combining two releases, cited
// only to newsroom week-ahead pieces.
const COMBINED = { headline: 'FOMC minutes and CPI both land Wednesday in a pivotal macro session', eventFamily: 'macro', eventDate: '2026-10-14', claims: [{ text: 'FOMC minutes and CPI are due October 14', sourceUrls: [REUTERS, CNBC] }] };
const NO_SOURCE = { headline: 'Treasury refunding announcement expected to shift issuance mix', eventFamily: 'rates', eventDate: '2026-10-21', claims: [{ text: 'Treasury will announce refunding sizes', sourceUrls: [] }] };

const foldAll = raws => E.foldObservations([], raws.map(r => obsFrom(r)), ctx(TODAY, 'c1', NOW)).events;
const riskFor = events => R.buildEventRisk(events, { today: TODAY });
const playbookFor = events => M.buildPlaybook({ indexes: {}, sessionState: 'closed' }, { eventRisk: riskFor(events) });

// ── P3-E1: the badge is earned per item, never stamped ───────────────────────
test('E1: Oct 7 minutes, Oct 14 CPI and Oct 14 Beige Book stay THREE atomic events with their own dates and sources', () => {
  const events = foldAll([MINUTES_OCT7, CPI_OCT14, BEIGE_OCT14]);
  assert.equal(events.length, 3);
  const risk = riskFor(events);
  assert.deepEqual(risk.map(r => r.eventDate), ['2026-10-07', '2026-10-14', '2026-10-14']);
  assert.equal(new Set(risk.map(r => r.eventId)).size, 3);
  for (const r of risk) {
    assert.ok(r.sources.length >= 1 && r.sources.every(s => s.url && s.publisher), 'each item carries its own source URL + publisher');
    assert.ok(r.asOf, 'each item carries an as-of');
    assert.equal(r.eventDateSource, 'model');
  }
  const minutes = risk.find(r => /minutes/i.test(r.text));
  assert.ok(minutes.sources.some(s => s.publisher === 'federalreserve.gov'));
  assert.ok(!/CPI|consumer price/i.test(minutes.text), 'the minutes item says nothing about CPI');
});

test('E1: an item backed by a PRIMARY official source earns VERIFIED_FACT; text, sources and asOf ride on the line', () => {
  const pb = playbookFor(foldAll([MINUTES_OCT7, CPI_OCT14, BEIGE_OCT14]));
  assert.equal(pb.upcomingEventRisk.length, 3);
  for (const l of pb.upcomingEventRisk) {
    assert.equal(l.basis, 'VERIFIED_FACT');
    assert.equal(typeof l.text, 'string');
    assert.ok(Array.isArray(l.sources) && l.sources.length);
    assert.deepEqual(Object.keys(l.sources[0]).sort(), ['publisher', 'url']);
    assert.ok(l.asOf);
    assert.ok(l.eventId);
  }
  assert.equal(pb.nextDecisionPoint.basis, 'VERIFIED_FACT');
  assert.match(pb.nextDecisionPoint.text, /2026-10-07/);
});

test('E1: the combined model-dated "FOMC minutes and CPI" item NEVER gets the verified badge', () => {
  const events = foldAll([COMBINED]);
  assert.notEqual(events[0].evidence, 'VERIFIED', 'two newsroom week-ahead pieces cannot verify a schedule');
  const pb = playbookFor(events);
  const l = pb.upcomingEventRisk[0];
  assert.notEqual(l.basis, 'VERIFIED_FACT');
  assert.equal(l.dateUnconfirmed, true);
  assert.match(l.text, /date unconfirmed/i);
  assert.notEqual(pb.nextDecisionPoint.basis, 'VERIFIED_FACT');
});

test('E1: a model-supplied date can never by itself yield the badge, even at VERIFIED evidence', () => {
  const line = M.eventRiskLine({ text: '2026-10-14: something', eventId: 'ev_x', eventDate: '2026-10-14', evidence: 'VERIFIED', dateConfidence: 'metadata', eventDateSource: 'model', hasPrimarySource: false, sources: [{ url: 'https://www.reuters.com/a', publisher: 'reuters.com' }], asOf: NOW });
  assert.notEqual(line.basis, 'VERIFIED_FACT');
  const official = M.eventRiskLine({ text: '2026-10-14: something', eventId: 'ev_x', eventDate: '2026-10-14', evidence: 'SUPPORTED', dateConfidence: 'metadata', eventDateSource: 'model', hasPrimarySource: true, sources: [{ url: BLS, publisher: 'bls.gov' }], asOf: NOW });
  assert.equal(official.basis, 'VERIFIED_FACT');
});

test('E1: missing source ⇒ no badge; a bare legacy string ⇒ no badge', () => {
  const pb = playbookFor(foldAll([NO_SOURCE]));
  assert.notEqual(pb.upcomingEventRisk[0].basis, 'VERIFIED_FACT');
  assert.deepEqual(pb.upcomingEventRisk[0].sources, []);
  const legacy = M.buildPlaybook({ indexes: {}, sessionState: 'closed' }, { eventRisk: ['2026-06-11: CPI release'] });
  assert.notEqual(legacy.upcomingEventRisk[0].basis, 'VERIFIED_FACT');
  assert.match(legacy.upcomingEventRisk[0].text, /CPI release/);
});

test('E1: unknown / inferred date confidence, an invalidated event and a past event are never verified event risk', () => {
  const base = { text: 't', eventId: 'e', eventDate: '2026-10-14', evidence: 'VERIFIED', eventDateSource: 'model', hasPrimarySource: true, sources: [{ url: BLS, publisher: 'bls.gov' }], asOf: NOW };
  assert.notEqual(M.eventRiskLine({ ...base, dateConfidence: 'inferred' }).basis, 'VERIFIED_FACT');
  assert.notEqual(M.eventRiskLine({ ...base, dateConfidence: 'unknown' }).basis, 'VERIFIED_FACT');
  assert.equal(M.eventRiskLine({ ...base, dateConfidence: 'metadata' }).basis, 'VERIFIED_FACT');
  const events = foldAll([CPI_OCT14]).map(e => ({ ...e, invalidated: true }));
  assert.equal(riskFor(events).length, 0, 'a denied/invalidated event is not upcoming risk');
  assert.equal(R.buildEventRisk(foldAll([MINUTES_OCT7]), { today: '2026-10-08' }).length, 0);
});

// ── P3-E3: scheduled macro claims cap at SUPPORTED without a PRIMARY lineage ──
test('E3: a future-dated macro claim with two newsroom lineages is capped at SUPPORTED; a PRIMARY source lifts the cap', () => {
  const idx = index();
  const refs = urls => P.resolveSourceRefs(urls, idx).sourceRefs;
  assert.equal(P.deriveClaimStatus({ sourceRefs: refs([REUTERS, CNBC]) }, idx), 'VERIFIED', 'unscheduled claims keep the existing rule');
  assert.equal(P.deriveClaimStatus({ sourceRefs: refs([REUTERS, CNBC]), scheduled: true }, idx), 'SUPPORTED');
  assert.equal(P.deriveClaimStatus({ sourceRefs: refs([BLS, REUTERS]), scheduled: true }, idx), 'VERIFIED');
  assert.equal(P.hasPrimarySource(refs([REUTERS, CNBC]), idx), false);
  assert.equal(P.hasPrimarySource(refs([FED]), idx), true);
});

test('E3: isScheduledMacro is true only for a FUTURE-dated macro/rates or ticker-less item', () => {
  assert.equal(E.isScheduledMacro({ tickers: [], eventFamily: 'macro', eventDate: '2026-10-14' }, TODAY), true);
  assert.equal(E.isScheduledMacro({ tickers: [], eventFamily: 'rates', eventDate: '2026-10-07' }, TODAY), true);
  assert.equal(E.isScheduledMacro({ tickers: [], eventFamily: 'macro', eventDate: '2026-10-02' }, TODAY), false);
  assert.equal(E.isScheduledMacro({ tickers: [], eventFamily: 'macro', eventDate: null }, TODAY), false);
  assert.equal(E.isScheduledMacro({ tickers: ['NVDA'], eventFamily: 'earnings', eventDate: '2026-10-20' }, TODAY), false);
});

// ── P3-E6: conflicting / revised dates, cancellation ─────────────────────────
test('E6: a later conflicting date records date-changed (from/to), sets dateConflict, keeps identity and does NOT mark the event fresh', () => {
  const r1 = E.foldObservations([], [obsFrom(CPI_OCT14)], ctx(TODAY, 'c1', NOW));
  const id = r1.events[0].id, key = r1.events[0].continuityKey, firstSeen = r1.events[0].firstSeenAt;
  const revised = { ...CPI_OCT14, eventDate: '2026-10-15' };
  const r2 = E.foldObservations(r1.events, [obsFrom(revised)], ctx('2026-10-05', 'c2', '2026-10-05T15:00:00.000Z'));
  assert.equal(r2.events.length, 1, 'no phantom twin');
  const ev = r2.events[0];
  assert.equal(ev.id, id);
  assert.equal(ev.continuityKey, key);
  assert.equal(ev.firstSeenAt, firstSeen);
  assert.equal(ev.dateConflict, true);
  assert.equal(ev.scheduleStatus, 'changed');
  assert.equal(ev.eventDate, '2026-10-14', 'the originally recorded date is preserved');
  assert.deepEqual(ev.reportedEventDates, ['2026-10-14', '2026-10-15']);
  assert.equal(ev.lastMaterialUpdateAt, null, 'a re-dated schedule is not a material update');
  assert.notEqual(ev.freshnessReason, 'NEW_MATERIAL_UPDATE');
  const t = r2.transitions.find(x => x.kind === 'date-changed');
  assert.ok(t);
  assert.equal(t.from, '2026-10-14');
  assert.equal(t.to, '2026-10-15');
  assert.ok(!r2.transitions.some(x => x.kind === 'material-update'));
  // The badge is withdrawn and the conflict is visible on the line.
  const line = M.buildPlaybook({ indexes: {}, sessionState: 'closed' }, { eventRisk: R.buildEventRisk(r2.events, { today: '2026-10-05' }) }).upcomingEventRisk[0];
  assert.notEqual(line.basis, 'VERIFIED_FACT');
  assert.equal(line.status, 'changed');
  assert.equal(line.eventId, id);
  assert.match(line.text, /2026-10-15/);
});

test('E6: a cancellation keeps the event identity, records a cancelled transition and removes the badge', () => {
  const r1 = E.foldObservations([], [obsFrom(BEIGE_OCT14)], ctx(TODAY, 'c1', NOW));
  const r2 = E.foldObservations(r1.events, [obsFrom({ ...BEIGE_OCT14, cancelled: true })], ctx('2026-10-05', 'c2', '2026-10-05T15:00:00.000Z'));
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].id, r1.events[0].id);
  assert.equal(r2.events[0].scheduleStatus, 'cancelled');
  assert.ok(r2.transitions.some(x => x.kind === 'cancelled' && x.eventId === r1.events[0].id));
  const line = M.buildPlaybook({ indexes: {}, sessionState: 'closed' }, { eventRisk: R.buildEventRisk(r2.events, { today: '2026-10-05' }) }).upcomingEventRisk[0];
  assert.equal(line.status, 'cancelled');
  assert.notEqual(line.basis, 'VERIFIED_FACT');
  assert.match(line.text, /cancelled/i);
});

test('E6: a PAST event that gains a later development date is still a material update (existing behaviour kept)', () => {
  const past = { headline: 'ACME merger clears antitrust review step', tickers: ['ACME'], claim: 'ACME merger cleared antitrust review', eventFamily: 'merger-acquisition', eventDate: '2026-09-20', direction: 'BULLISH', evidence: 'SUPPORTED', claims: [], independentLineages: 1 };
  const r1 = E.foldObservations([], [past], ctx('2026-09-21', 'c1'));
  const r2 = E.foldObservations(r1.events, [{ ...past, eventDate: '2026-10-01' }], ctx('2026-10-02', 'c2'));
  assert.ok(r2.transitions.some(x => x.kind === 'material-update' && x.reason === 'new-development-date'));
  assert.ok(!r2.events[0].dateConflict);
});

// ── P3-E5: a republication never refreshes an old event ──────────────────────
test('E5: an old event re-observed with a NEWER publication and a new firstSeen stays old', () => {
  const old = { headline: 'ACME wins large defense contract award', tickers: ['ACME'], claim: 'ACME won a large defense contract', eventFamily: 'product', eventDate: '2026-09-20', direction: 'BULLISH', evidence: 'SUPPORTED', claims: [], independentLineages: 1, publishedAt: '2026-09-20T13:00:00.000Z', dateConfidence: 'metadata', sourceCount: 1 };
  const r1 = E.foldObservations([], [old], ctx('2026-09-20', 'c1', '2026-09-20T15:00:00.000Z'));
  const first = r1.events[0];
  const republished = { ...old, publishedAt: '2026-10-04T12:00:00.000Z', sourceCount: 2 };
  const r2 = E.foldObservations(r1.events, [republished], ctx(TODAY, 'c2', NOW));
  const ev = r2.events[0];
  assert.equal(r2.events.length, 1);
  assert.equal(ev.firstPublishedAt, '2026-09-20T13:00:00.000Z', 'publication only ever moves earlier');
  assert.equal(ev.firstSeenAt, first.firstSeenAt);
  assert.equal(ev.eventOccurredAt, '2026-09-20');
  assert.equal(ev.lastMaterialUpdateAt, null);
  assert.ok(!['NEW_PUBLICATION', 'NEW_MATERIAL_UPDATE'].includes(ev.freshnessReason), `stays old, got ${ev.freshnessReason}`);
  assert.ok(r2.transitions.some(x => x.kind === 'syndication'));
});

test('legacy persisted events (no sources / eventDateSource) fail closed: surfaced, never verified', () => {
  const legacy = { id: 'ev_old', headline: 'CPI report due', eventDate: '2026-10-14', evidence: 'VERIFIED', dateConfidence: 'metadata', expired: false, claims: [], lastSeen: NOW };
  const risk = R.buildEventRisk([legacy], { today: TODAY });
  assert.equal(risk.length, 1);
  assert.deepEqual(risk[0].sources, []);
  assert.notEqual(M.eventRiskLine(risk[0]).basis, 'VERIFIED_FACT');
});

test('buildEventRisk resolves sources for older events from the persisted source cards', () => {
  const idx = index();
  const claims = P.sanitizeClaims(CPI_OCT14.claims, idx, { scheduled: true });
  const ev = { id: 'ev_a', headline: 'CPI due', eventDate: '2026-10-14', evidence: 'VERIFIED', dateConfidence: 'metadata', claims, lastSeenAt: NOW };
  const risk = R.buildEventRisk([ev], { today: TODAY, sourceCards: P.indexToJSON(idx) });
  assert.ok(risk[0].sources.some(s => s.publisher === 'bls.gov'));
  assert.equal(risk[0].hasPrimarySource, true);
});
