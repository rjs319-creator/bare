'use strict';
// F-12: INCREMENTAL-OVER-BASELINE GATES WERE DECLARED BUT NEVER ENFORCED.
//
// 10 registry entries state, in their own promotion `criteria`, that they must
// prove value INCREMENTAL to something else before they can be promoted:
//
//   ghost        "demonstrated incremental value after redundancy adjustment
//                 against the screener (a 0.96-correlated sleeve must prove it
//                 adds something the Breakout book does not)"
//   transparent  "beats residualMomentumOnly incrementally on identical dates"
//   ignition     "incremental lift over the WATCH control"
//   trendrider   "beating plain 12-1 momentum ... on identical dates"
//
// `gradeStrategy` carries `criteria` through to the payload as PROSE and nothing
// ever reads it. `gradeTrack` could therefore award `validated` — the grade
// governance converts into live clearance — to a strategy whose own declared
// incremental bar had never been computed, let alone cleared. The gate existed
// only as a sentence.
//
// It now fails closed like every other gate in that chain: a DECLARED
// incremental requirement with no MEASURED artifact caps the grade at Promising
// and says so. Silence is not evidence of clearance.
//
// NB this changes no grade today — all 10 declarers are shadow or rejected. It
// closes the door on a future silent promotion, which is exactly when an
// unenforced gate would have done its damage.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../lib/maturity');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');

// Clears every OTHER gate — reused from maturity-v3 so this file tests the new
// gate in isolation rather than an accidentally-failing fixture.
const VALIDATES = Object.freeze({
  excessN: 60, avgExcess: 2.6, beatMktRate: 38,
  netExcessN: 60, avgNetExcess: 2.4, netBeatMktRate: 36,
  secExcN: 60, avgSecExcess: 1.8, beatSecRate: 40,
  dates: 30,
  dateNet: { n: 30, avg: 1.2, sd: 2.0, ci95: { lo: 0.4, hi: 2.0 }, effectiveN: 22, positiveBlocks: 4, blockStability: { blocks: 4, positive: 4, means: [1.1, 1.3, 1.0, 1.4], usable: true } },
});
const PASSING = { fillVerified: true, noHistoryRate: 0 };

// ── detecting the declaration ──────────────────────────────────────────────
test('the real registry criteria that declare an incremental bar are detected', () => {
  const declared = STRATEGY_REGISTRY.filter(e => M.declaresIncrementalGate(e.criteria));
  // Not pinned to exactly 10 — entries come and go. Pinned to "this actually
  // matches the live registry", so the detector can't silently stop matching.
  assert.ok(declared.length >= 10, `expected the registry's incremental declarers to be detected, got ${declared.length}`);
  const ids = declared.map(e => e.id);
  for (const id of ['ghost', 'transparent', 'ignition', 'trendrider']) {
    assert.ok(ids.includes(id), `${id} declares an incremental bar in its criteria and must be detected`);
  }
});

test('criteria with no incremental language are not caught', () => {
  // Over-matching only ever makes the gate STRICTER (it fails closed), but a
  // false positive would block a strategy on a bar it never claimed.
  assert.equal(M.declaresIncrementalGate('Cost-net date-level CI clear of zero over 50 resolved episodes.'), false);
  assert.equal(M.declaresIncrementalGate('Beats SPY and its sector ETF on verified fills.'), false);
});

test('a missing or empty criteria string declares nothing', () => {
  assert.equal(M.declaresIncrementalGate(null), false);
  assert.equal(M.declaresIncrementalGate(undefined), false);
  assert.equal(M.declaresIncrementalGate(''), false);
  assert.equal(M.declaresIncrementalGate(42), false);
});

// ── enforcing it ───────────────────────────────────────────────────────────
test('a declared incremental bar with NO measured artifact cannot reach Validated', () => {
  const g = M.gradeTrack({ ...VALIDATES }, { ...PASSING, incremental: { declared: true } });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /incremental/i);
  assert.match(g.reason, /never measured|unmeasured|not been measured/i);
});

test('a declared bar that was measured and FAILED cannot reach Validated either', () => {
  const g = M.gradeTrack({ ...VALIDATES }, { ...PASSING, incremental: { declared: true, measured: true, cleared: false, source: 'confluence-marginal' } });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /incremental/i);
});

test('a declared bar that was measured and CLEARED lets the grade through', () => {
  const g = M.gradeTrack({ ...VALIDATES }, { ...PASSING, incremental: { declared: true, measured: true, cleared: true, source: 'confluence-marginal' } });
  assert.equal(g.grade, 'validated');
});

test('a strategy that never declared an incremental bar is unaffected', () => {
  // The gate must not become a universal new bar — only the strategies that
  // wrote the requirement into their own criteria are held to it.
  assert.equal(M.gradeTrack({ ...VALIDATES }, PASSING).grade, 'validated');
  assert.equal(M.gradeTrack({ ...VALIDATES }, { ...PASSING, incremental: { declared: false } }).grade, 'validated');
});

test('the incremental gate does not mask an earlier failure', () => {
  // Gate ordering matters: a proxy-fill record must still report the FILL
  // problem, not be relabelled as an incremental one.
  const g = M.gradeTrack({ ...VALIDATES }, { noHistoryRate: 0, incremental: { declared: true } });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /proxy/i);
});

test('the verdict records that the bar was unmet, for the payload', () => {
  const g = M.gradeTrack({ ...VALIDATES }, { ...PASSING, incremental: { declared: true } });
  assert.equal(g.stats.incremental.declared, true);
  assert.equal(g.stats.incremental.cleared, false);
});

// ── wiring ─────────────────────────────────────────────────────────────────
test('gradeStrategy passes each entry own criteria into the gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'maturity.js'), 'utf8');
  assert.match(src, /declaresIncrementalGate\(entry\.criteria\)/);
});

// ── payload parity ─────────────────────────────────────────────────────────
// gradeStrategy has TWO paths. A strategy with resolved Scoreboard rows goes
// through gradeTrack (gated above); one with none short-circuits to an
// "accruing" experimental verdict that hand-builds its stats and never calls
// gradeTrack. Nine of the ten declarers are on that second path, so the live
// payload advertised the declared bar for exactly one of them.
//
// That is not a safety hole — the accruing branch hard-codes `experimental`, so
// nothing can reach Validated through it. It is the SAME invisibility F-12 was
// about: a declared requirement that the payload does not mention.
const TRACKED = { groups: [{ section: 'S', tier: 'T', picks: 10, noHistory: 0 }] };
const UNTRACKED = { groups: [] };
const DECLARER = { id: 'x', label: 'X', section: 'S', horizon: 'swing', criteria: 'must show incremental lift over the control' };
const PLAIN = { id: 'y', label: 'Y', section: 'S', horizon: 'swing', criteria: 'cost-net CI clear of zero' };

test('an accruing declarer still advertises its declared incremental bar', () => {
  const g = M.gradeStrategy(DECLARER, UNTRACKED);
  assert.equal(g.grade, 'experimental');
  assert.equal(g.stats.incremental.declared, true);
  assert.equal(g.stats.incremental.measured, false);
  assert.equal(g.stats.incremental.cleared, false);
});

test('an accruing NON-declarer advertises nothing', () => {
  const g = M.gradeStrategy(PLAIN, UNTRACKED);
  assert.equal(g.stats.incremental, null);
});

test('both grading paths emit the identical contract shape', () => {
  // The payload shape must not depend on whether a strategy happened to have a
  // resolved record — that is what made the gap invisible in the first place.
  const untracked = M.gradeStrategy(DECLARER, UNTRACKED).stats.incremental;
  const tracked = M.gradeTrack({ ...VALIDATES }, { ...PASSING, incremental: { declared: true } }).stats.incremental;
  assert.deepEqual(Object.keys(untracked).sort(), Object.keys(tracked).sort());
});
