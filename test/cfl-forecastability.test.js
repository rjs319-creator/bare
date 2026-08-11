'use strict';
// CFL FORECASTABILITY — the abstention ladder is fail-closed and probabilities
// are structurally withheld without calibration support.
const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/cfl/forecastability');

const strongInput = {
  analogueCount: 200, analogueWins: 110, calibrationBinN: 60, binWins: 33,
  features: { mom63: 0.1 }, cohortStats: { mom63: { mean: 0.08, sd: 0.05 } },
  missing: [], freshnessClass: 'current', liquidityOk: true, providerHealthy: true,
};

test('strong evidence ⇒ ACTIONABLE with a Wilson uncertainty interval and displayable probability', () => {
  const r = F.assessForecastability(strongInput);
  assert.strictEqual(r.disposition, 'ACTIONABLE');
  assert.ok(r.forecastabilityScore >= 70);
  assert.ok(r.uncertaintyInterval && r.uncertaintyInterval.lo < r.uncertaintyInterval.hi);
  assert.strictEqual(r.displayProbability, true);
});

test('stale data fails closed to DATA_STALE regardless of sample strength', () => {
  const r = F.assessForecastability({ ...strongInput, freshnessClass: 'stale' });
  assert.strictEqual(r.disposition, 'DATA_STALE');
  assert.ok(r.reasonCodes.includes('DATA_STALE'));
});

test('a feature far outside the cohort distribution ⇒ OUT_OF_DISTRIBUTION', () => {
  const r = F.assessForecastability({ ...strongInput, features: { mom63: 5 } });
  assert.strictEqual(r.disposition, 'OUT_OF_DISTRIBUTION');
  assert.ok(r.distributionShiftScore >= 3);
});

test('thin analogues ⇒ INSUFFICIENT_EVIDENCE, true abstention — never forced into buy/hold/sell', () => {
  const r = F.assessForecastability({ ...strongInput, analogueCount: 5, analogueWins: 3, calibrationBinN: null, binWins: null });
  assert.strictEqual(r.disposition, 'INSUFFICIENT_EVIDENCE');
  assert.ok(r.reasonCodes.includes('THIN_ANALOGUES'));
  assert.strictEqual(r.displayProbability, false);
});

test('unhealthy provider or failed liquidity floor ⇒ ABSTAIN', () => {
  assert.strictEqual(F.assessForecastability({ ...strongInput, providerHealthy: false }).disposition, 'ABSTAIN');
  assert.strictEqual(F.assessForecastability({ ...strongInput, liquidityOk: false }).disposition, 'ABSTAIN');
});

test('no calibrator ⇒ probability withheld even when ACTIONABLE, with an explicit NO_CALIBRATOR reason', () => {
  const r = F.assessForecastability({ ...strongInput, calibrationBinN: null, binWins: null });
  assert.strictEqual(r.displayProbability, false);
  assert.ok(r.reasonCodes.includes('NO_CALIBRATOR'));
});

test('conformal is honest: without OOF residuals it reports available:false, never a fake interval', () => {
  const r = F.assessForecastability(strongInput);
  assert.strictEqual(r.conformal.available, false);
  assert.strictEqual(r.conformal.reason, 'insufficient-oof-residuals');
});

test('conformal engages when real OOF residuals and a point estimate are supplied', () => {
  const residuals = Array.from({ length: 60 }, (_, i) => (i - 30) * 5);
  const r = F.assessForecastability({ ...strongInput, residualsOOF: residuals, pointEstimate: 100 });
  assert.notStrictEqual(r.conformal.available, false);
  assert.ok(Number.isFinite(r.conformal.lower) && Number.isFinite(r.conformal.upper));
});
