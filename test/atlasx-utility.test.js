'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const {
  computeUtility, conformalInterval, isActionable, bestAlternativeBps,
} = require('../lib/atlasx-utility');
const { buildAtlasPortfolio } = require('../lib/atlasx-portfolio');
const { buildCapture, matchControls } = require('../lib/atlasx-capture');
const { HURDLES, CALIBRATION } = require('../lib/atlasx-config');

// A dense set of out-of-fold residuals (bps) so the conformal band is tight enough
// for a genuinely-good candidate to clear the hurdle.
function tightResiduals() {
  const out = [];
  for (let i = 0; i < CALIBRATION.minSamplesForBands + 20; i++) {
    out.push((i % 11) - 5); // tight, symmetric spread of ±5 bps
  }
  return out;
}

// ── computeUtility ────────────────────────────────────────────────────────────
test('computeUtility: an obviously-good candidate is actionable', () => {
  const res = computeUtility({
    distribution: { median: 0.03, p10: 0.01, p90: 0.05, expectedShortfall: -0.01 },
    survival: { pTargetBeforeStop: 0.6, calibrationStatus: 'uncalibrated' },
    prosecutor: { failureScore: 0.2 },
    costs: { roundTripBps: 15 },
    opportunity: { cash: 0.0, spy: 0.002, sector: 0.003, nextBest: 0.004 },
    ctx: {
      remainingRR: 2.0, dataStaleSessions: 0, expertApplicability: 0.8,
      liquidityDollarVol: 10_000_000, regimePermitted: true,
      residualsOOF: tightResiduals(),
    },
  });
  assert.equal(res.actionable, true, `expected actionable, got reason ${res.abstentionReason}`);
  assert.equal(res.abstentionReason, null);
  assert.ok(res.expectedValue > HURDLES.minNetUtilityBps, `EV ${res.expectedValue} should clear hurdle`);
});

test('computeUtility: a weak candidate abstains with a reason', () => {
  const res = computeUtility({
    distribution: { median: 0.001, p10: -0.02, p90: 0.02, expectedShortfall: -0.05 },
    survival: { pTargetBeforeStop: 0.3, calibrationStatus: 'uncalibrated' },
    prosecutor: { failureScore: 0.5 },
    costs: { roundTripBps: 20 },
    opportunity: { cash: 0.0, spy: 0.002, sector: 0.003, nextBest: 0.003 },
    ctx: {
      remainingRR: 1.5, dataStaleSessions: 0, expertApplicability: 0.6,
      liquidityDollarVol: 10_000_000, regimePermitted: true,
      residualsOOF: tightResiduals(),
    },
  });
  assert.equal(res.actionable, false);
  assert.ok(res.abstentionReason, 'must give an abstention reason');
});

test('computeUtility: raising costs + opportunity cost flips actionable → abstain', () => {
  const base = {
    distribution: { median: 0.006, p10: 0.004, p90: 0.008, expectedShortfall: -0.002 },
    survival: { pTargetBeforeStop: 0.55, calibrationStatus: 'uncalibrated' },
    prosecutor: { failureScore: 0.2 },
    costs: { roundTripBps: 5 },
    opportunity: { cash: 0.0 },
    ctx: {
      remainingRR: 2.0, dataStaleSessions: 0, expertApplicability: 0.8,
      liquidityDollarVol: 10_000_000, regimePermitted: true,
      residualsOOF: tightResiduals(),
    },
  };
  const good = computeUtility(base);
  assert.equal(good.actionable, true, `baseline should be actionable, got ${good.abstentionReason}`);

  const flipped = computeUtility({
    ...base,
    costs: { roundTripBps: 40 },
    opportunity: { cash: 0.0, spy: 0.005, sector: 0.006, nextBest: 0.006 },
  });
  assert.equal(flipped.actionable, false, 'higher costs + opportunity cost must abstain');
  assert.ok(flipped.expectedValue < good.expectedValue);
});

test('computeUtility: waterfall terms sum to expectedValue', () => {
  const res = computeUtility({
    distribution: { median: 0.02, p10: 0.005, p90: 0.04, expectedShortfall: -0.015 },
    survival: { pTargetBeforeStop: 0.5, calibrationStatus: 'uncalibrated' },
    prosecutor: { failureScore: 0.3 },
    costs: { roundTripBps: 12 },
    opportunity: { spy: 0.003, sector: 0.004 },
    ctx: { concentrationPenaltyBps: 8, residualsOOF: tightResiduals() },
  });
  const sum = res.waterfall.reduce((s, t) => s + t.value, 0);
  assert.ok(Math.abs(sum - res.expectedValue) < 1e-6, `terms ${sum} must sum to EV ${res.expectedValue}`);
  assert.equal(res.waterfall.length, 6);
});

test('computeUtility: uncalibrated probability is NEVER shown as a percent', () => {
  const res = computeUtility({
    distribution: { median: 0.02, p10: 0.005, p90: 0.04, expectedShortfall: -0.01 },
    survival: { pTargetBeforeStop: 0.62, calibrationStatus: 'uncalibrated' },
    prosecutor: { failureScore: 0.2 },
    costs: { roundTripBps: 10 },
    opportunity: {},
    ctx: { residualsOOF: tightResiduals() },
  });
  assert.equal(res.probabilityDisplay.isPercent, false);
  assert.ok(!String(res.probabilityDisplay.display).includes('%'), 'no % for uncalibrated score');
});

// ── conformalInterval ─────────────────────────────────────────────────────────
test('conformalInterval: no calibration data → WIDE band flagged insufficient-calibration', () => {
  const iv = conformalInterval(50, undefined);
  assert.equal(iv.uncertaintySource, 'insufficient-calibration');
  assert.equal(iv.wide, true);
  assert.ok((iv.upper - iv.lower) >= 2 * 500, 'band must be wide (>= 2x floor)');
  // A wide band means the conservative lower bound cannot clear the utility hurdle.
  assert.ok(iv.lower < HURDLES.minNetUtilityBps);
});

test('conformalInterval: too few residuals also fall back to wide/insufficient', () => {
  const iv = conformalInterval(30, [1, 2, 3]);
  assert.equal(iv.uncertaintySource, 'insufficient-calibration');
  assert.equal(iv.calibrationSamples, 3);
});

test('conformalInterval: enough residuals → conformal band around the estimate', () => {
  const iv = conformalInterval(100, tightResiduals(), 0.2);
  assert.equal(iv.uncertaintySource, 'conformal-oof');
  assert.equal(iv.wide, false);
  assert.ok(iv.lower < 100 && iv.upper > 100);
});

test('isActionable: reports the first failing hurdle', () => {
  const r = isActionable({
    expectedValue: 40, lower: 30, failureScore: 0.2, remainingRR: 0.5,
    dataStaleSessions: 0, expertApplicability: 0.8, liquidityDollarVol: 1e7,
    regimePermitted: true,
  });
  assert.equal(r.actionable, false);
  assert.equal(r.reason, 'insufficient-remaining-rr');
});

test('bestAlternativeBps: picks the largest competing return (in bps)', () => {
  assert.equal(bestAlternativeBps({ cash: 0, spy: 0.002, sector: 0.005, nextBest: 0.003 }), 50);
  assert.equal(bestAlternativeBps({}), 0);
});

// ── portfolio ─────────────────────────────────────────────────────────────────
test('portfolio: sector cap is enforced and excess names carry a reason', () => {
  const cands = [];
  for (let i = 0; i < 5; i++) {
    cands.push({
      ticker: `T${i}`, expert: `expert${i}`, sector: 'Technology',
      cluster: `c${i}`, rank: i + 1, score: 90 - i,
      liquidity: { dollarVol: 50_000_000 },
    });
  }
  const p = buildAtlasPortfolio(cands, { maxPerSector: 3 });
  assert.equal(p.positions.length, 3, 'sector cap of 3 must hold');
  assert.ok(p.positions.every((pos) => pos.weight === 0), 'every position weight is 0');
  assert.ok(p.excluded.length >= 2, 'excess names excluded');
  assert.ok(p.excluded.every((e) => typeof e.reason === 'string' && e.reason.length), 'each exclusion has a reason');
});

test('portfolio: maxPositions cap holds and there is no forced fill', () => {
  const cands = [];
  for (let i = 0; i < 20; i++) {
    cands.push({
      ticker: `N${i}`, expert: `e${i % 6}`, sector: `S${i}`,
      cluster: `k${i}`, rank: i + 1, score: 80,
      liquidity: { dollarVol: 20_000_000 },
    });
  }
  const p = buildAtlasPortfolio(cands, { maxPositions: 12 });
  assert.ok(p.positions.length <= 12, 'never exceeds maxPositions');
});

test('portfolio: a not-actionable candidate is excluded with its own reason', () => {
  const p = buildAtlasPortfolio([
    { ticker: 'GOOD', expert: 'e1', sector: 'Energy', cluster: 'a', rank: 1, score: 90, liquidity: { dollarVol: 1e7 } },
    { ticker: 'BAD', expert: 'e2', sector: 'Energy', cluster: 'b', rank: 2, score: 88, actionable: false, abstentionReason: 'stale-data', liquidity: { dollarVol: 1e7 } },
  ]);
  assert.ok(p.positions.find((x) => x.ticker === 'GOOD'));
  assert.ok(!p.positions.find((x) => x.ticker === 'BAD'));
  const bad = p.excluded.find((e) => e.ticker === 'BAD');
  assert.ok(bad && bad.reason === 'stale-data');
});

// ── capture ───────────────────────────────────────────────────────────────────
test('capture: matched control is same-sector and the closest', () => {
  const candidate = { ticker: 'AAA', sector: 'Tech', beta: 1.0, vol: 0.3, momentum: 0.1, price: 100, liqTier: 'deep', capGroup: 'large' };
  const pool = [
    { ticker: 'NEAR', sector: 'Tech', beta: 1.05, vol: 0.31, momentum: 0.11, price: 102, liqTier: 'deep', capGroup: 'large' },
    { ticker: 'FAR', sector: 'Tech', beta: 2.0, vol: 0.9, momentum: -0.4, price: 500, liqTier: 'thin', capGroup: 'small' },
    { ticker: 'OTHER', sector: 'Energy', beta: 1.0, vol: 0.3, momentum: 0.1, price: 100, liqTier: 'deep', capGroup: 'large' },
  ];
  const m = matchControls(candidate, pool);
  assert.ok(m, 'a same-sector control exists');
  assert.equal(m.sector, 'Tech');
  assert.equal(m.ticker, 'NEAR', 'nearest same-sector control chosen, not the cross-sector twin');
});

test('capture: no same-sector control → null (no fabricated match)', () => {
  const m = matchControls(
    { ticker: 'X', sector: 'Tech', beta: 1, vol: 0.3, momentum: 0.1, price: 50 },
    [{ ticker: 'Y', sector: 'Energy', beta: 1, vol: 0.3, momentum: 0.1, price: 50 }],
  );
  assert.equal(m, null);
});

test('capture: rejected and near-miss are retained in the record', () => {
  const rec = buildCapture({
    date: '2026-07-22',
    selected: [{ ticker: 'S1', sector: 'Tech' }],
    rejected: [{ ticker: 'R1', sector: 'Tech', reasonCode: 'below-net-utility-hurdle' }],
    nearMiss: [{ ticker: 'NM1', sector: 'Health Care' }],
    controls: [{ ticker: 'C1', sector: 'Tech', beta: 1, vol: 0.3, momentum: 0.1, price: 100 }],
    todayCandidates: [{ ticker: 'LIVE1', sector: 'Energy' }, { ticker: 'S1', sector: 'Tech' }],
    ctx: { prosecutorRejected: [{ ticker: 'P1', sector: 'Tech', reasonCode: 'prosecutor-veto' }] },
  });
  assert.equal(rec.rejected.length, 1);
  assert.equal(rec.nearThreshold.length, 1);
  assert.equal(rec.rejected[0].ticker, 'R1');
  assert.equal(rec.prosecutorRejected[0].ticker, 'P1');
  // currentAlgoNotSelected excludes what ATLAS-X itself selected.
  assert.deepEqual(rec.currentAlgoNotSelected.map((c) => c.ticker), ['LIVE1']);
  assert.equal(rec.version, 'atlasx-v1');
  assert.ok(Object.isFrozen(rec));
});
