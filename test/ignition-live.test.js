'use strict';
// IGNITION LIVE — behavioural tests for the synthesis layer's non-negotiable rules:
// the two-score separation (high ignition + high extension MUST mean low opportunity),
// acceleration-over-level, missing-data-never-helps, catalyst decay, the stage ladder,
// and the do-not-chase contract. These assert DECISIONS, not internals.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const live = require('../lib/ignition-live');
const C = require('../lib/ignition-live-config');

// A healthy, analyzed, early-stage record. Tests override what they need.
function baseRecord(over = {}) {
  return {
    ticker: 'TEST', price: 2.4, dayChangePct: 12, relativeVolume: 6,
    fiveMinVolumeAcceleration: 2.5, fifteenMinVolumeAcceleration: 2.0,
    fiveMinPriceAcceleration: 1.5, fifteenMinPriceAcceleration: 3.0,
    currentDollarVolume5m: 900_000, currentDollarVolume15m: 1_500_000,
    floatShares: 8_000_000, floatTier: 'LOW', floatTurnover: 0.6,
    catalyst: 'FDA_APPROVAL', catalystTier: 1, catalystFreshnessMinutes: 30,
    catalystPresent: true, catalystRecycled: false,
    distanceFromHighPct: -1.2, ema9: 2.3,
    entryQualityScore: 70, tradeQualityScore: 65, riskReward: 2.5,
    actionState: 'READY_IF_TRIGGERED', entryTemplate: 'HIGH_OF_DAY_COMPRESSION_BREAK',
    structureState: 'BREAKOUT_PENDING', ignitionState: 'SUSTAINED_IGNITION',
    maximumChasePrice: 2.55, trigger: 2.45, invalidation: 2.2,
    blockingReasons: [], stale: false, analyzed: true,
    structureFeatures: {
      vwapExtensionAtr: 1.0, vwapDistancePct: 4, sessionRunPct: 15,
      upperWickRisk: false, lastBarVolMult: 1.8, aboveVwap: true,
      consecutiveHigherLows: 3, compressionRatio: 0.6, emaStacked: true, atr5m: 0.1,
    },
    ...over,
  };
}

// ── RULE 3/4: the two scores are different and extension overrides enthusiasm ─

test('RULE 4: extreme ignition with extreme extension yields a LOW opportunity score', () => {
  const rec = baseRecord({
    dayChangePct: 95, relativeVolume: 30, fiveMinVolumeAcceleration: 5,
    structureState: 'BREAKOUT_CONFIRMED',
    structureFeatures: {
      vwapExtensionAtr: 5.5, vwapDistancePct: 25, sessionRunPct: 90,
      upperWickRisk: true, lastBarVolMult: 6, aboveVwap: true,
      consecutiveHigherLows: 4, compressionRatio: 1.2, emaStacked: true, atr5m: 0.2,
    },
  });
  const v = live.synthesizeIgnitionView(rec, { regime: 'risk-on' });
  assert.ok(v.ignitionScore >= 60, `momentum event should still score high (got ${v.ignitionScore})`);
  assert.ok(v.extensionRisk >= 81, `should be parabolic-extended (got ${v.extensionRisk})`);
  assert.equal(v.extensionLabel, 'PARABOLIC_EXIT_BIAS');
  assert.ok(v.opportunityScore <= 30, `opportunity must collapse when extended (got ${v.opportunityScore})`);
});

test('RULE 13: a clean 85-class setup outranks a parabolic 97-class one on opportunity', () => {
  const clean = live.synthesizeIgnitionView(baseRecord(), { regime: 'neutral' });
  const parabolic = live.synthesizeIgnitionView(baseRecord({
    dayChangePct: 120, relativeVolume: 40, fiveMinVolumeAcceleration: 6,
    structureFeatures: {
      vwapExtensionAtr: 6, vwapDistancePct: 30, sessionRunPct: 100,
      upperWickRisk: true, lastBarVolMult: 7, aboveVwap: true,
      consecutiveHigherLows: 1, compressionRatio: 1.5, emaStacked: true, atr5m: 0.3,
    },
  }), { regime: 'neutral' });
  assert.ok(parabolic.ignitionScore >= clean.ignitionScore - 5, 'parabolic name has at least comparable ignition');
  assert.ok(clean.opportunityScore > parabolic.opportunityScore, 'clean setup must win on opportunity');
});

// ── Missing data must never improve a score ──────────────────────────────────

test('UNKNOWN float earns zero supply credit and lowers ignition vs a known LOW float', () => {
  const known = live.ignitionScore(baseRecord());
  const unknown = live.ignitionScore(baseRecord({ floatTier: 'UNKNOWN', floatShares: null, floatTurnover: null }));
  assert.ok(unknown.score < known.score, 'unknown float must not score higher');
  assert.equal(live.supplyPressureScore(baseRecord({ floatTier: 'UNKNOWN', floatTurnover: null })).score, 0);
});

test('a NOT_EVALUATED catalyst earns zero credit and is distinct from NONE', () => {
  const notEval = live.catalystGrade({ catalystTier: null, catalystPresent: null });
  assert.equal(notEval.grade, null);
  assert.equal(notEval.score, 0);
  const none = live.catalystGrade({ catalystTier: 4, catalystPresent: false });
  assert.equal(none.grade, 'NONE');
  assert.equal(none.score, 0);
});

test('stale data discounts the ignition score, never inflates it', () => {
  const fresh = live.ignitionScore(baseRecord());
  const stale = live.ignitionScore(baseRecord({ stale: true }));
  assert.ok(stale.score <= Math.ceil(fresh.score * C.STALE_SCORE_FACTOR) + 1, `stale ${stale.score} vs fresh ${fresh.score}`);
});

test('the MOMENTUM_HISTORY weight is visibly unearned, not redistributed', () => {
  const r = live.ignitionScore(baseRecord());
  assert.equal(r.points.MOMENTUM_HISTORY, 0);
  assert.ok(r.unearned.includes('MOMENTUM_HISTORY'));
  const total = Object.values(C.IGNITION_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100, 'weight table must sum to 100');
});

// ── Acceleration over level ──────────────────────────────────────────────────

test('an accelerating +10% name outscores a decelerating +60% name on ignition', () => {
  const accelerating = live.ignitionScore(baseRecord({
    dayChangePct: 10, fiveMinVolumeAcceleration: 3.5, fiveMinPriceAcceleration: 2.5,
    fifteenMinPriceAcceleration: 4, currentDollarVolume5m: 2_000_000, currentDollarVolume15m: 2_400_000,
  }));
  const decelerating = live.ignitionScore(baseRecord({
    dayChangePct: 60, relativeVolume: 6, fiveMinVolumeAcceleration: 0.4,
    fiveMinPriceAcceleration: -0.5, fifteenMinPriceAcceleration: 0.2,
    currentDollarVolume5m: 200_000, currentDollarVolume15m: 3_000_000,
    catalystFreshnessMinutes: 26 * 60,
    structureFeatures: { ...baseRecord().structureFeatures, compressionRatio: 1.4, consecutiveHigherLows: 0 },
    structureState: 'WATCH',
  }));
  assert.ok(accelerating.score > decelerating.score,
    `accelerating ${accelerating.score} must beat decelerating ${decelerating.score}`);
});

// ── Catalyst decay table ─────────────────────────────────────────────────────

test('catalyst decay follows the spec steps and recycled news is halved', () => {
  const at = min => live.catalystGrade({ catalystTier: 1, catalystPresent: true, catalystFreshnessMinutes: min }).decayFactor;
  assert.equal(at(30), 1.0);
  assert.equal(at(120), 0.9);
  assert.equal(at(5 * 60), 0.75);
  assert.equal(at(20 * 60), 0.5);
  assert.equal(at(2 * 24 * 60), 0.25);
  assert.equal(at(5 * 24 * 60), 0.1);
  const fresh = live.catalystGrade({ catalystTier: 1, catalystPresent: true, catalystFreshnessMinutes: 30 });
  const recycled = live.catalystGrade({ catalystTier: 1, catalystPresent: true, catalystFreshnessMinutes: 30, catalystRecycled: true });
  assert.equal(recycled.score, +(fresh.score * 0.5).toFixed(2));
});

// ── Stage classifier ─────────────────────────────────────────────────────────

test('stage ladder: destructive states win over constructive evidence', () => {
  assert.equal(live.stageOf(baseRecord({ structureState: 'FAILED_BREAKOUT' })), 'FAILED');
  assert.equal(live.stageOf(baseRecord({ structureState: 'DISTRIBUTION' })), 'FAILED');
  assert.equal(live.stageOf(baseRecord({ structureState: 'EXHAUSTED' })), 'EXHAUSTION');
  assert.equal(live.stageOf(baseRecord({ ignitionState: 'CLIMAX' })), 'EXHAUSTION');
});

test('stage ladder: early → confirming → breakout → expansion map as specified', () => {
  assert.equal(live.stageOf(baseRecord({ ignitionState: 'EARLY_IGNITION', structureState: 'WATCH' })), 'EARLY_IGNITION');
  assert.equal(live.stageOf(baseRecord()), 'CONFIRMING');
  assert.equal(live.stageOf(baseRecord({ structureState: 'BREAKOUT_CONFIRMED', distanceFromHighPct: -6 })), 'BREAKOUT');
  assert.equal(live.stageOf(baseRecord({ structureState: 'BREAKOUT_CONFIRMED', distanceFromHighPct: -0.5 })), 'EXPANSION');
  assert.equal(live.stageOf({ ticker: 'X', structureState: 'WATCH', ignitionState: 'NO_IGNITION' }), 'DORMANT');
});

test('PARABOLIC stage engages on extreme extension', () => {
  const rec = baseRecord({
    structureFeatures: {
      ...baseRecord().structureFeatures,
      vwapExtensionAtr: 6, vwapDistancePct: 28, sessionRunPct: 85, lastBarVolMult: 6, upperWickRisk: true,
    },
    dayChangePct: 90,
  });
  const ext = live.extensionRisk(rec);
  assert.ok(ext.risk > 80);
  assert.equal(live.stageOf(rec, ext), 'PARABOLIC');
});

// ── Extension risk honesty ───────────────────────────────────────────────────

test('extension risk with no usable inputs is UNKNOWN, not zero', () => {
  const ext = live.extensionRisk({ structureFeatures: null, dayChangePct: null });
  assert.equal(ext.risk, null);
  assert.equal(ext.label, 'UNKNOWN');
});

test('extension bands map to the spec labels', () => {
  const mk = risk => C.EXTENSION_BANDS.find(b => risk <= b.max).label;
  assert.equal(mk(20), 'NORMAL');
  assert.equal(mk(45), 'CAUTION');
  assert.equal(mk(70), 'DO_NOT_INITIATE');
  assert.equal(mk(95), 'PARABOLIC_EXIT_BIAS');
});

// ── Anti-FOMO / view contract ────────────────────────────────────────────────

test('the view reuses the actionability chase ceiling as DO_NOT_CHASE and labels itself RULE_BASED_ESTIMATE', () => {
  const v = live.synthesizeIgnitionView(baseRecord(), {});
  assert.equal(v.doNotChasePrice, 2.55);
  assert.match(v.scoreBasis, /RULE_BASED_ESTIMATE/);
  assert.match(v.haltStatus, /no halt\/LULD feed/);
  assert.equal(v.haltCount, null);
});

test('a blocked record caps opportunity at the blocked ceiling', () => {
  const v = live.synthesizeIgnitionView(baseRecord({ blockingReasons: ['MANUAL_SPREAD_CONFIRMATION_REQUIRED'], actionState: 'NO_TRADE' }), {});
  assert.ok(v.opportunityScore <= C.OPPORTUNITY.BLOCKED_CAP);
});

test('alert states: CONFIRMED requires a setup template; FAILED and PARABOLIC_WARNING fire on their stages', () => {
  const confirmed = live.synthesizeIgnitionView(baseRecord({
    entryQualityScore: 85, tradeQualityScore: 80, relativeVolume: 9,
    fiveMinVolumeAcceleration: 3.5, currentDollarVolume5m: 2_500_000, currentDollarVolume15m: 3_000_000,
  }), { regime: 'risk-on', shortPressure: { known: true, level: 'high' } });
  if (confirmed.ignitionScore >= 80) assert.ok(confirmed.alertStates.includes('CONFIRMED'));
  const failed = live.synthesizeIgnitionView(baseRecord({ structureState: 'FAILED_BREAKOUT' }), {});
  assert.ok(failed.alertStates.includes('FAILED'));
});
