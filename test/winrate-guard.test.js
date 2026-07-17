'use strict';
// WIN-RATE SCALE GUARD — expectancyTilt reads `winRate - 50`, so a 0..1 fraction does not
// throw, it INVERTS: 0.7 → 0.7-50 = -49.3 pins the tilt to its floor and ranks a
// 70%-winning strategy as if it were losing. Nothing enforced the scale. These tests lock
// the contract (integer percent, 0..100 — what apex-routes.js summarizeReturns emits).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/decision');

// Silence the intentional warnings these tests provoke.
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

test('normalizeWinRate accepts the production contract (integer percent 0..100)', () => {
  assert.equal(D.normalizeWinRate(70), 70);
  assert.equal(D.normalizeWinRate(0), 0);     // a real 0% win rate
  assert.equal(D.normalizeWinRate(1), 1);     // ambiguous by nature — 1% is legal, so honour it
  assert.equal(D.normalizeWinRate(100), 100);
  assert.equal(D.normalizeWinRate(null), null);
  assert.equal(D.normalizeWinRate(undefined), null);
});

test('normalizeWinRate REJECTS a 0..1 fraction — the bug that silently inverts the rank', () => {
  quiet(() => {
    assert.equal(D.normalizeWinRate(0.7), null);
    assert.equal(D.normalizeWinRate(0.55), null);
    assert.equal(D.normalizeWinRate(0.999), null);
  });
});

test('normalizeWinRate rejects out-of-contract and non-finite values', () => {
  quiet(() => {
    assert.equal(D.normalizeWinRate(-5), null);
    assert.equal(D.normalizeWinRate(101), null);
    assert.equal(D.normalizeWinRate(NaN), null);
    assert.equal(D.normalizeWinRate(Infinity), null);
    assert.equal(D.normalizeWinRate('70'), null, 'a string is not the numeric contract');
  });
});

test('normalizeWinRate warns rather than swallowing — the bug leaves a trace', () => {
  const w = console.warn; const seen = [];
  console.warn = (line) => seen.push(line);
  try { D.normalizeWinRate(0.7, { section: 'screener' }); } finally { console.warn = w; }
  assert.equal(seen.length, 1, 'a rejected win rate must be logged');
  const rec = JSON.parse(seen[0]);
  assert.equal(rec.level, 'warn');
  assert.equal(rec.ctx, 'decision.winRate');
  assert.equal(rec.winRate, 0.7);
  assert.equal(rec.section, 'screener');
  assert.match(rec.msg, /fraction/);
});

test('THE REGRESSION: a fraction no longer inverts the tilt of a winning strategy', () => {
  // Before the guard: winRate 0.7 → wr = -49.3 → tilt 0.7 (the floor) on a record that
  // beats the market by 4% with a 70% win rate. The rank was quietly upside-down.
  const good = { known: true, n: 400, avgExcess: 4, winRate: 70 };
  const bugged = { known: true, n: 400, avgExcess: 4, winRate: 0.7 };
  const t1 = D.expectancyTilt(good);
  const t2 = quiet(() => D.expectancyTilt(bugged));
  assert.ok(t1.tilt > 1, `a market-beating record must tilt UP, got ${t1.tilt}`);
  assert.ok(t2.tilt > 1, `a rejected win rate must never invert the tilt, got ${t2.tilt}`);
  // The bad input degrades to avgExcess-only — strictly less confident, never inverted.
  assert.ok(t2.tilt < t1.tilt, 'an untrusted win rate should contribute nothing, not a boost');
});

test('a genuinely losing record still tilts DOWN (the guard does not whitewash)', () => {
  const bad = { known: true, n: 400, avgExcess: -4, winRate: 30 };
  assert.ok(D.expectancyTilt(bad).tilt < 1, 'losing to the market must trim the rank');
});

test('expectancyFor scale-guards the win rate at the Scoreboard boundary', () => {
  const mk = (winRate) => ({ groups: [{ section: 'screener', tier: 'Breakout', horizons: { '5d': { avgExcess: 4, winRate, n: 400 } } }] });
  assert.equal(D.expectancyFor('screener', 'Breakout', 'swing', mk(70)).winRate, 70);
  // A fraction from the feed is shown as "unknown" rather than as a wrong number.
  quiet(() => {
    const e = D.expectancyFor('screener', 'Breakout', 'swing', mk(0.7));
    assert.equal(e.winRate, null);
    assert.equal(e.known, true, 'the record is still known — only the win rate is untrusted');
    assert.equal(e.avgExcess, 4, 'a bad win rate must not discard the valid excess');
  });
});

test('the live Scoreboard scale is what the contract expects (integer percent)', () => {
  // Pins the producer↔consumer agreement: apex-routes.js emits Math.round((wins/n)*100).
  const emitted = Math.round((7 / 10) * 100);
  assert.equal(emitted, 70);
  assert.equal(D.normalizeWinRate(emitted), 70);
  assert.ok(D.expectancyTilt({ known: true, n: 100, avgExcess: 2, winRate: emitted }).tilt > 1);
});
