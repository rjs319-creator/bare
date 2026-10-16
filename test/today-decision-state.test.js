'use strict';
// Today board — decision state, blocker attribution, lane rank, session line, thin samples and
// keyboard reachability (review 2026-10, Prompts 2.1/2.2, 4.3/4.4/4.5, 8.4/8.5). Renders the
// real module (pure ESM import) into a fake container; no DOM needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = join(__dirname, '..');
let T;
test.before(async () => { T = await import(pathToFileURL(join(ROOT, 'public', 'js', 'today.js')).href); });

const fakeContainer = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });
const render = (p, opts) => { const c = fakeContainer(); T.renderCommandCenter(c, p, { now: new Date('2026-10-03T15:02:00Z'), heldTickers: [], ...opts }); return c.innerHTML; };
const assertClean = (html) => { for (const bad of ['${', 'undefined', 'NaN', '[object Object]']) assert.ok(!html.includes(bad), `leaked ${bad}`); };

const SIG = {
  id: 'x', rank: 130, laneRank: 1, ticker: 'GRML', side: 'short', state: 'triggered', source: 'gapdown', setup: 'Gap-down short', score: 41, horizon: 'intraday',
  evidenceClass: 'RESEARCH', retainedLabel: 'TRIGGERED', entry: 9.6, stop: 16.95, target: 0.01,
  eligibility: { signalClass: 'RESEARCH', reasonCodes: ['NOT_PRODUCTION', 'NO_BORROW'], reasons: ['strategy disabled', 'no borrow feed'] },
};
const BASE = { ok: true, generatedAt: '2026-10-03T11:02:00Z', actionableByHorizon: {}, qualifiedLeadsByHorizon: {}, horizons: {}, counts: { signals: 1 } };

test('a disabled short with no borrow and no position is TRIGGERED, never HOLD', () => {
  const html = render({ ...BASE, researchByHorizon: { intraday: [SIG] } });
  assertClean(html);
  assert.match(html, /▶ TRIGGERED/);
  assert.ok(!/🤝 HOLD/.test(html), 'HOLD chip must not appear without a position record');
  assert.ok(!/manage the existing position/.test(html));
  // the meaning is visible text, not hover-only
  assert.match(html, /td-retained-why">TRIGGERED: The entry level already traded; not a new entry\./);
  // both blockers remain attributable on the card
  assert.match(html, /not cleared for live trading; no observed borrow for the short/);
});

test('the pre-rename HOLD spelling from an older payload is shown as TRIGGERED too', () => {
  const html = render({ ...BASE, researchByHorizon: { intraday: [{ ...SIG, retainedLabel: 'HOLD' }] } });
  assert.match(html, /▶ TRIGGERED/);
  assert.ok(!/🤝 HOLD/.test(html));
});

test('HOLD wording appears only when the reader\'s My Book ledger holds the ticker', () => {
  const html = render({ ...BASE, researchByHorizon: { intraday: [SIG] } }, { heldTickers: ['grml'] });
  assert.match(html, /🤝 HOLD/);
  assert.match(html, /In your My Book/);
  const actionable = { ...SIG, evidenceClass: 'ACTIONABLE', eligibility: { signalClass: 'ACTIONABLE', reasonCodes: ['OK'], reasons: [] } };
  assert.match(render({ ...BASE, actionableByHorizon: { intraday: [actionable] } }), /TRIGGERED — the entry level already traded; not a new entry/);
  assert.match(render({ ...BASE, actionableByHorizon: { intraday: [actionable] } }, { heldTickers: ['GRML'] }), /HOLD \/ manage \(in your My Book\)/);
});

test('the empty governed-lane sentence is built from the blocker counts — paper governance ≠ no borrow', () => {
  const gate = { rejectionReasonCounts: { NOT_PRODUCTION: 12, NO_BORROW: 3, DATA_STALE: 2 }, rejectionReasonCountsNote: 'Every code is counted; a row can carry several.' };
  const html = render({ ...BASE, governanceGate: gate, researchByHorizon: { intraday: [SIG] } });
  assert.match(html, /rows blocked by: 12 not cleared for live trading \(paper \/ shadow governance\) · 3 no observed borrow \(shorts\) · 2 stale or incomplete data\./);
  assert.match(html, /Every code is counted; a row can carry several\./);
  assert.ok(!/every strategy is still at paper weight/.test(html), 'the universal explanation is gone');
  // Without counts the sentence stays honest and generic.
  assert.match(T.governedEmptyText(null), /nothing passed the fail-closed eligibility gate/);
  assert.match(T.governedEmptyText({ rejectionReasonCounts: { OK: 5 } }), /nothing passed/);
});

test('a lane prints its lane-local rank; the global rank appears only when labelled "overall"', () => {
  const html = render({ ...BASE, researchByHorizon: { intraday: [SIG] } });
  assert.match(html, /td-rank" title="Rank within this lane · #130 overall in the ranked cross-section">#1</);
  assert.ok(!/>#130</.test(html));
  const noLane = render({ ...BASE, researchByHorizon: { intraday: [{ ...SIG, laneRank: undefined }] } });
  assert.match(noLane, />#130 overall</);
});

test('the session / as-of line names the exchange session, the last completed session and the board\'s compute time with its zone', () => {
  const p = { ...BASE, session: { etDate: '2026-10-03', marketSession: 'closed', isTradingDay: false, isWeekend: true, lastCompletedSession: '2026-10-02' } };
  const html = render(p);
  assert.match(html, /td-session"[^>]*>🕒 <b>market closed<\/b> \(weekend\) · Sat, Oct 3, 2026 ET · last completed session Fri, Oct 2, 2026 · board computed 7:02 AM ET/);
  // Without the server block the line still carries the compute time (date + zone when not today).
  assert.match(T.sessionLine({ generatedAt: '2026-09-30T13:30:00Z' }, new Date('2026-10-03T15:00:00Z')), /board computed Sep 30, 2026, 9:30 AM ET/);
  assert.equal(T.sessionLine({}), '');
  assert.ok(!/\blive\b/.test(html));
});

test('a one-record 100% win rate is visibly insufficient and carries no win/loss colour', () => {
  const sig = { ...SIG, expectancy: { known: true, n: 1, winRate: 100, avgExcess: 5.2, horizonKey: '5d', ci: { lo: -3, hi: 13, level: 95, basis: 'date-clustered' } } };
  const html = render({ ...BASE, researchByHorizon: { intraday: [sig] } });
  assert.match(html, /td-track td-track-thin"/);
  assert.match(html, /100% win · \+5\.2% vs mkt · n=1 · insufficient sample \(&lt;10\)/);
  assert.ok(!/td-track td-pos/.test(html));
  assert.match(html, /95% confidence interval on the mean forward return \(date-clustered\)/);
  assert.ok(!/90% confidence/.test(html), 'the CI level is the server\'s, never a hardcoded 90%');
  const big = render({ ...BASE, researchByHorizon: { intraday: [{ ...sig, expectancy: { ...sig.expectancy, n: 40 } }] } });
  assert.match(big, /td-track td-pos/);
});

test('cards and lane chips are keyboard reachable', () => {
  const html = render({ ...BASE, researchByHorizon: { intraday: [SIG] }, lanes: { new: [SIG] } });
  assert.match(html, /class="td-card" data-go="[a-z]+" tabindex="0" role="link" aria-label="GRML — open the [a-z]+ tab"/);
  assert.match(html, /td-lane-tk" data-go="[a-z]+" tabindex="0" role="link"/);
});

test('data-trust panel: an unknown source timestamp is a neutral marker, never a green dot', () => {
  const html = render({ ...BASE, freshness: { sources: [
    { source: 'screener', label: 'Breakout', ok: true, timestampKnown: false, ageHours: null, stale: false, delayed: true, feed: ['Yahoo'] },
    { source: 'coil', label: 'Coil', ok: true, timestampKnown: true, ageHours: 40, stale: false, sessionDue: '2026-10-02', delayed: true, feed: ['Yahoo'] },
  ] } });
  assert.match(html, /⚪ <b>Breakout<\/b>/);
  assert.match(html, /age unknown — freshness not attested/);
  assert.match(html, /🟢 <b>Coil<\/b>.*40h old · session due 2026-10-02/);
});
