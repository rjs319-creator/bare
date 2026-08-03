'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { composeWhyNow, verdictOf, dedupedForCount } = require('../lib/whynow');

const riskOn = { regime: 'risk-on', macroRisk: 20 };

test('Apex + Conviction (same screener cross-section) collapse to ONE for-vote', () => {
  const r = composeWhyNow({
    ticker: 'NVDA', macro: riskOn,
    apex: { tier: 'loaded', score: 63, pillars: {} },
    conviction: { sleeveA: true, pctile: 85 },
  });
  // Two raw FOR rows render, but the verdict counts one correlated family.
  assert.equal(r.forCase.length, 2);
  assert.equal(r.verdict.level, 'watch', 'correlated screeners are one signal, not "multiple aligned"');
  assert.match(r.verdict.summary, /same underlying cross-section|count as one/i);
});

test('genuinely distinct families still reach constructive', () => {
  const r = composeWhyNow({
    ticker: 'NVDA', macro: riskOn,
    ghost: { tier: 'STALKING', score: 71, strongPillars: ['RM'] },
    apex: { tier: 'loaded', score: 63, pillars: {} },
  });
  assert.equal(r.verdict.level, 'constructive');
});

test('the word "independent" never appears in a multi-signal verdict', () => {
  const r = composeWhyNow({
    ticker: 'NVDA', macro: riskOn,
    ghost: { tier: 'GHOST', score: 82, strongPillars: ['RM'] },
    apex: { tier: 'apex', score: 88, pillars: {} },
  });
  assert.doesNotMatch(r.verdict.summary, /independent/i, 'use "separate signals", never claim independence');
});

test('dedupedForCount: signals without a section dedupe by their own key', () => {
  const n = dedupedForCount([
    { side: 'for', key: 'Ghost:GHOST' },
    { side: 'for', key: 'Apex:apex' },
    { side: 'for', key: 'Conviction:sleeveA' },
    { side: 'against', key: 'ReadThrough:Moved' },
  ]);
  assert.equal(n, 2, 'Ghost + (Apex⊕Conviction) = 2 families');
});

test('risk-off veto still beats any bullish count', () => {
  const v = verdictOf([
    { side: 'for', key: 'Ghost:GHOST' },
    { side: 'for', key: 'Apex:apex' },
    { side: 'context', key: 'regime', veto: true },
  ]);
  assert.equal(v.level, 'caution');
});
