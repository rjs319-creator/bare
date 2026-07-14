'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const DSR = require('../lib/evolve-dsr');

test('normCdf / normInv are consistent', () => {
  assert.ok(Math.abs(DSR.normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(DSR.normInv(0.5)) < 1e-4);
  assert.ok(Math.abs(DSR.normInv(DSR.normCdf(1.0)) - 1.0) < 1e-3, 'round-trips at 1σ');
  assert.ok(DSR.normCdf(1.645) > 0.94 && DSR.normCdf(1.645) < 0.96, '~95th percentile');
});

test('probabilisticSharpe rises with sample size and with the Sharpe', () => {
  const small = DSR.probabilisticSharpe(0.1, 30, 0, 3, 0);
  const big = DSR.probabilisticSharpe(0.1, 300, 0, 3, 0);
  assert.ok(big > small, 'more samples → more confident');
  const hi = DSR.probabilisticSharpe(0.3, 100, 0, 3, 0);
  const lo = DSR.probabilisticSharpe(0.05, 100, 0, 3, 0);
  assert.ok(hi > lo, 'higher SR → higher PSR');
});

test('expectedMaxSharpe grows with the number of trials and SR dispersion', () => {
  assert.ok(DSR.expectedMaxSharpe(100, 0.04) > DSR.expectedMaxSharpe(5, 0.04), 'more trials → higher expected max');
  assert.ok(DSR.expectedMaxSharpe(50, 0.09) > DSR.expectedMaxSharpe(50, 0.01), 'more dispersion → higher expected max');
  assert.strictEqual(DSR.expectedMaxSharpe(50, 0), 0, 'no dispersion → zero benchmark');
});

test('deflation: a modest Sharpe that passes at 1 trial fails once many were tried', () => {
  const sr = 0.15, n = 120;
  const single = DSR.probabilisticSharpe(sr, n, 0, 3, 0);            // benchmark 0 (no selection)
  const deflated = DSR.deflatedSharpe(sr, n, 0, 3, 200, 0.05).dsr;   // 200 trials, real SR dispersion
  assert.ok(single > 0.9, 'looks significant on its own');
  assert.ok(deflated < single, 'deflation lowers the confidence');
});

test('gridDeflatedSharpe: pure noise yields no surviving cell and reports the trial count', () => {
  // 6 specialist/regime/horizon cells, each 40 labels of zero-mean noise → nothing real.
  const events = [];
  const specs = ['A', 'B'], regs = ['risk-on', 'neutral', 'risk-off'];
  for (const sp of specs) for (const rg of regs) {
    for (let i = 0; i < 40; i++) {
      const v = ((i * 37 + sp.charCodeAt(0) + rg.length * 11) % 21 - 10) / 100;   // deterministic ~zero-mean
      events.push({ specialists: [sp], regimeLabel: rg, horizon: 'swing', spyRelReturn: v });
    }
  }
  const g = DSR.gridDeflatedSharpe(events, { minCellN: 20 });
  assert.strictEqual(g.trials, 6, 'counts every sufficiently-sampled cell as a trial');
  assert.strictEqual(g.passing, 0, 'no noise cell survives the multiple-testing gate');
  assert.strictEqual(g.verdict, 'no cell survives multiple-testing');
});

test('gridDeflatedSharpe: undersized cells are excluded from the trial count', () => {
  const events = [];
  for (let i = 0; i < 10; i++) events.push({ specialists: ['A'], regimeLabel: 'risk-on', horizon: 'fast', spyRelReturn: 0.02 });
  const g = DSR.gridDeflatedSharpe(events, { minCellN: 20 });
  assert.strictEqual(g.trials, 0, 'a 10-label cell is not a real trial');
  assert.ok(g.cells[0].tooSmall, 'flagged too small');
});
