'use strict';
// GRIDLOCK region model + constraint-pressure score: labeling, missing-data
// honesty, renormalization, region-specific normalization. Synthetic inputs.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/gridlock-region');

const FULL_INPUTS = {
  pjm: {
    currentLoadMW: 120000, forecastLoadMW: 118000, outageCapacityMW: 20000,
    installedCapacityMW: 180000, dayAheadPrice: 45, realTimePrice: 60,
    zonalPrices: { DOM: 70, PECO: 42 }, generationByFuel: { gas: 50000, nuclear: 33000 },
    netInterchangeMW: -2000,
  },
  eia: { demandMW: 119500, netGenerationMW: 118000, interchangeMW: -2100, generationByFuel: null },
  nws: { activeAlerts: [{ event: 'Excessive Heat Warning', severity: 'Severe' }, { event: 'Rip Current Statement' }] },
  gas: { hubPriceUSD: 4.2 },
  pipeline: { announcedLargeLoadMW: 6000, generationPipelineMW: 5000, retirementPipelineMW: 2000 },
};

test('buildRegionState labels every value with provenance and computes derived fields', () => {
  const st = R.buildRegionState({ isoRegion: 'PJM', asOf: '2026-07-15', inputs: FULL_INPUTS });
  assert.strictEqual(st.currentLoadMW.basis, 'observed');
  assert.strictEqual(st.availableCapacityMW.value, 160000);
  assert.strictEqual(st.availableCapacityMW.basis, 'derived');
  assert.strictEqual(st.reserveMarginProxy.basis, 'estimated-proxy');
  assert.strictEqual(st.representativeHeatRate.basis, 'assumed');
  assert.strictEqual(st.weatherDemandRisk.value, 1);         // only the heat alert counts
  assert.ok(st.dataCoverage > 0.8);
  assert.strictEqual(st.dataQuality, 'good');
  assert.strictEqual(st.season, 'summer');                   // July → summer norms
});

test('missing adapters produce explicit staleFields, never fabricated values', () => {
  const st = R.buildRegionState({ isoRegion: 'PJM', asOf: '2026-07-15', inputs: {} });
  assert.strictEqual(st.currentLoadMW.value, null);
  assert.ok(st.staleFields.includes('reserveMarginProxy'));
  assert.strictEqual(st.dataQuality, 'poor');
});

test('EIA demand backfills load when PJM is down (fallback labeled)', () => {
  const st = R.buildRegionState({ isoRegion: 'PJM', asOf: '2026-07-15', inputs: { eia: FULL_INPUTS.eia } });
  assert.strictEqual(st.currentLoadMW.value, 119500);
  assert.match(st.currentLoadMW.note || '', /EIA/);
});

test('constraintPressureScore decomposes, renormalizes over available components and names the dominant constraint', () => {
  const st = R.buildRegionState({ isoRegion: 'PJM', asOf: '2026-07-15', inputs: FULL_INPUTS });
  const cps = R.constraintPressureScore(st, []);
  assert.ok(cps.total >= 0 && cps.total <= 100);
  assert.ok(cps.available.length >= 6);
  assert.ok(typeof cps.dominantConstraint === 'string');
  assert.match(cps.explanation, /research hypotheses/);
  // Partial inputs → fewer components, weights renormalized, missing reported.
  const st2 = R.buildRegionState({ isoRegion: 'PJM', asOf: '2026-07-15', inputs: { nws: FULL_INPUTS.nws } });
  const cps2 = R.constraintPressureScore(st2, []);
  assert.ok(cps2.missing.includes('reserveMargin'));
  assert.ok(cps2.total != null);                              // still scored over what exists
  assert.ok(cps2.confidence < cps.confidence);                // but with lower confidence
});

test('no inputs at all → score WITHHELD, not zero', () => {
  const st = R.buildRegionState({ isoRegion: 'PJM', asOf: '2026-07-15', inputs: {} });
  const cps = R.constraintPressureScore(st, []);
  assert.strictEqual(cps.total, null);
  assert.strictEqual(cps.missing.length, 8);
});

test('unsupported region is withheld rather than mis-normalized (no raw cross-ISO comparison)', () => {
  const st = R.buildRegionState({ isoRegion: 'ERCOT', asOf: '2026-07-15', inputs: FULL_INPUTS });
  const cps = R.constraintPressureScore(st, []);
  assert.strictEqual(cps.total, null);
  assert.match(cps.explanation, /withheld/);
});

test('change deltas come from history (1d/7d/30d) and drive direction', () => {
  const st = R.buildRegionState({ isoRegion: 'PJM', asOf: '2026-07-15', inputs: FULL_INPUTS });
  const history = [{ asOf: '2026-06-15', total: 10 }, { asOf: '2026-07-08', total: 20 }, { asOf: '2026-07-14', total: 30 }];
  const cps = R.constraintPressureScore(st, history);
  assert.strictEqual(cps.change.d1, cps.total - 30);
  assert.strictEqual(cps.change.d7, cps.total - 20);
  assert.strictEqual(cps.change.d30, cps.total - 10);
  assert.ok(['tightening', 'easing', 'stable'].includes(cps.direction));
});

test('seasonal normalization differs (same margin scores differently in summer vs shoulder)', () => {
  const inputs = { pjm: { currentLoadMW: 100000, forecastLoadMW: 100000, outageCapacityMW: 10000, installedCapacityMW: 125000 } };
  const summer = R.constraintPressureScore(R.buildRegionState({ isoRegion: 'PJM', asOf: '2026-07-15', inputs }), []);
  const shoulder = R.constraintPressureScore(R.buildRegionState({ isoRegion: 'PJM', asOf: '2026-04-15', inputs }), []);
  // 25% margin: comfortable in summer terms (comfort 30) but far from shoulder comfort (45)
  assert.ok(shoulder.components.reserveMargin > summer.components.reserveMargin);
});
