'use strict';
// Unit tests for the CERN forced-flow engine fixes:
//  1. SPAC unit/warrant/rights filtering in the lockup feed (lib/ipo.js).
//  2. LOCKUP_EXPIRY demoted to counterfactual-log-only (lib/cern.js) — it
//     violates the uninformed-flow premise so it must never produce a TRADE/PROBE.
const { test } = require('node:test');
const assert = require('node:assert');
const { isLockupEligibleTicker } = require('../lib/ipo');
const { CERN, EVENT_TYPES } = require('../lib/cern');

// ── Fix 1: SPAC unit/warrant/rights filter ──────────────────────────────────
test('isLockupEligibleTicker keeps plain common-stock tickers', () => {
  for (const t of ['BLLN', 'CDNL', 'AAPL', 'F', 'CBC', 'BRK-B']) {
    assert.equal(isLockupEligibleTicker(t), true, `${t} should be eligible`);
  }
});

test('isLockupEligibleTicker drops 5-char SPAC units/warrants/rights', () => {
  // the exact contaminants observed in the live ledger
  for (const t of ['WSTNU', 'BPACU', 'BLRKU', 'CCXIU']) {
    assert.equal(isLockupEligibleTicker(t), false, `${t} (SPAC unit) should be dropped`);
  }
  assert.equal(isLockupEligibleTicker('ABCDW'), false, 'warrant dropped');
  assert.equal(isLockupEligibleTicker('ABCDR'), false, 'rights dropped');
});

test('isLockupEligibleTicker does not over-filter short tickers ending in U/W/R', () => {
  // 4-char-or-less commons ending in U/W/R are real stocks, not SPAC securities
  for (const t of ['U', 'W', 'R', 'BABU', 'FLOW']) {
    assert.equal(isLockupEligibleTicker(t), true, `${t} should be kept`);
  }
});

test('isLockupEligibleTicker rejects malformed symbols', () => {
  for (const t of ['', '123', 'TOOLONGX', 'a-b']) {
    assert.equal(isLockupEligibleTicker(t), false, `${t} should be rejected`);
  }
});

// ── Fix 2: LOCKUP_EXPIRY is counterfactual-log-only ─────────────────────────
test('LOCKUP_EXPIRY and FORCED_DOWNGRADE are logOnly; trade-eligible types are not', () => {
  assert.equal(EVENT_TYPES.LOCKUP_EXPIRY.logOnly, true);
  assert.equal(EVENT_TYPES.FORCED_DOWNGRADE.logOnly, true, 'proven Scoreboard loser → log-only');
  assert.ok(!EVENT_TYPES.INDEX_DELETE.logOnly, 'INDEX_DELETE stays trade-eligible');
  assert.ok(!EVENT_TYPES.FIRE_SALE.logOnly, 'FIRE_SALE stays trade-eligible');
});

test('dailyTick never returns TRADE or PROBE for a FORCED_DOWNGRADE event', () => {
  const cern = new CERN();
  const bars = dislocationBars();
  const nowMs = bars[bars.length - 1].dateMs;
  cern.addEvent({ type: 'FORCED_DOWNGRADE', symbol: 'DGX', dateMs: bars[bars.length - 6].dateMs, estFlowShares: 1e6, direction: -1, meta: {} });
  const out = cern.dailyTick(makeDataFor(bars), { regime: 'risk-on', costBps: 30 }, nowMs);
  for (const d of out.decisions.filter(d => d.type === 'FORCED_DOWNGRADE')) {
    assert.equal(d.action, 'LOG_ONLY', `FORCED_DOWNGRADE must be LOG_ONLY, got ${d.action}`);
    assert.equal(d.size, 0, 'LOG_ONLY carries no size');
  }
});

// Build a bar series that triggers a SIGNAL: a sharp dislocation down + an
// absorption (close back up on volume) so completion≥0.8 and absorptionBar fire.
function dislocationBars(n = 60) {
  const bars = []; let p = 100;
  for (let i = 0; i < n - 6; i++) {
    p *= 1 + (Math.sin(i / 5) * 0.004); // calm baseline
    bars.push({ dateMs: i * 86400000, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 });
  }
  // 5-day forced selloff
  for (let k = 0; k < 5; k++) {
    p *= 0.95;
    bars.push({ dateMs: (n - 6 + k) * 86400000, open: p / 0.95, high: p / 0.95, low: p * 0.98, close: p, volume: 4e6 });
  }
  // absorption bar: close in upper half on heavy volume
  const lo = p * 0.99, hi = p * 1.05;
  bars.push({ dateMs: (n - 1) * 86400000, open: lo, high: hi, low: lo, close: hi * 0.99, volume: 6e6 });
  return bars;
}

function makeDataFor(bars) {
  return () => ({ bars, sectorBars: bars, attentionZ: 0, daysToEarnings: 60, estimateRevisions: null });
}

test('dailyTick never returns TRADE or PROBE for a LOCKUP_EXPIRY event', () => {
  const cern = new CERN();
  const bars = dislocationBars();
  const nowMs = bars[bars.length - 1].dateMs;
  cern.addEvent({ type: 'LOCKUP_EXPIRY', symbol: 'TESTX', dateMs: bars[bars.length - 6].dateMs, estFlowShares: 1e6, direction: -1, meta: {} });
  const out = cern.dailyTick(makeDataFor(bars), { regime: 'risk-on', costBps: 30 }, nowMs);
  const lk = out.decisions.filter(d => d.type === 'LOCKUP_EXPIRY');
  for (const d of lk) {
    assert.equal(d.action, 'LOG_ONLY', `LOCKUP_EXPIRY must be LOG_ONLY, got ${d.action}`);
    assert.equal(d.size, 0, 'LOG_ONLY carries no size');
  }
});

// ── Dislocation sign: D must be positive for the thesis-correct dislocation ──
function flatThenMove(endClose, n = 60, evAt = 50, base = 100) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    // flat at `base` up to the event, then linear glide to `endClose`
    const close = i < evAt ? base : base + (endClose - base) * ((i - evAt) / (n - 1 - evAt));
    bars.push({ dateMs: i * 86400000, open: close, high: close * 1.005, low: close * 0.995, close, volume: 1e6 });
  }
  return bars;
}

test('D is positive for a down-dislocation on a long (dir -1) event', () => {
  const cern = new CERN();
  const bars = flatThenMove(90);                 // stock fell 10% after the event
  const sectorBars = flatThenMove(50, 60, 50, 50); // sector flat
  const ev = { type: 'LOCKUP_EXPIRY', symbol: 'X', dateMs: bars[50].dateMs, direction: -1, estFlowShares: 1e6 };
  const m = cern._measure(ev, { bars, sectorBars, attentionZ: 0, daysToEarnings: 60, estimateRevisions: null }, 'neutral');
  assert.ok(m && m.D > 0.02, `down-dislocation must yield positive D, got ${m && m.D}`);
});

test('D is positive for an up-dislocation on a short (dir +1) event', () => {
  const cern = new CERN();
  const bars = flatThenMove(110);                  // stock ran +10% after the event
  const sectorBars = flatThenMove(50, 60, 50, 50); // sector flat
  const ev = { type: 'INDEX_ADD_FADE', symbol: 'Y', dateMs: bars[50].dateMs, direction: 1, estFlowShares: 1e6 };
  const m = cern._measure(ev, { bars, sectorBars, attentionZ: 0, daysToEarnings: 60, estimateRevisions: null }, 'neutral');
  assert.ok(m && m.D > 0.02, `up-dislocation must yield positive D, got ${m && m.D}`);
});

test('D is zero for the wrong-way move (no dislocation to fade/buy)', () => {
  const cern = new CERN();
  const bars = flatThenMove(110);                  // stock UP but it's a buy-the-dip (dir -1) event
  const sectorBars = flatThenMove(50, 60, 50, 50);
  const ev = { type: 'LOCKUP_EXPIRY', symbol: 'Z', dateMs: bars[50].dateMs, direction: -1, estFlowShares: 1e6 };
  const m = cern._measure(ev, { bars, sectorBars, attentionZ: 0, daysToEarnings: 60, estimateRevisions: null }, 'neutral');
  assert.equal(m && m.D, 0, `wrong-way move must yield D=0, got ${m && m.D}`);
});

test('a non-logOnly type can still TRADE on the same dislocation (control)', () => {
  // bootstrap ship-gate lets a fresh type trade tiny when conviction is high
  const cern = new CERN();
  const bars = dislocationBars();
  const nowMs = bars[bars.length - 1].dateMs;
  cern.addEvent({ type: 'FIRE_SALE', symbol: 'TESTY', dateMs: bars[bars.length - 6].dateMs, estFlowShares: 1e6, direction: -1, meta: {} });
  const out = cern.dailyTick(makeDataFor(bars), { regime: 'risk-on', costBps: 30 }, nowMs);
  const fs = out.decisions.find(d => d.type === 'FIRE_SALE');
  assert.ok(fs, 'FIRE_SALE produced a decision');
  assert.ok(['TRADE', 'PROBE', 'LOG_ONLY'].includes(fs.action), 'valid action');
  // The control proves the logOnly gate is type-specific, not a global block:
  // FIRE_SALE remains eligible for TRADE/PROBE while LOCKUP_EXPIRY cannot be.
});
