'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { assembleCandidate } = require('../lib/biotech-engine');
const { findEventBar } = require('../lib/biotech-features');
const { ARCHETYPES: A, ACTION } = require('../lib/biotech-config');

function mk(closes, vols) {
  return closes.map((c, i) => ({
    date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c * 0.99, high: c * 1.03, low: c * 0.97, close: c, volume: vols ? vols[i] : 1e6,
  }));
}
function popCandles() {
  const base = Array.from({ length: 55 }, () => 10);
  const vols = [...Array.from({ length: 55 }, () => 1e6), 4e6, 3e6, 3e6, 2.5e6, 2.5e6];
  return mk([...base, 12.5, 12.8, 13.1, 12.9, 13.2], vols);
}

test('assembleCandidate: verified liquid post-catalyst can reach PRIMARY-SOURCE CONFIRMED', () => {
  const candles = popCandles();
  const eventIdx = findEventBar(candles, 15);
  const event = { eventType: 'TRIAL_READOUT', verified: true, verification: 'PRIMARY', actualDate: candles[eventIdx].date, independentOriginCount: 2, sources: [{ sourceType: 'sec', primary: true }] };
  const ai = { classification: 'DATA', evidence: 'Verified', catalyst_timing: 'Behind', citations: ['f1'], confidence: 4, groundedPrimary: true };
  const c = assembleCandidate({ ticker: 'VKTX', last: 13.2, relVol: 2.5, avgDollarVol: 4e7, candles, xbi: mk(Array.from({ length: 60 }, (_, i) => 50 + i * 0.02)), eventIdx, event, capital: { state: 'UNKNOWN', dataQuality: 'DEGRADED', dilutionRisk: 'Medium' }, ai });
  assert.equal(c.archetype, A.POST_CATALYST);
  assert.ok(['PRIMARY-SOURCE CONFIRMED', 'ACTIONABLE', 'WAIT'].includes(c.actionCeiling));
  assert.equal(c.tier, require('../lib/biotech').tierFor(c.score));
  assert.ok(c.plan && c.plan.entryStyle);
});

test('assembleCandidate: unverified STEALTH accumulation cannot become PRIMARY-SOURCE CONFIRMED', () => {
  const candles = popCandles();
  const ai = { classification: 'STEALTH', evidence: 'None', catalyst_timing: 'NA', citations: [], confidence: 2 };
  const c = assembleCandidate({ ticker: 'XYZ', last: 13.2, relVol: 2.5, avgDollarVol: 3e6, candles, ai });
  assert.notEqual(c.actionCeiling, ACTION.PRIMARY_CONFIRMED);
  assert.ok(c.actionCeilingReasons.some(r => /not primary-source verified/i.test(r)));
});

test('assembleCandidate: back-compat surface preserved for downstream consumers', () => {
  const candles = popCandles();
  const c = assembleCandidate({ ticker: 'ABC', last: 13.2, relVol: 2, avgDollarVol: 2e7, candles });
  // decision-normalizers.fromBiotech reads these exact fields:
  for (const k of ['tier', 'ticker', 'last', 'score', 'classification', 'relVol', 'catalyst_timing', 'sector']) {
    assert.ok(k in c, `field ${k} present`);
  }
  assert.ok(['Hot', 'Emerging', 'Watch'].includes(c.tier));
  assert.equal(c.sector, 'Health Care');
});

test('assembleCandidate: missing candles → MISSING data quality, watch-capped, no positive default', () => {
  const c = assembleCandidate({ ticker: 'NOD', last: 5, relVol: 2, avgDollarVol: 1e7, candles: [] });
  assert.equal(c.dataQuality, 'MISSING');
  assert.ok(c.overallResearchPriority <= 60, 'no inflated priority on missing data');
});

test('assembleCandidate: separated score fields are all present and bounded', () => {
  const c = assembleCandidate({ ticker: 'ABC', last: 13.2, relVol: 2, avgDollarVol: 2e7, candles: popCandles() });
  for (const k of ['setupScore', 'catalystEvidenceScore', 'scientificQualityScore', 'capitalStructureScore', 'executionScore', 'overallResearchPriority']) {
    assert.ok(c[k] >= 0 && c[k] <= 100, `${k} in range`);
  }
});
