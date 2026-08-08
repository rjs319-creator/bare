'use strict';
// Market Pulse v2 — frontend render module (pure, imported directly as an ES module,
// tech-command pattern). Locks honest empty states, basis tagging, and the separated
// clock chips in the actual HTML the user sees.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'pulse2-render.js')).href);

test('module parses and exports every renderer', async () => {
  const R = await load();
  for (const fn of ['renderShell', 'renderMarketNow', 'renderPlaybook', 'renderView', 'viewCard',
    'renderEventSections', 'renderRecent', 'renderTrackRecord', 'renderHealthStrip',
    'basisChip', 'clockChips', 'tradePill', 'evidenceChip', 'emptySection', 'eventCard']) {
    assert.equal(typeof R[fn], 'function', `${fn} must be exported`);
  }
});

test('missing market state renders an honest data-gap message, never a neutral market', async () => {
  const R = await load();
  const html = R.renderMarketNow(null, null);
  assert.match(html, /data gap, not a quiet market/);
  assert.match(html, /role="status"/);
});

test('clock chips render BOTH clocks with word labels (never color alone)', async () => {
  const R = await load();
  const html = R.clockChips({
    narrativeFreshness: 'RECENT_NARRATIVE', narrativeAgeMinutes: 240,
    marketDataFreshness: 'REALTIME', marketDataAgeSeconds: 60,
  });
  assert.match(html, /narrative recent/);
  assert.match(html, /market data realtime/);
  assert.match(html, /\(240m\)/);
});

test('a 4h-old narrative is never rendered with a "live" word on the narrative chip', async () => {
  const R = await load();
  const html = R.clockChips({ narrativeFreshness: 'RECENT_NARRATIVE', narrativeAgeMinutes: 240, marketDataFreshness: 'MARKET_CLOSED' });
  assert.ok(!/narrative live/.test(html));
});

test('empty view sections say WHY they are empty', async () => {
  const R = await load();
  const html = R.renderView('Day trade', [], true, 'no day-trade reads — needs fresh regular-session data and collected events');
  assert.match(html, /needs fresh regular-session data/);
});

test('a price-confirmed card carries trigger + invalidation in the expert drawer', async () => {
  const R = await load();
  const html = R.viewCard({
    view: 'day', eventId: 'e', ticker: 'ACME', headline: 'H', direction: 'BULLISH',
    evidence: 'VERIFIED', tradeState: 'PRICE_CONFIRMED',
    contract: { verified: 'VERIFIED', horizon: 'intraday', trigger: 100, invalidation: 98, missingData: [] },
  }, false);
  assert.match(html, /Trigger/);
  assert.match(html, /Invalidation/);
  assert.match(html, /Price-confirmed/);
});

test('novice mode hides the expert drawer; pro mode shows it', async () => {
  const R = await load();
  const card = { view: 'day', ticker: 'A', headline: 'H', direction: 'BULLISH', evidence: 'VERIFIED', tradeState: 'WATCH', contract: { missingData: [] } };
  assert.ok(!R.viewCard(card, true).includes('Expert detail'));
  assert.ok(R.viewCard(card, false).includes('Expert detail'));
});

test('playbook lines carry visible basis tags (measured vs inference vs editorial)', async () => {
  const R = await load();
  const html = R.renderPlaybook({
    marketMode: { text: 'ROTATION', basis: 'MEASURED' },
    whatChanged: [{ text: 'x', basis: 'MEASURED' }],
    leadership: { text: 'l', basis: 'MEASURED' },
    deterioration: { text: 'd', basis: 'MEASURED' },
    favor: { text: 'f', basis: 'MODEL_INFERENCE' },
    avoid: { text: 'a', basis: 'MODEL_INFERENCE' },
    nextDecisionPoint: { text: 'n', basis: 'MEASURED' },
    freshOpportunities: [], activeTriggers: [], upcomingEventRisk: [],
  });
  assert.match(html, /Measured/);
  assert.match(html, /Model inference/);
});

test('syndicated sources are labeled as such on event cards', async () => {
  const R = await load();
  const html = R.eventCard({
    id: 'e1', headline: 'H', evidence: 'SUPPORTED', tickers: ['A'],
    claims: [{ text: 'c', status: 'SUPPORTED', sourceRefs: ['s1'] }],
  }, { s1: { url: 'https://x.test/a', domain: 'x.test', lineageType: 'syndicated-copy' } }, false);
  assert.match(html, /syndicated/);
});

test('track record with no matured outcomes is an honest empty state, no invented stats', async () => {
  const R = await load();
  const html = R.renderTrackRecord(null);
  assert.match(html, /has not matured yet/);
  assert.ok(!/\d+%/.test(html), 'no percentage may appear without data');
});
