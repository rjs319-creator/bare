'use strict';
// expectancyTilt IS THE LAST AUTOMATIC LIVE REWEIGHTING (alpha-research pass 3).
//
// It multiplies straight into compositeScore, runs every day off the Scoreboard summary,
// and had no validated-grade requirement, no OOS window, no FDR and no minimum number of
// independent dates. Three defects, each pinned below:
//
//   1. shrank on PICKS, not independent dates — 40 picks on 3 dates bought ~83% weight
//   2. any positive point estimate boosted, however noisy
//   3. the symmetric ±0.3 clamp floored it at 0.70, so a strategy with a significantly
//      NEGATIVE record could not be ranked out

const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/decision');

// exp objects as expectancyFor emits them.
const exp = (o) => ({ known: true, n: 100, avgExcess: 3, winRate: 62, ...o });
const dates = (n, lo, hi, eff) => ({ dateN: n, effectiveDates: eff ?? n, dateCiLo: lo, dateCiHi: hi, dateAvg: (lo + hi) / 2 });

// ── defect 1: independence, not pick count ───────────────────────────────────────

test('a big pick count over few dates does not buy weight', () => {
  // The acceptance case from the audit: 40 picks on 3 dates must be ~neutral.
  const t = D.expectancyTilt(exp({ n: 40, ...dates(3, 0.2, 2.4) }));
  assert.equal(t.tilt, 1);
  assert.match(t.reason, /independent decision dates/);
});

test('shrinkage runs on EFFECTIVE dates, not raw dates or picks', () => {
  // Same raw date count, different autocorrelation adjustment ⇒ different weight.
  const loose = D.expectancyTilt(exp({ n: 500, ...dates(40, 0.5, 1.5, 36) }));
  const clustered = D.expectancyTilt(exp({ n: 500, ...dates(40, 0.5, 1.5, 9) }));
  assert.ok(loose.tilt > clustered.tilt,
    `an autocorrelated record must earn less tilt (loose ${loose.tilt} vs clustered ${clustered.tilt})`);
  assert.ok(clustered.tilt > 1, 'but a significant clustered record still tilts up');
});

// ── defect 2: significance, not point estimate ───────────────────────────────────

test('a positive point estimate whose interval spans zero does NOT boost', () => {
  const t = D.expectancyTilt(exp({ avgExcess: 6, winRate: 70, ...dates(30, -0.4, 2.9) }));
  assert.equal(t.tilt, 1, 'noise must not move the live rank');
  assert.match(t.reason, /spans zero/);
});

test('an interval clear of zero does boost', () => {
  const t = D.expectancyTilt(exp({ ...dates(30, 0.3, 1.9) }));
  assert.ok(t.tilt > 1);
  assert.match(t.reason, /clear of zero/);
});

// ── defect 3: a losing strategy can be ranked out ────────────────────────────────

test('a significantly NEGATIVE record sinks far below the old 0.70 floor', () => {
  const t = D.expectancyTilt(exp({ avgExcess: -5, winRate: 30, ...dates(30, -2.2, -0.6) }));
  assert.ok(t.tilt < 0.7, `must break the old floor, got ${t.tilt}`);
  assert.match(t.reason, /entirely below zero/);
});

test('a proven loser ranks below a strategy with NO record at all', () => {
  // The behaviour the ±0.3 clamp made impossible: "worse than unproven".
  const loser = D.expectancyTilt(exp({ avgExcess: -5, winRate: 30, ...dates(30, -2.2, -0.6) })).tilt;
  const unproven = D.expectancyTilt({ known: false }).tilt;
  assert.equal(unproven, 1);
  assert.ok(loser < unproven, 'a demonstrated loss must rank below no evidence');
});

test('proven losers keep relative order rather than flattening to a tie', () => {
  // A hard 0 would make every losing row identical and undebuggable.
  const a = D.expectancyTilt(exp({ avgExcess: -5, ...dates(30, -2.2, -0.6) })).tilt;
  assert.ok(a > 0, 'the negative tilt is a strong demotion, not an annihilation');
});

// ── fail-closed and provenance ───────────────────────────────────────────────────

test('a record with no date-level block neutralises rather than falling back to picks', () => {
  // The pick-count fallback is exactly what produced the overstated confidence, so it is
  // not retained as a "better than nothing" path.
  const t = D.expectancyTilt(exp({ n: 400 }));
  assert.equal(t.tilt, 1);
  assert.match(t.reason, /cannot establish independence/);
});

test('a date-level record with no interval cannot claim significance', () => {
  const t = D.expectancyTilt(exp({ dateN: 30, effectiveDates: 28 }));
  assert.equal(t.tilt, 1);
  assert.match(t.reason, /no confidence interval/);
});

test('every verdict states its reason and basis', () => {
  for (const e of [{ known: false }, exp({ n: 400 }), exp({ ...dates(30, 0.3, 1.9) }), exp({ ...dates(30, -2.2, -0.6) })]) {
    const t = D.expectancyTilt(e);
    assert.ok(t.reason && t.reason.length > 10, 'a rank multiplier must say why it applied');
    assert.equal(t.basis, 'date-level');
  }
});

test('the win-rate scale guard still holds on the significant path', () => {
  // Regression pin: a 0..1 fraction must never invert a winning record's tilt.
  const good = D.expectancyTilt(exp({ winRate: 70, ...dates(30, 0.3, 1.9) }));
  const bugged = D.expectancyTilt(exp({ winRate: 0.7, ...dates(30, 0.3, 1.9) }));
  assert.ok(good.tilt > 1);
  assert.ok(bugged.tilt >= 1, 'a rejected win rate contributes 0, never a sign flip');
});
