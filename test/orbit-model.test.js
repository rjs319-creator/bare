'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Mod = require('../lib/orbit-model');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

// Rows whose outcome depends monotonically on drift + residMom63 (+ noise).
function makeRows(n, seed) {
  const rnd = lcg(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.4) * 0.004;          // slightly positive-biased
    const residMom63 = (rnd() - 0.4) * 0.1;
    const signal = 8000 * drift + 6 * residMom63;  // latent score
    const p = 1 / (1 + Math.exp(-signal));
    const raw = rnd() < p ? 1 : 0;
    const net = raw ? 0.05 + rnd() * 0.1 : -0.04 - rnd() * 0.08;
    rows.push({
      features: {
        drift, residMom63, residMom21: residMom63 * 0.5, driftZ: drift * 400, residConsistency: 0.5 + residMom63,
        demandAsymmetry: (rnd() - 0.5) * 1e-3, udDollarImbalance: (rnd() - 0.5) * 0.4,
        driftProbPositive: p, obvSlope: (rnd() - 0.5) * 1e6, closeLocation: rnd() - 0.5,
      },
      raw, resid: raw, severe: net <= -0.08 ? 1 : 0,
      outcome: raw ? 'upper' : (net <= -0.08 ? 'lower' : 'timeout'), netReturn: net,
    });
  }
  return rows;
}

test('fits and orders: favorable features get a higher rawUp', () => {
  const model = Mod.fitOrbitModel(makeRows(400, 1), { horizon: 21 });
  assert.ok(model.trained);
  const strong = Mod.scoreOrbit(model, { drift: 0.003, residMom63: 0.08, driftProbPositive: 0.8, residConsistency: 0.6 });
  const weak = Mod.scoreOrbit(model, { drift: -0.003, residMom63: -0.08, driftProbPositive: 0.2, residConsistency: 0.4 });
  assert.ok(strong.rawUp > weak.rawUp, `strong ${strong.rawUp} > weak ${weak.rawUp}`);
  assert.ok(strong.rankScore > weak.rankScore);
});

test('score includes all contract fields and barrier probs sum to 1', () => {
  const model = Mod.fitOrbitModel(makeRows(400, 2), { horizon: 5 });
  const s = Mod.scoreOrbit(model, { drift: 0.001, residMom63: 0.02 });
  for (const k of ['rawUp', 'residualUp', 'pUpper', 'pLower', 'pTimeout', 'severeLossProbability', 'expectedNetReturn', 'rankScore']) {
    assert.ok(k in s, `field ${k}`);
  }
  assert.ok(Math.abs(s.pUpper + s.pLower + s.pTimeout - 1) < 1e-6, 'barrier probs normalised');
});

test('train/serve parity: transform is deterministic and frozen to the training scaler', () => {
  const rows = makeRows(300, 3);
  const model = Mod.fitOrbitModel(rows, { horizon: 21 });
  const feats = { drift: 0.002, residMom63: 0.05 };
  const a = Mod.transform(model.scaler, feats);
  const b = Mod.transform(model.scaler, feats);
  assert.deepStrictEqual(a, b, 'same features → identical design vector');
  // Refitting on the same rows gives an identical model (deterministic).
  const model2 = Mod.fitOrbitModel(rows, { horizon: 21 });
  assert.deepStrictEqual(model.weights, model2.weights);
});

test('winsor limits are fit on TRAIN only and clamp extreme serve values', () => {
  const model = Mod.fitOrbitModel(makeRows(300, 4), { horizon: 21 });
  const normal = Mod.transform(model.scaler, { residMom63: 0.05 });
  const extreme = Mod.transform(model.scaler, { residMom63: 1e6 });
  const idx = model.scaler.features.indexOf('residMom63') + 1;
  assert.ok(Number.isFinite(extreme[idx]));
  assert.ok(extreme[idx] < 100, 'extreme value winsorised, not exploding the design');
});

test('base-rate baseline returns the training base rate', () => {
  const rows = makeRows(200, 5);
  const b = Mod.fitBaseRate(rows);
  assert.ok(b.p > 0 && b.p < 1);
  assert.strictEqual(Mod.scoreBaseRate(b).rankScore, b.p);
});

test('residual-momentum baseline orders by residMom63', () => {
  const model = Mod.fitResidualMomentum(makeRows(300, 6));
  const hi = Mod.scoreResidualMomentum(model, { residMom63: 0.1 });
  const lo = Mod.scoreResidualMomentum(model, { residMom63: -0.1 });
  assert.ok(hi.rankScore > lo.rankScore);
});
