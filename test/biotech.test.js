'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  isBiotechRunner, biotechFeatures, countSpikeFades, scoreCatalyst, scoreBiotech,
  tierFor, parseResult, CATALYST_CLASSES,
} = require('../lib/biotech');

// Build daily candles from a close series (high/low ±2%, flat volume unless overridden).
function mk(closes, vols) {
  return closes.map((c, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c, high: c * 1.02, low: c * 0.98, close: c,
    volume: vols ? vols[i] : 1_000_000,
  }));
}

test('isBiotechRunner: early runner passes; junk is rejected', () => {
  const ok = { pct5d: 12, relVol: 2, avgDollarVol: 5e6, last: 8 };
  assert.equal(isBiotechRunner(ok), true);
  assert.equal(isBiotechRunner({ ...ok, pct5d: 3 }), false);        // move too small
  assert.equal(isBiotechRunner({ ...ok, relVol: 1.1 }), false);     // no volume confirm
  assert.equal(isBiotechRunner({ ...ok, avgDollarVol: 5e5 }), false); // illiquid
  assert.equal(isBiotechRunner({ ...ok, last: 0.6 }), false);       // sub-$1 delisting junk
  assert.equal(isBiotechRunner({ ...ok, pct5d: 250 }), false);      // already parabolic
  assert.equal(isBiotechRunner(null), false);
});

test('biotechFeatures: computes SMAs, run maturity and extension', () => {
  // 55 flat-ish bars then a fresh 5-day pop → young reclaim above a rising SMA20.
  const base = Array.from({ length: 50 }, () => 10);
  const pop = [10.5, 11, 11.6, 12.2, 13];
  const f = biotechFeatures(mk([...base, ...pop]));
  assert.ok(f, 'features computed');
  assert.equal(f.aboveSma20, true);
  assert.equal(f.sma20Rising, true);
  assert.ok(f.runAge <= 6, 'reclaim is recent');
  assert.ok(f.adr > 0);
  assert.equal(biotechFeatures(mk([1, 2, 3])), null); // not enough history
});

test('countSpikeFades: detects a +50% run that round-trips', () => {
  // 10 → 16 (spike) → back to ~10 within the window = one spike-fade episode.
  const closes = [
    ...Array.from({ length: 10 }, () => 10),
    11, 12.5, 14, 15, 16,          // +60% run
    14, 12, 11, 10.2, 10, 10, 10,  // gives it all back
  ];
  assert.ok(countSpikeFades(mk(closes)) >= 1);
  assert.equal(countSpikeFades(mk(Array.from({ length: 30 }, () => 10))), 0); // flat = none
});

test('scoreCatalyst: evidence-graded, cap/dilution aware', () => {
  assert.equal(scoreCatalyst({ classification: 'FDA', evidence: 'Verified' }, 'large'), 35);
  assert.ok(scoreCatalyst({ classification: 'FDA', evidence: 'Inferred' }, 'large') < 35); // half credit
  // Analyst call is near-worthless in a microcap (Fable A4).
  const big = scoreCatalyst({ classification: 'ANALYST', evidence: 'Verified' }, 'large');
  const micro = scoreCatalyst({ classification: 'ANALYST', evidence: 'Verified' }, 'micro');
  assert.ok(micro < big);
  // Financing: pending dilution is a trap; a completed priced raise clears the overhang.
  const pending = scoreCatalyst({ classification: 'FINANCING', evidence: 'Verified', dilution_risk: 'High' }, 'large');
  const priced = scoreCatalyst({ classification: 'FINANCING', evidence: 'Verified', dilution_risk: 'Low' }, 'large');
  assert.ok(priced > pending);
  assert.equal(scoreCatalyst(null, 'large'), null); // not investigated
});

test('scoreBiotech: verified hard catalyst outscores unknown noise; traps drag it down', () => {
  const closes = [...Array.from({ length: 50 }, () => 10), 10.5, 11, 11.6, 12.2, 13];
  const f = biotechFeatures(mk(closes));
  const m = { pct5d: 30, relVol: 3, pctChange: 6, last: 13, avgDollarVol: 8e6, highVolDays5: 3 };
  const ctx = { etfPct5d: 2, regime: 'risk-on', capTier: 'large' };
  const hot = scoreBiotech(m, f, { ...ctx, ai: { classification: 'DATA', evidence: 'Verified', dilution_risk: 'Low' } });
  const noise = scoreBiotech(m, f, { ...ctx, ai: { classification: 'NOISE', evidence: 'None', dilution_risk: 'None' } });
  assert.ok(hot.score > noise.score, 'catalyst lifts the score');
  assert.ok(hot.score >= 0 && hot.score <= 100);
  // A pending-offering dilution flag applies a real penalty.
  const diluted = scoreBiotech(m, f, { ...ctx, ai: { classification: 'DATA', evidence: 'Verified', dilution_risk: 'High' } });
  assert.ok(diluted.score < hot.score, 'dilution risk penalizes');
  // Risk-off haircuts the momentum component → lower than the same setup risk-on.
  const off = scoreBiotech(m, f, { etfPct5d: 2, regime: 'risk-off', capTier: 'large', ai: { classification: 'DATA', evidence: 'Verified', dilution_risk: 'Low' } });
  assert.ok(off.score <= hot.score);
});

test('tierFor: score → Hot/Emerging/Watch', () => {
  assert.equal(tierFor(82), 'Hot');
  assert.equal(tierFor(65), 'Emerging');
  assert.equal(tierFor(50), 'Watch');
  assert.equal(tierFor(20), 'Watch');
});

const CANDS = [{ ticker: 'VKTX' }, { ticker: 'CRSP' }];
test('parseResult: keeps candidates, clamps enums/confidence, drops hallucinations', () => {
  const { items } = parseResult({ items: [
    { ticker: 'vktx', classification: 'DATA', evidence: 'Verified', catalyst_timing: 'Behind', reason: 'Ph2 win', confidence: 9 },
    { ticker: 'CRSP', classification: 'BOGUS', evidence: 'nope', reason: 'x', confidence: 2 },   // bad enums → defaults
    { ticker: 'ZZZZ', classification: 'FDA', evidence: 'Verified', reason: 'x', confidence: 3 }, // not a candidate → dropped
  ] }, CANDS);
  assert.equal(items.length, 2);
  const v = items.find(x => x.ticker === 'VKTX');
  assert.equal(v.confidence, 5);                                   // clamped 9→5
  assert.equal(v.classification, 'DATA');
  const c = items.find(x => x.ticker === 'CRSP');
  assert.equal(c.classification, 'NOISE');                          // invalid enum → NOISE
  assert.equal(c.evidence, 'None');                                 // invalid → None
  assert.ok(CATALYST_CLASSES.includes(v.classification));
});
