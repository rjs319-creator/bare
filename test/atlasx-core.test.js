'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { residualize } = require('../lib/atlasx-residual');
const { detectTransition } = require('../lib/atlasx-transition');
const { pathFeatures } = require('../lib/atlasx-path');

// ── deterministic candle builders (tuple form: [date,o,h,l,c,v,adj]) ──────────
function isoDates(n, startY = 2023, startM = 0, startD = 2) {
  const out = [];
  const d = new Date(Date.UTC(startY, startM, startD));
  let made = 0;
  while (made < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) { out.push(d.toISOString().slice(0, 10)); made++; }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
// build bars from a close path; o/h/l derived deterministically around close
function barsFromCloses(closes, vols) {
  const dates = isoDates(closes.length);
  return closes.map((c, i) => {
    const prev = i ? closes[i - 1] : c;
    const hi = Math.max(c, prev) * 1.01;
    const lo = Math.min(c, prev) * 0.99;
    const o = prev;
    const v = vols ? vols[i] : 1_000_000;
    return [dates[i], round(o), round(hi), round(lo), round(c), v, round(c)];
  });
}
const round = x => Math.round(x * 1e4) / 1e4;

// spy path via a fixed pseudo-return pattern (no RNG → deterministic)
function spyCloses(n) {
  const closes = [100];
  for (let i = 1; i < n; i++) {
    const r = 0.0008 + 0.006 * Math.sin(i / 5) + 0.003 * Math.cos(i / 11);
    closes.push(closes[i - 1] * (1 + r));
  }
  return closes;
}
function spyReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(closes[i] / closes[i - 1] - 1);
  return r;
}

// ── residualization ──────────────────────────────────────────────────────────
test('residualize: a stock that tracks SPY 1:1 has ~zero residual', () => {
  const sc = spyCloses(120);
  const spy = barsFromCloses(sc);
  const stock = barsFromCloses(sc.map(c => c * 2.5)); // identical returns, scaled price
  const r = residualize({ stock, spy, asOf: null });
  assert.ok(r.coverage.spy, 'SPY coverage present');
  assert.ok(Math.abs(r.byHorizon[10].residual) < 0.01, `residual near zero, got ${r.byHorizon[10].residual}`);
});

test('residualize: idiosyncratic outperformance shows POSITIVE residual', () => {
  const sc = spyCloses(120);
  const spyRet = spyReturns(sc);
  const stockCloses = [100];
  for (let i = 0; i < spyRet.length; i++) {
    stockCloses.push(stockCloses[i] * (1 + spyRet[i] + 0.004)); // +40bps/day pure alpha
  }
  const r = residualize({ stock: barsFromCloses(stockCloses), spy: barsFromCloses(sc), asOf: null });
  assert.ok(r.byHorizon[10].residual > 0.01, `expected positive residual, got ${r.byHorizon[10].residual}`);
});

test('residualize: MISSING benchmark stays unknown (null), never zero', () => {
  const stock = barsFromCloses(spyCloses(120).map(c => c * 1.3));
  const r = residualize({ stock, spy: [], asOf: null });
  assert.equal(r.coverage.spy, false);
  assert.equal(r.byHorizon[10].residual, null, 'residual must be null, not 0');
  assert.equal(r.byHorizon[10].partial, true);
});

test('residualize: PIT — future bars after asOf cannot change the residual', () => {
  const sc = spyCloses(140);
  const spyAll = barsFromCloses(sc);
  const stockAll = barsFromCloses(sc.map((c, i) => c * (1.2 + 0.02 * Math.sin(i / 7))));
  const asOf = spyAll[100][0];
  const a = residualize({ stock: stockAll, spy: spyAll, asOf });
  // truncate to asOf then append DIFFERENT future bars — must not affect asOf result
  const b = residualize({
    stock: stockAll.slice(0, 101).concat(barsFromCloses(sc.slice(0, 20).map(c => c * 99))),
    spy: spyAll.slice(0, 101),
    asOf,
  });
  assert.equal(round(a.byHorizon[10].residual), round(b.byHorizon[10].residual));
});

// ── transition ──────────────────────────────────────────────────────────────
test('transition: compression→expansion scores ABOVE a static compression', () => {
  // static: tight range throughout, no expansion
  const staticC = [];
  for (let i = 0; i < 80; i++) staticC.push(50 + 0.05 * Math.sin(i / 3));
  const staticBars = barsFromCloses(staticC, staticC.map(() => 1_000_000));
  // transition: tight for 70 bars then a volume-backed expansion break
  const transC = staticC.slice(0, 70);
  let last = transC[transC.length - 1];
  const transVols = transC.map(() => 1_000_000);
  for (let i = 0; i < 10; i++) { last *= 1.03; transC.push(last); transVols.push(3_000_000); }
  const transBars = barsFromCloses(transC, transVols);

  const sStatic = detectTransition({ candles: staticBars }).scores.compressionToExpansion;
  const sTrans = detectTransition({ candles: transBars }).scores.compressionToExpansion;
  assert.ok(sTrans > sStatic, `transition(${sTrans}) should exceed static(${sStatic})`);
});

test('transition: one-day spike differs from persistent expansion', () => {
  const base = []; for (let i = 0; i < 60; i++) base.push(30 + 0.1 * Math.sin(i / 4));
  const spikeC = base.slice(); const spikeV = base.map(() => 1e6);
  spikeC.push(base[base.length - 1] * 1.25); spikeV.push(6e6);   // one huge day
  const persistC = base.slice(); const persistV = base.map(() => 1e6);
  let l = base[base.length - 1];
  for (let i = 0; i < 6; i++) { l *= 1.03; persistC.push(l); persistV.push(2e6); }

  const spike = detectTransition({ candles: barsFromCloses(spikeC, spikeV) });
  const persist = detectTransition({ candles: barsFromCloses(persistC, persistV) });
  assert.notEqual(spike.dominantTransition, undefined);
  // exhaustion/spike character should not read the same as persistent momentum
  assert.ok(persist.scores.momentumAcceleration >= spike.scores.momentumAcceleration - 0.05 ||
    spike.scores.exhaustion > 0 || spike.features.volAccel > persist.features.volAccel,
    'spike and persistent expansion should be distinguishable');
});

test('transition: breakout rejection is detected (tag high then close weak)', () => {
  const c = []; for (let i = 0; i < 40; i++) c.push(20 + i * 0.05); // slow uptrend
  const dates = isoDates(41);
  const bars = c.map((cl, i) => [dates[i], round(cl), round(cl * 1.005), round(cl * 0.995), round(cl), 1e6, round(cl)]);
  // final bar: spikes to a clear new high then closes near the low (rejection)
  const priorHigh = Math.max(...bars.slice(-22).map(b => b[2]));
  bars.push([dates[40], round(priorHigh), round(priorHigh * 1.05), round(priorHigh * 0.97), round(priorHigh * 0.975), 3e6, round(priorHigh * 0.975)]);
  const t = detectTransition({ candles: bars });
  assert.ok(t.scores.breakoutRejection > 0.1, `rejection score too low: ${t.scores.breakoutRejection}`);
  assert.ok(t.scores.breakoutRejection > t.scores.breakoutAcceptance,
    'rejection should exceed acceptance on a weak-close new-high bar');
});

test('transition: insufficient data fails safe', () => {
  const t = detectTransition({ candles: barsFromCloses([10, 11, 10.5]) });
  assert.equal(t.dataOk, false);
  assert.equal(t.dominantTransition, 'INSUFFICIENT_DATA');
});

test('transition: deterministic — identical input, identical output', () => {
  const bars = barsFromCloses(spyCloses(90));
  const a = detectTransition({ candles: bars });
  const b = detectTransition({ candles: bars });
  assert.deepEqual(a.scores, b.scores);
});

// ── path features ─────────────────────────────────────────────────────────────
test('path: spike-and-fade vs smooth drift are distinguishable', () => {
  const smooth = []; let s = 100; for (let i = 0; i < 22; i++) { s *= 1.006; smooth.push(s); }
  const spike = []; let p = 100;
  for (let i = 0; i < 18; i++) { spike.push(p); } // flat
  p *= 1.30; spike.push(p);                        // spike
  for (let i = 0; i < 3; i++) { p *= 0.97; spike.push(p); } // fade

  const fSmooth = pathFeatures({ candles: barsFromCloses(smooth) });
  const fSpike = pathFeatures({ candles: barsFromCloses(spike) });
  assert.ok(fSmooth.features.smoothness > fSpike.features.smoothness);
  assert.ok(fSpike.features.spikeShare > fSmooth.features.spikeShare);
});

test('path: PIT — future bars cannot change as-of features', () => {
  const closes = spyCloses(60).map((c, i) => c * (1 + 0.01 * Math.sin(i)));
  const bars = barsFromCloses(closes);
  const asOf = bars[40][0];
  const a = pathFeatures({ candles: bars, asOf });
  const b = pathFeatures({ candles: bars.slice(0, 41), asOf });
  assert.deepEqual(a.features, b.features);
});
