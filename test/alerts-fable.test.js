'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAssessments, mergeAssessments, fableEdgeReport, applyPromotion, qualityScore,
  buildAssessPrompt, PROMOTE_MIN_GRADED,
} = require('../lib/alerts-fable');

// ── parseAssessments: sanitize + clamp the model output ──────────────────────
test('parseAssessments: clamps ranges, filters unknown tickers, keys by ticker', () => {
  const out = parseAssessments({
    assessments: [
      { ticker: 'nvda', direction: 'bullish', confidence: 999, credibility: -5, pump_risk: 'low', thesis: 'x' },
      { ticker: 'ZZZZ', direction: 'bullish', confidence: 50, credibility: 50, pump_risk: 'low', thesis: 'not requested' },
      { ticker: 'TSLA', direction: 'sideways', confidence: 40, credibility: 60, pump_risk: 'nonsense', thesis: 'y' },
    ],
    notes: 'ok',
  }, ['NVDA', 'TSLA']);
  assert.equal(out.assessments.NVDA.confidence, 100);   // clamped 999 → 100
  assert.equal(out.assessments.NVDA.credibility, 0);    // clamped -5 → 0
  assert.equal(out.assessments.ZZZZ, undefined);        // not in the requested set
  assert.equal(out.assessments.TSLA.direction, 'neutral'); // invalid enum → neutral
  assert.equal(out.assessments.TSLA.pumpRisk, 'medium');   // invalid enum → medium default
});

// ── mergeAssessments: attach r.ai, disagreement flag, quality score ─────────
test('mergeAssessments: flags disagreement with the mechanical direction', () => {
  const ranked = [{ ticker: 'AAA', direction: 'bullish', score: 5, weightedSignal: 2 }];
  const doc = { assessments: { AAA: { direction: 'bearish', confidence: 70, credibility: 60, pumpRisk: 'low' } } };
  const [m] = mergeAssessments(ranked, doc);
  assert.equal(m.ai.agrees, false);
  assert.equal(typeof m.ai.qualityScore, 'number');
});

test('mergeAssessments: r.ai is null when no assessment exists for a ticker', () => {
  const [m] = mergeAssessments([{ ticker: 'AAA', direction: 'bullish', score: 3 }], { assessments: {} });
  assert.equal(m.ai, null);
});

// ── qualityScore: pump-risk penalizes; higher confidence/credibility helps ──
test('qualityScore: a high-pump-risk name scores below an equivalent low-risk name', () => {
  const clean = qualityScore({ confidence: 70, credibility: 70, pumpRisk: 'low' }, 4);
  const pumpy = qualityScore({ confidence: 70, credibility: 70, pumpRisk: 'high' }, 4);
  assert.ok(clean > pumpy);
});

// ── fableEdgeReport: refuses to promote on small samples ────────────────────
test('fableEdgeReport: stays TRACKING below the minimum paired sample', () => {
  const log = [{ graded: true, excess: 5, direction: 'bullish', aiDirection: 'bullish' }];
  const fe = fableEdgeReport(log);
  assert.equal(fe.promoted, false);
  assert.ok(fe.verdict.includes('TRACKING'));
});

test('fableEdgeReport: PROMOTES when Fable direction clearly beats the bot', () => {
  // Construct n>=min paired calls where Fable is right far more often than the bot.
  const log = [];
  for (let i = 0; i < PROMOTE_MIN_GRADED + 20; i++) {
    // stock went up; Fable says bullish (right), bot says bearish (wrong) 85% of the time
    const fableRight = i % 20 !== 0;   // ~95% right
    log.push({ graded: true, excess: fableRight ? 5 : -5, aiDirection: 'bullish', direction: 'bearish' });
  }
  const fe = fableEdgeReport(log);
  assert.ok(fe.n >= PROMOTE_MIN_GRADED);
  assert.equal(fe.promoted, true);
  assert.ok(fe.fableHitRatePct > fe.mechHitRatePct);
});

// ── applyPromotion: reorders by quality + drops junk only when promoted ─────
test('applyPromotion: no-op when not promoted', () => {
  const ranked = [{ ticker: 'A', ai: { qualityScore: 10, pumpRisk: 'low', credibility: 80 } }, { ticker: 'B', ai: { qualityScore: 90, pumpRisk: 'low', credibility: 80 } }];
  assert.deepEqual(applyPromotion(ranked, false), ranked);
});

test('applyPromotion: when promoted, sorts by quality and drops high-pump low-cred junk', () => {
  const ranked = [
    { ticker: 'LOW', weightedSignal: 1, ai: { qualityScore: 20, pumpRisk: 'low', credibility: 80 } },
    { ticker: 'HIGH', weightedSignal: 1, ai: { qualityScore: 90, pumpRisk: 'low', credibility: 80 } },
    { ticker: 'JUNK', weightedSignal: 1, ai: { qualityScore: 50, pumpRisk: 'high', credibility: 20 } },
  ];
  const out = applyPromotion(ranked, true);
  assert.equal(out.length, 2);              // JUNK dropped
  assert.equal(out[0].ticker, 'HIGH');      // highest quality first
});

// ── buildAssessPrompt: includes the post text + mechanical label ────────────
test('buildAssessPrompt: surfaces ticker, mechanical label and post text', () => {
  const p = buildAssessPrompt([{ ticker: 'NVDA', direction: 'bullish', independentSources: 2, distinctAccounts: 3, catalysts: ['earnings'], sampleText: 'loading NVDA into print' }]);
  assert.ok(p.includes('$NVDA'));
  assert.ok(p.includes('mechanical=bullish'));
  assert.ok(p.includes('loading NVDA into print'));
});
