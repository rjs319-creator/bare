'use strict';
// CENSORING-AWARE DRIFT — regression for the 2026-08-04 audit finding: comparing a young
// ledger's RESOLVED-SO-FAR win rate (fast stop-outs resolve first; slow target hits are
// still OPEN) against a FULLY-RESOLVED seed baseline made every young ledger read BROKEN by
// construction (replication: a 39%-final-win-rate population reads 7-19% when censored at
// age 10-40 sessions). These tests pin the age-matched baseline math and the fail-closed
// verdict precedence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signalAgeSessions, censoredSeedBaseline, driftVerdict } = require('../lib/apex-routes');
const { MAX_HOLD } = require('../lib/outcome');

const NOW = Date.parse('2026-08-04T00:00:00Z');
const daysAgo = n => new Date(NOW - n * 864e5).toISOString().slice(0, 10);

// A seed where wins take 40 sessions and losses take 5 — the shape that causes the bias.
// 40 wins / 60 losses → final win rate 40%, but censored young it reads ~0%.
function slowWinSeed() {
  const seed = [];
  for (let i = 0; i < 40; i++) seed.push({ regime: 'RISK_ON', won: true, hold: 40 });
  for (let i = 0; i < 60; i++) seed.push({ regime: 'RISK_ON', won: false, hold: 5 });
  return seed;
}

test('signalAgeSessions: calendar days scale to trading sessions (~252/365)', () => {
  assert.equal(signalAgeSessions(daysAgo(0), NOW), 0);
  const a30 = signalAgeSessions(daysAgo(30), NOW);
  assert.ok(a30 >= 19 && a30 <= 21, `30 calendar days ≈ 20-21 sessions (got ${a30})`);
  const a91 = signalAgeSessions(daysAgo(91), NOW);
  assert.ok(a91 >= 61 && a91 <= 64, `91 calendar days ≈ 63 sessions (got ${a91})`);
});

test('age-matched baseline: a young cohort against a slow-win seed expects a LOW resolved-so-far rate', () => {
  // Live cohort aged ~14 sessions (20 calendar days): only the 5-session losses have had
  // time to resolve in the seed → expected resolved-so-far win rate 0%, NOT the final 40%.
  const live = Array.from({ length: 30 }, () => ({ date: daysAgo(20), regime: 'RISK_ON' }));
  const m = censoredSeedBaseline(slowWinSeed(), live, NOW);
  assert.ok(m, 'baseline computable when seed carries hold');
  assert.equal(m.winRate, 0, 'at age ~14 sessions only the fast losses have resolved');
  // A mature cohort (150 calendar days ≈ 103 sessions) sees the full 40%.
  const old = Array.from({ length: 30 }, () => ({ date: daysAgo(150), regime: 'RISK_ON' }));
  const m2 = censoredSeedBaseline(slowWinSeed(), old, NOW);
  assert.equal(m2.winRate, 40, 'a mature cohort recovers the final win rate');
});

test('age-matched baseline fails closed without per-signal hold data', () => {
  const noHold = slowWinSeed().map(({ hold, ...s }) => s);
  assert.equal(censoredSeedBaseline(noHold, [{ date: daysAgo(20), regime: 'RISK_ON' }], NOW), null);
  assert.equal(censoredSeedBaseline(slowWinSeed().slice(0, 20), [{ date: daysAgo(20), regime: 'RISK_ON' }], NOW), null,
    'fewer than 50 hold-bearing seed signals is not a baseline');
});

test('THE AUDIT REGRESSION: a healthy-but-young ledger must not read BROKEN', () => {
  // Live resolved-so-far 8% [CI hi 12] — exactly the production numbers — with a matched
  // baseline of 10% (what a healthy strategy looks like at this age): HEALTHY, not BROKEN.
  const v = driftVerdict({
    liveWinRateCIHi: 12, liveWinRate: 8, windowN: 180,
    matched: { winRate: 10 }, uncensored: { winRate: 32 }, medianAgeSessions: 20,
  });
  assert.equal(v.status, 'HEALTHY');
  assert.equal(v.basis, 'age-matched-censored-baseline');
  assert.equal(v.baselineWinRate, 10, 'the matched baseline decides, never the fully-resolved 32');
});

test('a young ledger with NO matched baseline fails closed to PENDING (never BROKEN)', () => {
  const v = driftVerdict({
    liveWinRateCIHi: 12, liveWinRate: 8, windowN: 180,
    matched: null, uncensored: { winRate: 32 }, medianAgeSessions: 20,
  });
  assert.equal(v.status, 'PENDING');
  assert.equal(v.basis, 'ledger-too-young-for-uncensored-comparison');
  assert.match(v.note, /backfill/, 'the note names the manual step that enables the comparison');
});

test('a genuinely broken strategy still reads BROKEN against the age-matched baseline', () => {
  // Matched baseline says a healthy strategy would show 30% resolved-so-far at this age;
  // the live ledger shows 8% with CI hi 12 < 30−15 → BROKEN is real, not censoring.
  const v = driftVerdict({
    liveWinRateCIHi: 12, liveWinRate: 8, windowN: 180,
    matched: { winRate: 30 }, uncensored: { winRate: 32 }, medianAgeSessions: 20,
  });
  assert.equal(v.status, 'BROKEN');
});

test('a mature cohort may use the uncensored baseline; sample floor still gates everything', () => {
  const mature = driftVerdict({
    liveWinRateCIHi: 12, liveWinRate: 8, windowN: 180,
    matched: null, uncensored: { winRate: 32 }, medianAgeSessions: MAX_HOLD + 5,
  });
  assert.equal(mature.status, 'BROKEN');
  assert.equal(mature.basis, 'uncensored-baseline-mature-cohort');
  const thin = driftVerdict({ liveWinRateCIHi: 40, liveWinRate: 20, windowN: 10, matched: { winRate: 30 }, uncensored: null, medianAgeSessions: 20 });
  assert.equal(thin.status, 'PENDING');
  assert.equal(thin.basis, 'insufficient-sample');
});

test('seed EXPIRED outcomes (hold = MAX_HOLD) stay unresolved at younger ages', () => {
  const seed = [
    ...Array.from({ length: 50 }, () => ({ regime: 'RISK_ON', won: false, hold: 5 })),
    ...Array.from({ length: 50 }, () => ({ regime: 'RISK_ON', won: true, hold: MAX_HOLD })),
  ];
  const young = censoredSeedBaseline(seed, [{ date: daysAgo(30), regime: 'RISK_ON' }], NOW);
  assert.equal(young.winRate, 0, 'expired-at-63 seeds cannot count as resolved at age ~21');
});
