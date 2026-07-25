'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { decidePattern, ACTIONS } = require('../lib/patterns/decision');
const { buildPrediction } = require('../lib/patterns/predict');
const { computeFreshness, etDate } = require('../lib/freshness');

const ET = etDate();
const nowIso = new Date().toISOString();
const freshToday = () => computeFreshness({ barDate: ET, intradayBarAsOf: nowIso, quoteAsOf: nowIso });
const liveIntraday = { aboveVwap: true, triggerConfirmed: true, momentumOk: true, residualOk: true, relVolOk: true, remainingRR: 2.5, extensionAtr: 0.5, session: 'regular', nearTrigger: true };

function det(over = {}) {
  return {
    family: 'BULL_FLAG', direction: 'LONG', ticker: 'ABC', phase: 'CONFIRMED', invalidationHit: false,
    extensionAtr: 0.3, patternAsOf: ET, plan: { trigger: 100, stop: 97, target: 110, rr: 3.3 },
    similarity: { combined: 0.8 }, geometry: { lastClose: 100.5 }, ...over,
  };
}

// ---- lifecycle-gated actions ----

test('decision: FORMING never shows Buy Now', () => {
  const d = decidePattern(det({ phase: 'FORMING' }), { now: nowIso, freshness: freshToday(), intraday: liveIntraday });
  assert.notStrictEqual(d.action, ACTIONS.ACTIONABLE_NOW);
  assert.strictEqual(d.action, ACTIONS.FORMING);
});

test('decision: NEAR_TRIGGER shows Wait', () => {
  const d = decidePattern(det({ phase: 'NEAR_TRIGGER' }), { now: nowIso, freshness: freshToday() });
  assert.strictEqual(d.action, ACTIONS.WAIT_FOR_TRIGGER);
});

test('decision: confirmed + live-fresh + PROVEN can become ACTIONABLE_NOW', () => {
  const d = decidePattern(det({ phase: 'CONFIRMED' }), { now: nowIso, freshness: freshToday(), intraday: liveIntraday, analog: { calibrated: true, sufficient: true } });
  assert.strictEqual(d.action, ACTIONS.ACTIONABLE_NOW);
  assert.strictEqual(d.actionable, true);
});

test('decision: confirmed + live-fresh but UNPROVEN edge = RESEARCH_ONLY (not a buy)', () => {
  const d = decidePattern(det({ phase: 'CONFIRMED' }), { now: nowIso, freshness: freshToday(), intraday: liveIntraday });
  assert.strictEqual(d.action, ACTIONS.RESEARCH_ONLY);
  assert.strictEqual(d.actionable, false);
});

test('decision: daily-only (no live intraday) can never be ACTIONABLE_NOW', () => {
  const d = decidePattern(det({ phase: 'CONFIRMED' }), { now: nowIso, freshness: freshToday(), analog: { calibrated: true, sufficient: true } });
  assert.notStrictEqual(d.action, ACTIONS.ACTIONABLE_NOW);
});

test('decision: stale prior-session confirmed = NO_ACTION_STALE (fails closed)', () => {
  const d = decidePattern(det({ phase: 'CONFIRMED', patternAsOf: '2020-01-01' }), { now: nowIso });
  assert.strictEqual(d.action, ACTIONS.NO_ACTION_STALE);
});

test('decision: invalidation hit is FAILED (stale) / EXIT_INVALIDATED (live), never revived', () => {
  const stale = decidePattern(det({ invalidationHit: true, patternAsOf: '2020-01-01' }), { now: nowIso });
  assert.strictEqual(stale.action, ACTIONS.FAILED);
  // A live invalidation with no open position is FAILED (EXIT_INVALIDATED needs a position
  // to exit). Either way it is never revived to actionable.
  const live = decidePattern(det({ invalidationHit: true, patternAsOf: ET }), { now: nowIso, freshness: freshToday(), intraday: liveIntraday, analog: { calibrated: true, sufficient: true } });
  assert.ok([ACTIONS.FAILED, ACTIONS.EXIT_INVALIDATED].includes(live.action), 'a failed setup cannot be revived to actionable');
  assert.strictEqual(live.actionable, false);
});

test('decision: HIMS-style — prior-session bullish pattern + current collapse is not actionable', () => {
  // Bullish flag detected on a prior session, but today the name is down hard (invalidation +
  // not current-session fresh). Must not produce buy language.
  const collapsed = decidePattern(det({ phase: 'CONFIRMED', invalidationHit: true, patternAsOf: '2026-07-23' }), {
    now: nowIso, freshness: computeFreshness({ barDate: '2026-07-23' }),
  });
  assert.ok([ACTIONS.FAILED, ACTIONS.NO_ACTION_STALE, ACTIONS.EXIT_INVALIDATED].includes(collapsed.action));
  assert.strictEqual(collapsed.actionable, false);
});

test('decision: over-extended = DO_NOT_CHASE', () => {
  const d = decidePattern(det({ phase: 'EXTENDED', extensionAtr: 3.2 }), { now: nowIso, freshness: freshToday(), intraday: liveIntraday });
  assert.strictEqual(d.action, ACTIONS.DO_NOT_CHASE);
});

// ---- prediction honesty ----

test('prediction: barrier outcome probabilities are coherent (sum ~1)', () => {
  const p = buildPrediction(det(), { dailyVol: 0.025, horizonBars: 10 });
  assert.ok(p.available);
  const sum = p.targetBeforeStop + p.stopBeforeTarget;
  assert.ok(Math.abs(sum - 1) < 1e-6, `target+stop given-fill should sum to 1, got ${sum}`);
});

test('prediction: uncalibrated barrier estimate is NOT labeled calibrated', () => {
  const p = buildPrediction(det(), { dailyVol: 0.025, horizonBars: 10 });
  assert.strictEqual(p.calibrated, false);
  assert.strictEqual(p.calibrationStatus, 'model-estimate');
});

test('prediction: small analog sample does NOT assert calibration', () => {
  const p = buildPrediction(det(), { dailyVol: 0.025, analog: { targetFirstRate: 0.6, baselineRate: 0.55, effectiveN: 3, calibrated: false } });
  assert.strictEqual(p.calibrated, false);
});

test('prediction: incremental lift is measured vs baseline, not the raw rate', () => {
  const p = buildPrediction(det(), { dailyVol: 0.025, analog: { targetFirstRate: 0.62, baselineRate: 0.61, effectiveN: 200, calibrated: true } });
  assert.ok(Math.abs(p.incrementalLift - 0.01) < 1e-9, 'lift = 0.62 - 0.61 = 0.01, not 0.62');
});

test('prediction: round-trip costs can turn a positive gross RR into a non-positive expectation', () => {
  // A wide stop / thin edge with a hard cost: net expected R should be dragged down by costR.
  const p = buildPrediction(det({ plan: { trigger: 10, stop: 9.9, target: 10.2, rr: 2 } }), { dailyVol: 0.02, horizonBars: 5, roundTripCostPct: 0.01 });
  assert.ok(p.available);
  assert.ok(p.expectedNetR <= 0.05, `cost should suppress expectation, got ENR ${p.expectedNetR}`);
});
