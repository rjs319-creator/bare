'use strict';
// RISK KELLY — unit tests + the GOVERNANCE property: no recommendation, for ANY input, exceeds
// the hard position cap shared with omega-sizing / position-sizing, and Kelly ≤ 0 never yields
// a positive size.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RK = require('../lib/risk-kelly');
const OS = require('../lib/omega-sizing');
const { SIZING } = require('../lib/lowfloat-config');

test('the hard cap is ONE number across omega-sizing, position-sizing and risk-kelly', () => {
  assert.equal(RK.MAX_POSITION_FRACTION, OS.MAX_POSITION_PCT);
  assert.equal(RK.MAX_POSITION_FRACTION, SIZING.DEFAULT_MAX_POSITION_PCT / 100);
  assert.equal(RK.VOL_TARGET_ANNUAL_PCT, OS.VOL_TARGET_ANNUAL * 100);
});

test('kellyFraction: textbook values, sign of avgLoss ignored, cost charged to both legs', () => {
  // p=0.5, 2:1 payoff → f* = 0.5/1 − 0.5/2 = 0.25
  assert.ok(Math.abs(RK.kellyFraction({ winRate: 0.5, avgWin: 2, avgLoss: -1 }) - 0.25) < 1e-12);
  assert.equal(RK.kellyFraction({ winRate: 0.5, avgWin: 2, avgLoss: 1 }), RK.kellyFraction({ winRate: 0.5, avgWin: 2, avgLoss: -1 }));
  // coin flip at 1:1 has zero edge; with any cost it is negative
  assert.ok(Math.abs(RK.kellyFraction({ winRate: 0.5, avgWin: 1, avgLoss: 1 })) < 1e-12);
  assert.ok(RK.kellyFraction({ winRate: 0.5, avgWin: 1, avgLoss: 1, cost: 0.1 }) < 0);
  // a win that nets nothing after cost is reported as 0 (no edge), not as a division blow-up
  assert.equal(RK.kellyFraction({ winRate: 0.9, avgWin: 0.01, avgLoss: 0.02, cost: 0.01 }), 0);
});

test('kellyFraction: unusable inputs are null, never a number', () => {
  assert.equal(RK.kellyFraction({ winRate: 55, avgWin: 1, avgLoss: 1 }), null, 'percent win rate out of contract');
  assert.equal(RK.kellyFraction({ winRate: 0.5, avgWin: NaN, avgLoss: 1 }), null);
  assert.equal(RK.kellyFraction({ winRate: 0.5, avgWin: 1, avgLoss: 0 }), null, 'lossless bet has no finite Kelly');
  assert.equal(RK.kellyFraction({ winRate: 0.5, avgWin: 1, avgLoss: 1, cost: -1 }), null);
  assert.equal(RK.kellyFraction(), null);
});

test('kellyContinuous clamps to [0, 4] and refuses sd ≤ 0', () => {
  assert.equal(RK.kellyContinuous({ mu: -1, sd: 0.1 }), 0);
  assert.equal(RK.kellyContinuous({ mu: 10, sd: 0.1 }), 4);
  assert.ok(Math.abs(RK.kellyContinuous({ mu: 0.02, sd: 0.1, cost: 0.01 }) - 1) < 1e-12);
  assert.equal(RK.kellyContinuous({ mu: 0.02, sd: 0 }), null);
});

test('fractionalKelly never goes negative and is null-safe; cernSizeFraction caps at 5%', () => {
  assert.equal(RK.fractionalKelly(-3), 0);
  assert.equal(RK.fractionalKelly(null), null);
  assert.equal(RK.fractionalKelly(1, { fraction: 0.5 }), 0.5);
  assert.equal(RK.cernSizeFraction(4), 0.01);
  assert.equal(RK.cernSizeFraction(1e9), RK.CERN_MAX_SIZE);
  assert.equal(RK.cernSizeFraction(null), 0);
});

test('realizedVolAnnualPct: flat series is 0, needs window+1 closes, refuses bad closes', () => {
  const flat = Array.from({ length: 30 }, () => ({ close: 100 }));
  assert.equal(RK.realizedVolAnnualPct(flat), 0);
  assert.equal(RK.realizedVolAnnualPct(flat.slice(0, 20)), null);
  assert.equal(RK.realizedVolAnnualPct([...flat.slice(0, 29), { close: 0 }]), null);
  const alt = Array.from({ length: 30 }, (_, i) => ({ close: i % 2 ? 101 : 100 }));
  const v = RK.realizedVolAnnualPct(alt);
  assert.ok(v > 10 && v < 20, `±1% daily alternation ≈ 16% annualised, got ${v}`);
});

test('volTargetSize scales 25%/realised and is capped at the hard max', () => {
  const quiet = RK.volTargetSize({ realizedVol20d: 10 });
  assert.equal(quiet.fraction, RK.MAX_POSITION_FRACTION);
  assert.equal(quiet.capped, true);
  const wild = RK.volTargetSize({ realizedVol20d: 100 });
  assert.ok(Math.abs(wild.fraction - 0.25) < 1e-12 || wild.fraction <= RK.MAX_POSITION_FRACTION);
  assert.equal(RK.volTargetSize({ realizedVol20d: 250 }).fraction, 0.1);
  assert.equal(RK.volTargetSize({ realizedVol20d: 0 }), null);
  assert.equal(RK.volTargetSize({}), null);
});

const R_EDGE = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? -1 : i % 2 ? 2 : -1));   // mixed
const R_LOSER = Array.from({ length: 40 }, () => -1);

test('monteCarloDrawdown is seeded-deterministic, refuses thin samples, and rescales exactly', () => {
  const a = RK.monteCarloDrawdown({ rMultiples: R_EDGE });
  const b = RK.monteCarloDrawdown({ rMultiples: R_EDGE });
  assert.deepEqual(a, b);
  assert.equal(a.quantilesR.length, 101);
  assert.ok(a.quantilesR.every((q, i, arr) => i === 0 || q >= arr[i - 1]), 'percentiles are monotone');
  assert.equal(RK.monteCarloDrawdown({ rMultiples: R_EDGE.slice(0, 19) }), null);
  assert.equal(RK.monteCarloDrawdown({ rMultiples: [] }), null);
  // every trade loses 1R ⇒ 20-trade maxDD is exactly 20R on every path
  const loser = RK.monteCarloDrawdown({ rMultiples: R_LOSER });
  assert.ok(loser.quantilesR.every(q => q === 20));
  // at 1% risk 20R = 20% drawdown: P(DD > 10%) = 1, P(DD > 20%) = 0 (not strictly greater)
  assert.equal(RK.drawdownExceedProbability(loser.quantilesR, 0.10, 0.01), 1);
  assert.equal(RK.drawdownExceedProbability(loser.quantilesR, 0.20, 0.01), 0);
  assert.equal(RK.drawdownExceedProbability(loser.quantilesR, 0.20, 0.02), 1);
  assert.equal(RK.drawdownExceedProbability(loser.quantilesR, 0.20, 0), null);
});

test('sizeRecommendation fails closed: thin lane, no edge, undefined Kelly', () => {
  const thin = RK.sizeRecommendation({ winRate: 0.6, avgWin: 0.05, avgLoss: -0.02, n: 5 });
  assert.equal(thin.size, null);
  assert.match(thin.reason, /insufficient resolved episodes/);
  const noEdge = RK.sizeRecommendation({ winRate: 0.4, avgWin: 0.01, avgLoss: -0.02, n: 50 });
  assert.equal(noEdge.size, null);
  assert.equal(noEdge.reason, 'no measured edge');
  assert.ok(noEdge.kelly <= 0);
  const bad = RK.sizeRecommendation({ winRate: 0.4, avgWin: 0.01, avgLoss: 0, n: 50 });
  assert.equal(bad.size, null);
  assert.match(bad.reason, /undefined/);
});

test('sizeRecommendation: positive edge is sized at quarter Kelly under the cap, vol target can bind', () => {
  const r = RK.sizeRecommendation({ winRate: 0.55, avgWin: 0.04, avgLoss: -0.03, n: 50, rMultiples: R_EDGE, realizedVol20d: 40 });
  assert.ok(r.size > 0 && r.size <= RK.MAX_POSITION_FRACTION);
  assert.equal(r.bindingConstraint, 'max-position');          // raw quarter-Kelly is leveraged → cap binds
  assert.ok(r.drawdown && r.drawdown.probabilities.length === 2);
  const volBound = RK.sizeRecommendation({ winRate: 0.55, avgWin: 0.04, avgLoss: -0.03, n: 50, realizedVol20d: 250 });
  assert.equal(volBound.bindingConstraint, 'vol-target');
  assert.equal(volBound.size, 0.1);
  assert.equal(volBound.drawdown, null, 'no R-multiples ⇒ no drawdown band, not a fake one');
  const small = RK.sizeRecommendation({ winRate: 0.52, avgWin: 1.2, avgLoss: -1, n: 50 });   // R units
  assert.equal(small.bindingConstraint, 'kelly');
  assert.ok(Math.abs(small.size - RK.fractionalKelly(small.kelly)) < 1e-12);
});

// ── GOVERNANCE PROPERTY ────────────────────────────────────────────────────────────────────
// Over thousands of random (including hostile) inputs: a published size is always a finite
// fraction in (0, MAX_POSITION_FRACTION], and Kelly ≤ 0 always yields size null.
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

test('GOVERNANCE: no sizeRecommendation ever exceeds the hard cap or sizes a non-edge', () => {
  const rnd = lcg(7);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const hostile = [NaN, Infinity, -Infinity, null, undefined, -1, 0, 1e9, -1e9, '0.5', {}];
  let published = 0;
  for (let i = 0; i < 4000; i++) {
    const useHostile = rnd() < 0.15;
    const input = {
      winRate: useHostile ? pick(hostile) : rnd(),
      avgWin: useHostile ? pick(hostile) : rnd() * 0.5,
      avgLoss: useHostile ? pick(hostile) : -rnd() * 0.5,
      cost: useHostile ? pick(hostile) : rnd() * 0.02,
      n: useHostile ? pick(hostile) : Math.floor(rnd() * 400),
      realizedVol20d: rnd() < 0.3 ? pick(hostile) : rnd() * 300,
      rMultiples: rnd() < 0.5 ? Array.from({ length: Math.floor(rnd() * 60) }, () => (rnd() - 0.4) * 6) : null,
      fraction: rnd() < 0.1 ? pick([0.1, 0.25, 0.5, 1]) : undefined,
      riskPerTradeFrac: rnd() * 0.05,
    };
    const r = RK.sizeRecommendation(input);
    if (r.size === null) { assert.equal(typeof r.reason, 'string'); continue; }
    published++;
    assert.ok(Number.isFinite(r.size) && r.size > 0, `size must be a positive finite fraction: ${r.size}`);
    assert.ok(r.size <= RK.MAX_POSITION_FRACTION + 1e-12, `size ${r.size} exceeds cap`);
    assert.ok(r.kelly > 0, 'a published size implies a positive Kelly');
    if (r.volTarget) assert.ok(r.volTarget.fraction <= RK.MAX_POSITION_FRACTION + 1e-12);
    if (r.drawdown) for (const p of r.drawdown.probabilities) assert.ok(p.p === null || (p.p >= 0 && p.p <= 1));
  }
  assert.ok(published > 200, `property test must exercise the published branch (got ${published})`);
});
