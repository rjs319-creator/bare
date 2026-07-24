'use strict';
// Render-integrity for the biotech wire payload — same philosophy as render-guard.test.js:
// the UI drops these fields straight into innerHTML template strings, so a NaN / stray
// "undefined" / unresolved `${…}` in the payload becomes visible garbage or an escaping hazard.
// The DOM render is browser-only; this guards the data layer where garbage would start.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assembleCandidate } = require('../lib/biotech-engine');
const { toWireItem } = require('../lib/biotech-routes');
const { findEventBar } = require('../lib/biotech-features');

function mk(closes, vols) {
  return closes.map((c, i) => ({
    date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c * 0.99, high: c * 1.03, low: c * 0.97, close: c, volume: vols ? vols[i] : 1e6,
  }));
}
function scanClean(value, path = '$') {
  if (value == null) return;
  if (typeof value === 'number') { assert.ok(Number.isFinite(value), `non-finite number at ${path}`); return; }
  if (typeof value === 'string') {
    assert.ok(!value.includes('${'), `unresolved template at ${path}: ${value}`);
    assert.ok(!/\bundefined\b/.test(value), `"undefined" leaked at ${path}: ${value}`);
    assert.ok(!/\bNaN\b/.test(value), `"NaN" leaked at ${path}: ${value}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => scanClean(v, `${path}[${i}]`)); return; }
  if (typeof value === 'object') for (const k of Object.keys(value)) scanClean(value[k], `${path}.${k}`);
}

function build(overrides) {
  const base = Array.from({ length: 55 }, () => 10);
  const vols = [...Array.from({ length: 55 }, () => 1e6), 4e6, 3e6, 3e6, 2.5e6, 2.5e6];
  const candles = mk([...base, 12.5, 12.8, 13.1, 12.9, 13.2], vols);
  return assembleCandidate(Object.assign({
    ticker: 'TST', last: 13.2, relVol: 2.5, avgDollarVol: 3e7, candles,
    xbi: mk(Array.from({ length: 60 }, (_, i) => 50 + i * 0.02)), eventIdx: findEventBar(candles, 15),
  }, overrides));
}

test('wire items across all archetypes contain no NaN/undefined/unresolved-template garbage', () => {
  const variants = [
    build({ event: { eventType: 'TRIAL_READOUT', verified: true, verification: 'PRIMARY', sources: [{ sourceType: 'sec', primary: true, url: 'https://sec.gov/x' }] }, ai: { classification: 'DATA', evidence: 'Verified', catalyst_timing: 'Behind', citations: ['f1'], confidence: 4, thesis: 'Ph2 win', subsector: 'oncology' }, capital: { state: 'COMPLETED_FINANCING_RELIEF', dilutionRisk: 'Low', dataQuality: 'DEGRADED', evidence: ['priced'] } }),
    build({ event: { eventType: 'PDUFA', expectedDate: '2026-09-01', nextUnresolvedBinaryDate: '2026-09-01', verified: false, verification: 'SECONDARY', sources: [] }, ai: { classification: 'FDA', evidence: 'Inferred', catalyst_timing: 'Ahead', confidence: 3 }, asOf: '2026-08-20' }),
    build({ ai: { classification: 'STEALTH', evidence: 'None', catalyst_timing: 'NA', citations: [], confidence: 2 }, avgDollarVol: 3e6 }),
    build({}),  // pure mechanical, no evidence
  ];
  for (const c of variants) scanClean(toWireItem(c), `wire(${c.ticker}:${c.archetype})`);
});

test('toWireItem preserves the downstream back-compat fields', () => {
  const w = toWireItem(build({}));
  for (const k of ['tier', 'ticker', 'last', 'score', 'classification', 'relVol', 'catalyst_timing', 'sector']) {
    assert.ok(k in w, `field ${k} present on wire item`);
  }
});
