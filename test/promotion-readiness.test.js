const { test } = require('node:test');
const assert = require('node:assert');
const { promotionReadiness, coverageReport, CRITERIA } = require('../lib/promotion-readiness');

// A synthetic input that would pass EVERY criterion — used to prove that the gate CAN say
// yes, so its "no" on real data is meaningful rather than a hard-coded refusal.
function passingInput() {
  return {
    researchValidity: { survivorshipSafe: true, pointInTimeSafe: true },
    coverage: { nUniqueNames: 250, nDecisionDates: 120, nProspectiveDates: 30, hasDelisted: true, hasRejectedCandidates: true, pointInTimeUniverse: true },
    walkforward: { days21: { purgedIC: 0.06, icir: 0.5, nOuter: 10, nRegimes: 3 } },
    marginalDelta: 0.02,
    controls: { verdict: 'ROBUST', reason: 'survives all controls' },
    prospectiveHealth: 'HEALTHY',
  };
}

test('a fully-satisfying dataset is certified PROMOTABLE (the gate is not a hard no)', () => {
  const out = promotionReadiness(passingInput());
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.status, 'PROMOTABLE');
  assert.strictEqual(out.blockers.length, 0);
  assert.strictEqual(out.affectsLiveRank, false);
});

test('survivorship-unsafe data is blocked outright and classified INSUFFICIENT_DATA', () => {
  const inp = passingInput();
  inp.researchValidity.survivorshipSafe = false; // the real ORBIT-ML backfill state
  inp.coverage.hasDelisted = false;
  inp.coverage.pointInTimeUniverse = false;
  const out = promotionReadiness(inp);
  assert.strictEqual(out.ready, false);
  assert.strictEqual(out.status, 'INSUFFICIENT_DATA');
  assert.ok(out.blockers.some(b => b.id === 'survivorship-unsafe'));
});

test('the real ORBIT-ML numbers (IC≈0, hurts-ensemble, survivorship-unsafe) are NOT READY', () => {
  // Mirrors research/orbit_ml/validate.js: 24 names, IC≈0, marginalDelta −0.016, survivorship-unsafe.
  const out = promotionReadiness({
    researchValidity: { survivorshipSafe: false, pointInTimeSafe: false },
    coverage: coverageReport(
      [{ date: '2026-07-18', predictions: [{ ticker: 'AAPL' }, { ticker: 'MSFT' }] }],
      {},
      { hasDelisted: false, hasRejectedCandidates: false, pointInTimeUniverse: false }
    ),
    walkforward: { days21: { purgedIC: 0.0027, icir: 0.01, nOuter: 7, nRegimes: 1 } },
    marginalDelta: -0.016,
    controls: { verdict: 'NO-EDGE', reason: 'clean but nothing to promote' },
    prospectiveHealth: null,
  });
  assert.strictEqual(out.ready, false);
  // Survivorship dominates the classification (most fundamental defect first).
  assert.strictEqual(out.status, 'INSUFFICIENT_DATA');
  const ids = out.blockers.map(b => b.id);
  assert.ok(ids.includes('survivorship-unsafe'));
  assert.ok(ids.includes('too-few-names'));
  assert.ok(ids.includes('no-incremental-value'));
});

test('clean eval on survivorship-safe data but zero IC classifies as NO_EDGE', () => {
  const inp = passingInput();
  inp.walkforward.days21.purgedIC = 0.005; // below hurdle
  inp.controls = { verdict: 'NO-EDGE', reason: 'clean, nothing to promote' };
  const out = promotionReadiness(inp);
  assert.strictEqual(out.ready, false);
  assert.strictEqual(out.status, 'NO_EDGE');
});

test('leakage in controls classifies as INVALID_EVALUATION', () => {
  const inp = passingInput();
  inp.controls = { verdict: 'FAIL-LEAKAGE', reason: 'shuffled-label IC nonzero' };
  const out = promotionReadiness(inp);
  assert.strictEqual(out.status, 'INVALID_EVALUATION');
});

test('positive edge but redundant (marginalDelta≤0) classifies as NO_INCREMENTAL_VALUE', () => {
  const inp = passingInput();
  inp.marginalDelta = -0.001;
  const out = promotionReadiness(inp);
  assert.strictEqual(out.status, 'NO_INCREMENTAL_VALUE');
});

test('everything met but no prospective confirmation classifies as AWAITING_PROSPECTIVE', () => {
  const inp = passingInput();
  inp.coverage.nProspectiveDates = 3;
  const out = promotionReadiness(inp);
  assert.strictEqual(out.status, 'AWAITING_PROSPECTIVE');
});

test('coverageReport counts unique names, dates, and prospective resolved dates', () => {
  const days = [
    { date: '2026-07-17', predictions: [{ ticker: 'AAPL' }, { ticker: 'MSFT' }] },
    { date: '2026-07-18', predictions: [{ ticker: 'AAPL' }, { ticker: 'NVDA' }] },
  ];
  const resolved = {
    'AAPL:2026-05-01': { ticker: 'AAPL', decisionTs: '2026-05-01', horizons: { days21: { resolved: true }, days5: { resolved: true } } },
    'MSFT:2026-05-02': { ticker: 'MSFT', decisionTs: '2026-05-02', horizons: { days21: { resolved: false } } },
  };
  const cov = coverageReport(days, resolved, { hasDelisted: false });
  assert.strictEqual(cov.nUniqueNames, 3);
  assert.strictEqual(cov.nDecisionDates, 2);
  assert.strictEqual(cov.nProspectiveDates, 1); // only AAPL:2026-05-01 has a resolved horizon
  assert.strictEqual(cov.resolvedByHorizon.days21, 1);
});

test('criteria are frozen (cannot be mutated to force a pass)', () => {
  const before = CRITERIA.icHurdle;
  try { CRITERIA.icHurdle = 0; } catch { /* strict mode would throw; sloppy mode no-ops */ }
  assert.strictEqual(CRITERIA.icHurdle, before); // frozen: value is unchanged either way
  assert.ok(Object.isFrozen(CRITERIA));
});
