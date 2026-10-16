'use strict';
// Pulse v2 — counts are scoped to what is rendered (review 2026-10, Prompt 8.3) and the
// health strip never says "live" for doc availability (A6). Required fixture: raw section
// counts 1 / 3 / 6 with no visible Day rows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
let R;
test.before(async () => { R = await import(pathToFileURL(join(__dirname, '..', 'public', 'js', 'pulse2-render.js')).href); });

const ids = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const sections = { freshVerified: ids(1, 'a'), unreacted: ids(3, 'b'), priceConfirmed: ids(6, 'c') };

test('badges count the cards actually drawn; listed-but-unloadable ids are reported, not shown as a quiet market', () => {
  const html = R.renderEventSections(sections, [], {}, true);
  assert.match(html, /🆕 Fresh verified events <span class="p2-sec-n"[^>]*>0 visible · 1 listed is expired or outside the loaded window<\/span>/);
  assert.match(html, /💤 Verified but unreacted <span class="p2-sec-n"[^>]*>0 visible · 3 listed are expired or outside the loaded window<\/span>/);
  assert.ok(!/an honest quiet, not a data error/.test(html), 'the empty copy may not contradict a non-zero listed count');
  assert.match(html, /1 listed at the last tick is no longer loadable/);
  // With the events present the badge is the plain visible count and the old copy returns.
  const events = sections.freshVerified.map(id => ({ id, headline: 'h', tickers: [], evidence: 'VERIFIED' }));
  const full = R.renderEventSections({ freshVerified: sections.freshVerified }, events, {}, true);
  assert.match(full, /🆕 Fresh verified events <span class="p2-sec-n">1<\/span>/);
  assert.deepEqual(R.sectionCounts(['a', 'b'], new Map([['a', { id: 'a' }]])).missing, 1);
});

test('horizon tabs carry scoped counts and an empty Day view says "0 in Day · N across all horizons"', () => {
  const ctx = (t) => ({ ticker: t, eventId: t, headline: t, tradeState: 'CONTEXT_ONLY', freshness: { group: 'context' } });
  const views = { day: [], swing: [ctx('S1'), ctx('S2'), ctx('S3')], investor: Array.from({ length: 6 }, (_, i) => ctx(`I${i}`)) };
  const html = R.renderShell({ payload: { ok: true, clocks: { dataMode: 'complete', modelVersion: 'x' }, narratives: { views, sections, items: [], sources: [] }, events: [] }, novice: true });
  assert.match(html, /⚡ Day <span class="p2-tab-n"[^>]*>0\/0<\/span>/);
  assert.match(html, /📅 Swing <span class="p2-tab-n"[^>]*>0\/3<\/span>/);
  assert.match(html, /🏛 Investor <span class="p2-tab-n"[^>]*>0\/6<\/span>/);
  assert.match(html, /0 in Day trade · 0 current in Day · 9 across all horizons \(Day 0 \/ Swing 3 \/ Investor 6\)/);
  assert.equal(R.horizonCountsLine(views, 'swing'), '0 current in Swing · 9 across all horizons (Day 0 / Swing 3 / Investor 6)');
  // A view whose rows are all in the context group says so with its number, not a bare "nothing".
  assert.match(html, /nothing current right now — the 3 older or undated stories are in the context group below/);
});

test('health strip: data availability is "complete", never "live"; the cache chip names the narrative snapshot', () => {
  for (const mode of ['live', 'complete']) {
    const html = R.renderHealthStrip({ dataMode: mode, modelVersion: 'm', marketDataFreshness: 'MARKET_CLOSED' }, [], null, { status: 'STALE', ttlSeconds: 60 });
    assert.match(html, /data: complete · model m/);
    assert.ok(!/mode: live/.test(html) && !/\blive\b/.test(html.replace(/title="[^"]*"/g, '')), html);
    assert.match(html, /narrative snapshot: stale/);
  }
  assert.match(R.renderHealthStrip({ dataMode: 'degraded', modelVersion: 'm' }, [], null, { status: 'REFRESHED', ttlSeconds: 0 }), /data: degraded.*narrative snapshot: refreshed — current/);
  assert.match(R.renderHealthStrip({ dataMode: 'unavailable', modelVersion: 'm' }, [], null, null), /data: unavailable/);
});

test('playbook event-risk lines render provenance when present and never invent a verified badge', () => {
  const pb = { marketMode: { text: 'ROTATION', basis: 'MEASURED' }, upcomingEventRisk: [
    { text: '2026-10-07: CPI print', basis: 'EDITORIAL', sources: [{ url: 'https://www.bls.gov/schedule', publisher: 'BLS' }], asOf: '2026-10-03T11:00:00Z' },
    { text: '2026-10-09: earnings (date unconfirmed)', basis: 'MODEL_INFERENCE', dateUnconfirmed: true },
    'plain string line (legacy shape)',
  ] };
  const html = R.renderPlaybook(pb);
  assert.match(html, /<a href="https:\/\/www\.bls\.gov\/schedule" target="_blank" rel="noopener noreferrer">BLS<\/a>/);
  assert.match(html, /as of <time datetime="2026-10-03T11:00:00Z">/);
  assert.match(html, /date unconfirmed/);
  assert.match(html, /plain string line \(legacy shape\)/);
  const verifiedBadges = (html.match(/VERIFIED_FACT|verified fact/gi) || []).length;
  assert.equal(verifiedBadges, 0, 'no verified badge unless a basis says so');
  assert.ok(!/javascript:/.test(R.renderPlaybook({ upcomingEventRisk: [{ text: 'x', basis: 'EDITORIAL', sources: [{ url: 'javascript:alert(1)', publisher: 'evil' }] }] })));
});

test('cross-asset table labels the value column as the PROXY change and carries a unit when given', () => {
  const m = { available: true, equityChangePct: 0.8, summary: { confirmationRatioNote: 'n', contradicting: true, contradictingLegs: ['HYG (proxy for credit): -1.2%'] }, proxyDisclosure: 'd', coverage: { unavailable: [] },
    rows: { credit: { underlying: 'credit', proxy: 'HYG', changePct: -1.2, verdict: 'CONTRADICTS', reason: 'r' }, vol: { underlying: 'vol', proxy: 'VIX', level: 18.4, kind: 'level', unit: 'pts', verdict: 'CONFIRMS' } } };
  const html = R.renderCrossAsset(m);
  assert.match(html, /<th style="text-align:right"[^>]*>Proxy change<\/th>/);
  assert.match(html, /HYG \(proxy for credit\): -1\.2%/);
  assert.match(html, /18\.4 pts/);
});
