'use strict';
// Market Pulse v2 — STORY FRESHNESS.
// Locks the discovery≠publication contract end to end: timestamp provenance,
// honest lifecycle reasons, horizon age gates, syndication/rediscovery handling,
// recency-aware deterministic ranking, snapshot-vs-story clock separation, and
// honest refresh/cache reporting. All age tests use FIXED injected clocks.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const F = require('../lib/pulse2-freshness');
const P = require('../lib/pulse2-provenance');
const E = require('../lib/pulse2-events');
const A = require('../lib/pulse2-alerts');
const clocks = require('../lib/pulse2-clocks');

const NOW = '2026-08-11T18:00:00.000Z';
const hoursAgo = h => new Date(Date.parse(NOW) - h * 3600000).toISOString();
const daysAgo = d => hoursAgo(d * 24);

// A directly-constructed event record at given ages (hours before NOW).
const evAges = ({ eventH = null, pubH = null, seenH = 0, ...extra } = {}) => ({
  id: 'ev_x', evidence: 'VERIFIED', independentLineages: 2, observationCount: 1,
  eventOccurredAt: eventH == null ? null : hoursAgo(eventH),
  firstPublishedAt: pubH == null ? null : hoursAgo(pubH),
  firstSeenAt: hoursAgo(seenH),
  dateConfidence: pubH == null && eventH == null ? 'unknown' : 'metadata',
  lastMaterialUpdateAt: null,
  ...extra,
});

// ── 1. timestamp provenance ────────────────────────────────────────────────
test('extraction ladder: JSON-LD beats meta beats <time>; provider and URL are fallbacks', () => {
  const jsonld = '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-08-11T09:32:00Z","dateModified":"2026-08-11T12:00:00Z"}</script>';
  const a = F.normalizeSourceTimestamps({ url: 'https://n.test/x', html: jsonld, providerPublishedAt: '2026-08-01', discoveredAt: NOW, now: NOW });
  assert.equal(a.publishedAt, '2026-08-11T09:32:00.000Z');
  assert.equal(a.updatedAt, '2026-08-11T12:00:00.000Z');
  assert.equal(a.dateConfidence, 'publisher');

  const meta = '<meta property="article:published_time" content="2026-08-10T08:00:00Z">';
  assert.equal(F.extractDatesFromHtml(meta).dateConfidence, 'metadata');
  assert.equal(F.extractDatesFromHtml(meta).publishedAt, '2026-08-10T08:00:00.000Z');
  const timeTag = '<time datetime="2026-08-09T10:00:00Z">yesterday</time>';
  assert.equal(F.extractDatesFromHtml(timeTag).publishedAt, '2026-08-09T10:00:00.000Z');

  const provider = F.normalizeSourceTimestamps({ url: 'https://n.test/x', providerPublishedAt: '2026-08-11', discoveredAt: NOW, now: NOW });
  assert.equal(provider.publishedAt, '2026-08-11');
  assert.equal(provider.dateConfidence, 'metadata');

  const fromUrl = F.normalizeSourceTimestamps({ url: 'https://n.test/news/2026/08/05/big-story', discoveredAt: NOW, now: NOW });
  assert.equal(fromUrl.publishedAt, '2026-08-05');
  assert.equal(fromUrl.dateConfidence, 'url');
});

test('missing publication time produces dateConfidence unknown — discovery time is NEVER publication time', () => {
  const s = F.normalizeSourceTimestamps({ url: 'https://n.test/story-page', discoveredAt: NOW, now: NOW });
  assert.equal(s.publishedAt, null);
  assert.equal(s.dateConfidence, 'unknown');
  assert.equal(s.discoveredAt, NOW);   // discovery is tracked, separately
});

test('relative provider page_age resolves against the injected clock', () => {
  assert.equal(F.parsePageAge('2 hours ago', NOW), hoursAgo(2));
  assert.equal(F.parsePageAge('3 days ago', NOW), daysAgo(3));
  assert.equal(F.parsePageAge('January 5, 2026', NOW), new Date('January 5, 2026').toISOString());
});

test('canonical URLs drop tracking parameters and host/case noise; params are sorted', () => {
  assert.equal(
    F.canonicalizeUrl('https://WWW.Example.com/story/?utm_source=x&fbclid=abc&b=2&a=1'),
    'https://example.com/story?a=1&b=2');
  assert.equal(F.canonicalizeUrl('https://example.com/story#frag'), 'https://example.com/story');
});

// ── 2. lifecycle reasons ───────────────────────────────────────────────────
test('a six-day-old article discovered today is REDISCOVERED, never fresh', () => {
  const ev = evAges({ eventH: 6 * 24, pubH: 6 * 24, seenH: 0 });
  assert.equal(F.classifyFreshnessReason(ev, NOW), 'REDISCOVERED');
  assert.equal(F.freshVerifiedGate(ev, NOW).pass, false);
  assert.equal(F.dayGate(ev, NOW).group, 'context');   // multi-day context, not current
});

test('recent firstSeenAt alone can never make an event fresh (no timestamps → UNKNOWN)', () => {
  const ev = evAges({ eventH: null, pubH: null, seenH: 0 });
  assert.equal(F.classifyFreshnessReason(ev, NOW), 'UNKNOWN');
  assert.equal(F.freshVerifiedGate(ev, NOW).pass, false);
  assert.equal(F.dayGate(ev, NOW).group, 'context');
});

test('a newly published material update to an OLD event can be fresh again', () => {
  const ev = evAges({ eventH: 10 * 24, pubH: 10 * 24, observationCount: 4, lastMaterialUpdateAt: hoursAgo(2) });
  assert.equal(F.classifyFreshnessReason(ev, NOW), 'NEW_MATERIAL_UPDATE');
  assert.equal(F.freshVerifiedGate(ev, NOW).pass, true);
  assert.equal(F.dayGate(ev, NOW).group, 'current');
});

test('a genuinely recent publication is NEW_PUBLICATION and passes the fresh gate', () => {
  const ev = evAges({ eventH: 3, pubH: 2 });
  assert.equal(F.classifyFreshnessReason(ev, NOW), 'NEW_PUBLICATION');
  assert.equal(F.freshVerifiedGate(ev, NOW).pass, true);
});

test('date-only event on the SAME date as its publication ages by the publication clock', () => {
  // Event dated today (00:00Z anchor would read 18h) but published 3h ago → fresh.
  const ev = {
    ...evAges({ pubH: 3 }),
    eventOccurredAt: NOW.slice(0, 10), dateConfidence: 'metadata',
  };
  assert.equal(F.eventAges(ev, NOW).eventAgeHours, 3);
  assert.equal(F.freshVerifiedGate(ev, NOW).pass, true);
  // …but a date-only event WITHOUT a same-date publication keeps the conservative anchor.
  const noPub = { ...ev, firstPublishedAt: null, dateConfidence: 'inferred' };
  assert.equal(F.eventAges(noPub, NOW).eventAgeHours, 18);
});

test('fresh-verified is publication-gated: a 7h-old publication misses the 6h limit', () => {
  const ev = evAges({ eventH: 8, pubH: 7 });
  const g = F.freshVerifiedGate(ev, NOW);
  assert.equal(g.pass, false);
  assert.match(g.why, /publication/);
});

// ── 3. horizon gates + exact boundaries ────────────────────────────────────
test('Day gate at its EXACT boundaries: event 24.0h OR publication 18.0h is current; past both is not', () => {
  // event boundary (publication already stale — the event clock alone decides)
  assert.equal(F.dayGate(evAges({ eventH: 24, pubH: 20 }), NOW).group, 'current');
  assert.equal(F.dayGate(evAges({ eventH: 24 + 1 / 60, pubH: 20 }), NOW).group, 'context');
  // publication boundary (event clock already past — a fresh first publication still qualifies)
  assert.equal(F.dayGate(evAges({ eventH: 30, pubH: 18 }), NOW).group, 'current');
  assert.equal(F.dayGate(evAges({ eventH: 30, pubH: 18.1 }), NOW).group, 'context');
});

test('Day placement is decision-relevance: a recent event with UNVERIFIED publication surfaces, but never as Fresh verified', () => {
  const ev = { ...evAges({ eventH: 1.5 }), dateConfidence: 'inferred' };   // model-claimed date, no publication time
  const g = F.dayGate(ev, NOW);
  assert.equal(g.group, 'current');
  assert.match(g.why, /publication time unverified/);
  assert.equal(F.freshVerifiedGate(ev, NOW).pass, false);   // verification bar unchanged
});

test('Swing and Investor use their own policies', () => {
  assert.equal(F.swingGate(evAges({ eventH: 6 * 24, pubH: 6 * 24 }), NOW).group, 'current');   // inside 7d
  assert.equal(F.swingGate(evAges({ eventH: 8 * 24, pubH: 8 * 24 }), NOW).group, 'excluded');  // outside 7d
  assert.equal(F.swingGate(evAges({}), NOW).group, 'context');                                  // undated → context
  const inv = F.investorGate(evAges({ eventH: 40 * 24, pubH: 40 * 24 }), NOW);
  assert.equal(inv.group, 'current');                                                           // no hard cutoff
  const invUnknown = F.investorGate(evAges({}), NOW);
  assert.match(invUnknown.why, /age unknown/i);                                                 // …but age is exposed
});

test('thresholds are configurable via PULSE2_* environment overrides', () => {
  const prev = process.env.PULSE2_DAY_MAX_EVENT_AGE_H;
  try {
    process.env.PULSE2_DAY_MAX_EVENT_AGE_H = '48';
    const pol = F.policyFromEnv();
    assert.equal(pol.DAY_MAX_EVENT_AGE_H, 48);
    assert.equal(F.dayGate(evAges({ eventH: 30, pubH: 1 }), NOW, pol).group, 'current');
  } finally {
    if (prev === undefined) delete process.env.PULSE2_DAY_MAX_EVENT_AGE_H;
    else process.env.PULSE2_DAY_MAX_EVENT_AGE_H = prev;
  }
});

// ── 4. dedup / syndication / wrong-year / evergreen ────────────────────────
const CITES = [
  { url: 'https://www.reuters.com/markets/acme-beats-2026-08-11/', title: 'Acme beats and raises full-year outlook', domain: 'reuters.com', publishedAt: '2026-08-11' },
  { url: 'https://finance.yahoo.com/news/acme-beats.html?utm_source=rss', title: 'Acme beats and raises full-year outlook', domain: 'finance.yahoo.com', publishedAt: '2026-08-11' },
  { url: 'https://oldnews.test/archive/2025/03/10/acme-2025-outlook', title: 'Acme 2025 outlook preview', domain: 'oldnews.test', publishedAt: null },
  { url: 'https://calendarsite.test/earnings-calendar', title: 'Earnings calendar', domain: 'calendarsite.test', publishedAt: null },
];
const IDX = P.buildSourceIndex(CITES, { discoveredAt: NOW, now: NOW, asOfDate: '2026-08-11' });

test('a syndicated repost does not create an independent lineage', () => {
  const refs = P.resolveSourceRefs([CITES[0].url, CITES[1].url], IDX).sourceRefs;
  assert.equal(refs.length, 2);
  assert.equal(P.independentLineageCount(refs, IDX), 1);   // one underlying report
});

test('a source explicitly dated to the wrong year is reference-screened and cannot verify', () => {
  const src = IDX.byUrl.get(CITES[2].url);
  assert.equal(src.reference, 'year-mismatch');
  const refs = P.resolveSourceRefs([CITES[2].url], IDX).sourceRefs;
  assert.equal(P.independentLineageCount(refs, IDX), 0);
  assert.equal(P.deriveClaimStatus({ sourceRefs: refs }, IDX), 'STALE');
});

test('an evergreen undated calendar page is reference-only — it cannot support Fresh verified', () => {
  const src = IDX.byUrl.get(CITES[3].url);
  assert.equal(src.reference, 'evergreen');
  const claims = P.sanitizeClaims([{ text: 'Acme reports earnings', sourceUrls: [CITES[3].url] }], IDX);
  assert.equal(claims[0].status, 'STALE');
  assert.equal(P.rollupEvidence(claims), 'STALE');   // STALE can never read VERIFIED/SUPPORTED
});

test('tracking-parameter variants of one URL collapse to a single source', () => {
  const bare = P.resolveSourceRefs(['https://finance.yahoo.com/news/acme-beats.html'], IDX).sourceRefs;
  const tracked = P.resolveSourceRefs([CITES[1].url], IDX).sourceRefs;
  assert.deepEqual(bare, tracked);
});

// ── 5. event ledger: fold-time behavior ────────────────────────────────────
const ctx = (date, cycleId, iso) => ({ date, generation: iso, cycleId, now: () => iso });
const baseObs = {
  headline: 'Acme beats and raises full-year outlook',
  tickers: ['ACME'], claim: 'Acme raised full-year guidance after a beat',
  eventFamily: 'guidance', eventDate: '2026-08-11', direction: 'BULLISH',
  evidence: 'VERIFIED', claims: [], independentLineages: 2,
  publishedAt: hoursAgo(2), dateConfidence: 'metadata', sourceCount: 2,
};

test('fold stamps the timestamp-provenance block and a fresh reason on new events', () => {
  const r = E.foldObservations([], [baseObs], ctx('2026-08-11', 'c1', NOW));
  const ev = r.events[0];
  assert.equal(ev.firstPublishedAt, hoursAgo(2));
  assert.equal(ev.eventOccurredAt, '2026-08-11');
  assert.equal(ev.firstSeenAt, NOW);
  assert.equal(ev.lastSeenAt, NOW);
  assert.equal(ev.dateConfidence, 'metadata');
  assert.equal(ev.freshnessReason, 'NEW_PUBLICATION');
  const appeared = r.transitions.find(t => t.kind === 'appeared');
  assert.equal(appeared.freshnessReason, 'NEW_PUBLICATION');
});

test('an OLD story first ingested today folds as REDISCOVERED — not a new event', () => {
  const oldObs = { ...baseObs, eventDate: '2026-08-05', publishedAt: daysAgo(6) };
  const r = E.foldObservations([], [oldObs], ctx('2026-08-11', 'c1', NOW));
  assert.equal(r.events[0].freshnessReason, 'REDISCOVERED');
  const appeared = r.transitions.find(t => t.kind === 'appeared');
  assert.equal(A.kindOf(appeared), 'NARRATIVE_DISCOVERED');
  assert.match(A.ALERT_KINDS.NARRATIVE_DISCOVERED.label, /Newly discovered by Market Pulse/);
});

test('a syndicated repost continues the SAME event: no new event, no corroboration, diagnostics only', () => {
  const r1 = E.foldObservations([], [baseObs], ctx('2026-08-11', 'c1', NOW));
  const later = hoursAgo(-1);   // one hour after NOW
  const repost = { ...baseObs, sourceCount: 5, independentLineages: 2 };   // more copies, same lineages
  const r2 = E.foldObservations(r1.events, [repost], ctx('2026-08-11', 'c2', later));
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].freshnessReason, 'SYNDICATED_COPY');
  assert.ok(r2.transitions.some(t => t.kind === 'syndication'));
  assert.ok(!r2.transitions.some(t => t.kind === 'corroborated'));
  assert.equal(A.kindOf({ kind: 'syndication' }), null);   // never a prominent alert
});

test('a NEW independent lineage is corroboration: lastCorroboratedAt advances and alerts honestly', () => {
  const first = { ...baseObs, independentLineages: 1, sourceCount: 1, evidence: 'SINGLE_SOURCE' };
  const r1 = E.foldObservations([], [first], ctx('2026-08-11', 'c1', NOW));
  const later = hoursAgo(-1);
  const r2 = E.foldObservations(r1.events, [{ ...baseObs, independentLineages: 2, sourceCount: 2 }], ctx('2026-08-11', 'c2', later));
  assert.equal(r2.events[0].lastCorroboratedAt, later);
  assert.equal(r2.events[0].freshnessReason, 'NEW_CORROBORATION');
  const t = r2.transitions.find(x => x.kind === 'corroborated');
  assert.equal(A.kindOf(t), 'NEW_CORROBORATION');
  assert.equal(A.ALERT_KINDS.NEW_CORROBORATION.label, 'New corroborating source');
});

test('a newer development date is a MATERIAL update and re-freshens the event', () => {
  const old = { ...baseObs, eventDate: '2026-08-01', publishedAt: daysAgo(10) };
  const r1 = E.foldObservations([], [old], ctx('2026-08-01', 'c1', daysAgo(10)));
  const update = { ...baseObs, eventDate: '2026-08-11', publishedAt: hoursAgo(1) };
  const r2 = E.foldObservations(r1.events, [update], ctx('2026-08-11', 'c9', NOW));
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].eventOccurredAt, '2026-08-11');
  assert.equal(r2.events[0].lastMaterialUpdateAt, NOW);
  assert.equal(r2.events[0].freshnessReason, 'NEW_MATERIAL_UPDATE');
  const t = r2.transitions.find(x => x.kind === 'material-update');
  assert.equal(A.kindOf(t), 'MATERIAL_UPDATE');
  assert.equal(A.ALERT_KINDS.MATERIAL_UPDATE.label, 'Material update');
  assert.equal(A.ALERT_KINDS.NARRATIVE_APPEARED.label, 'New event');   // renamed from "New narrative detected"
});

test('legacy stored event records (no freshness fields) load safely and fail closed', () => {
  const legacy = {
    id: 'ev_legacy', continuityKey: 'ACME|guidance|acme-guidance-raised|2026-08-01', entity: 'ACME',
    family: 'guidance', claim: 'Acme raised guidance', headline: 'Acme raises', tickers: ['ACME'],
    eventDate: '2026-08-01', firstSeen: daysAgo(10), firstSeenDate: '2026-08-01',
    lastSeen: daysAgo(10), lastSeenDate: '2026-08-01', observationCount: 3, observationDates: ['2026-08-01'],
    evidence: 'VERIFIED', independentLineages: 2, missedCycles: 0, narrativeLifecycle: 'VERIFIED',
    lifecycleHistory: [], transitions: [],
  };
  const m = E.migrateEventRecord(legacy);
  assert.equal(m.firstSeenAt, legacy.firstSeen);
  assert.equal(m.eventOccurredAt, '2026-08-01');
  assert.equal(m.firstPublishedAt, null);
  assert.equal(m.dateConfidence, 'inferred');            // model-claimed date → low confidence
  assert.equal(F.freshVerifiedGate(m, NOW).pass, false); // migration can never mint freshness
  const r = E.foldObservations([legacy], [], ctx('2026-08-11', 'c1', NOW));   // no throw
  assert.equal(r.events[0].lastCorroboratedAt, legacy.lastSeen);
  assert.ok(r.events[0].freshnessReason);
});

// ── 6. ranking ─────────────────────────────────────────────────────────────
const cardAt = (id, eventH, tradeState = 'WATCH') => ({
  eventId: id, tradeState,
  freshness: {
    rankScore: null, eventOccurredAt: hoursAgo(eventH), firstPublishedAt: hoursAgo(eventH),
    lastCorroboratedAt: null, eventAgeHours: eventH, publicationAgeHours: eventH,
  },
});

test('Day ranking: a 3-hour-old event beats an otherwise-equivalent 3-day-old event', () => {
  const young = F.rankScore({ tradeState: 'WATCH', evidence: 'VERIFIED', freshness: { eventAgeHours: 3, publicationAgeHours: 3 } }, 'day');
  const old = F.rankScore({ tradeState: 'WATCH', evidence: 'VERIFIED', freshness: { eventAgeHours: 72, publicationAgeHours: 72 } }, 'day');
  assert.ok(young > old, `young ${young} must outrank old ${old}`);
});

test('unknown timestamps are penalized in ranking', () => {
  const dated = F.rankScore({ tradeState: 'WATCH', evidence: 'VERIFIED', freshness: { eventAgeHours: 6, publicationAgeHours: 6 } }, 'day');
  const undated = F.rankScore({ tradeState: 'WATCH', evidence: 'VERIFIED', freshness: {} }, 'day');
  assert.ok(dated > undated);
});

test('sorting is deterministic: shuffled input yields identical order; ties break on timestamps then id', () => {
  const a = cardAt('ev_a', 3), b = cardAt('ev_b', 30), c = cardAt('ev_c', 80), d = cardAt('ev_d', 3);
  for (const card of [a, b, c, d]) {
    card.freshness.rankScore = F.rankScore({ tradeState: card.tradeState, evidence: 'VERIFIED', freshness: card.freshness }, 'day');
  }
  const s1 = [a, b, c, d].sort(F.compareRanked).map(x => x.eventId);
  const s2 = [d, c, b, a].sort(F.compareRanked).map(x => x.eventId);
  const s3 = [c, a, d, b].sort(F.compareRanked).map(x => x.eventId);
  assert.deepEqual(s1, s2);
  assert.deepEqual(s1, s3);
  assert.deepEqual(s1.slice(0, 2), ['ev_a', 'ev_d']);   // equal scores → stable id tiebreak
  assert.equal(s1[3], 'ev_c');
});

// ── 7. clocks + cache honesty ──────────────────────────────────────────────
test('snapshot age is DISTINCT from story ages: a 160m-old narrative does not age its stories', () => {
  const out = clocks.buildClocks({
    narrativeGeneratedAt: new Date(Date.parse(NOW) - 160 * 60000).toISOString(),
    sessionInfo: { marketSession: 'regular', isTradingDay: true, etDate: '2026-08-11' },
    now: new Date(NOW),
  });
  assert.equal(out.narrativeAgeMinutes, 160);
  const card = F.cardFreshness(evAges({ eventH: 3, pubH: 2 }), NOW, { horizon: 'day', tradeState: 'WATCH' });
  assert.equal(card.publicationAgeHours, 2);   // the story's own clock, not 160m
  assert.equal(card.eventAgeHours, 3);
  assert.ok(out.nextNarrativeRefreshAt, 'payload clocks must expose the next refresh slot');
});

test('nextNarrativeRefreshAt: in-session → next top of hour; weekend → the nightly 22:00 UTC slot', () => {
  assert.equal(clocks.nextNarrativeRefreshAt(new Date('2026-08-11T18:20:00Z')), '2026-08-11T19:00:00.000Z'); // Tue RTH
  assert.equal(clocks.nextNarrativeRefreshAt(new Date('2026-08-15T02:00:00Z')), '2026-08-15T22:00:00.000Z'); // Sat
});

test('cacheMeta reports HIT vs REFRESHED vs STALE honestly', () => {
  assert.equal(clocks.cacheMeta({ narrativeAgeMinutes: 30 }).status, 'HIT');
  assert.equal(clocks.cacheMeta({ narrativeAgeMinutes: null }).status, 'MISS');
  assert.equal(clocks.cacheMeta({ refreshRequested: true, narrativeAgeMinutes: 10 }).status, 'REFRESHED');
  assert.equal(clocks.cacheMeta({ refreshRequested: true, narrativeAgeMinutes: 200 }).status, 'STALE');
  assert.equal(clocks.cacheMeta({ refreshRequested: true, narrativeAgeMinutes: 10 }).ttlSeconds, 0);
});

test('op=pulse2&refresh=1 bypasses the CDN (no-store) and carries cache metadata; normal reads stay cacheable', async () => {
  const { runPulse2 } = require('../lib/pulse2-routes');
  const fakeRes = () => ({
    headers: {}, statusCode: 200, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  });
  const r1 = fakeRes();
  await runPulse2({ query: { op: 'pulse2', refresh: '1' } }, r1);
  assert.equal(r1.headers['Cache-Control'], 'no-store');
  assert.ok(r1.body.cache, 'refresh payload must carry cache metadata');
  assert.equal(r1.body.cache.refreshRequested, true);
  assert.ok('nextNarrativeRefreshAt' in r1.body.clocks);
  const r2 = fakeRes();
  await runPulse2({ query: { op: 'pulse2' } }, r2);
  assert.match(r2.headers['Cache-Control'], /s-maxage=/);
  assert.equal(r2.body.cache.refreshRequested, false);
});

// ── 8. rendering ───────────────────────────────────────────────────────────
const loadRender = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'pulse2-render.js')).href);

test('cards render an accessible timestamp row with valid <time datetime> elements', async () => {
  const R = await loadRender();
  const html = R.viewCard({
    view: 'day', eventId: 'e1', ticker: 'ACME', headline: 'H', direction: 'BULLISH',
    evidence: 'VERIFIED', tradeState: 'WATCH', contract: { missingData: [] },
    freshness: {
      reason: 'NEW_PUBLICATION', group: 'current', eventOccurredAt: '2026-08-05',
      firstPublishedAt: '2026-08-05T13:32:00.000Z', discoveredAt: '2026-08-11T22:00:00.000Z',
      eventAgeHours: 3, publicationAgeHours: 3, dateConfidence: 'metadata',
    },
  }, false);
  assert.match(html, /<time datetime="2026-08-05">/);
  assert.match(html, /<time datetime="2026-08-11T22:00:00\.000Z">/);
  assert.match(html, /Event /);
  assert.match(html, /Published /);
  assert.match(html, /Discovered /);
  assert.match(html, /date confidence metadata/);
});

test('age badges: hours, days, date-unknown, rediscovered, material update', async () => {
  const R = await loadRender();
  assert.match(R.ageBadge({ eventAgeHours: 3 }), />3h</);
  assert.match(R.ageBadge({ eventAgeHours: 49 }), />2d old</);
  assert.match(R.ageBadge({}), /Date unknown/);
  assert.match(R.ageBadge({ eventAgeHours: 49, reason: 'REDISCOVERED' }), /Rediscovered/);
  assert.match(R.ageBadge({ eventAgeHours: 2, reason: 'NEW_MATERIAL_UPDATE' }), /Material update/);
});

test('Day view separates current stories from a collapsed Earlier/undated context group', async () => {
  const R = await loadRender();
  const mk = (id, group, score) => ({
    eventId: id, ticker: id.toUpperCase(), headline: id, direction: 'BULLISH', evidence: 'VERIFIED',
    tradeState: 'WATCH', contract: { missingData: [] },
    freshness: { group, rankScore: score, eventOccurredAt: null, firstPublishedAt: null, lastCorroboratedAt: null },
  });
  const html = R.renderView('Day trade', [mk('older', 'context', 1), mk('fresh', 'current', 9)], true, 'empty');
  assert.match(html, /Earlier \/ undated context \(1\)/);
  assert.ok(html.indexOf('fresh') < html.indexOf('older'), 'current stories precede the context group');
  assert.match(html, /<details class="p2-context-group">/);
});

test('source metadata is escaped (no raw HTML injection through titles or URLs)', async () => {
  const R = await loadRender();
  const html = R.eventCard({
    id: 'e1', headline: '<script>alert(1)</script>', evidence: 'SUPPORTED', tickers: ['A'],
    freshnessReason: 'NEW_PUBLICATION', firstPublishedAt: '2026-08-11T09:00:00Z', firstSeenAt: '2026-08-11T10:00:00Z',
    claims: [{ text: 'c', status: 'SUPPORTED', sourceRefs: ['s1'] }],
  }, { s1: { url: 'https://x.test/a', domain: 'x.test', title: '"><img src=x onerror=alert(1)>', publishedAt: '2026-08-11T09:00:00Z' } }, false);
  assert.ok(!html.includes('<script>alert'), 'headline must be escaped');
  assert.ok(!html.includes('<img src=x'), 'source title must be escaped');
  assert.match(html, /<time datetime="2026-08-11T09:00:00Z">/);
});

test('the narrative snapshot age is labeled as a narrative update, not story age', async () => {
  const R = await loadRender();
  const html = R.renderHealthStrip(
    { dataMode: 'live', modelVersion: 'x', narrativeAgeMinutes: 160, nextNarrativeRefreshAt: '2026-08-11T19:00:00.000Z' },
    [], null, { status: 'HIT', ttlSeconds: 60 });
  assert.match(html, /narrative updated 160m ago/);
  assert.match(html, /next update/);
  assert.match(html, /cache HIT/);
  assert.ok(!/stories 160m old/.test(html));
});
