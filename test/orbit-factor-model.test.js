'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const FM = require('../lib/orbit-factor-model');

// Deterministic pseudo-random (LCG) so tests never touch Math.random.
function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

test('toReturns computes simple daily returns with null lead', () => {
  const r = FM.toReturns([100, 110, 99]);
  assert.strictEqual(r[0], null);
  assert.ok(Math.abs(r[1] - 0.1) < 1e-9);
  assert.ok(Math.abs(r[2] + 0.1) < 1e-9);
});

test('recovers market beta and near-zero residual when stock = 2*market', () => {
  const rnd = lcg(7);
  const L = 160;
  const mktRet = Array.from({ length: L }, (_, i) => i === 0 ? null : (rnd() - 0.5) * 0.02);
  const stockRet = mktRet.map(m => m == null ? null : 2 * m);   // pure beta 2, no idio
  const out = FM.residualWindow(stockRet, { market: mktRet }, { window: 120, minObs: 40 });
  assert.ok(out.sufficient);
  assert.ok(Math.abs(out.exposures.market - 2) < 0.02, `beta ${out.exposures.market}`);
  const maxAbsResid = Math.max(...out.residuals.map(Math.abs));
  assert.ok(maxAbsResid < 1e-3, `residuals ~0, got ${maxAbsResid}`);
});

test('idiosyncratic drift survives factor removal', () => {
  const rnd = lcg(11);
  const L = 160;
  const mktRet = Array.from({ length: L }, (_, i) => i === 0 ? null : (rnd() - 0.5) * 0.02);
  // stock = 1*market + constant +0.001 idiosyncratic drift
  const stockRet = mktRet.map(m => m == null ? null : 1 * m + 0.001);
  const out = FM.residualWindow(stockRet, { market: mktRet }, { window: 120, minObs: 40 });
  assert.ok(out.sufficient);
  assert.ok(Math.abs(out.exposures.market - 1) < 0.03);
  // The +0.001 is absorbed by the intercept (alpha), leaving residuals ~0-mean.
  assert.ok(Math.abs(out.exposures.alpha - 0.001) < 3e-4, `alpha ${out.exposures.alpha}`);
});

test('insufficient when too few usable rows', () => {
  const stockRet = [null, 0.01, 0.02, -0.01];
  const out = FM.residualWindow(stockRet, { market: [null, 0.01, 0.0, 0.01] }, { minObs: 40 });
  assert.strictEqual(out.sufficient, false);
  assert.ok(/rows/.test(out.reason));
  assert.deepStrictEqual(out.residuals, []);
});

test('deterministic — identical inputs give identical output', () => {
  const rnd = lcg(3);
  const L = 130;
  const mktRet = Array.from({ length: L }, (_, i) => i === 0 ? null : (rnd() - 0.5) * 0.02);
  const stockRet = mktRet.map((m, i) => m == null ? null : 0.8 * m + (i % 5 === 0 ? 0.003 : -0.001));
  const a = FM.residualWindow(stockRet, { market: mktRet });
  const b = FM.residualWindow(stockRet, { market: mktRet });
  assert.deepStrictEqual(a, b);
});

test('betas are hard-capped', () => {
  const rnd = lcg(5);
  const L = 130;
  const mktRet = Array.from({ length: L }, (_, i) => i === 0 ? null : (rnd() - 0.5) * 0.0001); // tiny market moves
  const stockRet = mktRet.map(m => m == null ? null : 50 * m); // would imply beta 50
  const out = FM.residualWindow(stockRet, { market: mktRet }, { betaCap: 3.5 });
  assert.ok(Math.abs(out.exposures.market) <= 3.5 + 1e-9, `capped ${out.exposures.market}`);
});

test('sectorEtfFor maps known sectors and returns null otherwise', () => {
  assert.strictEqual(FM.sectorEtfFor('Technology'), 'XLK');
  assert.strictEqual(FM.sectorEtfFor('Financials'), 'XLF');
  assert.strictEqual(FM.sectorEtfFor('Nonexistent'), null);
});
