'use strict';
// NEWS UNDERREACTION tests. The invariants that matter:
//   1. TIMESTAMP DISCIPLINE: no publishedAt → INSUFFICIENT_DATA (never an age
//      guessed from detectedAt); publishedAt after the asOf close →
//      NOT_YET_OBSERVABLE (retroactive incorporation is impossible).
//   2. The gap is semantic impact MINUS the normalized market/sector-adjusted
//      reaction since publication: strong news + no reprice → FRESH underreaction;
//      reaction far beyond impact (same direction) → POSSIBLE_OVERREACTION.
//   3. Repeats: the same event fingerprint seen recently → STALE_REPEATED.
//   4. Normalization vol comes from PRE-event history only (no post-event
//      volatility contaminating the divisor).
//   5. Every record is researchOnly:true — states are features for a future
//      prospectively-trained model, never probabilities themselves.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/underreaction');

function tradingDates(n) {
  const out = [];
  const d = new Date('2025-02-03T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// Flat-ish path with bounded noise; optional jump (fractional) after jumpDate.
function bars(dts, { seed = 3, jumpDate = null, jump = 0 } = {}) {
  const rnd = lcg(seed);
  let px = 100;
  return dts.map(date => {
    px *= 1 + (rnd() - 0.5) * 0.008;
    if (jumpDate && date === jumpDate) px *= 1 + jump;
    return { date, open: px * 0.999, high: px * 1.004, low: px * 0.996, close: +px.toFixed(4), volume: 1e6 };
  });
}

const DTS = tradingDates(120);
const ASOF = DTS[110];
const PUB_IDX = 107;                                   // 3 sessions before asOf → fresh
const PUB = `${DTS[PUB_IDX]}T13:30:00.000Z`;

function event(over = {}) {
  return {
    ticker: 'NEWS', eventType: 'guidance', claim: 'raised FY guidance', direction: 'positive',
    materialityScore: 0.9, noveltyScore: 0.9, sourceQualityScore: 0.9, primarySourceCount: 1,
    publishedAt: PUB, detectedAt: DTS[110], extractor: { model: 'claude-haiku-4-5-20251001', promptVersion: 'extract-v1' },
    ...over,
  };
}

test('semantic impact: signed by direction, scaled by materiality, bounded, 0 for mixed/neutral', () => {
  assert.ok(U.semanticImpact(event()) > 0.6);
  assert.ok(U.semanticImpact(event({ direction: 'negative' })) < -0.6);
  assert.equal(U.semanticImpact(event({ direction: 'mixed' })), 0);
  assert.ok(Math.abs(U.semanticImpact(event({ materialityScore: 1, noveltyScore: 1, sourceQualityScore: 1 }))) <= 1);
});

test('strong positive news + no reprice → FRESH_POSITIVE_UNDERREACTION', () => {
  const flat = bars(DTS);
  const spy = bars(DTS, { seed: 4 });
  const reaction = U.priceReaction({ bars: flat, benchBars: spy, sectorBars: [], publishedAt: PUB, asOf: ASOF });
  assert.equal(reaction.ok, true);
  assert.ok(Math.abs(reaction.reactionNorm) < 0.3, `flat path should have small reaction, got ${reaction.reactionNorm}`);
  const rec = U.classifyUnderreaction(event(), reaction, { isRepeated: false });
  assert.equal(rec.state, 'FRESH_POSITIVE_UNDERREACTION');
  assert.ok(rec.gap > 0.35);
  assert.equal(rec.researchOnly, true);
});

test('a reaction far beyond the impact (same direction) → POSSIBLE_OVERREACTION', () => {
  const jumped = bars(DTS, { jumpDate: DTS[PUB_IDX + 1], jump: 0.30 });
  const spy = bars(DTS, { seed: 4 });
  const reaction = U.priceReaction({ bars: jumped, benchBars: spy, sectorBars: [], publishedAt: PUB, asOf: ASOF });
  assert.equal(reaction.ok, true);
  assert.ok(reaction.reactionNorm >= 0.99, `30% jump on ~0.2% daily vol must saturate, got ${reaction.reactionNorm}`);
  const mild = event({ materialityScore: 0.5, noveltyScore: 0.5 });
  const rec = U.classifyUnderreaction(mild, reaction, { isRepeated: false });
  assert.equal(rec.state, 'POSSIBLE_OVERREACTION');
});

test('timestamp discipline: no publishedAt → INSUFFICIENT_DATA; future publish → NOT_YET_OBSERVABLE', () => {
  const noTs = U.classifyUnderreaction(event({ publishedAt: null }), null, {});
  assert.equal(noTs.state, 'INSUFFICIENT_DATA');
  assert.equal(noTs.reason, 'no-publish-timestamp');

  const futurePub = `${DTS[115]}T13:30:00.000Z`;      // after asOf
  const reaction = U.priceReaction({ bars: bars(DTS), benchBars: [], sectorBars: [], publishedAt: futurePub, asOf: ASOF });
  assert.equal(reaction.ok, false);
  assert.equal(reaction.reason, 'publish-date-after-asof');
  const rec = U.classifyUnderreaction(event({ publishedAt: futurePub }), reaction, {});
  assert.equal(rec.state, 'NOT_YET_OBSERVABLE');
});

test('repeats: a recently-seen fingerprint → STALE_REPEATED', () => {
  const reaction = U.priceReaction({ bars: bars(DTS), benchBars: [], sectorBars: [], publishedAt: PUB, asOf: ASOF });
  const rec = U.classifyUnderreaction(event(), reaction, { isRepeated: true });
  assert.equal(rec.state, 'STALE_REPEATED');
});

test('normalization vol comes from pre-event history only', () => {
  // Wild volatility AFTER the event must not change the divisor: compare a world
  // whose post-publication noise explodes against the calm one — reactionZ's
  // divisor (pre-event vol) is identical, so only the numerator (actual move) differs.
  const calm = bars(DTS);
  const wildTail = calm.map((b, i) => (i > PUB_IDX ? { ...b, close: b.close * (1 + (i % 2 ? 0.1 : -0.09)) } : b));
  const rCalm = U.priceReaction({ bars: calm, benchBars: [], sectorBars: [], publishedAt: PUB, asOf: ASOF });
  const rWild = U.priceReaction({ bars: wildTail, benchBars: [], sectorBars: [], publishedAt: PUB, asOf: ASOF });
  assert.equal(rCalm.ok, true);
  assert.equal(rWild.ok, true);
  // Same pre-event window → same sessionsSincePublish; the wild world just moved more.
  assert.equal(rCalm.sessionsSincePublish, rWild.sessionsSincePublish);
  assert.ok(Math.abs(rWild.reactionZ) > Math.abs(rCalm.reactionZ));
});

test('below the materiality floor → AMBIGUOUS, never a candidate', () => {
  const reaction = U.priceReaction({ bars: bars(DTS), benchBars: [], sectorBars: [], publishedAt: PUB, asOf: ASOF });
  const rec = U.classifyUnderreaction(event({ materialityScore: 0.1 }), reaction, {});
  assert.equal(rec.state, 'AMBIGUOUS');
});

test('eventFingerprint is stable and keyed on ticker|type|publish-day|direction', () => {
  const a = U.eventFingerprint(event());
  const b = U.eventFingerprint(event());
  assert.equal(a, b);
  assert.notEqual(a, U.eventFingerprint(event({ direction: 'negative' })));
});
