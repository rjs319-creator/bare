'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const f = require('../lib/optionsflow-fable');

// ── parseAnalyses: sanitize / clamp / validate against the provided tickers ──
test('parseAnalyses clamps conviction, validates enums, filters unknown tickers', () => {
  const input = {
    analyses: [
      { ticker: 'nvda', bias: 'bullish', conviction: 250, interpretation: 'x', entry: 'reclaim $120', invalidation: 'below $110', vehicle: 'call_option', timeframe: 'swing', catalyst: 'earnings', caution: 'IV crush' },
      { ticker: 'AMD', bias: 'sideways', conviction: -5, interpretation: 'y', entry: 'e', invalidation: 'i', vehicle: 'rocket', timeframe: 'forever' },
      { ticker: 'FAKE', bias: 'bearish', conviction: 50 },   // not in valid list → dropped
      { bias: 'bullish' },                                   // no ticker → dropped
    ],
    deskRead: 'NVDA is the cleanest bullish flow today.',
  };
  const { analyses, deskRead } = f.parseAnalyses(input, ['NVDA', 'AMD']);
  assert.equal(Object.keys(analyses).length, 2);
  assert.equal(analyses.NVDA.conviction, 100);              // 250 clamped
  assert.equal(analyses.NVDA.vehicle, 'call_option');
  assert.equal(analyses.AMD.bias, 'neutral');               // invalid enum → default
  assert.equal(analyses.AMD.conviction, 0);                 // -5 clamped
  assert.equal(analyses.AMD.vehicle, 'shares');             // invalid → default
  assert.equal(analyses.AMD.timeframe, 'swing');            // invalid → default
  assert.equal(analyses.FAKE, undefined);
  assert.equal(deskRead, 'NVDA is the cleanest bullish flow today.');
});

test('parseAnalyses tolerates empty / malformed input', () => {
  assert.deepEqual(f.parseAnalyses(null).analyses, {});
  assert.deepEqual(f.parseAnalyses({}).analyses, {});
  assert.deepEqual(f.parseAnalyses({ analyses: 'nope' }).analyses, {});
});

// ── mergeAnalyses: attach r.ai + agrees flag, non-destructive ────────────────
test('mergeAnalyses attaches ai and computes agrees vs mechanical net', () => {
  const rollups = [
    { ticker: 'NVDA', net: 'bullish', totalPremium: 5e6 },
    { ticker: 'AMD', net: 'bearish', totalPremium: 2e6 },
    { ticker: 'MU', net: 'mixed', totalPremium: 1e6 },
  ];
  const doc = { analyses: {
    NVDA: { bias: 'bullish', conviction: 80, vehicle: 'shares', catalyst: 'earnings' },
    AMD: { bias: 'neutral', conviction: 30, vehicle: 'avoid', catalyst: '' },
  } };
  const out = f.mergeAnalyses(rollups, doc);
  assert.equal(out[0].ai.agrees, true);       // bullish == bullish
  assert.equal(out[1].ai.agrees, false);      // neutral != bearish (a refinement)
  assert.equal(out[1].ai.catalyst, null);     // '' normalized to null
  assert.equal(out[2].ai, null);              // no analysis for MU
  assert.notEqual(out[0], rollups[0]);        // new objects (immutable)
  assert.equal(rollups[0].ai, undefined);     // original untouched
});

// ── prompt builders are defensive on partial rows ────────────────────────────
test('tickerBlock / contractLine render without throwing on sparse data', () => {
  const row = {
    ticker: 'NVDA', net: 'bullish', grade: 'Bullish', bullishPct: 78, totalPremium: 4.2e6,
    underlying: 120.5, undChgPct: 2.1, earningsBeforeExpiry: true, earningsInDays: 4, abnormalVsNormal: true, baselineNote: '+3σ',
    contracts: [
      { type: 'C', strike: 125, dte: 4, moneyness: 'OTM', premium: 1.5e6, kind: 'sweep', aggressor: 'ask', volOi: 3.2, breakeven: 128, moveToBePct: 6.2, expiry: '2026-07-11' },
      { type: 'P', strike: 110, dte: 30, moneyness: 'OTM', premium: 5e5, kind: 'block', aggressor: 'bid', volOi: null, breakeven: null, moveToBePct: null, expiry: null },
    ],
  };
  const block = f.tickerBlock(row);
  assert.match(block, /\$NVDA/);
  assert.match(block, /EARNINGS in 4d/);
  assert.match(block, /abnormal vs its OWN norm/);
  assert.match(block, /bought@ask/);
  const prompt = f.buildAnalysisPrompt([row]);
  assert.match(prompt, /submit_flow_analysis/);
});
