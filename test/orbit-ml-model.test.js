'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/orbit-ml-model');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

// Date-grouped rows: target (future net residual return) driven by residMom63 + drift.
function makeRows(nDates, nNames, seed) {
  const rnd = lcg(seed); const rows = [];
  for (let d = 0; d < nDates; d++) {
    const decisionDate = `2023-${String(1 + (d % 12)).padStart(2, '0')}-${String(1 + (d % 27)).padStart(2, '0')}`;
    for (let n = 0; n < nNames; n++) {
      const residMom63 = (rnd() - 0.5) * 0.2, drift = (rnd() - 0.5) * 0.004;
      const target = 6 * residMom63 + 6000 * drift + (rnd() - 0.5) * 2;   // noisy but signal present
      rows.push({ decisionDate, features: { residMom63, residMom21: residMom63 * 0.5, drift, driftZ: drift * 400, driftProbPositive: 0.5, residConsistency: 0.5 + residMom63, demandAsymmetry: (rnd() - 0.5) * 1e-3, udDollarImbalance: (rnd() - 0.5) * 0.4 }, target });
    }
  }
  return rows;
}

test('pairwise RankNet learns cross-sectional ordering', () => {
  const model = R.fitRankModel(makeRows(40, 15, 1), { iters: 250 });
  assert.ok(model.trained);
  assert.ok(model.nPairs > 0 && model.nGroups > 0);
  const strong = R.scoreRankModel(model, { residMom63: 0.09, drift: 0.003 });
  const weak = R.scoreRankModel(model, { residMom63: -0.09, drift: -0.003 });
  assert.ok(strong > weak, `strong ${strong} > weak ${weak}`);
});

test('rankGroup orders a same-date group and assigns percentiles', () => {
  const model = R.fitRankModel(makeRows(40, 15, 2), { iters: 200 });
  const cands = [
    { ticker: 'A', features: { residMom63: 0.1, drift: 0.003 } },
    { ticker: 'B', features: { residMom63: 0.0, drift: 0.0 } },
    { ticker: 'C', features: { residMom63: -0.1, drift: -0.003 } },
  ];
  const ranked = R.rankGroup(model, cands);
  assert.strictEqual(ranked[0].ticker, 'A', 'strongest first');
  assert.strictEqual(ranked[ranked.length - 1].ticker, 'C');
  assert.ok(ranked[0].rankPct === 1 && ranked[ranked.length - 1].rankPct === 0);
});

test('deterministic — identical rows give identical weights', () => {
  const rows = makeRows(30, 12, 3);
  assert.deepStrictEqual(R.fitRankModel(rows, { iters: 150 }).weights, R.fitRankModel(rows, { iters: 150 }).weights);
});

test('no within-date pairs → not trained (honest)', () => {
  const rows = [{ decisionDate: '2023-01-01', features: { residMom63: 0.1 }, target: 0.05 }];
  const model = R.fitRankModel(rows);
  assert.strictEqual(model.trained, false);
  assert.ok(/pairs/.test(model.reason));
});

test('gbmStatus reports NOT available with no artifact (no fabricated boosted result)', () => {
  assert.strictEqual(R.gbmStatus(null).available, false);
  assert.ok(/LightGBM|CatBoost|artifact/.test(R.gbmStatus(null).reason));
  assert.strictEqual(R.evalTrees(null, {}), null);
});

test('evalTrees deterministically evaluates a frozen JSON-tree artifact', () => {
  const artifact = {
    version: 'test', features: ['x'], bias: 0.1,
    trees: [{ nodes: [{ feature: 0, threshold: 0, left: 1, right: 2 }, { leaf: -1 }, { leaf: 1 }] }],
  };
  assert.strictEqual(R.gbmStatus(artifact).available, true);
  assert.ok(Math.abs(R.evalTrees(artifact, { x: 5 }) - 1.1) < 1e-9, 'x>0 → right leaf +1 +bias');
  assert.ok(Math.abs(R.evalTrees(artifact, { x: -5 }) + 0.9) < 1e-9, 'x<=0 → left leaf −1 +bias');
});
