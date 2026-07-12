'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../lib/baselines');

const RESEARCH = {
  factors: [
    { key: 'mom126', label: 'Momentum 6mo', rankIC: 0.10, winRateSpread: 12, n: 4000, quintiles: [{ q: 1, avgR: -1.2 }, { q: 5, avgR: 1.8 }] },
    { key: 'proximity', label: 'Proximity', rankIC: 0.07, winRateSpread: 8, n: 4000, quintiles: [{ q: 1, avgR: -0.8 }, { q: 5, avgR: 1.1 }] },
    { key: 'volSurge', label: 'Volume surge', rankIC: -0.004, winRateSpread: 0, n: 4000, quintiles: [{ q: 1, avgR: 0.1 }, { q: 5, avgR: -0.1 }] },
  ],
};
const MATURITY = {
  strategies: [
    { id: 'ghost', label: 'Ghost', kind: 'signal', grade: 'disabled', stats: { baselines: { market: { avgExcess: -3.7, n: 129 }, sector: { avgExcess: -2.1, n: 100 } } } },
    { id: 'screener', label: 'Breakout', kind: 'signal', grade: 'experimental', stats: { baselines: { market: { avgExcess: -0.4, n: 180 }, sector: { avgExcess: 0.2, n: 150 } } } },
    { id: 'sectors', label: 'Sectors', kind: 'informational' },
  ],
};

test('readFactor: momentum reads rankIC + top-quintile excess + predictive', () => {
  const r = B.readFactor(RESEARCH, 'mom126');
  assert.equal(r.available, true);
  assert.equal(r.rankIC, 0.10);
  assert.equal(r.topQuintileExcess, 1.8);
  assert.equal(r.predictive, true);
});

test('readFactor: dead factor (volSurge) reads not-predictive', () => {
  const r = B.readFactor(RESEARCH, 'volSurge');
  assert.equal(r.available, true);
  assert.equal(r.predictive, false);   // IC ~0
});

test('readFactor: missing factor → unavailable', () => {
  assert.equal(B.readFactor(RESEARCH, 'nope').available, false);
  assert.equal(B.readFactor(null, 'mom126').available, false);
});

test('assembleBaselines: builds 8 baselines incl. benchmarks + null + unavailable', () => {
  const out = B.assembleBaselines({ research: RESEARCH, maturity: MATURITY });
  assert.equal(out.baselines.length, 8);
  assert.equal(out.baselines.find(b => b.key === 'equalweight').topQuintileExcess, 0);
  assert.equal(out.baselines.find(b => b.key === 'revision').available, false);
  assert.equal(out.bestBar.key, 'momentum');   // strongest predictive factor
});

test('assembleBaselines: strategies compared vs SPY + sector, sorted, only signals', () => {
  const out = B.assembleBaselines({ research: RESEARCH, maturity: MATURITY });
  assert.equal(out.strategies.length, 2);       // informational excluded
  assert.equal(out.strategies[0].id, 'screener'); // higher vsSpy first
  assert.equal(out.strategies.find(s => s.id === 'ghost').beatsSpy, false);
  assert.equal(out.summary.beatSpyAndSector, 0);
});

test('assembleBaselines: honest verdict when nothing beats SPY+sector', () => {
  const out = B.assembleBaselines({ research: RESEARCH, maturity: MATURITY });
  assert.match(out.verdict, /No strategy yet beats SPY \+ sector/);
  assert.match(out.verdict, /momentum/);
});

test('assembleBaselines: graceful when research not computed', () => {
  const out = B.assembleBaselines({ research: null, maturity: MATURITY });
  assert.equal(out.summary.researchAvailable, false);
  assert.match(out.verdict, /not computed yet/);
});
