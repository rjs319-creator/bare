'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SUP = require('../lib/swing-supervisor');
const { isMarketHoliday } = require('../lib/stats');

const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });
const flat = (dates, v) => dates.map(d => bar(d, v, v, v, v));
const DATES = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];

// ABC: filled 7/21 @10.5, drifts up, no barrier by 7/24 (stop 9.5, target 12).
const abcCandles = [
  bar('2026-07-20', 10, 10.1, 9.9, 10),
  bar('2026-07-21', 10.2, 10.6, 10.1, 10.5),
  bar('2026-07-22', 10.5, 10.9, 10.4, 10.7),
  bar('2026-07-23', 10.7, 11.0, 10.5, 10.8),
  bar('2026-07-24', 10.8, 11.1, 10.6, 10.9),
];
const spy = flat(DATES, 100);

const abcSignal = {
  ticker: 'ABC', side: 'long', horizon: 'swing', source: 'screener', sources: ['screener'],
  strategyFamily: 'priceTrend', score: 72, rank: 5, tier: 'A', setup: 'breakout',
  price: 10, entry: 10.5, stop: 9.5, target: 12, holdingWindow: 10, note: 'Base breakout on volume',
};

function ctxFor(date) {
  return { date, generatedAt: `${date}T21:00:00Z`, regime: 'neutral', isHoliday: isMarketHoliday, cooldownSessions: 3 };
}

test('a NEW signal creates a durable episode with an immutable origin', () => {
  const r = SUP.buildSupervisor({ prevEpisodes: [], signals: [abcSignal], priceBundle: { map: { ABC: [abcCandles[0]] }, bench: { SPY: [spy[0]] } }, ctx: ctxFor('2026-07-20') });
  assert.equal(r.episodes.length, 1);
  const ep = r.episodes[0];
  assert.equal(ep.origin.ticker, 'ABC');
  assert.equal(ep.origin.originalStop, 9.5);
  assert.equal(r.counts.newCandidates, 1);   // opened this session
});

test('THE REGRESSION: a pick absent from every current source still appears, with a reason (tests #1, #2)', () => {
  // Day 1: published.
  const d1 = SUP.buildSupervisor({ prevEpisodes: [], signals: [abcSignal], priceBundle: { map: { ABC: [abcCandles[0]] }, bench: { SPY: [spy[0]] } }, ctx: ctxFor('2026-07-20') });
  // Day 5: NO source emits ABC anymore (signals empty) — but it still trades.
  const d5 = SUP.buildSupervisor({ prevEpisodes: d1.episodes, signals: [], priceBundle: { map: { ABC: abcCandles }, bench: { SPY: spy } }, ctx: ctxFor('2026-07-24') });
  // The pick did NOT vanish.
  assert.equal(d5.episodes.length, 1);
  const ep = d5.episodes[0];
  // It has an explicit, non-terminal state + a human explanation + a reason code — never blank.
  assert.equal(ep.assessment.lifecycleState, 'VALID_BUT_DISPLACED');
  assert.ok(ep.assessment.reasonCodes.includes('SOURCE_DROPPED'));
  assert.ok(/Source no longer selects/.test(ep.assessment.explanation));
  assert.equal(ep.assessment.sourceStillSelects, false);
  // And it is placed in a visible section (Needs Attention), not dropped.
  assert.equal(d5.counts.needsAttention, 1);
});

test('a dropped pick keeps being graded — a later target hit is still captured (test #24)', () => {
  const d1 = SUP.buildSupervisor({ prevEpisodes: [], signals: [abcSignal], priceBundle: { map: { ABC: [abcCandles[0]] }, bench: { SPY: [spy[0]] } }, ctx: ctxFor('2026-07-20') });
  // ABC dropped from sources, then rips to the target after being retired.
  const rip = [...abcCandles, bar('2026-07-27', 11.0, 12.3, 10.9, 12.1)];
  const d = SUP.buildSupervisor({ prevEpisodes: d1.episodes, signals: [], priceBundle: { map: { ABC: rip }, bench: { SPY: flat([...DATES, '2026-07-27'], 100) } }, ctx: ctxFor('2026-07-27') });
  const ep = d.episodes[0];
  assert.equal(ep.assessment.lifecycleState, 'TARGET_HIT');
  assert.equal(ep.terminal, true);
  assert.equal(d.graded.length, 1);
  assert.equal(d.counts.completed, 1);
});

test('idempotent per session — re-running on the same date appends no new transition (test #11 supervisor)', () => {
  const d1 = SUP.buildSupervisor({ prevEpisodes: [], signals: [abcSignal], priceBundle: { map: { ABC: [abcCandles[0]] }, bench: { SPY: [spy[0]] } }, ctx: ctxFor('2026-07-20') });
  const d5a = SUP.buildSupervisor({ prevEpisodes: d1.episodes, signals: [], priceBundle: { map: { ABC: abcCandles }, bench: { SPY: spy } }, ctx: ctxFor('2026-07-24') });
  const d5b = SUP.buildSupervisor({ prevEpisodes: d5a.episodes, signals: [], priceBundle: { map: { ABC: abcCandles }, bench: { SPY: spy } }, ctx: ctxFor('2026-07-24') });
  assert.equal(d5a.transitions.length, 1);          // NEW→VALID_BUT_DISPLACED once
  assert.equal(d5b.transitions.length, 0);          // second run on the same state = no churn
  assert.equal(d5b.episodes[0].transitions.length, d5a.episodes[0].transitions.length);
});

test('a base-source change does not create a new episode (test #14 end-to-end)', () => {
  const d1 = SUP.buildSupervisor({ prevEpisodes: [], signals: [abcSignal], priceBundle: { map: { ABC: [abcCandles[0]] }, bench: { SPY: [spy[0]] } }, ctx: ctxFor('2026-07-20') });
  // Same slot, but now COIL is the base source instead of the screener.
  const coilSig = { ...abcSignal, source: 'coil', sources: ['coil'] };
  const d2 = SUP.buildSupervisor({ prevEpisodes: d1.episodes, signals: [coilSig], priceBundle: { map: { ABC: abcCandles.slice(0, 3) }, bench: { SPY: spy.slice(0, 3) } }, ctx: ctxFor('2026-07-22') });
  assert.equal(d2.episodes.length, 1);                          // still ONE episode
  assert.equal(d2.episodes[0].origin.episodeId, d1.episodes[0].origin.episodeId);   // same identity
});

test('a stop breach on a dropped pick is INVALIDATED (No Longer Actionable), never a silent disappearance (test #5 e2e)', () => {
  const d1 = SUP.buildSupervisor({ prevEpisodes: [], signals: [abcSignal], priceBundle: { map: { ABC: [abcCandles[0]] }, bench: { SPY: [spy[0]] } }, ctx: ctxFor('2026-07-20') });
  const broke = [abcCandles[0], abcCandles[1], bar('2026-07-22', 10.4, 10.5, 9.3, 9.4)];  // low 9.3 ≤ stop 9.5
  const d = SUP.buildSupervisor({ prevEpisodes: d1.episodes, signals: [], priceBundle: { map: { ABC: broke }, bench: { SPY: spy.slice(0, 3) } }, ctx: ctxFor('2026-07-22') });
  const ep = d.episodes[0];
  assert.equal(ep.assessment.lifecycleState, 'INVALIDATED');
  assert.equal(ep.assessment.outcomeState, 'LOSS');
  assert.equal(d.counts.noLongerActionable, 1);
});

test('union covers both current candidates and prior open episodes together', () => {
  const d1 = SUP.buildSupervisor({ prevEpisodes: [], signals: [abcSignal], priceBundle: { map: { ABC: [abcCandles[0]] }, bench: { SPY: [spy[0]] } }, ctx: ctxFor('2026-07-20') });
  const newSig = { ...abcSignal, ticker: 'XYZ', source: 'ghost', sources: ['ghost'] };
  const d2 = SUP.buildSupervisor({
    prevEpisodes: d1.episodes, signals: [newSig],
    priceBundle: { map: { ABC: abcCandles, XYZ: [bar('2026-07-24', 10, 10.1, 9.9, 10)] }, bench: { SPY: spy } },
    ctx: ctxFor('2026-07-24'),
  });
  const tickers = d2.episodes.map(e => e.origin.ticker).sort();
  assert.deepEqual(tickers, ['ABC', 'XYZ']);   // carried-forward ABC ∪ new XYZ
});
