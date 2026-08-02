'use strict';
// Required-benchmark wiring (research-harness-v2): every runExperiment must report the
// no-information control and the 12-1 momentum swing benchmark on the same folds, and the
// mom121 feature must be PIT-correct (skip-month, no proxy when history is short).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/research/harness');
const B = require('../lib/research/baseline-ranker');
const { computeFeatureVector, FEATURE_KEYS } = require('../lib/research/features');

test('mom121 is declared and computed as skip-month 12-1 momentum', () => {
  assert.ok(FEATURE_KEYS.includes('mom121'));
  const candles = [];
  const d0 = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 300; i++) {
    candles.push({ date: new Date(d0 + i * 86400000).toISOString().slice(0, 10), open: 10, high: 10, low: 10, close: 10, volume: 1000 });
  }
  const idx = 290;
  candles[idx - 252].close = 8;                       // 12m-ago close
  candles[idx - 21].close = 12;                       // skip-month close
  candles[idx].close = 100;                           // current close must NOT enter mom121
  const fv = computeFeatureVector(candles, idx);
  assert.ok(Math.abs(fv.values.mom121 - (12 / 8 - 1)) < 1e-12, 'mom121 = close[t-21]/close[t-252]-1');
});

test('mom121 is null (never proxied) without a year of history', () => {
  const candles = [];
  const d0 = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 120; i++) {
    candles.push({ date: new Date(d0 + i * 86400000).toISOString().slice(0, 10), open: 10, high: 10, low: 10, close: 10, volume: 1000 });
  }
  const fv = computeFeatureVector(candles, 110);
  assert.equal(fv.values.mom121, null);
  assert.ok(fv.missing.includes('mom121'));
});

// Synthetic event rows across enough distinct dates for a 3-fold comparison.
function syntheticEvents() {
  const rows = [];
  const d0 = Date.UTC(2024, 0, 1);
  for (let di = 0; di < 12; di++) {
    const date = new Date(d0 + di * 7 * 86400000).toISOString().slice(0, 10);
    for (let s = 0; s < 6; s++) {
      const mom = s / 10;
      rows.push({
        securityId: `SYM${s}`, ticker: `SYM${s}`, decisionTs: date, labelEndDate: date,
        horizon: 'swing', score: s, outcome: mom + (di % 2 ? 0.01 : -0.01) * s,
        features: { mom121: mom, ret21: mom / 2 },
      });
    }
  }
  return rows;
}

test('runExperiment auto-appends control-random and momentum-12-1', () => {
  const out = H.runExperiment(syntheticEvents(), [B.productionCompositeRanker], { folds: 3, embargo: 0 });
  const names = Object.keys(out.result.perRanker);
  assert.ok(names.includes('momentum-12-1'), 'benchmark appended');
  assert.ok(names.includes('control-random'), 'control appended');
  assert.ok(names.includes('production-composite'), 'caller ranker kept');
  assert.ok(out.vsMomentumBenchmark, 'benchmark comparison reported');
  assert.ok('benchmarkMeanIC' in out.vsMomentumBenchmark);
  // Benchmarks are yardsticks, not trials: attempted-count still counts the caller's list.
  assert.equal(out.manifest.relatedExperimentsAttempted, 1);
});

test('runExperiment does not duplicate an explicitly passed benchmark', () => {
  const out = H.runExperiment(syntheticEvents(), [B.momentum121Ranker, B.randomRanker], { folds: 3, embargo: 0 });
  const names = Object.keys(out.result.perRanker);
  assert.equal(names.filter((n) => n === 'momentum-12-1').length, 1);
  assert.equal(names.filter((n) => n === 'control-random').length, 1);
});

test('opts.requireBenchmarks=false opts out (tests only)', () => {
  const out = H.runExperiment(syntheticEvents(), [B.productionCompositeRanker], { folds: 3, embargo: 0, requireBenchmarks: false });
  assert.ok(!Object.keys(out.result.perRanker).includes('momentum-12-1'));
  assert.equal(out.vsMomentumBenchmark, null);
});
