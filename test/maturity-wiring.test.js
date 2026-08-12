'use strict';
// WIRING EXISTING MACHINERY INTO THE PATH THAT GATES (alpha-research pass 3).
//
// Two corrections that were already implemented, tested, and consumed by nothing:
//   1. lib/evidence-stats.fdrAdjust / pValueOf — Benjamini-Hochberg across attempted
//      strategies. Zero production callers; its own unit test is literally named
//      "a lone nominal winner among many does not survive".
//   2. The Scoreboard's ungradeable-pick count. Picks whose ticker has no price history
//      (delisted / acquired / bankrupt / halted) incremented the denominator and then
//      entered no statistic, so failures were deleted from the record that feeds
//      expectancyTilt, maturity and governance.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('../lib/maturity');

// A track that clears every pre-existing Validated gate, so each test below isolates
// exactly one new gate.
const FULL_TRACK = {
  excessN: 200, avgExcess: 2.0, beatMktRate: 64,
  netExcessN: 200, avgNetExcess: 1.8, netBeatMktRate: 63,
  secExcN: 200, avgSecExcess: 1.1, beatSecRate: 60,
  dates: 60,
  dateNet: {
    n: 60, avg: 0.9, sd: 2.0, se: 0.2, ci95: { lo: 0.5, hi: 1.3 },
    effectiveN: 40, positiveBlocks: 4,
    blockStability: { blocks: 4, positive: 4, means: [0.8, 1.0, 0.7, 1.1], usable: true },
  },
};

// ── 1. ungradeable-share gate ────────────────────────────────────────────────────

test('a clean record with no missing history still validates', () => {
  const g = M.gradeTrack({ ...FULL_TRACK }, { fillVerified: true, noHistoryRate: 0 });
  assert.equal(g.grade, 'validated');
});

test('a record with a material ungradeable share cannot validate', () => {
  const g = M.gradeTrack({ ...FULL_TRACK }, { fillVerified: true, noHistoryRate: 0.12 });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /no price history/);
  assert.match(g.reason, /12\.0%/);
});

test('an UNMEASURED ungradeable share fails closed rather than passing', () => {
  // A summary written before the counter existed cannot prove the share is small.
  // Consistent with how this file already treats a missing effectiveN and fillVerified.
  const g = M.gradeTrack({ ...FULL_TRACK }, { fillVerified: true });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /UNMEASURED/);
});

test('the ungradeable gate sits behind the fill gate, not in front of it', () => {
  // Ordering matters for the reported reason: an unfilled proxy pipeline is the more
  // fundamental objection and should be what the user is told first.
  const g = M.gradeTrack({ ...FULL_TRACK }, { fillVerified: false, noHistoryRate: 0.9 });
  assert.match(g.reason, /fill-UNVERIFIED/);
});

// ── 2. FDR across the registry ───────────────────────────────────────────────────

// Build a synthetic summary + registry: one strong strategy among many null ones, all
// graded in the same run. This is the exact situation BH exists to correct.
function scenario(nNull) {
  const mkGroup = (section, avg, se) => ({
    section, tier: 'T', scope: 'large', picks: 200, noHistory: 0,
    horizons: {
      '1m': {
        excessN: 200, avgExcess: avg, beatMktRate: 60,
        netExcessN: 200, avgNetExcess: avg, netBeatMktRate: 60,
        secExcN: 200, avgSecExcess: avg / 2, beatSecRate: 58,
        dates: 60,
        dateNet: {
          n: 60, avg, sd: 2.0, se, ci95: { lo: avg - 1.96 * se, hi: avg + 1.96 * se },
          effectiveN: 40, positiveBlocks: 4,
          blockStability: { blocks: 4, positive: 4, means: [avg, avg, avg, avg], usable: true },
        },
      },
    },
  });
  // One genuine winner (p ≈ 0.0085) among pure nulls (p ≈ 0.92). The nulls do not reach
  // validated on their own — they are not meant to. They are the TESTS THAT WERE RUN,
  // and their existence is what should raise the bar for the winner.
  const groups = [mkGroup('S0', 0.50, 0.19)];
  for (let i = 1; i <= nNull; i++) groups.push(mkGroup(`S${i}`, 0.02, 0.20));
  const registry = groups.map((g, i) => ({
    id: `s${i}`, label: `S${i}`, kind: 'signal', section: g.section,
    horizon: 'position', core: false, maturity: 'production', scoringVersion: `s${i}-v1`,
  }));
  // Fill verification must be granted for these fixtures to reach `validated` at all —
  // without it every arm stops at the fill gate and the FDR path below would never
  // execute, leaving these tests vacuously green.
  const fillVerification = {};
  for (const r of registry) fillVerification[r.id] = { fillVerified: true, resolved: 200, reason: 'fixture' };
  return { summary: { groups, fillVerification, generatedAt: '2026-08-11T00:00:00Z' }, registry };
}

test('classifyStrategies reports an FDR block', () => {
  const { summary, registry } = scenario(3);
  const r = M.classifyStrategies(summary, registry);
  assert.equal(r.fdr.method, 'benjamini-hochberg');
  assert.equal(r.fdr.alpha, 0.05);
  assert.ok(r.fdr.tested > 0, 'strategies carrying a date-level test must be counted');
});

test('a lone nominal winner among many does not survive the correction', () => {
  // THE point of the correction, asserted on an IDENTICAL winner in both runs — only
  // the number of simultaneous tests differs. Asserted as concrete grades rather than
  // an inequality between counts, because an inequality passes vacuously when nothing
  // validates in either arm.
  const a = scenario(2);
  const b = scenario(60);
  const few = M.classifyStrategies(a.summary, a.registry);
  const many = M.classifyStrategies(b.summary, b.registry);

  const wFew = few.strategies.find(s => s.id === 's0');
  const wMany = many.strategies.find(s => s.id === 's0');

  assert.equal(wFew.grade, 'validated', 'with 3 tests the winner clears BH');
  assert.equal(wMany.grade, 'promising', 'with 61 tests the same winner does not');

  // Same evidence, same p — only the family size changed.
  assert.equal(wFew.fdr.p, wMany.fdr.p, 'the winner\'s own p-value is identical in both runs');
  assert.ok(wMany.fdr.q > wFew.fdr.q, 'q rises with the number of tests');
  assert.equal(wMany.fdr.demoted, true);
  assert.equal(few.fdr.tested, 3);
  assert.equal(many.fdr.tested, 61);
});

test('FDR only ever demotes — it never promotes', () => {
  const { summary, registry } = scenario(40);
  const r = M.classifyStrategies(summary, registry);
  for (const s of r.strategies) {
    if (s.fdr && s.fdr.demoted) {
      assert.equal(s.grade, 'promising', 'a demotion lands on promising, never lower or higher');
      assert.match(s.reason, /Benjamini-Hochberg/);
      assert.match(s.reason, /Original verdict:/, 'the superseded verdict stays visible');
    }
    // Nothing may be raised to validated by the correction.
    if (s.fdr && !s.fdr.survives) assert.notEqual(s.grade, 'validated');
  }
});

test('the correction family includes non-winners, not just the winners', () => {
  // Correcting over only the strategies that reached validated would understate the
  // number of tests run — which is the entire error being corrected.
  const { summary, registry } = scenario(10);
  const r = M.classifyStrategies(summary, registry);
  const validated = r.strategies.filter(s => s.grade === 'validated').length;
  assert.ok(r.fdr.tested > validated,
    `family (${r.fdr.tested}) must exceed the winners (${validated})`);
});
