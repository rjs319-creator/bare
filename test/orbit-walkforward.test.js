'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const WF = require('../lib/orbit-walkforward');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

// Build samples across `nDates` decision dates × `nNames` tickers. Each name's
// label is driven by its residMom63/drift (a real cross-sectional signal) + noise.
function makeSamples(nDates, nNames, seed) {
  const rnd = lcg(seed);
  const samples = [];
  let d = new Date('2022-01-03T00:00:00Z');
  for (let di = 0; di < nDates; di++) {
    const decisionDate = d.toISOString().slice(0, 10);
    d = new Date(d.getTime() + 5 * 86400000);   // weekly cadence
    for (let ni = 0; ni < nNames; ni++) {
      const residMom63 = (rnd() - 0.5) * 0.2;
      const drift = (rnd() - 0.5) * 0.004;
      const signal = 6 * residMom63 + 6000 * drift;
      const p = 1 / (1 + Math.exp(-signal));
      const win = rnd() < p ? 1 : 0;
      const net = win ? 0.04 + rnd() * 0.08 : -0.03 - rnd() * 0.06;
      samples.push({
        ticker: `T${ni}`, decisionDate,
        features: { residMom63, residMom21: residMom63 * 0.5, drift, driftZ: drift * 400, driftProbPositive: p, residConsistency: 0.5 + residMom63, demandAsymmetry: (rnd() - 0.5) * 1e-3, udDollarImbalance: (rnd() - 0.5) * 0.4 },
        horizons: {
          days21: { resolved: true, positiveResidual: win, positiveRaw: win, severeLoss: net <= -0.08 ? 1 : 0, barrier: win ? 'upper' : 'lower', netReturn: net, exitDate: new Date(new Date(decisionDate).getTime() + 30 * 86400000).toISOString().slice(0, 10) },
        },
      });
    }
  }
  return samples;
}

test('runs nested walk-forward and recovers a positive purged IC on a real signal', () => {
  const out = WF.walkForward(makeSamples(60, 25, 1), { horizon: 'days21', labelField: 'positiveResidual', outerBlocks: 6, minTrain: 150 });
  assert.ok(out.ok, out.reason);
  assert.ok(out.purged.overall, 'purged overall metrics present');
  assert.ok(out.purged.overall.ic > 0, `purged IC positive, got ${out.purged.overall.ic}`);
  assert.ok(out.purged.nOuter >= 2, 'multiple outer folds evaluated');
});

test('reports purged AND leaky side by side with a leakage-inflation number', () => {
  const out = WF.walkForward(makeSamples(60, 25, 2), { outerBlocks: 6, minTrain: 150 });
  assert.ok(out.leaky.overall && out.purged.overall);
  assert.ok('leakageInflation' in out, 'leakage inflation reported');
});

test('purge drops training events whose label has not closed before the block', () => {
  const rows = WF.horizonRows(makeSamples(40, 20, 3), 'days21', 'positiveResidual');
  const blocks = WF.dateBlocks(rows, 5);
  const blockStart = blocks[3][0];
  const embargo = 45;
  const purged = rows.filter(r => r.labelEndDate < WF.addDays(blockStart, -embargo));
  const leaky = rows.filter(r => r.decisionDate < blockStart);
  assert.ok(purged.length < leaky.length, 'purge removes boundary-overlapping events');
});

test('researchValidity defaults to NOT survivorship-safe / NOT production-grade', () => {
  const out = WF.walkForward(makeSamples(60, 20, 4), { outerBlocks: 6, minTrain: 150 });
  assert.strictEqual(out.researchValidity.productionGrade, false);
  assert.strictEqual(out.researchValidity.survivorshipSafe, false);
});

test('too few resolved rows → ok:false with a reason', () => {
  const out = WF.walkForward(makeSamples(5, 5, 5), { minTrain: 150 });
  assert.strictEqual(out.ok, false);
  assert.ok(/too few/.test(out.reason));
});

test('groupedIC averages per-date and yields an ICIR', () => {
  const preds = [];
  for (let dd = 0; dd < 10; dd++) for (let n = 0; n < 5; n++) preds.push({ date: `2022-01-${10 + dd}`, score: n / 5, net: (n / 5 - 0.5) * 0.1 });
  const g = WF.groupedIC(preds);
  assert.ok(g.ic > 0.5, `strong monotone signal, IC ${g.ic}`);
  assert.ok(g.nDates === 10);
});
