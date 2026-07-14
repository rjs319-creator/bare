'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const U = require('../lib/evolve-uniqueness');
const WF = require('../lib/evolve-walkforward');

const isoDay = (n) => new Date(2025, 0, 1 + n).toISOString().slice(0, 10);

test('non-overlapping labels each keep uniqueness weight ~1', () => {
  // Same ticker, swing (21td ≈ 30 cal days span), predictions 120 days apart → no overlap.
  const events = [0, 120, 240].map(d => ({ ticker: 'AAA', horizon: 'swing', predDate: isoDay(d), barsToBarrier: 21 }));
  const w = U.uniquenessWeights(events);
  for (const e of events) assert.ok(w.get(e) > 0.99, `weight ~1 (got ${w.get(e)})`);
});

test('fully concurrent labels split weight ~1/count', () => {
  // Three labels on the SAME day, same span → each is 1-of-3 concurrent throughout.
  const events = [0, 0, 0].map(() => ({ ticker: 'AAA', horizon: 'swing', predDate: isoDay(10), barsToBarrier: 21 }));
  const w = U.uniquenessWeights(events);
  for (const e of events) assert.ok(Math.abs(w.get(e) - 1 / 3) < 0.02, `~0.33 (got ${w.get(e)})`);
});

test('uniquenessSummary: overlap makes effectiveN < rawN; independence keeps ratio ~1', () => {
  const overlapping = Array.from({ length: 6 }, (_, i) => ({ ticker: 'AAA', horizon: 'position', predDate: isoDay(i * 3), barsToBarrier: 63 }));
  const s = U.uniquenessSummary(overlapping);
  assert.strictEqual(s.rawN, 6);
  assert.ok(s.effectiveN < 6 && s.uniquenessRatio < 1, `discounted (effN ${s.effectiveN}, ratio ${s.uniquenessRatio})`);

  const spread = Array.from({ length: 6 }, (_, i) => ({ ticker: 'AAA', horizon: 'position', predDate: isoDay(i * 200), barsToBarrier: 63 }));
  assert.ok(U.uniquenessSummary(spread).uniquenessRatio > 0.99, 'temporally isolated labels ≈ fully independent');
});

test('different tickers are independent series (no cross-ticker co-eventing)', () => {
  const events = [
    { ticker: 'AAA', horizon: 'position', predDate: isoDay(10), barsToBarrier: 63 },
    { ticker: 'BBB', horizon: 'position', predDate: isoDay(10), barsToBarrier: 63 },
  ];
  const w = U.uniquenessWeights(events);
  for (const e of events) assert.ok(w.get(e) > 0.99, 'same day, different tickers → each unique');
});

test('weighted fitPerf lowers effective sample vs unweighted on overlapping labels', () => {
  // A ticker firing one specialist on tightly-spaced position cohorts (heavy overlap).
  const events = Array.from({ length: 8 }, (_, i) => ({
    ticker: 'AAA', horizon: 'position', predDate: isoDay(i * 5), barsToBarrier: 63,
    contextKey: 'risk-on|large|position', specialists: ['S'], won: i % 2, terminalReturn: i % 2 ? 0.1 : -0.05,
  }));
  const plain = WF.fitPerf(events);
  const weighted = WF.fitPerf(events, { weighted: true });
  assert.strictEqual(plain.bySpecialist.S.global.n, 8, 'unweighted counts every label');
  assert.ok(weighted.bySpecialist.S.global.n < 8, `weighted effective n < 8 (got ${weighted.bySpecialist.S.global.n})`);
  assert.ok(weighted.bySpecialist.S.global.n > 0, 'still positive');
});
