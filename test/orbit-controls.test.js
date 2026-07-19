'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../lib/orbit-controls');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

// Synthetic resolved samples across `nDates` dates × `nNames` names, spanning 2 years.
// `mode`: 'signal' (label tracks residMom63), 'noise' (label independent), 'leak' (a
// feature equals the label).
function makeSamples(nDates, nNames, seed, mode = 'signal') {
  const rnd = lcg(seed); const samples = [];
  let d = new Date('2022-01-03T00:00:00Z');
  for (let di = 0; di < nDates; di++) {
    const decisionDate = d.toISOString().slice(0, 10); d = new Date(d.getTime() + 15 * 86400000); // ~semi-monthly → spans 2 yrs
    for (let ni = 0; ni < nNames; ni++) {
      const residMom63 = (rnd() - 0.5) * 0.2, drift = (rnd() - 0.5) * 0.004;
      // Realistic signal: a modest, noisy dependence on residMom63 (real IC ~0.15-0.35),
      // NOT a near-perfect linear label. Noise dominates any single name.
      const resid = mode === 'signal' ? (2.5 * residMom63 + 0.008 + (rnd() - 0.5) * 0.35) : (rnd() - 0.5) * 0.4;
      const gross = resid, net = gross - 0.0016;   // cost-v1 liquid round-trip ≈ 0.16%
      const feats = { residMom63, residMom21: residMom63 * 0.5, drift, driftZ: drift * 400, driftProbPositive: 0.5, residConsistency: 0.5 + residMom63, demandAsymmetry: (rnd() - 0.5) * 1e-3, udDollarImbalance: (rnd() - 0.5) * 0.4 };
      if (mode === 'leak') feats.LEAK = resid;      // a feature that equals the future label
      samples.push({ ticker: `T${ni}`, decisionDate, features: feats, horizons: { days21: { resolved: true, residualReturn: +resid.toFixed(4), netReturn: +net.toFixed(4), grossReturn: +gross.toFixed(4), positiveResidual: resid > 0 ? 1 : 0, severeLoss: net <= -0.08 ? 1 : 0 } } });
    }
  }
  return samples;
}

test('shuffled-label control: real signal gives IC>0, shuffled collapses to ~0', () => {
  const out = C.shuffledLabelControl(makeSamples(50, 16, 1, 'signal'), { outerBlocks: 5 });
  assert.ok(out.realIC > 0.05, `real IC ${out.realIC}`);
  assert.ok(Math.abs(out.shuffledIC) < out.realIC * 0.6, `shuffled IC (${out.shuffledIC}) far below real IC (${out.realIC})`);
  assert.strictEqual(out.leakSuspected, false);
});

test('future-feature control flags a feature that equals the label', () => {
  const out = C.futureFeatureControl(makeSamples(20, 10, 2, 'leak'));
  assert.ok(out.leakSuspected);
  assert.ok(out.flagged.some(f => f.feature === 'LEAK'));
});

test('random-ranker baseline has IC ~0', () => {
  const out = C.randomRankerControl(makeSamples(30, 12, 3, 'signal'));
  assert.ok(out.ok, `random IC should be ~0, got ${out.ic}`);
});

test('doubled-cost control recomputes the top decile at 2x cost', () => {
  const out = C.doubledCostControl(makeSamples(30, 12, 4, 'signal'));
  assert.ok(out.baseTopDecileNet != null && out.doubledTopDecileNet != null);
  assert.ok(out.doubledTopDecileNet < out.baseTopDecileNet, 'doubled cost lowers net');
});

test('runControls returns FAIL-LEAKAGE when a future-leak feature is present', () => {
  const out = C.runControls(makeSamples(40, 12, 5, 'leak'), { outerBlocks: 4 });
  assert.strictEqual(out.verdict, 'FAIL-LEAKAGE');
  assert.ok(out.controls.futureFeat.leakSuspected);
});

test('runControls returns NO-EDGE on clean noise (no leakage, nothing to promote)', () => {
  const out = C.runControls(makeSamples(40, 12, 6, 'noise'), { outerBlocks: 4 });
  assert.strictEqual(out.verdict, 'NO-EDGE');
  assert.strictEqual(out.controls.shuffled.leakSuspected, false);
});

test('shuffleLabels is deterministic and preserves the label multiset per date', () => {
  const s = makeSamples(3, 6, 7, 'signal');
  const a = C.shuffleLabels(s), b = C.shuffleLabels(s);
  assert.deepStrictEqual(a.map(x => x.horizons.days21.netReturn), b.map(x => x.horizons.days21.netReturn));
  // Same set of labels on the first date, just reassigned across names.
  const d0 = s[0].decisionDate;
  const orig = s.filter(x => x.decisionDate === d0).map(x => x.horizons.days21.netReturn).sort();
  const shuf = a.filter(x => x.decisionDate === d0).map(x => x.horizons.days21.netReturn).sort();
  assert.deepStrictEqual(orig, shuf);
});
