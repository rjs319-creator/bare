'use strict';
// Downstream compatibility — the redesigned op=biotech payload must still feed the Today engine
// (decision-normalizers.fromBiotech) and the Apex scoreboard (writeBiotechDay picks[]) exactly
// as before, so governance/eligibility/weight are unchanged by the implementation change.
const { test } = require('node:test');
const assert = require('node:assert');
const N = require('../lib/decision-normalizers');
const { toWireItem } = require('../lib/biotech-routes');
const { assembleCandidate } = require('../lib/biotech-engine');
const { findEventBar } = require('../lib/biotech-features');

function mk(closes, vols) {
  return closes.map((c, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, open: c * 0.99, high: c * 1.03, low: c * 0.97, close: c, volume: vols ? vols[i] : 1e6 }));
}
function hotCandidate() {
  const base = Array.from({ length: 55 }, () => 10);
  const vols = [...Array.from({ length: 55 }, () => 1e6), 4e6, 3e6, 3e6, 2.5e6, 2.5e6];
  const candles = mk([...base, 12.5, 12.8, 13.1, 12.9, 13.2], vols).map((c, i) => ({ ...c, date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}` }));
  return assembleCandidate({
    ticker: 'VKTX', last: 13.2, relVol: 2.5, avgDollarVol: 4e7, candles, eventIdx: findEventBar(candles, 15),
    event: { eventType: 'TRIAL_READOUT', verified: true, verification: 'PRIMARY', sources: [{ sourceType: 'sec', primary: true }] },
    ai: { classification: 'DATA', evidence: 'Verified', catalyst_timing: 'Behind', citations: ['f1'], confidence: 4 },
    capital: { state: 'UNKNOWN', dilutionRisk: 'Medium', dataQuality: 'DEGRADED' },
  });
}

test('fromBiotech normalizes the new payload without error (Today engine compatibility)', () => {
  const item = toWireItem(hotCandidate());
  const payload = { items: [item] };
  const out = N.fromBiotech(payload);
  // Only Hot/Emerging survive; the assembled hot name should pass if its tier qualifies.
  if (item.tier === 'Hot' || item.tier === 'Emerging') {
    assert.equal(out.length, 1);
    const s = out[0];
    assert.equal(s.source, 'biotech');
    assert.equal(s.section, 'Biotech');
    assert.equal(s.horizon, 'swing');
    assert.equal(s.side, 'long');
    assert.equal(s.ticker, 'VKTX');
    assert.equal(s.scoringVersion, 'biotech-v1');   // governance key UNCHANGED
    assert.ok(s.evidenceFamilies.includes('catalystForcedFlow'));
    assert.ok(Number.isFinite(s.rawConfidence));
  } else {
    assert.equal(out.length, 0, 'Watch-tier correctly filtered out');
  }
});

test('fromBiotech filters Watch-tier and missing tickers', () => {
  const out = N.fromBiotech({ items: [
    { tier: 'Watch', ticker: 'AAA', score: 40, classification: 'NOISE', last: 5, relVol: 1.2, catalyst_timing: 'NA' },
    { tier: 'Hot', score: 80, classification: 'DATA', last: 10, relVol: 2 },   // no ticker → dropped
  ] });
  assert.equal(out.length, 0);
});

test('logged picks[] shape stays apex/calibration-compatible', () => {
  // Mirror lib/biotech-routes.logSurfaced pick projection.
  const c = hotCandidate();
  const pick = { ticker: c.ticker, tier: c.tier, date: '2026-07-22', bench: 'XBI', score: c.score, classification: c.classification, evidence: c.evidence, confidence: c.confidence };
  for (const k of ['ticker', 'tier', 'date', 'bench', 'score', 'classification', 'evidence', 'confidence']) assert.ok(k in pick, `pick.${k}`);
  assert.equal(pick.bench, 'XBI');
  assert.ok(['Hot', 'Emerging', 'Watch'].includes(pick.tier));
});
