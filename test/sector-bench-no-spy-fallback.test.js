'use strict';
// F-04: A SECTOR-LABELLED STAT SILENTLY FELL BACK TO SPY.
//
// Seven sections are SECTOR_BENCH — ReadThrough, Gridlock, Anomaly, Biotech,
// SecondWave, CrossAsset, ToneShift. Their `exc` channel is a SECTOR-relative
// statistic: beat your peers, not merely the market. The Scoreboard computed it
// as
//
//     benchRet = sectorBenchCandles ? sectorReturn : spyRet
//
// so a row whose sector-ETF history was missing quietly contributed a
// SPY-relative number to a sector-labelled average. `benchFallback` counts how
// many rows fell back — but a count does not un-blend a mean. The average has
// already mixed two different rulers, which is the same defect #345 fixed one
// level up ("the baseline scorecard compared two different rulers").
//
// Fail closed instead: a sector-labelled row with no sector return has NO
// sector-relative excess. It goes null, is counted, and drops out of the
// statistic rather than quietly changing what the statistic means.
//
// The MARKET channel is untouched — `mktExc` is always measured against SPY and
// summarizeReturns prefers it, so nothing loses its market-relative record.
//
// Currently latent: benchFallback is 0 across all 79 live groups. It bites the
// first time a sector ETF fetch fails.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { excBenchmarkReturn, SECTOR_BENCH_SECTIONS } = require('../lib/apex-routes');

test('the sector-benched sections are the seven named ones', () => {
  for (const s of ['ReadThrough', 'Gridlock', 'Anomaly', 'Biotech', 'SecondWave', 'CrossAsset', 'ToneShift']) {
    assert.ok(SECTOR_BENCH_SECTIONS.has(s), `${s} must be sector-benched`);
  }
});

test('a sector-labelled row with a sector return uses it', () => {
  assert.equal(excBenchmarkReturn(1.5, 9.9, true), 1.5, 'the sector return, not SPY');
});

test('a sector-labelled row with NO sector return yields null, never SPY', () => {
  // The whole defect. Returning spyRet here is what blended the average.
  assert.equal(excBenchmarkReturn(null, 9.9, true), null);
});

test('an ordinary row still benchmarks against SPY', () => {
  // Non-sector sections legitimately measure excess against the market.
  assert.equal(excBenchmarkReturn(null, 9.9, false), 9.9);
  assert.equal(excBenchmarkReturn(1.5, 9.9, false), 9.9, 'SPY is the benchmark for these, not the sector');
});

test('a missing SPY return is still just missing', () => {
  assert.equal(excBenchmarkReturn(null, null, false), null);
  assert.equal(excBenchmarkReturn(null, null, true), null);
});

test('zero is a real return and is not treated as absent', () => {
  assert.equal(excBenchmarkReturn(0, 9.9, true), 0);
  assert.equal(excBenchmarkReturn(null, 0, false), 0);
});

// ── wiring ─────────────────────────────────────────────────────────────────
test('the Scoreboard derives exc through the guard, not a bare ternary', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apex-routes.js'), 'utf8');
  assert.match(src, /const benchRet = excBenchmarkReturn\(/);
  assert.doesNotMatch(src, /sectorBenchCandles \? spyForwardReturn\([^)]*\) : spyRet/,
    'the silent SPY fallback must be gone');
});

test('the market channel is untouched — mktExc is still always vs SPY', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apex-routes.js'), 'utf8');
  assert.match(src, /r\.mktExc = excessOrNull\(r\.ret, spyRet, selfMkt\)/,
    'nulling the sector channel must not cost a row its market-relative record');
});
