'use strict';
// ORBIT live-resolution labels — pins the 2026-08-11 monitor-starvation defect.
//
// The monitor consumes ONLY rows whose label (positiveResidual) is non-null, and the
// label engine only computes a residual when given the prediction's factor exposures.
// The old op=orbitresolve never passed exposures, so every one of the 600+ live-resolved
// outcomes carried positiveResidual:null and orbit-monitor reported INSUFFICIENT_DATA
// (n=0) on every horizon, forever — the prospective evidence lane the shadow system
// exists to accrue was structurally empty.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { orbitLabels } = require('../lib/orbit-labels');
const Monitor = require('../lib/orbit-monitor');
const { exposuresFor, needsResidualRepair } = require('../lib/orbit-routes');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// n synthetic daily bars; per-bar drift compounds from 100.
function mkCandles(n, driftPct) {
  const out = [];
  let close = 100;
  const d0 = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    close = close * (1 + driftPct);
    const date = new Date(d0.getTime() + i * 86400e3).toISOString().slice(0, 10);
    out.push({ date, open: close, high: close * 1.004, low: close * 0.996, close, volume: 1e6 });
  }
  return out;
}

test('with exposures, resolved horizons carry a non-null residual label the monitor accepts', () => {
  const candles = mkCandles(240, 0.001);        // gently rising stock
  const market = mkCandles(240, 0);             // flat market
  const decisionTs = candles[150].date;
  const labels = orbitLabels(candles, decisionTs, {
    tier: 'liquid', marketCandles: market, sectorCandles: null, exposures: { market: 1 },
  });
  assert.ok(labels.resolvable, 'window must resolve');
  const resolvedHs = Object.entries(labels.horizons).filter(([, h]) => h.resolved);
  assert.ok(resolvedHs.length >= 1, 'at least one horizon resolves in 90 forward bars');
  for (const [name, h] of resolvedHs) {
    assert.ok(h.positiveResidual === 0 || h.positiveResidual === 1, `${name} residual label must be 0/1, got ${h.positiveResidual}`);
  }
  // And the monitor actually counts such a record (the end-to-end contract).
  const rows = resolvedHs.map(([horizon, h]) => ({ date: decisionTs, ticker: 'TEST', horizon, score: null, calUp: null, label: h.positiveResidual, net: h.netReturn, severe: h.severeLoss }));
  const m = Monitor.monitorAll(rows);
  const counted = Object.values(m.byHorizon).reduce((s, v) => s + v.nResolved, 0);
  assert.equal(counted, rows.length, 'monitor must count every labeled row');
});

test('THE REGRESSION: without exposures the residual label is null and the monitor drops the row', () => {
  const candles = mkCandles(240, 0.001);
  const market = mkCandles(240, 0);
  const labels = orbitLabels(candles, candles[150].date, {
    tier: 'liquid', marketCandles: market, sectorCandles: null,   // no exposures — the old resolver
  });
  const resolvedHs = Object.values(labels.horizons).filter(h => h.resolved);
  assert.ok(resolvedHs.length >= 1);
  for (const h of resolvedHs) assert.equal(h.positiveResidual, null);
  const rows = resolvedHs.map((h, i) => ({ date: candles[150].date, ticker: 'TEST', horizon: 'days5', score: null, calUp: null, label: h.positiveResidual, net: h.netReturn, severe: h.severeLoss }));
  const m = Monitor.monitorAll(rows);
  assert.equal(m.byHorizon.days5.nResolved, 0, 'null-labeled rows must not count — which is why n was 0');
});

test('exposuresFor prefers the PIT exposures logged with the prediction', () => {
  const logged = { market: 1.1, sector: 0.4 };
  const got = exposuresFor({ exposures: logged, decisionTs: '2026-06-01' }, { candles: [] }, {}, null);
  assert.strictEqual(got, logged, 'a logged exposure vector must never be recomputed');
});

test('needsResidualRepair flags exactly the null-residual done records', () => {
  assert.equal(needsResidualRepair({ probs: null, horizons: { days5: { resolved: true, positiveResidual: null } } }), true);
  assert.equal(needsResidualRepair({ probs: null, horizons: { days5: { resolved: true, positiveResidual: 1 } } }), false);
  assert.equal(needsResidualRepair({ probs: null, horizons: { days5: { resolved: false } } }), false);
  assert.equal(needsResidualRepair(null), false);
});

test('wiring: the resolver passes exposures + sector candles into the label engine, and the log persists exposures', () => {
  const SRC = read('lib/orbit-routes.js');
  const resolveFn = SRC.slice(SRC.indexOf('async function runOrbitResolve'), SRC.indexOf('runOrbitWalkForward'));
  assert.match(resolveFn, /exposuresFor\(p, hist, factorBundle, sectorCandles\)/);
  assert.match(resolveFn, /orbitLabels\([^)]*exposures/s, 'labels must receive the exposures');
  const logFn = SRC.slice(SRC.indexOf('async function runOrbitLog'), SRC.indexOf('runOrbitResolve'));
  assert.match(logFn, /exposures: p\.factorExposures \|\| null/, 'op=orbitlog must persist PIT exposures');
});

test('resolved records carry per-horizon scores so the monitor can compute IC and brier', () => {
  const SRC = read('lib/orbit-routes.js');
  const resolveFn = SRC.slice(SRC.indexOf('async function runOrbitResolve'), SRC.indexOf('runOrbitWalkForward'));
  assert.match(resolveFn, /probs: p\.horizonProbabilities \|\| null/, 'the resolver must persist the prediction probabilities');
  const flat = SRC.slice(SRC.indexOf('function flattenResolved'), SRC.indexOf('function orbitRouterWeight'));
  assert.match(flat, /pb\.rankScore/, 'flattenResolved must surface rankScore as the IC score');
  assert.match(flat, /pb\.residualUp/, 'flattenResolved must surface the calibrated probability');
  assert.ok(!/score: null, calUp: null/.test(flat), 'the hardcoded nulls that starved the monitor must be gone');
});

test('needsResidualRepair also flags records written without probs', () => {
  assert.equal(needsResidualRepair({ horizons: { days5: { resolved: true, positiveResidual: 1 } } }), true, 'no probs field → repair');
  assert.equal(needsResidualRepair({ probs: null, horizons: { days5: { resolved: true, positiveResidual: 1 } } }), false, 'probs:null is an honest logged absence');
  assert.equal(needsResidualRepair({ probs: { days5: { rankScore: 1 } }, horizons: { days5: { resolved: true, positiveResidual: 1 } } }), false);
});
