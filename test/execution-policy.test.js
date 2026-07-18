'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const EP = require('../lib/execution-policy');
const { POLICIES } = EP;

// Helper: a candle. Weekends are simply skipped in the date sequence so "next session"
// naturally jumps a Friday→Monday gap.
const bar = (date, o, h, l, c, v = 1e6) => ({ date, open: o, high: h, low: l, close: c, volume: v });

// A tiny week: Thu, Fri, then Mon (Sat/Sun absent from the feed, like a real EOD series).
const WEEK = [
  bar('2026-01-08', 100, 101, 99, 100),   // Thu — signal bar
  bar('2026-01-09', 102, 104, 101, 103),  // Fri — next session
  bar('2026-01-12', 105, 108, 104, 107),  // Mon — the session after a weekend
];

// ── the core anti-lookahead guarantee ───────────────────────────────────────
test('a signal from day T does NOT fill on day T (fills at the next session)', () => {
  const f = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.NEXT_OPEN });
  assert.equal(f.filled, true);
  assert.equal(f.earliestFillDate, '2026-01-09');       // next session, not the signal day
  assert.notEqual(f.earliestFillDate, f.signalDate);
  assert.equal(f.fillPrice, 102);                        // the next session OPEN, not the T close (100)
  assert.equal(f.fillReason, 'next-open');
});

test('feature cutoff is the signal close; earliest executable is the next session', () => {
  const f = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.NEXT_OPEN });
  assert.equal(f.timestamps.featureCutoffAt, '2026-01-08');
  assert.equal(f.timestamps.earliestExecutableAt, '2026-01-09');
  assert.equal(f.timestamps.basis, 'daily-close-derived');
});

test('weekend transition resolves to the next valid session (Fri signal → Mon fill)', () => {
  const f = EP.planFill(WEEK, '2026-01-09', { policy: POLICIES.NEXT_OPEN });
  assert.equal(f.earliestFillDate, '2026-01-12');        // skips Sat/Sun absent from the feed
  assert.equal(f.fillPrice, 105);
});

// ── missing data never fabricates a fill ────────────────────────────────────
test('a signal on the LAST bar has no next session → unfilled, not a fabricated fill', () => {
  const f = EP.planFill(WEEK, '2026-01-12', { policy: POLICIES.NEXT_OPEN });
  assert.equal(f.filled, false);
  assert.equal(f.fillPrice, null);
  assert.equal(f.fillReason, 'no-next-session');
});

test('missing next-session open → unfilled', () => {
  const candles = [bar('2026-01-08', 100, 101, 99, 100), bar('2026-01-09', 0, 104, 101, 103)];
  const f = EP.planFill(candles, '2026-01-08', { policy: POLICIES.NEXT_OPEN });
  // open 0 falls back to close, so this still fills at close(103); prove the true-missing case:
  const missing = [bar('2026-01-08', 100, 101, 99, 100), { date: '2026-01-09', high: 104, low: 101 }];
  const g = EP.planFill(missing, '2026-01-08', { policy: POLICIES.NEXT_OPEN });
  assert.equal(f.filled, true);            // open<=0 → close fallback is acceptable
  assert.equal(g.filled, false);           // no open AND no close → genuinely unfilled
  assert.equal(g.fillReason, 'no-next-open');
});

// ── slippage is adverse and direction-aware ─────────────────────────────────
test('NEXT_OPEN_PLUS_SLIPPAGE moves a long fill UP and a short fill DOWN', () => {
  const long = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, side: 'long', slippagePct: 0.01 });
  const short = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, side: 'short', slippagePct: 0.01 });
  assert.ok(long.fillPrice > 102, `long pays up: ${long.fillPrice}`);   // 102 * 1.01
  assert.ok(short.fillPrice < 102, `short sells down: ${short.fillPrice}`); // 102 * 0.99
  assert.equal(long.slippagePct, 0.01);
});

test('tier-derived slippage matches the cost model (single source of truth)', () => {
  const { TIERS } = require('../lib/costs');
  const expected = (TIERS.micro.halfSpreadBps + TIERS.micro.slippageBps) / 10000;
  assert.equal(EP.perSideSlippagePct('micro'), expected);
  const f = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, tier: 'micro' });
  assert.equal(f.slippagePct, +expected.toFixed(6));
});

// ── stop / limit policies fill conditionally, and gaps are included ──────────
test('BREAKOUT_STOP does not fill when the trigger is never touched', () => {
  const f = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.BREAKOUT_STOP, trigger: 200 });
  assert.equal(f.filled, false);
  assert.equal(f.fillReason, 'trigger-not-touched');
});

test('BREAKOUT_STOP fills at the trigger when intraday reaches it', () => {
  // next bar high 104 ≥ trigger 103.5, open 102 < trigger → fill at the trigger (+slippage)
  const f = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.BREAKOUT_STOP, trigger: 103.5, slippagePct: 0 });
  assert.equal(f.filled, true);
  assert.equal(f.fillReason, 'stop-trigger');
  assert.equal(f.referencePrice, 103.5);
});

test('BREAKOUT_STOP gap-up through the trigger fills at the (worse) open — gaps are included', () => {
  // signal Thu; next Fri opens 102 which is already above a 101 trigger → gap-through fill at open
  const f = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.BREAKOUT_STOP, trigger: 101, slippagePct: 0 });
  assert.equal(f.filled, true);
  assert.equal(f.fillReason, 'gap-through-trigger');
  assert.equal(f.referencePrice, 102);   // the open, not the trigger
});

test('PULLBACK_LIMIT only fills if price pulls back to the limit, at the limit or better', () => {
  const noFill = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.PULLBACK_LIMIT, trigger: 90 });
  assert.equal(noFill.filled, false);
  assert.equal(noFill.fillReason, 'limit-not-touched');
  // low 101 ≤ limit 101.5, open 102 > limit → fill at the limit
  const fill = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.PULLBACK_LIMIT, trigger: 101.5 });
  assert.equal(fill.filled, true);
  assert.equal(fill.fillPrice, 101.5);
});

// ── MOC is the only same-close policy, and it says so ───────────────────────
test('MARKET_ON_CLOSE_PRECOMMITTED fills at the signal-day close and flags the assumption', () => {
  const f = EP.planFill(WEEK, '2026-01-08', { policy: POLICIES.MARKET_ON_CLOSE_PRECOMMITTED });
  assert.equal(f.filled, true);
  assert.equal(f.earliestFillDate, '2026-01-08');   // same day, by design
  assert.equal(f.fillPrice, 100);                   // the signal close
  assert.equal(f.fillReason, 'moc-precommitted');
  assert.ok(f.assumptions.join(' ').includes('pre-committed'));
});

// ── versioning ──────────────────────────────────────────────────────────────
test('every fill record carries the execution-policy version', () => {
  const f = EP.planFill(WEEK, '2026-01-08', {});
  assert.equal(f.version, EP.EXECUTION_POLICY_VERSION);
  assert.equal(f.policy, EP.DEFAULT_POLICY);        // NEXT_OPEN_PLUS_SLIPPAGE default
});
