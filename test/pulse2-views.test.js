'use strict';
// Market Pulse v2 — HORIZON VIEWS + ACTIONABILITY CONTRACT.
// Required behaviors #16-#19: a day-trade signal requires fresh regular-session data;
// closed/weekend/stale data cannot produce an actionable intraday signal; a verified
// but extended event is not presented as an entry; a narrative alone cannot create
// PRICE_CONFIRMED.

const test = require('node:test');
const assert = require('node:assert');
const V = require('../lib/pulse2-views');

const EVENT = {
  id: 'ev_1', headline: 'Acme wins major contract', claim: 'Acme won a large contract',
  currentDirection: 'BULLISH', firstSeenDirection: 'BULLISH',
  evidence: 'VERIFIED', family: 'product', invalidated: false, tickers: ['ACME'],
};
const FEATURES = {
  hasIntraday: true, orComplete: true,
  openingRange: { high: 100, low: 98 }, vwap: 99,
  last: { c: 100.5 }, timeOfDayRelVol: 2.1, extensionAtr: 0.8,
  vwapDist: 0.01, dayChangePct: 2.0,
};
const REACTING = { reaction: 'REACTING_AS_EXPECTED', why: [] };

test('#16: a complete day-trade candidate on fresh regular-session data can be PRICE_CONFIRMED with a full risk plan', () => {
  const d = V.dayTradeDecision({ event: EVENT, ticker: 'ACME', features: FEATURES, reactionInfo: REACTING, executionAllowed: true, sessionState: 'regular' });
  assert.equal(d.tradeState, 'PRICE_CONFIRMED');
  assert.ok(d.contract.trigger != null, 'trigger required');
  assert.ok(d.contract.invalidation != null, 'invalidation required');
  assert.equal(d.contract.horizon, 'intraday');
  assert.ok(d.timeStopMinutes > 0, 'time stop required');
});

test('#17: market closed / weekend cannot produce an actionable intraday signal', () => {
  const d = V.dayTradeDecision({ event: EVENT, ticker: 'ACME', features: FEATURES, reactionInfo: REACTING, executionAllowed: false, sessionState: 'closed' });
  assert.equal(d.tradeState, 'CONTEXT_ONLY');
  assert.match(d.contract.notActionableReason, /closed/);
});

test('#17b: stale data during the session yields DATA_STALE, never ARMED/PRICE_CONFIRMED', () => {
  const d = V.dayTradeDecision({ event: EVENT, ticker: 'ACME', features: FEATURES, reactionInfo: REACTING, executionAllowed: false, sessionState: 'regular' });
  assert.equal(d.tradeState, 'DATA_STALE');
});

test('#19: a narrative alone (no intraday features) can NEVER be PRICE_CONFIRMED', () => {
  const d = V.dayTradeDecision({ event: EVENT, ticker: 'ACME', features: null, reactionInfo: { reaction: 'INSUFFICIENT_DATA', why: [] }, executionAllowed: true, sessionState: 'regular' });
  assert.equal(d.tradeState, 'DATA_STALE');
  assert.notEqual(d.tradeState, 'PRICE_CONFIRMED');
});

test('#18: a verified but extended event is not presented as an entry', () => {
  const d = V.dayTradeDecision({
    event: EVENT, ticker: 'ACME',
    features: { ...FEATURES, extensionAtr: 3.2 },
    reactionInfo: { reaction: 'EXTENDED', why: [] },
    executionAllowed: true, sessionState: 'regular',
  });
  assert.equal(d.tradeState, 'WATCH');
  assert.equal(d.contract.extended, true);
  assert.match(d.contract.notActionableReason, /extended/i);
});

test('#8 (views): mixed/unknown direction stays CONTEXT_ONLY even with perfect data', () => {
  const d = V.dayTradeDecision({
    event: { ...EVENT, currentDirection: 'MIXED' }, ticker: 'ACME',
    features: FEATURES, reactionInfo: REACTING, executionAllowed: true, sessionState: 'regular',
  });
  assert.equal(d.tradeState, 'CONTEXT_ONLY');
});

test('unverified catalyst stays INVESTIGATE — never armed', () => {
  const d = V.dayTradeDecision({
    event: { ...EVENT, evidence: 'UNVERIFIED' }, ticker: 'ACME',
    features: FEATURES, reactionInfo: REACTING, executionAllowed: true, sessionState: 'regular',
  });
  assert.equal(d.tradeState, 'INVESTIGATE');
  assert.ok(d.contract.missingData.includes('verified source'));
});

test('ARMED requires participation; without it the read is WATCH naming the missing data', () => {
  const below = { ...FEATURES, last: { c: 99.5 }, timeOfDayRelVol: 0.8 };
  const d = V.dayTradeDecision({ event: EVENT, ticker: 'ACME', features: below, reactionInfo: REACTING, executionAllowed: true, sessionState: 'regular' });
  assert.equal(d.tradeState, 'WATCH');
  assert.ok(d.contract.missingData.includes('participation'));
  const withVol = { ...FEATURES, last: { c: 99.5 } };
  const a = V.dayTradeDecision({ event: EVENT, ticker: 'ACME', features: withVol, reactionInfo: REACTING, executionAllowed: true, sessionState: 'regular' });
  assert.equal(a.tradeState, 'ARMED');
});

// ── swing ───────────────────────────────────────────────────────────────────
const SETUP = { valid: true, direction: 'long', trigger: 105, invalidation: 95, target: 125, rr: 2, quality: 0.8, spot: 100 };

test('swing: narrative without chart structure is INVESTIGATE — narrative cannot conjure a setup', () => {
  const d = V.swingDecision({ event: EVENT, ticker: 'ACME', setup: { direction: 'none', valid: false, reason: 'no-clean-trend' }, enrichment: null });
  assert.equal(d.tradeState, 'INVESTIGATE');
  assert.match(d.contract.notActionableReason, /research, not a setup/);
});

test('swing: bullish narrative vs short chart structure = CONTRADICTED', () => {
  const d = V.swingDecision({ event: EVENT, ticker: 'ACME', setup: { ...SETUP, direction: 'short' }, enrichment: null });
  assert.equal(d.tradeState, 'CONTRADICTED');
});

test('swing: valid aligned setup below trigger is WATCH with trigger+invalidation', () => {
  const d = V.swingDecision({ event: EVENT, ticker: 'ACME', setup: SETUP, enrichment: { ret3: 1, atrExt: 0.5, relVol: 1.0 } });
  assert.equal(d.tradeState, 'WATCH');
  assert.equal(d.contract.trigger, 105);
  assert.equal(d.contract.invalidation, 95);
});

test('swing: extended entry is chase — WATCH with extended flag, not an entry', () => {
  const d = V.swingDecision({ event: EVENT, ticker: 'ACME', setup: SETUP, enrichment: { ret3: 8, atrExt: 2.5, relVol: 2 } });
  assert.equal(d.tradeState, 'WATCH');
  assert.equal(d.contract.extended, true);
});

// ── investor ────────────────────────────────────────────────────────────────
test('investor: social-attention family is SENTIMENT_ONLY and not actionable', () => {
  const d = V.investorDecision({ event: { ...EVENT, family: 'positioning-sentiment' }, ticker: 'ACME', enrichment: null });
  assert.equal(d.thesisClass, 'SENTIMENT_ONLY');
  assert.equal(d.tradeState, 'CONTEXT_ONLY');
  assert.match(d.contract.notActionableReason, /social attention/);
});

test('investor: verified structural bullish change is THESIS_POSITIVE; big prior move is ALREADY_PRICED', () => {
  const pos = V.investorDecision({ event: { ...EVENT, family: 'guidance' }, ticker: 'ACME', enrichment: { ret3: 2 } });
  assert.equal(pos.thesisClass, 'THESIS_POSITIVE');
  const priced = V.investorDecision({ event: { ...EVENT, family: 'guidance' }, ticker: 'ACME', enrichment: { ret3: 15 } });
  assert.equal(priced.thesisClass, 'ALREADY_PRICED');
  assert.equal(priced.tradeState, 'CONTEXT_ONLY');
});

test('investor: unverified evidence is INSUFFICIENT_EVIDENCE', () => {
  const d = V.investorDecision({ event: { ...EVENT, evidence: 'SINGLE_SOURCE' }, ticker: 'ACME', enrichment: null });
  assert.equal(d.thesisClass, 'INSUFFICIENT_EVIDENCE');
});

test('the actionability contract is complete on every decision', () => {
  const d = V.dayTradeDecision({ event: EVENT, ticker: 'ACME', features: FEATURES, reactionInfo: REACTING, executionAllowed: true, sessionState: 'regular' });
  for (const k of ['whatHappened', 'verified', 'horizon', 'tradeState', 'missingData']) {
    assert.ok(k in d.contract, `contract must carry ${k}`);
  }
});
