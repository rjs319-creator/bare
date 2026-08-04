'use strict';
// Gap & Go intraday ORB verification (gapgo-orb-verify-v1) — the REAL execution record
// the daily-close proxy ledger cannot provide. Pins the frozen contract: genuine
// 30-minute opening range (never the completed daily high), trigger only after the
// range completes, gap-through at the worse open, >5% chase ceiling = gap-skip,
// same-bar stop/target ambiguity resolves to the STOP, honest no-trigger and
// insufficient-bars states, cost-net R.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveOrbFromBars, verifyCostTier, GAPGO_VERIFY_VERSION } = require('../lib/gapgo-verify');

const bar = (t, open, high, low, close) => ({ t, open, high, low, close });
// A clean 30-min opening range: high 105, low 100.
const OR = [
  bar('09:30', 101, 103, 100, 102),
  bar('09:35', 102, 104, 101, 103),
  bar('09:40', 103, 105, 102, 104),
  bar('09:45', 104, 104.5, 103, 104),
  bar('09:50', 104, 104.8, 103.5, 104.2),
  bar('09:55', 104.2, 104.6, 103.8, 104.1),
];

test('no-trigger: a gap whose OR high never breaks records NO-FILL, not a 3-day drift return', () => {
  const post = [bar('10:00', 104, 104.9, 103, 104), bar('10:05', 104, 104.5, 102, 103), bar('15:55', 103, 103.5, 101, 102)];
  const r = resolveOrbFromBars([...OR, ...post]);
  assert.equal(r.status, 'no-trigger');
  assert.equal(r.trigger, 105);
  assert.equal(r.version, GAPGO_VERIFY_VERSION);
});

test('touched trigger fills AT the trigger; target-before-stop resolves at +2R', () => {
  const post = [
    bar('10:00', 104.5, 105.5, 104, 105.2),  // breaks 105 → fill 105 (touched, not gapped)
    bar('10:05', 105.2, 108, 105.1, 107),
    bar('10:10', 107, 116, 106.5, 115),      // target = 105 + 2×(105−100) = 115
  ];
  const r = resolveOrbFromBars([...OR, ...post]);
  assert.equal(r.status, 'target-before-stop');
  assert.equal(r.fill, 105);
  assert.equal(r.stop, 100);
  assert.equal(r.target, 115);
  assert.equal(r.grossR, 2);
});

test('gap-through fills at the WORSE open, never the trigger', () => {
  const post = [
    bar('10:00', 106.5, 107, 106, 106.8),    // opens above 105 but under the 5% ceiling (110.25)
    bar('15:55', 107, 107.5, 106, 107),
  ];
  const r = resolveOrbFromBars([...OR, ...post]);
  assert.equal(r.fill, 106.5, 'gap-through must fill at the open, not the trigger');
  assert.equal(r.status, 'timeout');         // neither stop (100) nor target hit
  assert.equal(r.exit, 107);
});

test('an open beyond the 5% chase ceiling is a GAP-SKIP — refused, never an optimistic fill', () => {
  const post = [bar('10:00', 111, 112, 110, 111.5), bar('15:55', 111, 111.5, 110, 111)];
  const r = resolveOrbFromBars([...OR, ...post]);
  assert.equal(r.status, 'gap-skip');
  assert.equal(r.fill, undefined);
});

test('same-bar stop+target ambiguity resolves to the STOP (conservative), on the fill bar too', () => {
  const post = [
    // fill bar: breaks 105, then spans BOTH the stop (100) and the target — stop wins
    bar('10:00', 104.5, 116, 99.5, 100.5),
  ];
  const r = resolveOrbFromBars([...OR, ...post]);
  assert.equal(r.status, 'stop-before-target');
  assert.equal(r.exit, 100);
  assert.equal(r.grossR, -1);
});

test('timeout exits at the session close; netR charges the round-trip cost', () => {
  const post = [
    bar('10:00', 104.5, 105.5, 104, 105.2),  // fill 105
    bar('15:55', 106, 107, 105.5, 106.5),    // no stop/target → time exit at 106.5
  ];
  const r = resolveOrbFromBars([...OR, ...post], { costPct: 0.5 });
  assert.equal(r.status, 'timeout');
  assert.equal(r.exit, 106.5);
  assert.equal(r.grossR, 0.3);               // (106.5−105)/5
  assert.ok(r.netR < r.grossR, 'net must be worse than gross');
  assert.equal(r.netR, +(((106.5 - 105) - 105 * 0.005) / 5).toFixed(3));
});

test('a truncated opening range fails CLOSED (insufficient-bars) — the daily high can never stand in', () => {
  const r = resolveOrbFromBars([OR[0], OR[1], bar('10:05', 104, 110, 103, 109)]);
  assert.equal(r.status, 'insufficient-bars');
});

test('unknown ADV never earns the cheapest cost tier', () => {
  assert.equal(verifyCostTier(null), 'small');
  assert.equal(verifyCostTier(0), 'small');
  assert.equal(verifyCostTier(60_000_000), 'liquid');
  assert.equal(verifyCostTier(3_000_000), 'micro');
});
