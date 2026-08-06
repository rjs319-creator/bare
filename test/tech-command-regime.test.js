'use strict';
// Technology regime header: deterministic arithmetic, explicit missing-data flags,
// and a novice line that never contradicts the measurements.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const REG = require('../lib/tech-command-regime');

// Build a synthetic daily series with a fixed compound drift.
function series(n, start, dailyPct) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    out.push({ date: d, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 });
    p *= 1 + dailyPct;
  }
  return out;
}

const benchmarksLeading = {
  SPY: series(300, 100, 0.0002),
  QQQ: series(300, 100, 0.0008),
  XLK: series(300, 100, 0.0010),
  RSPT: series(300, 100, 0.0002),   // equal-weight lagging cap-weight ⇒ mega-cap-led
  SMH: series(300, 100, 0.0016),
  IGV: series(300, 100, 0.0003),
  SKYY: series(300, 100, 0.0005),
  CIBR: series(300, 100, 0.0004),
  TLT: series(300, 100, -0.0002),
};

test('regime classifies leadership, concentration and volatility deterministically', () => {
  const r = REG.buildRegime({ benchmarks: benchmarksLeading, members: {}, now: new Date('2026-08-05T12:00:00Z') });
  assert.equal(r.schema, REG.REGIME_VERSION);
  assert.equal(r.states.leadership, 'leading');
  assert.equal(r.states.concentration, 'mega-cap-led');
  assert.ok(r.measures.techVsSpy21 > 0);
  // Same inputs, same output — no clock or randomness inside the computation.
  const r2 = REG.buildRegime({ benchmarks: benchmarksLeading, members: {}, now: new Date('2026-08-05T12:00:00Z') });
  assert.equal(r2.classification, r.classification);
});

test('semiconductor leadership ranks above software when the ETFs say so', () => {
  const r = REG.buildRegime({ benchmarks: benchmarksLeading, members: {} });
  assert.equal(r.measures.leadership[0].group, 'semiconductors');
  assert.ok(r.measures.leadership[0].excessVsQqq21 > r.measures.leadership.at(-1).excessVsQqq21);
});

test('missing benchmarks are named, never defaulted to zero', () => {
  const r = REG.buildRegime({ benchmarks: { SPY: benchmarksLeading.SPY }, members: {} });
  assert.equal(r.states.leadership, 'unknown');
  assert.equal(r.measures.techVsSpy21, null);
  assert.ok(r.missing.some(m => m.startsWith('QQQ')));
  assert.ok(r.missing.some(m => m.startsWith('XLK')));
});

test('breadth is WITHHELD below the minimum sample rather than estimated', () => {
  const members = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`T${i}`, series(300, 50, 0.001)]));
  const r = REG.buildRegime({ benchmarks: benchmarksLeading, members });
  assert.equal(r.measures.pctAbove50dma, null);
  assert.equal(r.states.participation, 'unknown');
  assert.ok(r.missing.some(m => m.startsWith('breadth')));
});

test('breadth computes once the sample clears the floor', () => {
  const members = Object.fromEntries(Array.from({ length: REG.MIN_BREADTH_SAMPLE + 5 }, (_, i) =>
    [`T${i}`, series(300, 50, i % 2 === 0 ? 0.001 : -0.001)]));
  const r = REG.buildRegime({ benchmarks: benchmarksLeading, members });
  assert.ok(r.coverage.breadthSufficient);
  assert.ok(r.measures.pctAbove50dma != null);
  assert.ok(r.measures.advancing != null && r.measures.declining != null);
  assert.ok(r.measures.averagePairwiseCorrelation != null);
});

test('intraday VWAP participation is declared unavailable, never approximated', () => {
  const r = REG.buildRegime({ benchmarks: benchmarksLeading, members: {} });
  assert.equal(r.measures.intradayVwapParticipation, null);
  assert.ok(r.missing.some(m => /intraday VWAP participation/.test(m)));
});

test('the novice line reflects the measured state and warns when nothing is known', () => {
  const r = REG.buildRegime({ benchmarks: benchmarksLeading, members: {} });
  assert.match(r.novice, /Technology is leading/);
  const blind = REG.buildRegime({ benchmarks: {}, members: {} });
  assert.match(blind.novice, /Not enough current data/);
});

test('the regime record never claims to be a forecast', () => {
  const r = REG.buildRegime({ benchmarks: benchmarksLeading, members: {} });
  assert.match(r.note, /Not a forecast/i);
  assert.ok(!('probability' in r.measures));
});
