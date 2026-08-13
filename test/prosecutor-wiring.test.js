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

const dn0 = (values) => ({
  n: 30, avg: 1.2, sd: 2.0, ci95: { lo: 0.4, hi: 2.0 }, effectiveN: 22,
  positiveBlocks: 4, blockStability: { blocks: 4, positive: 4, means: [1.1, 1.3, 1.0, 1.4], usable: true },
  values,
});
const track = (values) => ({
  excessN: 60, avgExcess: 2.6, beatMktRate: 38,
  netExcessN: 60, avgNetExcess: 2.4, netBeatMktRate: 36,
  secExcN: 60, avgSecExcess: 1.8, beatSecRate: 40,
  dates: 30, dateNet: dn0(values),
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

// ── excision calibration ───────────────────────────────────────────────────
// Investigating the screener's excision "failure" showed the check was measuring
// SAMPLE SIZE, not concentration. removeCounts are absolute [5,10,20], written
// for trade counts in the hundreds. On an 18-date series they strip 28% and 56%
// of the sample and then demand the remaining bottom 44% average positive.
//
// Simulated against the screener's OWN mean and dispersion, a genuinely positive
// strategy survived 0.51% of the time at n=18 (and 0.01% at n=30, where k=20
// kicks in and removes 67% — the absolute thresholds create a discontinuity).
// The screener itself sits at the 49.6th percentile of its own null: exactly
// average concentration, top1Share 0.208, slightly NEGATIVE skew. It is weak,
// not fragile, and the date-level CI gate already says so.
//
// Same floor as MIN_CONCENTRATION_N, expressed as a fraction: a removal that
// takes more than MAX_EXCISION_FRACTION of the sample cannot distinguish
// concentration from dispersion, so it declines to run.
test('excision refuses a removal that would strip most of the sample', () => {
  const eighteen = Array.from({ length: 18 }, (_, i) => ({ net: i - 8 }));
  const e = P.excisionCheck(eighteen);         // k=5 is 28% of 18
  assert.equal(e.ok, false);
  assert.match(e.reason, /sample|insufficient/i);
});

test('excision runs once the removal is a small enough slice', () => {
  const twentyFive = Array.from({ length: 25 }, (_, i) => ({ net: i - 12 }));
  const e = P.excisionCheck(twentyFive);       // k=5 is exactly 20%
  assert.equal(e.ok, true);
  assert.ok(e.rows.length >= 1);
  for (const r of e.rows) assert.ok(r.removed / 25 <= 0.20, `k=${r.removed} exceeds the fraction cap`);
});

test('excision still convicts a real one-sided edge on an adequate sample', () => {
  const trades = [...Array.from({ length: 5 }, () => ({ net: 1 })), ...Array.from({ length: 40 }, () => ({ net: -0.02 }))];
  const e = P.excisionCheck(trades);           // k=5 is 11% of 45 — applies
  assert.equal(e.ok, true);
  assert.equal(e.survives, false);
});

test("the screener's real 18-date series is UNRUN, not convicted", () => {
  // The actual production series that prompted this. It must not be blocked.
  const screener = [10.36, 10.27, 9.74, 5, 4.2, 3.75, 3.16, 2.37, 0.98,
    -0.06, -0.15, -1.14, -1.47, -2.2, -3.4, -6.75, -8.3, -11.45];
  const g = M.gradeTrack(track(screener), PASSING);
  assert.equal(g.stats.prosecution.blocked, false, 'an 18-date series cannot be convicted of concentration');
  assert.ok(g.stats.prosecution.unrun.includes('best-trade-excision'));
});

// ── the calibrated statistic decides ───────────────────────────────────────
// The raw excision/concentration checks stay as descriptives; only the matched-
// null comparison (and a genuine leak REJECTION) can take a grade away.
test('the screener series is cleared — weak, not concentrated', () => {
  const screener = [10.36, 10.27, 9.74, 5, 4.2, 3.75, 3.16, 2.37, 0.98,
    -0.06, -0.15, -1.14, -1.47, -2.2, -3.4, -6.75, -8.3, -11.45];
  const g = M.gradeTrack(track(screener), PASSING);
  assert.equal(g.stats.prosecution.blocked, false);
  assert.equal(g.stats.prosecution.blockedBy, null);
  assert.equal(g.stats.prosecution.calibrated.concentrated, false);
});

test('the events series IS convicted, and the report names the statistic', () => {
  const events = [52.5, 38.51, 31.26, 27.37, 18.26, 11.37, 9.61, 3.96, 3.19, 2.83, 2.13, 0.86, 0.44, 0.22,
    -0.22, -0.5, -1.78, -4.67, -5.16, -6.78, -9.18, -11.58, -14.07, -20.31, -21.77, -22.93, -23.5];
  const g = M.gradeTrack(track(events), PASSING);
  assert.equal(g.stats.prosecution.blocked, true);
  assert.equal(g.stats.prosecution.blockedBy, 'null-calibrated-concentration');
  assert.ok(g.stats.prosecution.calibrated.skew.percentile >= 95);
  assert.match(g.reason, /prosecut/i);
});

test('a raw excision failure alone no longer takes a grade away', () => {
  // 45 observations where the raw check convicts (removing the best 5 flips it
  // negative) but the shape is ordinary against a matched null. Before, this
  // was a conviction; now it is a descriptive.
  const v = [...Array.from({ length: 5 }, () => 1), ...Array.from({ length: 40 }, () => -0.02)];
  const g = M.gradeTrack(track(v), PASSING);
  const p = g.stats.prosecution;
  if (p.calibrated && p.calibrated.concentrated) return;   // calibration agrees — nothing to assert
  assert.ok(p.failed.includes('best-trade-excision'), 'the raw check should still REPORT the failure');
  assert.equal(p.blocked, false, 'but it must not block on its own');
});

// ── applicability: concentration presumes an edge ──────────────────────────
// `attention` was the most extreme shape in the book — skew +1.99 at the 100th
// percentile, not one of 2000 matched null draws more right-tailed. But its mean
// is -0.011 WITH the outlier and -1.83 without it: it loses on 10 of 14 dates
// with a median of -2.24%. It is not an edge concentrated in one date, it is a
// losing record dragged to breakeven by one.
//
// Concentration asks HOW AN EDGE IS EARNED. Asked of a series with no positive
// mean it answers a question nobody needs — expectancy already failed.
const ATTENTION = [-4.48, -2.17, -0.4, -2.31, 0.92, -6.31, -0.14, -2.35, 8.04, -3.89, -8.29, 23.62, -5.54, 3.13];
const EVENTS_S = [52.5, 38.51, 31.26, 27.37, 18.26, 11.37, 9.61, 3.96, 3.19, 2.83, 2.13, 0.86, 0.44, 0.22,
  -0.22, -0.5, -1.78, -4.67, -5.16, -6.78, -9.18, -11.58, -14.07, -20.31, -21.77, -22.93, -23.5];

test('a non-positive-mean record is not prosecuted for concentration', () => {
  const g = M.gradeTrack(track(ATTENTION), PASSING);
  const p = g.stats.prosecution;
  assert.equal(p.blocked, false, 'no edge to concentrate — expectancy already failed');
  const c = p.checks.find(x => x.check === 'null-calibrated-concentration');
  assert.equal(c.ok, null, 'not applicable, not passed');
  assert.equal(c.detail.applicable, false);
  assert.match(String(c.detail.notApplicable), /mean|edge/i);
});

test('the shape is still MEASURED and reported, just not charged', () => {
  const g = M.gradeTrack(track(ATTENTION), PASSING);
  const cal = g.stats.prosecution.calibrated;
  assert.equal(cal.ran, true, 'the statistic is still computed — silence would lose the finding');
  assert.ok(cal.skew.percentile >= 95, 'and it still records how extreme the shape was');
});

test('a positive-mean record is still prosecuted normally', () => {
  const g = M.gradeTrack(track(EVENTS_S), PASSING);
  assert.equal(g.stats.prosecution.blocked, true);
  assert.equal(g.stats.prosecution.blockedBy, 'null-calibrated-concentration');
});

// ── locating the outlier ───────────────────────────────────────────────────
// #352 forwarded dateNet.values without the matching dates, so a finding like
// attention's could only be given a POSITION (12 of 14), never a date. A
// concentration verdict you cannot trace to a session is not actionable.
test('dateLevelNetExcess forwards dates aligned with values', () => {
  const rows = [
    { date: '2026-08-03', netExc: 1.0 }, { date: '2026-08-03', netExc: 2.0 },
    { date: '2026-08-04', netExc: -0.5 }, { date: '2026-08-05', netExc: 9.0 },
  ];
  const out = dateLevelNetExcess(rows);
  assert.deepEqual(out.dates, ['2026-08-03', '2026-08-04', '2026-08-05']);
  assert.equal(out.dates.length, out.values.length, 'one date per value, same order');
  assert.equal(out.dates[out.values.indexOf(Math.max(...out.values))], '2026-08-05');
});

test('the prosecution names the date carrying the tail', () => {
  const dn = { ...dn0(ATTENTION), dates: ATTENTION.map((_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`) };
  const g = M.gradeTrack({ ...track(ATTENTION), dateNet: dn }, PASSING);
  const peak = g.stats.prosecution.peak;
  assert.ok(peak, 'peak must be reported when dates are available');
  assert.equal(peak.value, 23.62);
  assert.equal(peak.date, '2026-07-12', 'the 12th of 14 — the outlier');
});
