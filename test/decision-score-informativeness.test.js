'use strict';
// Score informativeness (2026-09-09 alpha pass): the Today rank must not consume a
// section score the ledger has shown does not rank that section's own winners.
// op=scoreboard (2026-09-09) measured every native section's within-section score
// at 5d as `noise` (overall date-clustered IC −0.019, top decile −0.68% vs base
// −0.30%). Until now the rank still multiplied a 95th-percentile name to ~2× the
// confidence of a 45th-percentile one. The persisted `sectionDecile` verdict now
// scales the SPREAD of the comparable score around neutral, exactly as
// expectancyTilt consumes the persisted lane record.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/decision');

const DECILE = {
  screener: { verdict: 'noise', ic: -0.018, t: -0.38, n: 431, method: 'apex', horizon: '5d' },
  Ghost: { verdict: 'weak-positive', ic: 0.07, t: 1.46, n: 437, method: 'ghost', horizon: '5d' },
  Fade: { verdict: 'predictive', ic: 0.106, t: 2.53, n: 565, method: 'proxy', horizon: '5d' },
  Attention: { verdict: 'inverted', ic: -0.139, t: -2.72, n: 379, method: 'proxy', horizon: '5d' },
  Anomaly: { verdict: 'insufficient', ic: null, n: 18, method: 'proxy', horizon: '5d' },
};

test('scoreInformativeness: verdict → spread weight table', () => {
  assert.equal(D.scoreInformativeness(DECILE, 'Fade').w, 1);
  assert.equal(D.scoreInformativeness(DECILE, 'Ghost').w, 0.5);
  assert.equal(D.scoreInformativeness(DECILE, 'screener').w, 0);
  // Inverted is NOT flipped into a negative weight — the rank never inverts a score.
  assert.equal(D.scoreInformativeness(DECILE, 'Attention').w, 0);
  assert.equal(D.scoreInformativeness(DECILE, 'Anomaly').w, 0.5);
  // Section with a ledger but no verdict entry (<15 resolved): unmeasured, half spread.
  const un = D.scoreInformativeness(DECILE, 'coil');
  assert.equal(un.w, 0.5);
  assert.equal(un.verdict, 'unmeasured');
});

test('scoreInformativeness: no persisted verdict at all is feature-off (weight 1)', () => {
  assert.equal(D.scoreInformativeness(null, 'screener').w, 1);
  assert.equal(D.scoreInformativeness({}, 'screener').w, 1);
  assert.equal(D.scoreInformativeness(undefined, 'screener').verdict, 'feature-off');
});

test('informedConfidence: scales the spread around neutral 50, never the level', () => {
  assert.equal(D.informedConfidence(95, 1), 95);
  assert.equal(D.informedConfidence(95, 0), 50);
  assert.equal(D.informedConfidence(5, 0), 50);
  assert.equal(D.informedConfidence(90, 0.5), 70);
  assert.equal(D.informedConfidence(50, 0), 50);
  // Non-finite inputs degrade to neutral rather than NaN.
  assert.equal(D.informedConfidence(null, 1), 50);
});

const mk = (ticker, section, rawConfidence, extra = {}) => {
  const { signal } = D.makeSignal({ ticker, source: section, section, horizon: 'swing', rawConfidence, side: 'long', ...extra });
  return { ...signal, normalized: { value: rawConfidence, basis: 'within-source percentile (same-day cross-section)' } };
};
const regime = { riskOn: true };

test('rankSignals: a measured-noise section scores identically at percentile 95 and 45', () => {
  const hi = mk('HI', 'screener', 95);
  const lo = mk('LO', 'screener', 45);
  const withVerdict = D.rankSignals([hi, lo], { regime, scoreboard: { groups: [], sectionDecile: DECILE } });
  assert.equal(withVerdict[0].score, withVerdict[1].score, 'noise verdict must collapse the score spread');
  assert.equal(withVerdict[0].scoreDecomposition.scoreInformativeness.w, 0);
  assert.equal(withVerdict[0].scoreDecomposition.scoreInformativeness.verdict, 'noise');
  assert.equal(withVerdict[0].scoreDecomposition.comparableConfidence, 95);
  assert.equal(withVerdict[0].scoreDecomposition.informedConfidence, 50);
  assert.match(withVerdict[0].scoreDecomposition.formula, /informedConfidence/);
  // CONTRAST against the old behaviour: without a persisted verdict the 95 still out-scores the 45.
  const legacy = D.rankSignals([hi, lo], { regime, scoreboard: { groups: [] } });
  assert.ok(legacy[0].score > legacy[1].score, 'feature-off path must keep the old ordering');
  assert.equal(legacy[0].ticker, 'HI');
  assert.equal(legacy[0].scoreDecomposition.scoreInformativeness.w, 1);
});

test('rankSignals: a predictive section keeps its full spread; weak-positive keeps half', () => {
  const fadeHi = mk('FH', 'Fade', 90, { side: 'short' });
  const fadeLo = mk('FL', 'Fade', 50, { side: 'short' });
  const [a, b] = D.rankSignals([fadeHi, fadeLo], { regime, scoreboard: { groups: [], sectionDecile: DECILE } });
  assert.equal(a.ticker, 'FH');
  assert.equal(a.scoreDecomposition.informedConfidence, 90);
  const ghost = D.rankSignals([mk('G', 'Ghost', 90)], { regime, scoreboard: { groups: [], sectionDecile: DECILE } })[0];
  assert.equal(ghost.scoreDecomposition.informedConfidence, 70);
  assert.equal(ghost.scoreDecomposition.scoreInformativeness.w, 0.5);
});

test('rankSignals: with the spread collapsed, the realized lane record still orders the board', () => {
  const summary = {
    groups: [
      { section: 'screener', tier: 'Early', horizons: { '5d': { avgExcess: 2, avgNetExcess: 1.5, netExcessN: 40, winRate: 58, n: 40,
        dateNet: { n: 24, effectiveN: 22, avg: 0.9, se: 0.3, ci95: { lo: 0.3, hi: 1.5 } } } } },
      { section: 'screener', tier: 'Breakout', horizons: { '5d': { avgExcess: -2, avgNetExcess: -2.1, netExcessN: 94, winRate: 40, n: 94,
        dateNet: { n: 36, effectiveN: 30, avg: -1.9, se: 0.5, ci95: { lo: -4.25, hi: -0.32 } } } } },
    ],
    sectionDecile: DECILE,
  };
  // The Breakout name carries the HIGHER raw score; the Early name the lower one.
  const breakout = mk('BRK', 'screener', 95, { tier: 'Breakout' });
  const early = mk('ERL', 'screener', 40, { tier: 'Early' });
  const ranked = D.rankSignals([breakout, early], { regime, scoreboard: summary });
  assert.equal(ranked[0].ticker, 'ERL', 'the lane with a CI clear of zero must out-rank the ranked-out lane regardless of raw score');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('scoreInformativeness: a MERGED row is floored at the unmeasured spread, never flattened on its base section', () => {
  assert.equal(D.scoreInformativeness(DECILE, 'screener', { mergedFrom: 3 }).w, D.MERGED_FLOOR_W);
  assert.match(D.scoreInformativeness(DECILE, 'screener', { mergedFrom: 3 }).basis, /corroborated by 3 sources/);
  assert.equal(D.scoreInformativeness(DECILE, 'screener', { mergedFrom: 1 }).w, 0);
  assert.equal(D.scoreInformativeness(DECILE, 'Fade', { mergedFrom: 2 }).w, 1, 'a predictive verdict is not reduced by merging');
  assert.equal(D.scoreInformativeness(null, 'screener', { mergedFrom: 3 }).w, 1, 'feature-off stays feature-off');
});

test('rankSignals: a corroborated screener row keeps half its spread; the ranked-out flag is explicit', () => {
  const merged = { ...mk('MRG', 'screener', 88), mergedFrom: 3, sources: ['screener', 'ghost', 'rt'] };
  const lone = mk('ONE', 'screener', 88);
  const [a, b] = D.rankSignals([merged, lone], { regime, scoreboard: { groups: [], sectionDecile: DECILE } });
  assert.equal(a.ticker, 'MRG');
  assert.equal(a.scoreDecomposition.informedConfidence, 69);
  assert.equal(b.scoreDecomposition.informedConfidence, 50);
  assert.equal(a.expectancyTiltNegative, false);
  const summary = { groups: [{ section: 'screener', tier: 'Breakout', horizons: { '5d': { avgExcess: -2, avgNetExcess: -2.1, netExcessN: 94, winRate: 40, n: 94,
    dateNet: { n: 36, effectiveN: 30, avg: -1.9, se: 0.5, ci95: { lo: -4.25, hi: -0.32 } } } } }], sectionDecile: DECILE };
  const [out] = D.rankSignals([mk('BRK', 'screener', 60, { tier: 'Breakout' })], { regime, scoreboard: summary });
  assert.equal(out.expectancyTilt, D.NEGATIVE_TILT);
  assert.equal(out.expectancyTiltNegative, true);
});
