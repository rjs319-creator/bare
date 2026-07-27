'use strict';
// PHASES 6-9 — feature schema, Stage A, Stage B, inventory states
// (docs/premove-transition-v2.md). Required regressions:
//   - features computed only from candles ≤ decision cutoff; missing stays missing;
//   - Stage A labels are competing-risk with censoring; censored ≠ negative;
//   - no model artifact ⇒ rank/evidence band only, NEVER a probability;
//   - stale/mismatched calibration ⇒ no probability;
//   - Stage B: no trigger means watch/wait, not buy; the utility waterfall is
//     inspectable and sums; outputs stay separate and named;
//   - inventory states map from the supervisor lifecycle; probability display
//     gates hold end to end.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const PF = require('../lib/premove-features');
const SA = require('../lib/premove-stage-a');
const SB = require('../lib/premove-stage-b');
const INV = require('../lib/premove-inventory');
const FLAGS = require('../lib/premove-flags');
const { LIFECYCLE } = require('../lib/swing-lifecycle');

function candles(n, px = 50, drift = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 5 + Math.floor(i / 5) * 7 + (i % 5)));
    const c = px * (1 + drift * i + (i % 2 ? 0.004 : -0.004));
    out.push({ date: d.toISOString().slice(0, 10), open: c, high: c * 1.006, low: c * 0.994, close: c, volume: 1e6 + i * 1e3 });
  }
  return out;
}

// ── feature schema ───────────────────────────────────────────────────────────
test('features use only candles at or before the decision cutoff', () => {
  const cs = candles(90, 50);
  const asOf = cs[79].date;
  const wild = cs.map((c, i) => (i >= 80 ? { ...c, close: c.close * 5, high: c.high * 5 } : c));
  const a = PF.computePremoveFeatures({ candles: cs, asOf });
  const b = PF.computePremoveFeatures({ candles: wild, asOf });
  assert.deepEqual(b.values, a.values, 'post-cutoff candles must not change any feature');
  assert.equal(a.asOf, asOf);
});

test('missing inputs stay missing with explicit masks — never imputed bullish', () => {
  const cs = candles(90, 50).map(c => ({ ...c, volume: null }));   // no volume anywhere
  const f = PF.computePremoveFeatures({ candles: cs });
  assert.equal(f.values.turnoverPct, null);
  assert.equal(f.values.downImpact, null);
  assert.ok(f.missing.includes('turnoverPct'));
  assert.ok(f.missing.includes('downImpact'));
  // No benchmark → residuals missing AND the basis is labeled.
  assert.equal(f.values.resid20, null);
  assert.equal(f.residualBasis, 'none');
  const withBench = PF.computePremoveFeatures({ candles: candles(90, 50), benchCandles: candles(90, 400) });
  assert.equal(withBench.residualBasis, 'market-only');
  assert.ok(withBench.missing.includes('sector-benchmark(market-only-residual)'));
});

test('the schema exposes a stable versioned key list', () => {
  assert.equal(PF.PREMOVE_FEATURE_VERSION, 'premove-features-v1');
  assert.ok(PF.FEATURE_KEYS.includes('bbPctile'));
  assert.ok(PF.FEATURE_KEYS.includes('retXTurnover'));
  assert.ok(PF.FEATURE_KEYS.includes('absorptionTrend'));
  assert.ok(PF.FEATURE_KEYS.includes('remainingRR'));
  assert.ok(PF.FEATURE_KEYS.includes('catalystAgeDays'));
});

// ── Stage A labels ───────────────────────────────────────────────────────────
test('Stage A labels are competing-risk; a partial window is censored, not a negative', () => {
  const flat = candles(30, 100);
  const label = SA.stageALabel({ date: flat[29].date, ticker: 'T', entry: 110, stop: 90 }, flat);
  assert.equal(label.horizons[5].event, 'censored');
  const withDown = candles(30, 100).concat(
    Array.from({ length: 6 }, (_, i) => ({ ...candles(36, 100)[30 + i], open: 80, high: 81, low: 79, close: 80 })));
  const l2 = SA.stageALabel({ date: withDown[29].date, ticker: 'T', entry: 110, stop: 90 }, withDown);
  assert.equal(l2.horizons[5].event, 'down');
  assert.equal(l2.horizons[5].version, SA.STAGE_A_LABEL_VERSION);
});

// ── Stage A model + output gating ────────────────────────────────────────────
test('fitStageA is deterministic and refuses tiny samples', () => {
  const tiny = SA.fitStageA([{ features: { ret5: 0.1 }, y: 1 }]);
  assert.equal(tiny.status, 'insufficient-data');
  const rows = Array.from({ length: 60 }, (_, i) => ({
    features: { ret5: i % 2 ? 0.05 : -0.05, resid20: i % 2 ? 0.06 : -0.06 },
    y: i % 2,
  }));
  const m1 = SA.fitStageA(rows);
  const m2 = SA.fitStageA(rows);
  assert.equal(m1.status, 'fitted');
  assert.deepEqual(m1.weights, m2.weights, 'byte-identical refits');
  const up = SA.scoreStageA(m1, { ret5: 0.05, resid20: 0.06 });
  const dn = SA.scoreStageA(m1, { ret5: -0.05, resid20: -0.06 });
  assert.ok(up > dn, 'the model learned the separable direction');
});

test('missing model artifact ⇒ rank/evidence band only, no probability', () => {
  const cands = [
    { ticker: 'A', features: { ret5: 0.05, resid20: 0.06 } },
    { ticker: 'B', features: { ret5: -0.05, resid20: -0.06 } },
  ];
  const gate = FLAGS.premoveGate({ mode: 'shadow', artifact: null });
  const out = SA.stageACrossSection(cands, null, gate);
  for (const r of out) {
    assert.equal(r.pTriggerBeforeInvalidation, null, 'NEVER a probability without a model+calibration');
    assert.equal(r.calibrationStatus, 'uncalibrated');
    assert.equal(r.modelStatus, 'no-model');
  }
});

test('stale/mismatched calibration artifact ⇒ still no probability (fail closed)', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ features: { ret5: i % 2 ? 0.05 : -0.05 }, y: i % 2 }));
  const model = SA.fitStageA(rows);
  const staleArtifact = {
    kind: 'calibration', modelVersion: 'x', featureVersion: 'premove-features-v0',  // WRONG schema version
    labelVersion: FLAGS.LIVE_VERSIONS.labelVersion, executionPolicyVersion: FLAGS.LIVE_VERSIONS.executionPolicyVersion,
    universePolicy: FLAGS.LIVE_VERSIONS.universePolicy, trainedThrough: '2026-01-01', status: 'validated',
  };
  const gate = FLAGS.premoveGate({ mode: 'shadow', artifact: staleArtifact, kind: 'calibration' });
  assert.equal(gate.showProbabilities, false);
  const out = SA.stageACrossSection([{ ticker: 'A', features: { ret5: 0.05 } }], model, gate);
  assert.equal(out[0].pTriggerBeforeInvalidation, null);
  assert.ok(out[0].preMoveRank != null, 'rank percentile still available');
  assert.ok(out[0].evidenceBand, 'qualitative band still available');
});

// ── Stage B ──────────────────────────────────────────────────────────────────
test('no trigger means watch/wait, never buy', () => {
  const r = SB.assessStageB({ trigger: { triggered: false, reason: 'level-not-touched' }, current: 100, entry: 110, stop: 95, target: 130, dailyVol: 0.02 });
  assert.equal(r.state, 'WATCH');
  assert.equal(r.action, 'wait');
  assert.equal(r.probabilities, null);
});

test('a one-tick touch without acceptance/confirmation is not a trigger', () => {
  const base = { meanRange20: 1, meanVol20: 1e6 };
  const wickTag = SB.evaluateTrigger({ bar: { open: 100, high: 110.1, low: 99, close: 100.5, volume: 9e5 }, level: 110, base });
  assert.equal(wickTag.triggered, false);
  assert.equal(wickTag.reason, 'touch-without-acceptance');
  const accepted = SB.evaluateTrigger({ bar: { open: 108, high: 111, low: 107, close: 110.6, volume: 1.5e6 }, level: 110, base });
  assert.equal(accepted.triggered, true);
  assert.equal(accepted.executable, true);
  const gapped = SB.evaluateTrigger({ bar: { open: 120, high: 121, low: 118, close: 120, volume: 2e6 }, level: 110, base });
  assert.equal(gapped.triggered, true);
  assert.equal(gapped.executable, false, 'gap beyond max entry is a refused fill');
});

test('the utility waterfall is inspectable, sums exactly, and outputs stay separate', () => {
  const trig = SB.evaluateTrigger({ bar: { open: 108, high: 111, low: 107, close: 110.6, volume: 1.5e6 }, level: 110, base: { meanRange20: 1, meanVol20: 1e6 } });
  const r = SB.assessStageB({ trigger: trig, current: 110.6, entry: 110, stop: 100, target: 130, dailyVol: 0.03, tier: 'small', holdSessions: 10 });
  assert.ok(r.waterfall, 'waterfall present');
  const sum = r.waterfall.rows.reduce((s, x) => s + x.bps, 0);
  assert.ok(Math.abs(sum - r.waterfall.expectedNetUtilityBps) < 0.101, 'waterfall rows sum to the net utility');
  const p = r.probabilities;
  assert.ok(p.pFillGivenTrigger != null && p.pTargetBeforeStopGivenFill != null && p.severeLossProbability != null);
  assert.equal(p.calibrationStatus, 'model-estimate', 'barrier outputs are labeled model estimates');
  assert.ok(r.remainingOpportunity != null);
  assert.ok(!('confidence' in r), 'no collapsed confidence number anywhere');
});

// ── inventory states + display gate ──────────────────────────────────────────
test('inventory states map from the supervisor lifecycle (no new state machine)', () => {
  const ep = (lc) => ({ assessment: { lifecycle: lc } });
  assert.equal(INV.premoveState(ep(LIFECYCLE.WAITING_FOR_TRIGGER)), INV.STATES.PRIMED);
  assert.equal(INV.premoveState({ assessment: { lifecycle: LIFECYCLE.WAITING_FOR_TRIGGER }, nearTrigger: true }), INV.STATES.ARMED, 'waiting + near the trigger = ARMED');
  assert.equal(INV.premoveState({ assessment: null, nearTrigger: true }), INV.STATES.ARMED);
  assert.equal(INV.premoveState(ep(LIFECYCLE.ENTERABLE)), INV.STATES.ARMED);
  assert.equal(INV.premoveState(ep(LIFECYCLE.TRIGGERED)), INV.STATES.TRIGGERED);
  assert.equal(INV.premoveState(ep(LIFECYCLE.TRIGGERED), { waterfall: { expectedNetUtilityBps: 50 } }), INV.STATES.ACCEPTED);
  assert.equal(INV.premoveState(ep(LIFECYCLE.WEAKENING)), INV.STATES.WEAKENING);
  assert.equal(INV.premoveState(ep(LIFECYCLE.INVALIDATED)), INV.STATES.INVALIDATED);
  assert.equal(INV.premoveState(ep(LIFECYCLE.EXPIRED)), INV.STATES.EXPIRED);
  assert.equal(INV.premoveState(ep(LIFECYCLE.TARGET_HIT)), INV.STATES.COMPLETED);
});

test('cards carry novice AND expert views; percentages blocked without calibration', () => {
  const gate = FLAGS.premoveGate({ mode: 'shadow', artifact: null });
  const card = INV.inventoryCard({
    ticker: 'T', state: INV.STATES.PRIMED,
    stageA: { preMoveRank: 0.9, evidenceBand: 'very-high', pTriggerBeforeInvalidation: 0.7 },
    stageB: null, invalidation: 95, timeframeSessions: 21,
  }, gate);
  assert.equal(card.novice.action, 'watch');
  assert.equal(card.novice.invalidation, 95);
  assert.equal(card.expert.pTriggerBeforeInvalidation.isPercent, false, 'no % without calibration');
  assert.match(card.expert.pTriggerBeforeInvalidation.display, /experimental score/);
  assert.equal(card.expert.preMoveRank, 0.9);
  assert.ok(card.expert.shadowLabel, 'uncalibrated/shadow label present');
});

test('the board never blends outputs and reports every state bucket', () => {
  const gate = FLAGS.premoveGate({ mode: 'shadow', artifact: null });
  const board = INV.buildInventoryBoard([
    { ticker: 'A', state: INV.STATES.PRIMED, stageA: {}, stageB: null },
    { ticker: 'B', state: INV.STATES.INVALIDATED, stageA: {}, stageB: null, displacement: ['STOP_BREACH'] },
  ], gate);
  assert.deepEqual(board.states, Object.keys(INV.STATES));
  assert.equal(board.counts.PRIMED, 1);
  assert.equal(board.counts.INVALIDATED, 1);
  assert.ok(board.byState.INVALIDATED[0].expert.displacement, 'a dropped candidate carries its reason — no silent disappearance');
});
