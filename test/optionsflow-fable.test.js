'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const f = require('../lib/optionsflow-fable');

// ── parseAnalyses: GROUNDED-ONLY sanitize / validate against provided tickers ──
test('parseAnalyses keeps only grounded fields, drops invented levels/catalyst/probability', () => {
  const input = {
    analyses: [
      // Model tries to smuggle in entry/invalidation/catalyst/conviction — all must be dropped.
      { ticker: 'nvda', bias: 'bullish', evidenceClarity: 'clear', interpretation: 'aggressive OTM calls lifted @ask', vehicle: 'call_option', timeframe: 'swing', caution: 'IV crush', entry: 'reclaim $120', invalidation: 'below $110', catalyst: 'earnings', conviction: 250 },
      { ticker: 'AMD', bias: 'sideways', evidenceClarity: 'nonsense', interpretation: 'y', vehicle: 'rocket', timeframe: 'forever' },
      { ticker: 'FAKE', bias: 'bearish', evidenceClarity: 'clear' },   // not in valid list → dropped
      { bias: 'bullish' },                                             // no ticker → dropped
    ],
    deskRead: 'NVDA shows the clearest bullish evidence today.',
  };
  const { analyses, deskRead } = f.parseAnalyses(input, ['NVDA', 'AMD']);
  assert.equal(Object.keys(analyses).length, 2);
  // Invented fields are NOT carried through — Fable cannot author levels/catalysts/probability.
  assert.equal(analyses.NVDA.entry, undefined);
  assert.equal(analyses.NVDA.invalidation, undefined);
  assert.equal(analyses.NVDA.catalyst, undefined);
  assert.equal(analyses.NVDA.conviction, undefined);
  assert.equal(analyses.NVDA.evidenceClarity, 'clear');
  assert.equal(analyses.NVDA.vehicle, 'call_option');
  assert.equal(analyses.AMD.bias, 'neutral');               // invalid enum → default
  assert.equal(analyses.AMD.evidenceClarity, 'thin');       // invalid clarity → conservative default
  assert.equal(analyses.AMD.vehicle, 'shares');             // invalid → default
  assert.equal(analyses.AMD.timeframe, 'swing');            // invalid → default
  assert.equal(analyses.FAKE, undefined);
  assert.equal(deskRead, 'NVDA shows the clearest bullish evidence today.');
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
    NVDA: { bias: 'bullish', evidenceClarity: 'clear', vehicle: 'shares' },
    AMD: { bias: 'neutral', evidenceClarity: 'thin', vehicle: 'avoid' },
  } };
  const out = f.mergeAnalyses(rollups, doc);
  assert.equal(out[0].ai.agrees, true);       // bullish == bullish
  assert.equal(out[0].ai.evidenceClarity, 'clear');
  assert.equal(out[1].ai.agrees, false);      // neutral != bearish (a refinement)
  assert.equal(out[1].ai.catalyst, undefined); // no invented catalyst field at all
  assert.equal(out[2].ai, null);              // no analysis for MU
  assert.notEqual(out[0], rollups[0]);        // new objects (immutable)
  assert.equal(rollups[0].ai, undefined);     // original untouched
});

// ── the tool SCHEMA itself forbids Fable from authoring levels/catalysts/odds ──
test('OPTIONS_FABLE_TOOL schema exposes no invented-level / catalyst / probability fields', () => {
  const props = f.OPTIONS_FABLE_TOOL.input_schema.properties.analyses.items.properties;
  for (const forbidden of ['entry', 'invalidation', 'catalyst', 'conviction']) {
    assert.equal(props[forbidden], undefined, `${forbidden} must not be a Fable output field`);
  }
  assert.ok(props.evidenceClarity, 'evidence clarity (quality, not probability) is present');
  const required = f.OPTIONS_FABLE_TOOL.input_schema.properties.analyses.items.required;
  assert.ok(!required.includes('entry') && !required.includes('conviction'));
});

test('buildAnalysisPrompt instructs the model not to invent levels/catalysts/probability', () => {
  const prompt = f.buildAnalysisPrompt([{ ticker: 'NVDA', net: 'bullish', grade: 'Bullish', bullishPct: 70, totalPremium: 1e6, underlying: 100, contracts: [] }]);
  assert.match(prompt, /Do NOT invent price levels/i);
  assert.match(prompt, /Do NOT invent a catalyst/i);
  assert.match(prompt, /Do NOT output a probability/i);
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

// ── flowFableEdge: Fable bias vs mechanical lean on resolved entries ─────────
test('flowFableEdge stays TRACKING below the resolved-entry floor', () => {
  const r = f.flowFableEdge([{ aiBias: 'bullish', sentiment: 'bullish', ret: 0.05 }]);
  assert.equal(r.promoted, false);
  assert.equal(r.n, 1);
  assert.match(r.verdict, /TRACKING/);
  assert.equal(r.fableHitRatePct, undefined);   // no rates until the floor is cleared
});

test('flowFableEdge recovers the raw move and scores both reads on the same calls', () => {
  // Build 24 resolved entries. Mechanical lean = call/put side; ret is lean-signed
  // (ret>0 => the mechanical lean was right). aiBias sometimes overrides the lean.
  const entries = [];
  // 12 where a BEARISH mechanical lean was WRONG (stock went up: ret<0), but Fable
  // called it bullish (correct on the raw up-move) → Fable beats mechanical here.
  for (let i = 0; i < 12; i++) entries.push({ aiBias: 'bullish', sentiment: 'bearish', ret: -0.03 });
  // 12 where the mechanical bullish lean was RIGHT (ret>0) and Fable agreed bullish.
  for (let i = 0; i < 12; i++) entries.push({ aiBias: 'bullish', sentiment: 'bullish', ret: 0.04 });
  const r = f.flowFableEdge(entries);
  assert.equal(r.n, 24);
  assert.equal(r.fableHitRatePct, 100);   // bullish was right on all 24 raw moves
  assert.equal(r.mechHitRatePct, 50);     // mechanical lean right on only the 12 bullish
  assert.equal(r.overrides, 12);          // the 12 bearish-lean entries Fable flipped
  assert.equal(r.overrideHitRatePct, 100);
  assert.equal(r.promoted, true);
  assert.match(r.verdict, /BEATS/);
});

test('flowFableEdge excludes neutral bias and flat (undecidable) returns', () => {
  const entries = [
    { aiBias: 'neutral', sentiment: 'bullish', ret: 0.05 },   // neutral → skipped
    { aiBias: 'bullish', sentiment: 'bullish', ret: 0 },       // flat → skipped
    { aiBias: 'bullish', sentiment: 'bullish', ret: 0.02 },    // counted
  ];
  const r = f.flowFableEdge(entries);
  assert.equal(r.n, 1);
});
