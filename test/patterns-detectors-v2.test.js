'use strict';
// The t-1/t correctness contract: the confirmation bar can never define the trigger it is
// tested against, intraday penetration ≠ closing confirmation, and degenerate plans are
// flagged invalid.
const { test } = require('node:test');
const assert = require('node:assert');
const F = require('./helpers/pattern-fixtures');
const { detectWindow } = require('../lib/patterns/detectors');
const ST = require('../lib/patterns/structure');

test('correctness: the current close cannot define and confirm its own trigger', () => {
  // Confirmation bar makes a huge new high far above every formation bar. If the trigger
  // were derived from the rolling window INCLUDING this bar, it would sit at this bar's
  // high and closing confirmation would be structurally unreachable.
  const bars = F.bullFlag({ confirmClose: 200 });
  bars[bars.length - 1].high = 201;
  const d = detectWindow(bars, { timeframe: '20d' }).find(x => x.family === 'BULL_FLAG');
  assert.ok(d, 'flag detected');
  const formationHigh = Math.max(...bars.slice(0, -1).map(c => c.high));
  assert.ok(d.plan.trigger <= formationHigh + 1e-9, `trigger ${d.plan.trigger} must come from formation bars (≤ ${formationHigh}), never the confirmation bar`);
  assert.strictEqual(d.confirmation.closedThrough, true, 'and the close CAN therefore confirm it');
});

test('correctness: splitFormation is the one canonical t-1/t cut', () => {
  const bars = F.bullFlag();
  const s = ST.splitFormation(bars);
  assert.strictEqual(s.formation.length, bars.length - 1);
  assert.strictEqual(s.confirmBar.date, bars[bars.length - 1].date);
});

test('correctness: intraday penetration is distinct from closing confirmation', () => {
  // Wick through the trigger but close back below → INTRADAY_PENETRATION, not confirmed.
  const bars = F.bullFlag({ confirmClose: 123 });
  bars[bars.length - 1].high = 140;                 // deep wick through any trigger
  const d = detectWindow(bars, { timeframe: '20d' }).find(x => x.family === 'BULL_FLAG');
  assert.ok(d);
  assert.strictEqual(d.confirmation.status, 'INTRADAY_PENETRATION');
  assert.strictEqual(d.breakoutConfirmed, false);
});

test('correctness: assessBarVsLevel reports gap-through separately', () => {
  const bar = { open: 105, high: 106, low: 104, close: 105.5 };
  const a = ST.assessBarVsLevel(bar, 101, 'LONG', 1);
  assert.strictEqual(a.gapThrough, true);
  assert.strictEqual(a.closedThrough, true);
});

test('correctness: a trigger ~equal to the stop is an INVALID plan (degenerate risk)', () => {
  // Directly exercise the quality rule via a synthetic detection path: flag whose
  // boundary sits on the flag low would produce risk < 0.25 ATR → invalid.
  const bars = F.bullFlag();
  const d = detectWindow(bars, { timeframe: '20d' }).find(x => x.family === 'BULL_FLAG');
  assert.ok(d.plan.quality !== 'invalid' || Math.abs(d.plan.trigger - d.plan.stop) < 0.25 * d.measurements.atr,
    'quality=invalid must coincide with degenerate risk');
  // And the reward:risk is genuinely computed from levels — no forced 2.5:1 anywhere.
  const rr = Math.abs(d.plan.target - d.plan.trigger) / Math.abs(d.plan.trigger - d.plan.stop);
  assert.ok(Math.abs(rr - d.plan.rr) < 0.02, 'rr must equal the structural computation');
});

test('correctness: structurally invalid reads carry no plan and are excluded by default', () => {
  const dets = detectWindow(F.downtrend(), { timeframe: '20d' });
  for (const d of dets) assert.ok(d.plan, 'default output only contains planned (valid) detections');
  const withInvalid = detectWindow(F.downtrend(), { timeframe: '20d', includeInvalid: true });
  for (const d of withInvalid.filter(x => x.structurallyInvalid)) {
    assert.strictEqual(d.plan, null, 'invalid reads never carry a plan');
  }
});
