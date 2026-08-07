'use strict';
// Around the Corner: syndicated stories deduplicate, timestamps order strictly,
// scheduled catalysts stay separate from emerging narratives, and no scenario ever
// carries a probability.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EVT = require('../lib/tech-command-events');

const NOW = new Date('2026-08-05T15:00:00Z');

test('syndicated copies of one story collapse to a single event, keeping the earliest', () => {
  const raw = [
    EVT.makeEvent({ ticker: 'AAAA', kind: 'news', title: 'Reuters: AAAA lands major cloud deal!', publishedAt: '2026-08-04T12:00:00Z', publisher: 'Reuters', url: 'https://r/1' }),
    EVT.makeEvent({ ticker: 'AAAA', kind: 'news', title: 'AAAA lands major cloud deal', publishedAt: '2026-08-04T13:30:00Z', publisher: 'Yahoo', url: 'https://y/1' }),
    EVT.makeEvent({ ticker: 'AAAA', kind: 'news', title: 'AAAA Lands Major Cloud Deal.', publishedAt: '2026-08-04T14:00:00Z', publisher: 'MarketWatch', url: 'https://m/1' }),
  ];
  const { events, duplicatesRemoved } = EVT.dedupeEvents(raw);
  assert.equal(events.length, 1);
  assert.equal(duplicatesRemoved, 2);
  assert.equal(events[0].publishedAt, '2026-08-04T12:00:00.000Z');
  assert.equal(events[0].syndicatedCopies, 2);
  assert.ok(events[0].publishers.length >= 2);
});

test('different companies with the same headline shape do NOT merge', () => {
  const { events } = EVT.dedupeEvents([
    EVT.makeEvent({ ticker: 'AAAA', kind: 'news', title: 'Q2 results beat', publishedAt: '2026-08-04T12:00:00Z' }),
    EVT.makeEvent({ ticker: 'BBBB', kind: 'news', title: 'Q2 results beat', publishedAt: '2026-08-04T12:00:00Z' }),
  ]);
  assert.equal(events.length, 2);
});

test('provenance is preserved and its absence is labeled, not hidden', () => {
  const sourced = EVT.makeEvent({ title: 'x', url: 'https://a/b', publisher: 'Reuters', publishedAt: '2026-08-04T12:00:00Z', retrievedAt: '2026-08-05T00:00:00Z' });
  assert.equal(sourced.dataConfidence, 'sourced');
  assert.equal(sourced.retrievedAt, '2026-08-05T00:00:00Z');
  const dated = EVT.makeEvent({ title: 'x', publishedAt: '2026-08-04T12:00:00Z' });
  assert.equal(dated.dataConfidence, 'dated-unsourced');
  const bare = EVT.makeEvent({ title: 'x' });
  assert.equal(bare.dataConfidence, 'unverified');
  assert.equal(bare.undated, true);
});

test('forward events bucket by distance and past events order newest-first', () => {
  const tl = EVT.buildTimeline({
    now: NOW,
    events: [
      EVT.makeEvent({ ticker: 'AAAA', kind: 'earnings', title: 'AAAA earnings', scheduledFor: '2026-08-06' }),
      EVT.makeEvent({ ticker: 'BBBB', kind: 'earnings', title: 'BBBB earnings', scheduledFor: '2026-08-12' }),
      EVT.makeEvent({ ticker: 'CCCC', kind: 'investor-day', title: 'CCCC investor day', scheduledFor: '2026-10-01' }),
      EVT.makeEvent({ ticker: 'AAAA', kind: 'news', title: 'older story', publishedAt: '2026-08-01T10:00:00Z' }),
      EVT.makeEvent({ ticker: 'AAAA', kind: 'news', title: 'newer story', publishedAt: '2026-08-04T10:00:00Z' }),
    ],
  });
  assert.equal(tl.byBucket['next-session'].length, 1);
  assert.equal(tl.byBucket['next-two-weeks'].length, 1);
  assert.equal(tl.byBucket['next-1-3-months'].length, 1);
  assert.equal(tl.past[0].title, 'newer story', 'past events must be newest-first');
  assert.ok(tl.upcoming[0].scheduledFor <= tl.upcoming[1].scheduledFor, 'upcoming must be soonest-first');
});

test('scheduled catalysts and emerging narratives are counted separately', () => {
  const tl = EVT.buildTimeline({
    now: NOW,
    events: [
      EVT.makeEvent({ ticker: 'AAAA', kind: 'earnings', title: 'earnings', scheduledFor: '2026-08-06' }),
      EVT.makeEvent({ ticker: 'AAAA', kind: 'news', title: 'rumor', publishedAt: '2026-08-04T10:00:00Z' }),
    ],
  });
  assert.equal(tl.counts.scheduled, 1);
  assert.equal(tl.counts.emerging, 1);
});

test('company-scope and sector-scope events are distinguished', () => {
  const tl = EVT.buildTimeline({
    now: NOW,
    events: [
      EVT.makeEvent({ ticker: 'AAAA', scope: 'company', kind: 'news', title: 'a', publishedAt: '2026-08-04T10:00:00Z' }),
      EVT.makeEvent({ scope: 'market', kind: 'options-expiry', title: 'opex', scheduledFor: '2026-08-21' }),
    ],
  });
  assert.equal(tl.counts.companyScope, 1);
  assert.equal(tl.counts.sectorScope, 1);
});

test('undated items are quarantined out of the timeline rather than assigned a time', () => {
  const tl = EVT.buildTimeline({ now: NOW, events: [EVT.makeEvent({ ticker: 'AAAA', kind: 'news', title: 'no date' })] });
  assert.equal(tl.past.length, 0);
  assert.equal(tl.upcoming.length, 0);
  assert.equal(tl.undated.length, 1);
});

test('an empty timeline says it is a coverage gap, not a quiet calendar', () => {
  const tl = EVT.buildTimeline({ now: NOW, events: [] });
  assert.equal(tl.empty, true);
  assert.match(tl.emptyReason, /coverage gap, not a quiet calendar/i);
});

test('present-tense contradictions are mechanical and named', () => {
  const c = EVT.presentContradictions({ attentionState: 'SATURATED', pctChange: -1, rsVsQqq: -2, optionsState: 'CONTRADICTS_SETUP', relVol: 3 });
  assert.ok(c.some(x => /saturated/i.test(x)));
  assert.ok(c.some(x => /options positioning leans against/i.test(x)));
  assert.equal(EVT.presentContradictions(null).length, 0);
});

test('scenarios carry NO probability, only confirmation/invalidation conditions', () => {
  const s = EVT.buildScenarios({
    ticker: 'AAAA',
    universeRecord: { benchmark: 'SMH', subsectorLabel: 'Semiconductors' },
    nextEvent: { id: 'e1', kind: 'earnings', scheduledFor: '2026-08-20' },
    levels: { trigger: 105, invalidation: 95, target: 125, price: 100 },
    expectedMovePct: 7,
    peers: ['BBBB', 'CCCC'],
  });
  assert.equal(s.probabilities, null);
  assert.match(s.probabilityNote, /not forecasts/i);
  assert.ok(!JSON.stringify(s).match(/"probability":\s*0\.\d/), 'a numeric probability leaked into a scenario');
  assert.ok(s.bull.confirmedBy.some(x => /105/.test(x)));
  assert.ok(s.bear.confirmedBy.some(x => /95/.test(x)));
  assert.deepEqual(s.affectedRelated, ['BBBB', 'CCCC']);
  assert.match(s.window, /2026-08-20/);
  assert.ok(s.dataConfidence.some(x => /option-implied move is available/.test(x)));
});

test('scenario data confidence reports what is MISSING when inputs are absent', () => {
  const s = EVT.buildScenarios({ ticker: 'AAAA', levels: {}, expectedMovePct: null });
  assert.ok(s.dataConfidence.some(x => /no dated forward event/.test(x)));
  assert.ok(s.dataConfidence.some(x => /no option-implied move/.test(x)));
  assert.match(s.bull.priceContext, /unquantified/);
});

test('the fact hash changes when the underlying facts change (LLM cache safety)', () => {
  const base = { ticker: 'AAAA', levels: { trigger: 105 }, expectedMovePct: 7, peers: ['BBBB'] };
  const a = EVT.buildScenarios(base);
  const b = EVT.buildScenarios({ ...base, levels: { trigger: 110 } });
  const c = EVT.buildScenarios(base);
  assert.notEqual(a.factHash, b.factHash);
  assert.equal(a.factHash, c.factHash);
});
