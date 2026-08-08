'use strict';
// Market Pulse v2 — HORIZON-SPECIFIC APPENDABLE OUTCOMES.
// Required behaviors #22-#30: per-horizon outcomes append only when mature; a missing
// 5-session outcome is never relabeled from another horizon; trading-session maturity
// differs from calendar-day age; same-day correlated events do not inflate the sample;
// sector-relative outcomes use the sector benchmark; multi-ticker themes grade per
// ticker; zero pre/post moves are not awareness success; price-only vs price-plus-Pulse
// uses identical base events; no probability below the sample floor.

const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/pulse2-grade');

// Synthetic session calendar: weekdays only (weekend gap between 06-05 and 06-08).
const DATES = ['2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09', '2026-06-10',
  '2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18',
  '2026-06-19', '2026-06-22', '2026-06-23', '2026-06-24'];
const mkRows = (n, base = 100, step = 1) => DATES.slice(0, n).map((date, i) => ({
  date, open: base + i * step, close: base + i * step + 0.5, high: base + i * step + 1, low: base + i * step - 1,
}));
const EVENT = {
  id: 'ev_test', firstSeenDate: '2026-06-05', firstSeenDirection: 'BULLISH',
  family: 'guidance', firstSeenEvidence: 'VERIFIED', thesisVersion: 1,
  firstSeenFeatures: { AAA: { ret3: 1.0 } },
};

test('#22: horizons append ONLY when matured in trading sessions', () => {
  const rows = mkRows(8);   // decision 06-05 → 6 bars after it
  const { outcome, appended } = G.gradeEventTicker({ event: EVENT, ticker: 'AAA', rows });
  assert.ok(appended.includes(1) && appended.includes(3) && appended.includes(5));
  assert.ok(!appended.includes(10) && !appended.includes(21) && !appended.includes(63));
  assert.equal(outcome.fullyMatured, false);
  assert.equal(outcome.horizons[10], undefined);   // stays missing, not faked
});

test('#23: a missing 5-session outcome is NEVER served from the 1- or 3-session number', () => {
  const rows = mkRows(4);   // only 2 sessions after decision → h=1 only
  const { outcome, appended } = G.gradeEventTicker({ event: EVENT, ticker: 'AAA', rows });
  assert.deepEqual(appended, [1]);
  assert.equal(outcome.horizons[5], undefined);
  // The 5-session aggregate sees NO rows from this outcome.
  const summary = G.summarizeOutcomes([outcome], { horizon: 5 });
  assert.equal(summary.rawEventCount, 0);
});

test('#24: trading-session maturity ≠ calendar-day age (weekend does not mature an outcome)', () => {
  // Decision Friday 06-05. Monday 06-08 is 3 CALENDAR days later but session 1.
  const rows = mkRows(4);   // 06-04, 06-05, 06-08, 06-09 → 2 sessions after decision
  const { appended } = G.gradeEventTicker({ event: EVENT, ticker: 'AAA', rows });
  assert.deepEqual(appended, [1]);   // a calendar-day counter would have claimed h=3 matured
});

test('appended horizons are immutable — re-grading never overwrites an existing record', () => {
  const rows8 = mkRows(8);
  const first = G.gradeEventTicker({ event: EVENT, ticker: 'AAA', rows: rows8 }).outcome;
  const marker = { ...first.horizons[1], ret: -999 };   // tamper to prove preservation
  const existing = { ...first, horizons: { ...first.horizons, 1: marker } };
  const again = G.gradeEventTicker({ event: EVENT, ticker: 'AAA', rows: mkRows(15), existing });
  assert.equal(again.outcome.horizons[1].ret, -999);        // untouched
  assert.ok(again.appended.includes(10));                   // later horizon appended
  assert.ok(!again.appended.includes(1));
});

test('#26: sector-relative outcomes carry the sector benchmark used', () => {
  const rows = mkRows(8);
  const spyRows = mkRows(8, 500, 0.5);
  const sectorRows = mkRows(8, 200, 2);
  const { outcome } = G.gradeEventTicker({ event: EVENT, ticker: 'AAA', rows, spyRows, sectorRows, sectorBenchmark: 'XLK' });
  assert.ok(Number.isFinite(outcome.horizons[5].sectorExcess));
  assert.equal(outcome.horizons[5].sectorBenchmark, 'XLK');
  assert.ok(Number.isFinite(outcome.horizons[5].spyExcess));
});

test('#27: multi-ticker themes grade each ticker separately under the shared event id', () => {
  const ev = { ...EVENT, tickers: ['AAA', 'BBB'] };
  const a = G.gradeEventTicker({ event: ev, ticker: 'AAA', rows: mkRows(8) }).outcome;
  const b = G.gradeEventTicker({ event: ev, ticker: 'BBB', rows: mkRows(8, 50, -1) }).outcome;
  assert.equal(a.eventId, b.eventId);
  assert.notEqual(a.ticker, b.ticker);
  assert.notEqual(a.horizons[5].ret, b.horizons[5].ret);
});

test('#28: zero pre-move + zero post-move is NOT early-detection success', () => {
  const flat = DATES.slice(0, 8).map(date => ({ date, open: 100, close: 100, high: 100.2, low: 99.8 }));
  const ev = { ...EVENT, firstSeenFeatures: { AAA: { ret3: 0 } } };
  const { outcome } = G.gradeEventTicker({ event: ev, ticker: 'AAA', rows: flat });
  assert.equal(outcome.awareness.detectedAhead, false);   // v1 said 0 ≥ 0 ⇒ true — the defect
  assert.equal(outcome.awareness.materialConsequence, false);
});

test('awareness succeeds only with a material post-detection move exceeding the pre-move', () => {
  const rows = mkRows(8, 100, 2);   // strong post-detection drift
  const { outcome } = G.gradeEventTicker({ event: EVENT, ticker: 'AAA', rows });
  assert.equal(outcome.awareness.detectedAhead, true);
  assert.ok(outcome.awareness.postMove >= G.AWARENESS_MIN_POST_PCT);
});

test('#25: same-day correlated events do not inflate the effective sample', () => {
  const rows = mkRows(8);
  const outcomes = [];
  for (let i = 0; i < 30; i++) {
    const o = G.gradeEventTicker({ event: { ...EVENT, id: 'ev_' + i }, ticker: 'AAA', rows }).outcome;
    outcomes.push(o);   // 30 events, ONE decision date
  }
  const s = G.summarizeOutcomes(outcomes, { minSample: 20 });
  assert.equal(s.rawEventCount, 30);
  assert.equal(s.distinctDecisionDates, 1);
  assert.ok(s.effectiveSampleSize <= 3, 'one correlated day cannot count as 30 independent samples');
  assert.equal(s.directional.probability, null);   // suppressed
});

test('#30: no probability below the sample-and-independence floor', () => {
  const rows = mkRows(8);
  const o = G.gradeEventTicker({ event: EVENT, ticker: 'AAA', rows }).outcome;
  const s = G.summarizeOutcomes([o]);
  assert.equal(s.directional.probability, null);
  assert.equal(s.awareness.probability, null);
  assert.equal(s.directionalValueProven, false);
});

test('#29: setup-only vs setup-plus-Pulse compares IDENTICAL base events', () => {
  const rows = mkRows(8);
  const outcomes = [];
  for (let i = 0; i < 10; i++) {
    const o = G.gradeEventTicker({
      event: { ...EVENT, id: 'ev_' + i, firstSeenEvidence: i % 2 ? 'VERIFIED' : 'UNVERIFIED' },
      ticker: 'AAA', rows,
    }).outcome;
    o.setupValidAtDecision = true;
    outcomes.push(o);
  }
  const cmp = G.compareSetupVsSetupPlusPulse(outcomes, { horizon: 5, minSample: 20 });
  assert.equal(cmp.identicalBaseEvents, true);
  assert.equal(cmp.baseCohort.n, 10);
  assert.equal(cmp.pulseCohort.n, 5);          // strict subset — same base events
  assert.equal(cmp.verdict, 'INSUFFICIENT_SAMPLE');   // 1 decision date can never prove value
});

test('entry basis: next-session open strictly after the decision date (no lookahead)', () => {
  const rows = mkRows(8);
  const idx = G.entryIndex(rows, '2026-06-05');
  assert.equal(rows[idx].date, '2026-06-08');   // the Monday, never the decision Friday
});
