// Defect 6 — Confluence attribution. Correlated trend votes must count as ONE
// evidence family; live weights are frozen equal; the shadow marginal learner
// cannot touch production without a registry promotion AND a PASS artifact.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const CM = require('../lib/confluence-marginal');
const { confluenceStratWeights } = require('../lib/screener-routes');
const { STRATEGIES, STRATEGY_FAMILY } = require('../lib/confluence');

const pick = (date, ticker, bull, excPct) => ({ date, ticker, bull, excPct, resolved: true });

test('four correlated trend votes count as ONE evidence family unit, not four', () => {
  const obs = CM.toFamilyObservations([
    pick('2026-06-01', 'AAA', ['ema', 'supertrend', 'macd', 'priceAction'], 4.0),
  ]);
  assert.strictEqual(obs.length, 1);
  assert.deepStrictEqual(obs[0].fam, { trend: 1, meanReversion: 0 }, 'trend family is binary — 4 votes = 1 unit');
  // Sanity: the family map really groups 4 trend + 1 mean-reversion.
  assert.strictEqual(STRATEGIES.filter(s => STRATEGY_FAMILY[s] === 'trend').length, 4);
  assert.strictEqual(STRATEGY_FAMILY.rsi, 'meanReversion');
});

test('multiple overlapping picks from one date/ticker are never independent samples', () => {
  const obs = CM.toFamilyObservations([
    pick('2026-06-01', 'AAA', ['ema'], 2.0),
    pick('2026-06-01', 'AAA', ['macd'], 2.0),        // same date/ticker → one observation
    pick('2026-06-01', 'BBB', ['rsi'], -1.0),
  ]);
  assert.strictEqual(obs.length, 2);
  // …and the effective sample is DATES, not picks.
  const report = CM.marginalReport([pick('2026-06-01', 'AAA', ['ema'], 2.0), pick('2026-06-01', 'BBB', ['rsi'], 1.0)]);
  assert.strictEqual(report.effectiveSample, 1);
  assert.strictEqual(report.verdict, 'INSUFFICIENT_DATA');
});

test('live per-strategy weights are FROZEN equal regardless of the EWMA state', () => {
  const hotEwma = { ema: { ewma: 9.5, n: 40 }, supertrend: { ewma: 8.1, n: 40 }, rsi: { ewma: -6.0, n: 40 } };
  const w = confluenceStratWeights(hotEwma);
  for (const s of STRATEGIES) assert.strictEqual(w[s], 1, `${s} frozen at equal weight`);
});

test('shadow marginal weights cannot affect production without registry promotion AND a PASS artifact', () => {
  const artifact = { version: CM.MARGINAL_VERSION, verdict: 'PASS', weights: { ema: 1.4, supertrend: 1.4, macd: 1.4, priceAction: 1.4, rsi: 0.8 } };
  // Artifact alone (registry still shadow) → frozen.
  const w1 = confluenceStratWeights({}, { marginalArtifact: artifact });
  for (const s of STRATEGIES) assert.strictEqual(w1[s], 1);
  // Registry promotion alone (no artifact) → frozen (fail closed).
  const promoted = [{ id: 'confluence-marginal', maturity: 'production' }];
  const w2 = confluenceStratWeights({}, { registry: promoted });
  for (const s of STRATEGIES) assert.strictEqual(w2[s], 1);
  // A non-PASS artifact even with promotion → frozen.
  const w3 = confluenceStratWeights({}, { registry: promoted, marginalArtifact: { ...artifact, verdict: 'NO_IMPROVEMENT' } });
  for (const s of STRATEGIES) assert.strictEqual(w3[s], 1);
  // Both → the validated weights apply (clamped).
  const w4 = confluenceStratWeights({}, { registry: promoted, marginalArtifact: artifact });
  assert.strictEqual(w4.ema, 1.4);
  assert.strictEqual(w4.rsi, 0.8);
});

test('marginal report runs a purged walk-forward with baselines on identical paired dates', () => {
  // 60 synthetic dates: trend-heavy dates carry +2% mean excess, mean-reversion 0.
  const picks = [];
  for (let i = 0; i < 60; i++) {
    const date = `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`;
    picks.push(pick(date, 'T' + i, ['ema', 'macd'], 2 + ((i * 7) % 5) * 0.1));
    picks.push(pick(date, 'M' + i, ['rsi'], 0 + ((i * 3) % 5) * 0.1 - 0.2));
  }
  const report = CM.marginalReport(picks);
  assert.strictEqual(report.effectiveSample, 60);
  assert.ok(report.folds.length >= 2, 'multiple chronological folds');
  for (const f of report.folds) {
    assert.ok(Number.isFinite(f.marginal) && Number.isFinite(f.equalWeight) && Number.isFinite(f.voteCount) && Number.isFinite(f.placebo),
      'all four models scored on the same paired test dates');
    assert.ok(f.trainDates > 0 && f.testDates > 0);
  }
  assert.ok(['PASS', 'NO_IMPROVEMENT'].includes(report.verdict));
  assert.strictEqual(report.shadow, true);
  // Determinism (seeded placebo): identical inputs → identical report.
  assert.deepStrictEqual(CM.marginalReport(picks), report);
});
