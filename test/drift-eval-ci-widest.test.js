'use strict';
// REVIEW 2026-08-15: the drift-eval precision fix (avgExact/seExact) computed ci95Pct
// purely from the exact Student-t interval — DROPPING the widest-of(t, moving-block
// bootstrap) conservatism that evidence-stats' summary carries (and that the parallel
// challenger-eval fix kept). A heavy-tailed series whose bootstrap interval is wider could
// then claim a tighter CI than the widest-of rule allows. clusteredStats must widen the
// exact t-interval PER SIDE against the same seeded moving-block bootstrap, recomputed at
// full precision (the summary's s.ci95 is display-rounded to 2dp — whole-percent
// quantization for a fractional-units drift series, so it cannot be the widening source).
//
// evidence-stats is stubbed through require.cache (drift-eval requires it lazily inside
// clusteredStats) so the bootstrap interval can be pinned wider than the t-interval —
// something the real HAC-floored summary rarely produces on constructible fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const esId = require.resolve('../lib/evidence-stats');
const stub = {
  // What the next summarizeDateSeries / movingBlockCI95 calls return (set per test).
  summary: null,
  boot: null,
  bootCalls: [],
};
require.cache[esId] = {
  id: esId, filename: esId, loaded: true,
  exports: {
    dedupeToDateSeries: (rows, { pickValue, pickDate }) => ({
      series: rows.map(r => pickValue(r)),
      dates: rows.map(r => pickDate(r)),
    }),
    summarizeDateSeries: () => stub.summary,
    movingBlockCI95: (vals, opts) => { stub.bootCalls.push({ vals, opts }); return stub.boot; },
  },
};
const { clusteredStats } = require('../lib/drift-eval');

// 40 fractional-units rows; the stubbed summary controls the statistics.
const rows = Array.from({ length: 40 }, (_, i) => ({
  date: `2026-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, '0')}`,
  v: 0.004,
}));

// avgExact 0.004, seExact 2e-4, tCritical 2 → exact t-interval [0.0036, 0.0044] = [0.36%, 0.44%].
const baseSummary = { n: 40, effectiveN: 40, avgExact: 0.004, seExact: 0.0002, tCritical: 2 };

test('a bootstrap interval wider on BOTH sides widens ci95Pct per side (widest-of conservatism)', () => {
  // Arrange
  stub.summary = { ...baseSummary };
  stub.boot = { lo: 0.001, hi: 0.009 };
  stub.bootCalls = [];
  // Act
  const s = clusteredStats(rows, 5);
  // Assert — both bounds take the wider bootstrap value; tStat stays exact-field-based.
  assert.deepEqual(s.ci95Pct, { lo: 0.1, hi: 0.9 });
  assert.equal(s.tStat, 20, 'tStat must remain avgExact/seExact, untouched by the widening');
  // Bootstrap parity with summarizeDateSeries: same block length (max(2, horizonBars)).
  assert.equal(stub.bootCalls.length, 1);
  assert.equal(stub.bootCalls[0].opts.blockLen, 5);
});

test('a bootstrap wider on ONE side widens only that side (per-side, not symmetric)', () => {
  stub.summary = { ...baseSummary };
  stub.boot = { lo: 0.0038, hi: 0.009 };   // lo NARROWER than t, hi wider
  const s = clusteredStats(rows, 5);
  assert.deepEqual(s.ci95Pct, { lo: 0.36, hi: 0.9 },
    'lo keeps the wider t bound; hi takes the wider bootstrap bound');
});

test('a bootstrap NARROWER than the t-interval never tightens ci95Pct', () => {
  stub.summary = { ...baseSummary };
  stub.boot = { lo: 0.0038, hi: 0.0042 };
  const s = clusteredStats(rows, 5);
  assert.deepEqual(s.ci95Pct, { lo: 0.36, hi: 0.44 });
});

test('an unavailable bootstrap (null — series too short) falls back to the exact t-interval', () => {
  stub.summary = { ...baseSummary };
  stub.boot = null;
  const s = clusteredStats(rows, 5);
  assert.deepEqual(s.ci95Pct, { lo: 0.36, hi: 0.44 });
  assert.equal(s.tStat, 20);
});
