'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../lib/alerts-score');

const goodSetup = { direction: 'long', valid: true, quality: 0.8, spot: 100, atr: 2, rsi: 55, sma20: 98, support: 95, resistance: 105, trigger: 106, invalidation: 94, target: 118, rr: 2.0 };
const ep = (o = {}) => ({ id: 'e1', ticker: 'AAA', side: 'long', status: 'WAITING', catalysts: ['breakout'], ...o });

test('absolute score is comparable across batches (identical inputs → identical score)', () => {
  const ctx = { setup: goodSetup, skill: { state: 'UNKNOWN', skillWeight: 0, accountPoints: 0 }, catalyst: { status: 'VERIFIED_SECONDARY' }, social: { confirmation: 0.4, independentClusters: 2 }, market: { liquidityOk: true, preMovePct: 1 }, regime: { supportive: true } };
  const a = sc.scoreEpisode(ep(), ctx);
  const b = sc.scoreEpisode(ep(), ctx);
  assert.equal(a.score, b.score);
  assert.ok(a.score >= 0 && a.score <= 100);
});

test('an elite account CANNOT rescue a broken chart (no valid setup → not REVIEW)', () => {
  const d = sc.scoreEpisode(ep(), {
    setup: { direction: 'none', valid: false, quality: 0 },
    skill: { state: 'PROVEN', skillWeight: 1, accountPoints: 20 },
    catalyst: { status: 'VERIFIED_PRIMARY' }, social: { confirmation: 0.8, independentClusters: 5 },
    market: { liquidityOk: true }, regime: { supportive: true },
  });
  assert.notEqual(d.action, 'REVIEW');
});

test('an over-extended (already-consumed) move is AVOID / crowded, not actionable', () => {
  const d = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: { state: 'PROVEN', skillWeight: 1, accountPoints: 20 },
    catalyst: { status: 'VERIFIED_PRIMARY' }, social: { confirmation: 0.8, independentClusters: 5 },
    market: { liquidityOk: true, preMovePct: 20 }, regime: { supportive: true },
  });
  assert.equal(d.action, 'AVOID');
  assert.equal(d.view, 'crowded');
});

test('a coordinated pump stays out of Actionable (crowded view)', () => {
  const d = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: { state: 'UNKNOWN', skillWeight: 0, accountPoints: 0 },
    catalyst: { status: 'SOCIAL_ONLY' }, social: { confirmation: 0.5, independentClusters: 1, coordinated: true },
    market: { liquidityOk: true, preMovePct: 1 }, regime: { supportive: true },
  });
  assert.equal(d.view, 'crowded');
});

test('a contradicting chart routes to the Contradictions view', () => {
  const d = sc.scoreEpisode(ep({ side: 'long' }), {
    setup: { ...goodSetup, direction: 'short' }, skill: { state: 'UNKNOWN', skillWeight: 0, accountPoints: 0 },
    catalyst: { status: 'UNVERIFIED' }, social: { confirmation: 0.3, independentClusters: 1 },
    market: { liquidityOk: true }, regime: { supportive: true },
  });
  assert.equal(d.view, 'contradiction');
});

test('confirmed setup + verified catalyst + liquid + fresh → REVIEW (Actionable)', () => {
  const d = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: { state: 'SUPPORTED', skillWeight: 0.7, accountPoints: 14 },
    catalyst: { status: 'VERIFIED_SECONDARY' }, social: { confirmation: 0.5, independentClusters: 2 },
    market: { liquidityOk: true, preMovePct: 1 }, regime: { supportive: true },
  });
  assert.equal(d.action, 'REVIEW');
  assert.equal(d.view, 'confirmation');
});

test('account component is capped at the configured share of the score', () => {
  const d = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: { state: 'PROVEN', skillWeight: 1, accountPoints: 99 },   // absurd
    catalyst: { status: 'VERIFIED_PRIMARY' }, social: { confirmation: 0.5, independentClusters: 2 },
    market: { liquidityOk: true, preMovePct: 1 }, regime: { supportive: true },
  });
  assert.ok(d.components.account <= sc.WEIGHTS.account);
});

test('risk-off regime vetoes actionable', () => {
  const d = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: { state: 'PROVEN', skillWeight: 1, accountPoints: 20 },
    catalyst: { status: 'VERIFIED_PRIMARY' }, social: { confirmation: 0.8, independentClusters: 5 },
    market: { liquidityOk: true, preMovePct: 1 }, regime: { riskOff: true },
  });
  assert.notEqual(d.action, 'REVIEW');
});

test('probability is suppressed without a frozen, out-of-sample calibrated model', () => {
  assert.equal(sc.probabilityDisplay(null).available, false);
  assert.equal(sc.probabilityDisplay({ frozen: true, outOfSample: false, beatsBaseRate: true, n: 200 }).available, false);
  assert.equal(sc.probabilityDisplay(null).message, sc.PROBABILITY_UNAVAILABLE);
});

test('every decision carries the shadow maturity marker', () => {
  const d = sc.scoreEpisode(ep(), { setup: goodSetup, skill: {}, catalyst: {}, social: {}, market: {}, regime: {} });
  assert.equal(d.researchMaturity, 'shadow');
});
