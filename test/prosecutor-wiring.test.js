'use strict';
// F-11 (second half): THE PROSECUTOR BATTERY EXISTED AND NOTHING RAN IT.
//
// lib/cfl/prosecutor.js composes the repo's adversarial controls — label
// shuffle, future-feature leak, random ranker, doubled costs, drop-best-year,
// best-trade excision, concentration — into `prosecuteClaim`, whose whole
// purpose is to challenge a claimed edge before it is believed. It had unit
// tests and ZERO production callers. Every strategy in the registry reached its
// grade without one adversarial question being asked of it.
//
// The artifact half of F-11 (promotion artifacts REQUIRE a negativeControls
// block, fail closed) shipped earlier. This is the review half: strategies at
// Promising or better are now prosecuted as part of grading, and the verdict
// rides on the payload.
//
// WHAT BLOCKS, AND WHY THAT LINE:
//   • REJECTED           — a leak/placebo test FAILED. The claim is invalid, not
//                          merely weak. Blocks Validated.
//   • a check that RAN and failed (excision / concentration) — blocks Validated.
//   • a check that could NOT run (no samples, too few trades) — recorded as
//     `unrun`, does NOT block.
//
// That last line is a deliberate judgement, not an oversight. `prosecuteClaim`
// marks unrun checks `ok: null` and folds them into a RESEARCH verdict, so
// requiring a full SURVIVES would permanently block EVERY strategy from
// Validated until a feature-sample channel is wired — a policy change nobody
// asked for. Unrun is therefore surfaced loudly instead of being silently
// counted as a pass. Tightening it is a one-line change for the owner.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/maturity');
const { dateLevelNetExcess } = require('../lib/apex-routes');

// Per-date portfolio nets are the right granularity: the repo's own doctrine is
// that a same-day cluster is ONE observation, so "does the edge die without its
// best few DATES" is the honest excision question.
const HEALTHY = Array.from({ length: 30 }, (_, i) => 0.6 + (i % 5) * 0.25);
// One enormous date carrying everything, the rest bleeding — concentration, not edge.
const CONCENTRATED = [...Array.from({ length: 29 }, () => -0.15), 40];

const dn = (values) => ({
  n: 30, avg: 1.2, sd: 2.0, ci95: { lo: 0.4, hi: 2.0 }, effectiveN: 22,
  positiveBlocks: 4, blockStability: { blocks: 4, positive: 4, means: [1.1, 1.3, 1.0, 1.4], usable: true },
  values,
});
const track = (values) => ({
  excessN: 60, avgExcess: 2.6, beatMktRate: 38,
  netExcessN: 60, avgNetExcess: 2.4, netBeatMktRate: 36,
  secExcN: 60, avgSecExcess: 1.8, beatSecRate: 40,
  dates: 30, dateNet: dn(values),
});
const PASSING = { fillVerified: true, noHistoryRate: 0 };

// ── the battery actually runs ──────────────────────────────────────────────
test('a graded record is prosecuted and the verdict rides on the payload', () => {
  const g = M.gradeTrack(track(HEALTHY), PASSING);
  assert.ok(g.stats.prosecution, 'every promising-or-better record carries a prosecution block');
  assert.equal(g.stats.prosecution.ran, true);
  assert.ok(Array.isArray(g.stats.prosecution.checks));
});

test('a robust record survives prosecution and keeps its grade', () => {
  const g = M.gradeTrack(track(HEALTHY), PASSING);
  assert.equal(g.grade, 'validated');
  assert.equal(g.stats.prosecution.blocked, false);
});

// ── it can actually take a grade away ──────────────────────────────────────
test('an edge carried by one date is concentration, not alpha — Validated fails closed', () => {
  const g = M.gradeTrack(track(CONCENTRATED), PASSING);
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /prosecut/i);
  assert.equal(g.stats.prosecution.blocked, true);
  const failed = g.stats.prosecution.checks.filter(c => c.ok === false).map(c => c.check);
  assert.ok(failed.includes('concentration') || failed.includes('best-trade-excision'),
    `expected a concentration/excision failure, got ${JSON.stringify(failed)}`);
});

// ── unrun is surfaced, not silently passed ─────────────────────────────────
test('checks that could not run are named, and do not count as passes', () => {
  const g = M.gradeTrack(track(HEALTHY), PASSING);
  // The leak battery needs feature samples, which the maturity path has none of.
  assert.ok(g.stats.prosecution.unrun.length > 0, 'unrun checks must be listed');
  assert.ok(g.stats.prosecution.unrun.includes('orbit-controls-battery'));
  assert.notEqual(g.stats.prosecution.verdict, 'SURVIVES',
    'the raw prosecutor verdict must stay honest about the unrun battery');
});

test('a record with no per-date values is recorded as UNPROSECUTED, not as passing', () => {
  const t = track(HEALTHY);
  delete t.dateNet.values;
  const g = M.gradeTrack(t, PASSING);
  assert.equal(g.stats.prosecution.ran, false);
  assert.match(g.stats.prosecution.reason, /no per-date/i);
});

// ── the evidence channel this depends on ───────────────────────────────────
test('dateLevelNetExcess forwards the per-date values the prosecutor needs', () => {
  const rows = [
    { date: '2026-08-03', netExc: 1.0 }, { date: '2026-08-03', netExc: 2.0 },
    { date: '2026-08-04', netExc: -0.5 },
  ];
  const out = dateLevelNetExcess(rows);
  assert.deepEqual(out.values, [1.5, -0.5], 'one equal-weight portfolio value per decision date');
  assert.equal(out.values.length, out.n, 'exactly one value per counted date');
});

// ── small-sample honesty ───────────────────────────────────────────────────
// Found by verifying this feature on production. 16 of 17 prosecuted records
// came back `blocked: true`, but several were decided on 2-5 decision dates:
//
//   anomaly n=2, emergingleader n=3, crossasset n=4, peerlab n=4
//
// With 2 dates, "one date carries >=50% of positive P&L" is true by ARITHMETIC,
// not by concentration. excisionCheck already refuses to run below 10 trades;
// concentrationCheck had NO floor, so it fired spuriously on tiny records and
// `blocked: true` read as "adversarially rejected" when it meant "too few dates
// to say". A verdict that is really a sample-size artifact is the exact defect
// class this whole pass has been closing.
const P = require('../lib/cfl/prosecutor');

test('concentration refuses to judge a handful of observations', () => {
  const tiny = P.concentrationCheck([{ net: 5 }, { net: 0.01 }, { net: 0.01 }]);
  assert.equal(tiny.ok, false);
  assert.match(tiny.reason, /insufficient/i);
});

test('concentration still convicts a real monster-trade edge', () => {
  const real = P.concentrationCheck([{ net: 5 }, ...Array.from({ length: 30 }, () => ({ net: 0.01 }))]);
  assert.equal(real.ok, true);
  assert.ok(real.top1Share > 0.5);
});

test('a record too small to judge is UNRUN, never blocked', () => {
  const t = track([1.0, 4.0, 0.2]);           // 3 dates: arithmetically "concentrated"
  const g = M.gradeTrack(t, PASSING);
  assert.equal(g.stats.prosecution.blocked, false, 'a 3-date record cannot be convicted of concentration');
  assert.ok(g.stats.prosecution.unrun.includes('concentration'));
});
