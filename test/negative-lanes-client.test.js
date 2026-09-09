'use strict';
// Client consumption of evidence-negative lanes (2026-09-09). The lanes are produced by
// lib/negative-lanes (server) and consumed by public/js/opportunities.js (ESM) — this
// test drives the REAL server output through the REAL client splitter so the key
// contract between them cannot drift silently.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const NL = require('../lib/negative-lanes');

const dn = (lo, hi, effectiveN, positive) => ({ n: effectiveN + 1, effectiveN, avg: (lo + hi) / 2, ci95: { lo, hi }, blockStability: { blocks: 4, positive, usable: true } });
const h = (netEx, dateNet, dates) => ({ n: 40, dates, avgNetExcess: netEx, netExcessN: 40, dateNet });
const SUMMARY = { groups: [
  { section: 'screener', tier: 'Breakout', scope: 'large', horizons: { '3d': h(-1.47, dn(-2.39, -0.4, 37, 0), 37), '5d': h(-2.1, dn(-4.25, -0.32, 36, 0), 36), '10d': h(-3.62, dn(-7.45, -1.17, 33, 1), 33) } },
  { section: 'screener', tier: 'Early', scope: 'large', horizons: { '5d': h(0.83, dn(-1.81, 2.82, 24, 2), 24) } },
] };
const LANES = NL.negativeLanes(SUMMARY);

const cands = [
  { ticker: 'BRK1', status: 'Breakout', scope: 'large', opp: 90 },
  { ticker: 'ERL1', status: 'Early', scope: 'large', opp: 80 },
  { ticker: 'BRK2', status: 'Breakout', scope: 'small', opp: 85 },   // small Breakout not flagged
  { ticker: 'QH1', status: 'Breakout', capTier: 'large', opp: 70 },  // Quick Hit shape (capTier)
  { ticker: 'OPP1', status: 'Breakout', capTier: 'Large', opp: 65 }, // raw /api/screener shape (capitalized capTier, no scope)
];

test('splitEvidenceNegative: joins on the server lane key, scope-aware, input untouched', async () => {
  const { splitEvidenceNegative } = await import('../public/js/opportunities.js');
  const before = JSON.stringify(cands);
  const { kept, excluded } = splitEvidenceNegative(cands, LANES);
  assert.deepEqual(kept.map(c => c.ticker), ['ERL1', 'BRK2']);
  assert.deepEqual(excluded.map(c => c.ticker), ['BRK1', 'QH1', 'OPP1']);
  assert.equal(excluded[0].evidenceNegative.key, 'screener:Breakout:large');
  assert.equal(JSON.stringify(cands), before);
});

test('splitEvidenceNegative: no lanes (legacy scoreboard) keeps everything — feature-off', async () => {
  const { splitEvidenceNegative } = await import('../public/js/opportunities.js');
  assert.equal(splitEvidenceNegative(cands, undefined).kept.length, 5);
  assert.equal(splitEvidenceNegative(cands, []).excluded.length, 0);
  assert.deepEqual(splitEvidenceNegative(null, LANES), { kept: [], excluded: [] });
});

test('evidenceNegativeNote: names the lane, its record and the held-out tickers', async () => {
  const { splitEvidenceNegative, evidenceNegativeNote } = await import('../public/js/opportunities.js');
  const { excluded } = splitEvidenceNegative(cands, LANES);
  const html = evidenceNegativeNote(excluded);
  assert.match(html, /3 candidates held out/);
  assert.match(html, /screener · Breakout · large/);
  assert.match(html, /-2\.1% net @5d, CI95 \[-4\.25, -0\.32\], 36 dates/);
  assert.match(html, /BRK1, QH1, OPP1/);
  assert.equal(evidenceNegativeNote([]), '');
});

test('candidateScope: raw screener capTier and Quick Hit scope resolve to the same scoreboard scope key', async () => {
  const { candidateScope } = await import('../public/js/opportunities.js');
  assert.equal(candidateScope({ capTier: 'Small' }), 'small');
  assert.equal(candidateScope({ scope: 'micro', capTier: 'Micro' }), 'micro');
  assert.equal(candidateScope({}), '');
  assert.equal(candidateScope(null), '');
});
