'use strict';
// EXPECTATION-GAP tests. The invariants that matter:
//   1. REDUCE-ONLY, structurally: no RISK_ADD state exists, recommendedMaxExposure
//      is never above 1 and never below the floor — this challenger cannot
//      amplify exposure under ANY input.
//   2. Complacency detection: objectively bad credit + calm implied vol → a large
//      positive gap → RISK_REDUCE; a calm consistent world → NEUTRAL, exposure 1.
//   3. Fail closed: missing core inputs → INSUFFICIENT_DATA with exposure 1
//      (untouched), never a guessed reduction.
//   4. transitionProbability is null-with-reason — no hand-mapped probability.
//   5. PIT: bars after asOf never change the read; identical inputs → identical output.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const EG = require('../lib/expectation-gap');

function tradingDates(n) {
  const out = [];
  const d = new Date('2025-06-02T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// A candle series with controllable drift and noise; optional tail modifier for
// the last `tailDays` sessions (e.g. credit cracking while VIX stays asleep).
function series(dts, { level = 100, drift = 0, noise = 0.004, seed = 1, tailDays = 0, tailDrift = 0 } = {}) {
  const rnd = lcg(seed);
  let px = level;
  return dts.map((date, i) => {
    const inTail = i >= dts.length - tailDays;
    px *= 1 + (inTail ? tailDrift : drift) + (rnd() - 0.5) * noise;
    return { date, close: +px.toFixed(4) };
  });
}
const flatLine = (dts, level) => dts.map(date => ({ date, close: level }));

const N = 300;
const DTS = tradingDates(N);
const ASOF = DTS[N - 1];

// Calm consistent world: stable credit, low quiet VIX, drifting-up SPY and sectors.
function calmWorld() {
  const sectors = {};
  ['XLK', 'XLC', 'XLY', 'XLP', 'XLV', 'XLF', 'XLI', 'XLE'].forEach((etf, i) => {
    sectors[etf] = series(DTS, { level: 80, drift: 0.0006, seed: 40 + i });
  });
  return {
    spyBars: series(DTS, { level: 500, drift: 0.0005, seed: 11 }),
    vixBars: series(DTS, { level: 14, noise: 0.01, seed: 12 }),
    hygBars: series(DTS, { level: 80, drift: 0.0001, seed: 13 }),
    lqdBars: series(DTS, { level: 110, drift: 0.0001, seed: 14 }),
    sectorBarsByEtf: sectors, asOf: ASOF,
  };
}

// Complacent world: HYG cracks hard over the last month and breadth rolls over,
// while VIX stays asleep at its lows and SPY sits near its highs.
function complacentWorld() {
  const w = calmWorld();
  w.hygBars = series(DTS, { level: 80, drift: 0.0001, seed: 13, tailDays: 21, tailDrift: -0.004 });
  const weakSectors = {};
  Object.keys(w.sectorBarsByEtf).forEach((etf, i) => {
    weakSectors[etf] = series(DTS, { level: 80, drift: 0.0006, seed: 40 + i, tailDays: 40, tailDrift: -0.003 });
  });
  w.sectorBarsByEtf = weakSectors;
  return w;
}

test('reduce-only is structural: no RISK_ADD state, exposure bounded [floor, 1]', () => {
  assert.ok(!EG.STATES.includes('RISK_ADD'));
  for (const world of [calmWorld(), complacentWorld()]) {
    const r = EG.computeExpectationGap(world);
    assert.ok(r.recommendedMaxExposure <= 1);
    assert.ok(r.recommendedMaxExposure >= EG.POLICY.floorExposure);
    assert.equal(r.reduceOnly, true);
  }
});

test('complacency (credit cracking + sleeping VIX + rolling breadth) → RISK_REDUCE', () => {
  const r = EG.computeExpectationGap(complacentWorld());
  assert.equal(r.state, 'RISK_REDUCE', `expected RISK_REDUCE, got ${r.state} (gap ${r.expectationGap})`);
  assert.ok(r.expectationGap >= EG.POLICY.gapReduceThreshold);
  assert.ok(r.recommendedMaxExposure < 1);
  assert.ok(r.reasons.some(x => /complacency/.test(x)));
});

test('a calm consistent world → NEUTRAL with exposure untouched', () => {
  const r = EG.computeExpectationGap(calmWorld());
  assert.equal(r.state, 'NEUTRAL');
  assert.equal(r.recommendedMaxExposure, 1);
});

test('fail closed: missing core inputs → INSUFFICIENT_DATA, exposure untouched', () => {
  const r = EG.computeExpectationGap({ spyBars: [], vixBars: [], hygBars: [], lqdBars: [], asOf: ASOF });
  assert.equal(r.state, 'INSUFFICIENT_DATA');
  assert.equal(r.recommendedMaxExposure, 1);
  assert.ok(r.missing.length >= 3);
});

test('transitionProbability is null-with-reason — never hand-mapped', () => {
  const r = EG.computeExpectationGap(complacentWorld());
  assert.equal(r.transitionProbability, null);
  assert.match(r.transitionProbabilityReason, /uncalibrated/);
});

test('PIT: bars after asOf never change the read; determinism holds', () => {
  const w = complacentWorld();
  const base = EG.computeExpectationGap(w);
  const futureDts = tradingDates(N + 20).slice(N);
  const distort = bars => bars.concat(futureDts.map(date => ({ date, close: 1 })));
  const distorted = EG.computeExpectationGap({
    ...w,
    spyBars: distort(w.spyBars), vixBars: distort(w.vixBars),
    hygBars: distort(w.hygBars), lqdBars: distort(w.lqdBars),
  });
  assert.equal(JSON.stringify(base), JSON.stringify(distorted));
  assert.equal(JSON.stringify(base), JSON.stringify(EG.computeExpectationGap(complacentWorld())));
});

test('breadth stays null (disclosed) below the minimum ETF count — never guessed', () => {
  const w = complacentWorld();
  w.sectorBarsByEtf = { XLK: w.sectorBarsByEtf.XLK };
  const r = EG.computeExpectationGap(w);
  assert.equal(r.expectedCondition.breadth, null);
  assert.ok(r.uncertainty > 0);
});
