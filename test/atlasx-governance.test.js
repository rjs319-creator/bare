'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { modelHealth, promotionView, assertShadow } = require('../lib/atlasx-governance');
const { HEALTH_STATES } = require('../lib/atlasx-config');
const { PROMOTION_GATE } = require('../lib/strategy-gate');

// A full evidence bundle that clears every gate criterion; tests knock out one field.
function fullEvidence() {
  return {
    resolvedEpisodes: PROMOTION_GATE.minResolvedEpisodes + 10,
    independentDates: PROMOTION_GATE.minIndependentDates + 5,
    incrementalExcessReturn: true,
    calibrationBeatsBaseRate: true,
    costAware: true,
    regimeRobust: true,
    confidenceInterval: true,
  };
}

// ── modelHealth ────────────────────────────────────────────────────────────────
test('modelHealth: few episodes → INSUFFICIENT_DATA', () => {
  const h = modelHealth({ nEpisodes: 5, rankIC: -0.5, calibrationError: 0.9 });
  assert.equal(h.state, 'INSUFFICIENT_DATA', 'cannot call a model broken on 5 episodes');
  assert.ok(h.reasons.length > 0);
  assert.ok(HEALTH_STATES.includes(h.state));
});

test('modelHealth: mid-count sample → BUILDING (still accruing)', () => {
  const h = modelHealth({ nEpisodes: 20, rankIC: 0.05, netUtility: 30 });
  assert.equal(h.state, 'BUILDING');
});

test('modelHealth: deteriorating metrics on a mature sample → DEGRADING', () => {
  const h = modelHealth({
    nEpisodes: 80, rankIC: 0.01, precision: 0.35, netUtility: -5,
    calibrationError: 0.15, featureDrift: 0.4, expertDisagreement: 0.8,
    regimeCoverage: 0.4, dataFreshness: 0,
  });
  assert.equal(h.state, 'DEGRADING');
  assert.ok(h.reasons.length > 0);
});

test('modelHealth: negative IC / broken calibration on a mature sample → BROKEN', () => {
  const h = modelHealth({ nEpisodes: 120, rankIC: -0.02, calibrationError: 0.3, dudRate: 0.7 });
  assert.equal(h.state, 'BROKEN');
});

test('modelHealth: healthy metrics → HEALTHY', () => {
  const h = modelHealth({
    nEpisodes: 120, rankIC: 0.08, precision: 0.6, netUtility: 40,
    calibrationError: 0.05, featureDrift: 0.1, expertDisagreement: 0.3,
    regimeCoverage: 0.8, dudRate: 0.2, dataFreshness: 0,
  });
  assert.equal(h.state, 'HEALTHY');
});

test('modelHealth: a DEGRADING shadow model stays shadow (never auto-promotes)', () => {
  const h = modelHealth({ nEpisodes: 80, rankIC: 0.01, netUtility: -5 });
  assert.equal(h.state, 'DEGRADING');
  // The invariant holds regardless of health state.
  assert.notEqual(assertShadow(), 'production');
});

// ── promotionView ────────────────────────────────────────────────────────────
test('promotionView: eligible only when EVERY criterion is met', () => {
  const v = promotionView(fullEvidence());
  assert.equal(v.eligible, true);
  assert.deepEqual(v.unmet, []);
  assert.ok(/reviewable registry/i.test(v.note), 'note keeps promotion an explicit registry action');
});

test('promotionView: any single unmet criterion makes it ineligible (fail-closed)', () => {
  for (const key of ['resolvedEpisodes', 'independentDates', 'incrementalExcessReturn',
    'calibrationBeatsBaseRate', 'costAware', 'regimeRobust', 'confidenceInterval']) {
    const ev = fullEvidence();
    if (typeof ev[key] === 'boolean') ev[key] = false; else ev[key] = 0;
    const v = promotionView(ev);
    assert.equal(v.eligible, false, `${key} unmet must block eligibility`);
    assert.ok(v.unmet.length >= 1);
  }
});

test('promotionView: a single strong block does NOT make it eligible', () => {
  const v = promotionView({
    resolvedEpisodes: 10_000, // massively over the episode bar
    independentDates: 1,      // …but nothing else is met
  });
  assert.equal(v.eligible, false);
  assert.equal(v.met.minResolvedEpisodes, true);
  assert.ok(v.unmet.length >= 1);
});

test('promotionView: empty evidence → ineligible with all criteria unmet', () => {
  const v = promotionView({});
  assert.equal(v.eligible, false);
  assert.equal(v.unmet.length, Object.keys(v.met).length);
});

// ── assertShadow ────────────────────────────────────────────────────────────
test('assertShadow: atlasx is registered shadow, so the invariant passes', () => {
  const status = assertShadow();
  assert.notEqual(status, 'production');
  assert.equal(status, 'shadow');
});
