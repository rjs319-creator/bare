const test = require('node:test');
const assert = require('node:assert');
const TC = require('../lib/transparent-challenger');

// Synthetic candle factory: geometric drift + fixed intraday range, deterministic.
function makeCandles(n, { drift = 0.001, range = 0.02, start = 50 } = {}) {
  const out = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    close = close * (1 + drift);
    out.push({ close, high: close * (1 + range / 2), low: close * (1 - range / 2), volume: 1e6 });
  }
  return out;
}
const closesOf = cs => cs.map(c => c.close);

test('percentileRanks: averages ties, spans 0..1, skips non-finite', () => {
  // Arrange / Act
  const r = TC.percentileRanks([10, 20, 20, 40, null]);

  // Assert
  assert.strictEqual(r[0], 0);
  assert.strictEqual(r[3], 1);
  assert.strictEqual(r[1], r[2]);
  assert.strictEqual(r[4], null);
});

test('scoreCohort retains the FULL denominator: rejected names stay in the cohort with reasons', () => {
  // Arrange — one liquid eligible name, one illiquid, one with too little history.
  const bench = closesOf(makeCandles(200, { drift: 0.0005 }));
  const cohort = [
    { ticker: 'GOOD', candles: makeCandles(200), dollarVol: 20e6, benchCloses: bench },
    { ticker: 'THIN', candles: makeCandles(200), dollarVol: 1e6, benchCloses: bench },
    { ticker: 'YOUNG', candles: makeCandles(60), dollarVol: 20e6, benchCloses: bench },
  ];

  // Act
  const out = TC.scoreCohort(cohort, { asOf: '2026-08-11' });

  // Assert
  assert.strictEqual(out.cohortSize, 3);
  assert.strictEqual(out.eligibleCount, 1);
  assert.strictEqual(out.rejectedCount, 2);
  const thin = out.cohort.find(r => r.ticker === 'THIN');
  const young = out.cohort.find(r => r.ticker === 'YOUNG');
  assert.ok(thin.rejectionReasons.includes('below-liquidity-floor'));
  assert.ok(young.rejectionReasons.includes('insufficient-history'));
  assert.strictEqual(out.version, TC.TRANSPARENT_VERSION);
});

test('the frozen inverse arm is exactly the negated full score — the missing negative control', () => {
  // Arrange
  const bench = closesOf(makeCandles(200, { drift: 0.0005 }));
  const cohort = [
    { ticker: 'A', candles: makeCandles(200, { drift: 0.002 }), dollarVol: 20e6, benchCloses: bench },
    { ticker: 'B', candles: makeCandles(200, { drift: 0.0002 }), dollarVol: 20e6, benchCloses: bench },
  ];

  // Act
  const out = TC.scoreCohort(cohort);

  // Assert
  for (const r of out.cohort.filter(x => x.eligible)) {
    assert.ok(Math.abs(r.scores.frozenInverse + r.scores.full) < 1e-9);
  }
});

test('higher residual momentum ranks higher on the momentum-only arm, all else equal', () => {
  // Arrange — same range/vol profile, different drift.
  const bench = closesOf(makeCandles(200, { drift: 0.0005 }));
  const cohort = [
    { ticker: 'FAST', candles: makeCandles(200, { drift: 0.003 }), dollarVol: 20e6, benchCloses: bench },
    { ticker: 'SLOW', candles: makeCandles(200, { drift: 0.0001 }), dollarVol: 20e6, benchCloses: bench },
  ];

  // Act
  const out = TC.scoreCohort(cohort);
  const fast = out.cohort.find(r => r.ticker === 'FAST');
  const slow = out.cohort.find(r => r.ticker === 'SLOW');

  // Assert
  assert.ok(fast.scores.residualMomentumOnly > slow.scores.residualMomentumOnly);
});

test('repeated failed breakouts trip the veto gate', () => {
  // Arrange — a flat series with engineered breakout-and-fail spikes.
  const candles = makeCandles(200, { drift: 0, range: 0.01 });
  // Three fake failed breakouts: a close above the prior 20d high, reverted next bar.
  // Spaced >20 sessions apart (and inside the trailing-63 count window) so each spike's
  // prior-20d-high window is clean of the previous spike.
  for (const i of [140, 165, 190]) {
    candles[i] = { ...candles[i], close: candles[i].close * 1.05, high: candles[i].close * 1.06 };
  }

  // Act
  const fails = TC.failedBreakouts63(candles, candles.length - 1);

  // Assert
  assert.ok(fails >= 3, `expected ≥3 engineered failures, got ${fails}`);
  const bench = closesOf(makeCandles(200, { drift: 0 }));
  const out = TC.scoreCohort([{ ticker: 'FAIL', candles, dollarVol: 20e6, benchCloses: bench }]);
  assert.ok(out.cohort[0].rejectionReasons.includes('repeated-failed-breakouts'));
});

test('expected cost sits INSIDE the score: cheaper execution outranks identical-but-expensive', () => {
  // Arrange — identical price series; only the liquidity tier differs.
  const bench = closesOf(makeCandles(200, { drift: 0.0005 }));
  const cohort = [
    { ticker: 'CHEAP', candles: makeCandles(200, { drift: 0.001 }), dollarVol: 100e6, benchCloses: bench },
    { ticker: 'DEAR', candles: makeCandles(200, { drift: 0.001 }), dollarVol: 4e6, benchCloses: bench },
  ];

  // Act
  const out = TC.scoreCohort(cohort);
  const cheap = out.cohort.find(r => r.ticker === 'CHEAP');
  const dear = out.cohort.find(r => r.ticker === 'DEAR');

  // Assert
  assert.ok(cheap.scores.full > dear.scores.full);
  assert.strictEqual(out.ranked[0], 'CHEAP');
});

test('gates are frozen constants exposed on the result — never silently tuned', () => {
  const out = TC.scoreCohort([]);
  assert.strictEqual(out.gates, TC.GATES);
  assert.ok(Object.isFrozen(TC.GATES));
  assert.ok(Object.isFrozen(TC.ARMS));
});
