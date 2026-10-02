'use strict';
// lib/options-greeks + lib/vendor/lets-be-rational — model greeks and the IV solver.
//
// Oracles: (1) hand-derived Black-Scholes values for S=100 K=100 T=1y r=5% σ=20%
// (d1=0.35, d2=0.15; N(0.35)=0.636831, N(0.15)=0.559618, φ(0.35)=0.375240);
// (2) 59 rows sampled from vollib/lets-be-rational-ts test/TestValues.json (MIT).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/options-greeks');
const LBR = require('../lib/vendor/lets-be-rational');
const ORACLE = require('./fixtures/lets-be-rational-oracle.json');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} got ${a} (tol ${tol})`);
const relClose = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${msg || ''} expected ${b} got ${a}`);
const BASE = { spot: 100, strike: 100, dte: 365, r: 0.05, iv: 0.2 };

test('greeksFromQuotedIV: ATM call matches the textbook Black-Scholes values', () => {
  const g = G.greeksFromQuotedIV({ ...BASE, type: 'call' });
  close(g.price, 10.4506, 1e-3, 'price');
  close(g.delta, 0.636831, 1e-5, 'delta');
  close(g.gamma, 0.018762, 1e-5, 'gamma');
  close(g.vega, 0.37524, 1e-4, 'vega per 1 vol point');
  close(g.theta, -0.017573, 1e-5, 'theta per day');
  close(g.rho, 0.532325, 1e-5, 'rho per 1%');
  assert.equal(g.greeksSource, 'model-bsm-from-quoted-iv');
  assert.equal(g.model.rate, 0.05);
});

test('greeksFromQuotedIV: ATM put matches put-call parity and the textbook greeks', () => {
  const p = G.greeksFromQuotedIV({ ...BASE, type: 'P' });
  close(p.price, 5.5735, 1e-3, 'price');
  close(p.delta, -0.363169, 1e-5, 'delta');
  close(p.gamma, 0.018762, 1e-5, 'gamma equals the call gamma');
  close(p.theta, -0.0045422, 1e-5, 'theta per day');
  close(p.rho, -0.418905, 1e-5, 'rho per 1%');
  const c = G.greeksFromQuotedIV({ ...BASE, type: 'call' });
  close(c.price - p.price, 100 - 100 * Math.exp(-0.05), 1e-9, 'put-call parity');
});

test('greeksFromQuotedIV: refuses out-of-domain inputs instead of fabricating', () => {
  assert.equal(G.greeksFromQuotedIV({ ...BASE, type: 'call', dte: 0 }), null, 'expired');
  assert.equal(G.greeksFromQuotedIV({ ...BASE, type: 'call', iv: 0.001 }), null, 'degenerate IV');
  assert.equal(G.greeksFromQuotedIV({ ...BASE, type: 'call', iv: 9 }), null, 'absurd IV');
  assert.equal(G.greeksFromQuotedIV({ ...BASE, type: 'straddle' }), null, 'unknown type');
  assert.equal(G.greeksFromQuotedIV({ ...BASE, type: 'call', spot: -1 }), null, 'bad spot');
  assert.equal(G.greeksFromQuotedIV({ ...BASE, type: 'call', strike: NaN }), null, 'bad strike');
});

test('impliedVolFromMid: round-trips the model price back to the quoted volatility', () => {
  for (const type of ['call', 'put']) {
    for (const [strike, iv] of [[100, 0.2], [80, 0.35], [125, 0.15]]) {
      const g = G.greeksFromQuotedIV({ ...BASE, strike, iv, type });
      const solved = G.impliedVolFromMid({ ...BASE, strike, mid: g.price, type });
      close(solved.iv, iv, 1e-10, `${type} K=${strike}`);
      assert.equal(solved.greeksSource, 'model-bsm-from-mid');
    }
  }
});

test('impliedVolFromMid: below-intrinsic and above-maximum prices return a reason, not a number', () => {
  const below = G.impliedVolFromMid({ ...BASE, strike: 80, mid: 1, type: 'call' });   // intrinsic ≈ 23.9
  assert.equal(below.iv, null); assert.match(below.reason, /below intrinsic/i);
  const above = G.impliedVolFromMid({ ...BASE, mid: 150, type: 'call' });
  assert.equal(above.iv, null); assert.match(above.reason, /maximum/i);
  const bad = G.impliedVolFromMid({ ...BASE, mid: 0, type: 'call' });
  assert.equal(bad.iv, null); assert.match(bad.reason, /domain/i);
});

test('fillGreeks: vendor greeks are kept and labelled; missing ones are derived from the quoted IV; no IV → none', () => {
  const vendor = G.fillGreeks({ side: 'call', strike: 100, dte: 30, iv: 0.2, delta: 0.52, gamma: 0.03 }, { spot: 100 });
  assert.equal(vendor.delta, 0.52); assert.equal(vendor.greeksSource, 'vendor');
  const row = { side: 'put', strike: 100, expiration: Math.floor(Date.UTC(2026, 10, 20) / 1000), impliedVolatility: 0.25 };
  const nowMs = Date.UTC(2026, 9, 20, 15);
  const derived = G.fillGreeks(row, { spot: 100, nowMs });
  assert.equal(derived.greeksSource, 'model-bsm-from-quoted-iv');
  assert.ok(derived.delta < 0 && derived.delta > -1 && derived.gamma > 0 && derived.vega > 0 && derived.theta < 0);
  assert.equal(row.delta, undefined, 'input row is not mutated');
  const none = G.fillGreeks({ side: 'call', strike: 100, dte: 30, iv: 0 }, { spot: 100 });
  assert.equal(none.greeksSource, null); assert.equal(none.delta, undefined);
});

// ── vendored LetsBeRational against the upstream oracle ─────────────────────
test(`LetsBeRational: black / normalised black / IV inversion match ${ORACLE.rows.length} upstream oracle rows`, () => {
  for (const o of ORACLE.rows) {
    relClose(LBR.black(o.F, o.K, o.sigma, o.T, o.q), o.black, 1e-11, `black F=${o.F} K=${o.K}`);
    relClose(LBR.normalizedBlack(o.x, o.s, o.q), o.normalised_black, 1e-11, `normalised_black x=${o.x}`);
    relClose(LBR.normalizedVega(o.x, o.s), o.normalised_vega, 1e-11, 'normalised_vega');
    relClose(LBR.normCdf(o.z), o.norm_cdf, 1e-13, 'norm_cdf');
    relClose(LBR.impliedVolatilityFromATransformedRationalGuess(o.black, o.F, o.K, o.T, o.q), o.iv, 1e-9, `iv F=${o.F} K=${o.K} T=${o.T}`);
    if (o.iv_limited != null) relClose(LBR.impliedVolatilityFromATransformedRationalGuessWithLimitedIterations(o.black, o.F, o.K, o.T, o.q, o.N), o.iv_limited, 1e-9, 'iv limited');
  }
});

test('LetsBeRational: special functions and arbitrage bounds behave', () => {
  close(LBR.normCdf(0), 0.5, 1e-15); close(LBR.normCdf(1.96), 0.9750021048517795, 1e-13);
  close(LBR.inverseNormCdf(0.975), 1.959963984540054, 1e-12); close(LBR.inverseNormCdf(1e-6), -4.753424308822899, 1e-10);
  close(LBR.erfcxCody(0), 1, 1e-15); close(LBR.erfcxCody(2) * Math.exp(-4), 0.004677734981047266, 1e-14);
  assert.throws(() => LBR.impliedVolatilityFromATransformedRationalGuess(0.5, 100, 90, 1, 1), LBR.BelowIntrinsicError);
  assert.throws(() => LBR.impliedVolatilityFromATransformedRationalGuess(101, 100, 90, 1, 1), LBR.AboveMaximumError);
});
