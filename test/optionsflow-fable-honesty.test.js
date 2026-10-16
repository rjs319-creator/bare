'use strict';
// LEGACY OPTIONS FLOW — what volume/OI and a delayed quote can and cannot say (review
// prompt 7, findings P7-O11/O12). Volume alone never proves a sweep, a block,
// institutional buying, an opening position or a direction — in API fields, in the
// LLM prompt, or in the tool description.

const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../lib/optionsflow-fable');
const oc = require('../lib/options-classify');
const of = require('../lib/optionsflow');

const row = {
  ticker: 'NVDA', net: 'bullish', grade: 'Bullish', bullishPct: 78, totalPremium: 4.2e6,
  underlying: 120.5, undChgPct: 2.1, earningsBeforeExpiry: true, earningsInDays: 4,
  contracts: [
    { type: 'C', strike: 125, dte: 4, moneyness: 'OTM', premium: 1.5e6, kind: 'sweep', aggressor: 'ask', volOi: 3.2, breakeven: 128, moveToBePct: 6.2, expiry: '2026-07-11' },
    { type: 'P', strike: 110, dte: 30, moneyness: 'OTM', premium: 5e5, kind: 'block', aggressor: 'bid', volOi: null },
    { type: 'C', strike: 130, dte: 10, moneyness: 'OTM', premium: 2e5, kind: 'large', aggressor: 'mid', volOi: 1.1 },
  ],
};

test('contractLine describes what was MEASURED: high-turnover / large-notional and where the LAST print sat', () => {
  const [sweep, block, large] = row.contracts.map(f.contractLine);
  assert.match(sweep, /high-turnover/);
  assert.match(sweep, /last@ask/);
  assert.doesNotMatch(sweep, /\bsweep\b|bought|lifted|swept/i);
  assert.match(block, /large-notional/);
  assert.match(block, /last@bid/);
  assert.doesNotMatch(block, /\bblock\b|sold\b|institution/i);
  assert.doesNotMatch(large, /last@/);
  // The internal `kind` keys the ledgers depend on are untouched.
  assert.deepEqual(Object.keys(f.KIND_LABEL).sort(), ['block', 'large', 'sweep']);
});

test('the prompt and the tool never assert sweeps, blocks, buying, institutions or "genuine conviction"', () => {
  const prompt = f.buildAnalysisPrompt([row]);
  const tool = JSON.stringify(f.OPTIONS_FABLE_TOOL);
  // "sweep" / "block" / "institutional" may appear ONLY inside these NEGATIONS, which say
  // what the data cannot establish; stripped before the positive-claim checks below.
  const NEGATIONS = [/confirmed sweep, block, or institutional order/g, /opening vs closing, or institutional origin/g];
  const stripped = t => NEGATIONS.reduce((s, re) => s.replace(re, ''), t);
  for (const text of [prompt, tool]) {
    assert.doesNotMatch(text, /genuine conviction/i);
    assert.doesNotMatch(text, /real prints/i);
    assert.doesNotMatch(text, /\b(call|put|OTM) (sweep|block)s?\b|\bswept\b|\bsweep (lifted|bought)|\bblock (sold|bought)/i);
    assert.doesNotMatch(stripped(text), /\bsweep\b|\bblock\b/i);
    assert.doesNotMatch(text, /bought@|sold@|lifted at the ask|bought at the ask/i);
    assert.doesNotMatch(stripped(text), /institutional|smart money|whale/i);
  }
  assert.match(prompt, /delayed/i);
  assert.match(prompt, /cannot (establish|tell|distinguish)/i);
  assert.match(prompt, /opening|closing/i);
  assert.match(prompt, /Calls are not bullish and puts are not bearish/i);
});

test('call volume alone never becomes confirmed bullish buying', () => {
  // Enormous call volume on a wide / unreliable quote — no direction can be read.
  assert.equal(oc.directionState({ side: 'call', aggressor: null, bid: 1, ask: 1.5 }), oc.DIRECTION.UNKNOWN);
  assert.equal(oc.directionState({ side: 'call', aggressor: 'mid', bid: 1, ask: 1.05 }), oc.DIRECTION.UNKNOWN);
  assert.equal(oc.directionState({ side: 'call', aggressor: 'bid', bid: 1, ask: 1.05 }), oc.DIRECTION.UNKNOWN);
  // Even the best case is PROVISIONAL — no state in the enum says "confirmed".
  for (const v of Object.values(oc.DIRECTION)) assert.doesNotMatch(v, /CONFIRMED/);
  // Investor-facing kind labels never say sweep/block.
  assert.ok(Object.keys(oc.KIND_LABELS).length >= 3);
  for (const label of Object.values(oc.KIND_LABELS)) assert.doesNotMatch(label, /\bsweep\b|\bblock\b/i);
  // The classifier's own kind is a turnover/size heuristic and the module says so.
  assert.equal(of.classify({ volume: 5000, openInterest: 100, lastPrice: 2 }), 'sweep');
});
