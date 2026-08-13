'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { composeWhyNow, verdictOf, dedupedForCount } = require('../lib/whynow');

const riskOn = { regime: 'risk-on', macroRisk: 20 };

test('Apex + Conviction (both registry-shadow) contribute CONTEXT, never for-votes', () => {
  // RT-02 (graduation-league): apex was demoted to a zero-weight frozen benchmark and
  // conviction's registry entry forbids user-facing consumption — neither may add
  // verdict weight until a registry re-promotion.
  const r = composeWhyNow({
    ticker: 'NVDA', macro: riskOn,
    apex: { tier: 'loaded', score: 63, pillars: {} },
    conviction: { sleeveA: true, pctile: 85 },
  });
  assert.equal(r.forCase.length, 0, 'shadow strategies may not sit in the for-column');
  assert.notEqual(r.verdict.level, 'constructive');
  const ctx = r.signals.filter(x => x.side === 'context' && /^(Apex:|Conviction:)/.test(x.key));
  assert.equal(ctx.length, 2, 'both reads stay visible as labeled context');
  assert.ok(ctx.every(x => /shadow/i.test(x.note || '')), 'context rows must say WHY they carry no weight');
});

test('genuinely distinct families still reach constructive (verdict layer)', () => {
  // The family-collapse logic is unchanged — exercised at the verdict layer with two
  // for-votes from distinct families (the raw-source path now requires registry
  // clearance, which shadow fixtures cannot supply).
  const v = verdictOf([
    { side: 'for', key: 'Ghost:STALKING' },
    { side: 'for', key: 'ReadThrough:Fresh' },
  ]);
  assert.equal(v.level, 'constructive');
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
