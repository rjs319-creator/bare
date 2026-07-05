'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreGapGo, GAP_STRONG, GAP_MODERATE, MIN_DOLLAR_VOL,
        continuationScore, gapTake, suggestedRiskPct, TIER_STATS,
        META_MODEL, gapMetaFeatures, metaProbFromVector, metaProb, metaTier } = require('../lib/gapgo');

// Build a flat, liquid base of `n` candles at price `p`, then a final GAP-UP day whose
// open is `gapPct`% above the prior close. Volume kept well above the liquidity floor.
function withGap(gapPct, { p = 20, n = 30, vol = 3_000_000 } = {}) {
  const candles = [];
  for (let i = 0; i < n; i++) {
    candles.push({ date: `2026-02-${String((i % 28) + 1).padStart(2, '0')}`, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: vol });
  }
  const prevClose = candles[candles.length - 1].close;
  const open = +(prevClose * (1 + gapPct / 100)).toFixed(2);
  const close = +(open * 1.02).toFixed(2);       // holds the gap, closes green
  candles.push({ date: '2026-03-01', open, high: +(close * 1.01).toFixed(2), low: +(open * 0.995).toFixed(2), close, volume: vol * 2 });
  return candles;
}

test('a ≥5% gap-up on a liquid name scores STRONG with an ORB plan', () => {
  const s = scoreGapGo(withGap(6));
  assert.ok(s, 'expected a signal');
  assert.equal(s.tier, 'STRONG');
  assert.ok(s.gapPct >= GAP_STRONG);
  assert.ok(s.plan && s.plan.trigger > 0 && s.plan.stop < s.plan.trigger && s.plan.target > s.plan.trigger,
    'ORB plan must have trigger > stop and target above trigger');
  assert.equal(s.plan.rr, 2, '1:2 reward:risk');
});

test('a 3–5% gap-up scores MODERATE', () => {
  const s = scoreGapGo(withGap(4));
  assert.ok(s);
  assert.equal(s.tier, 'MODERATE');
  assert.ok(s.gapPct >= GAP_MODERATE && s.gapPct < GAP_STRONG);
});

test('a sub-threshold gap (<3%) does not signal', () => {
  assert.equal(scoreGapGo(withGap(1.5)), null);
});

test('an illiquid name is rejected even with a big gap', () => {
  // Dollar volume = price(20) × volume must be below MIN_DOLLAR_VOL; use tiny volume.
  const thinVol = Math.floor(MIN_DOLLAR_VOL / 20 / 4);   // well under the floor
  assert.equal(scoreGapGo(withGap(8, { vol: thinVol })), null);
});

function flatBase(n = 25, p = 20, vol = 3_000_000) {
  const c = [];
  for (let i = 0; i < n; i++) c.push({ date: `2026-02-${String((i % 28) + 1).padStart(2, '0')}`, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: vol });
  return c;
}

test('a split-adjustment artifact (huge move, NO volume spike) is rejected', () => {
  const c = flatBase();
  c.push({ date: '2026-03-02', open: 80, high: 81, low: 79, close: 80, volume: 1_000_000 }); // ~4× price, sub-avg volume
  assert.equal(scoreGapGo(c), null, 'a ~300% "gap" that volume did not confirm is a data artifact, not a signal');
});

test('a real large gap WITH a volume spike still signals (guard is volume-gated, not a blunt cap)', () => {
  const c = flatBase();
  c.push({ date: '2026-03-02', open: 26, high: 27, low: 25.8, close: 26.5, volume: 15_000_000 }); // +30% on 5× volume
  const s = scoreGapGo(c);
  assert.ok(s, 'a real high-volume catalyst gap must still signal');
  assert.equal(s.tier, 'STRONG');
});

test('the stop is a ~2.5×ATR distance below the trigger (wide stop, the validated exit)', () => {
  const s = scoreGapGo(withGap(6));
  const risk = s.plan.trigger - s.plan.stop;
  assert.ok(risk >= 2 * s.plan.atr && risk <= 3 * s.plan.atr,
    `stop distance ${risk} should be ~2.5×ATR (${s.plan.atr})`);
});

test('excessPct is computed when SPY history is supplied', () => {
  const candles = withGap(6);
  const spyByDate = {};
  candles.forEach((c, i) => { spyByDate[c.date] = 400 + i * 0.1; });   // gently rising SPY
  const s = scoreGapGo(candles, spyByDate);
  assert.ok(s && typeof s.excessPct === 'number', 'excessPct should be a number vs SPY');
});

// ── Meta-label (#1) + fractional-Kelly sizing (#2) — validated pure functions ──
test('continuationScore: bounded 0-100 and monotone in gap size', () => {
  const a = continuationScore(3, 2, 'neutral'), b = continuationScore(8, 2, 'neutral'), c = continuationScore(15, 2, 'neutral');
  assert.ok(a >= 0 && c <= 100);
  assert.ok(b > a && c > b);
});

test('continuationScore: monotone in relVol', () => {
  assert.ok(continuationScore(6, 4, 'neutral') > continuationScore(6, 1, 'neutral'));
});

test('continuationScore: risk-off < neutral < risk-on (regime is the leak)', () => {
  assert.ok(continuationScore(6, 3, 'risk-off') < continuationScore(6, 3, 'neutral'));
  assert.ok(continuationScore(6, 3, 'neutral') < continuationScore(6, 3, 'risk-on'));
});

test('gapTake: never take in risk-off regardless of score', () => {
  assert.equal(gapTake(100, 'risk-off'), false);
});

test('gapTake: take when score >= threshold and not risk-off', () => {
  assert.equal(gapTake(60, 'risk-on'), true);
  assert.equal(gapTake(10, 'neutral'), false);
});

test('suggestedRiskPct: zero in risk-off, and unknown tier is fail-safe zero', () => {
  assert.equal(suggestedRiskPct('STRONG', 90, 'risk-off'), 0);
  assert.equal(suggestedRiskPct('WEAK', 80, 'risk-on'), 0);
});

test('suggestedRiskPct: STRONG > MODERATE, scales with score, within fractional-Kelly cap', () => {
  assert.ok(suggestedRiskPct('STRONG', 70, 'risk-on') > suggestedRiskPct('MODERATE', 70, 'risk-on'));
  assert.ok(suggestedRiskPct('STRONG', 90, 'neutral') > suggestedRiskPct('STRONG', 40, 'neutral'));
  const cap = TIER_STATS.STRONG.fullKelly * 0.25 * 100;
  assert.ok(suggestedRiskPct('STRONG', 100, 'risk-on') <= cap + 1e-9);
});

// ── Meta-label serve model (exp11) — PINNED to the exported Python LogisticRegression ──
// Fixtures from `python experiments/11_metalabel.py export`. If lib/gapgo.js META_MODEL and
// the study's serve model ever drift, these fail loudly (same guard as continuationScore).
const META_FIXTURES = [
  { feat: { gap: 0.20517, atr_pct: 0.1642, log_adv: 16.6177, prior_ret: 0.28889, gap_to_atr: 1.2495, reg_norm: 0.55, dow: 0, rel_vol: 4.0 }, prob: 0.156953 },
  { feat: { gap: 0.04023, atr_pct: 0.06838, log_adv: 8.5724, prior_ret: 0.06221, gap_to_atr: 0.5883, reg_norm: 0.0, dow: 2, rel_vol: 0.8704 }, prob: 0.447931 },
  { feat: { gap: 0.1102, atr_pct: 0.07599, log_adv: 8.3214, prior_ret: 0.06004, gap_to_atr: 1.4501, reg_norm: 1.0, dow: 2, rel_vol: 0.9197 }, prob: 0.482774 },
  { feat: { gap: 0.04583, atr_pct: 0.08524, log_adv: 7.7485, prior_ret: 0.08597, gap_to_atr: 0.5377, reg_norm: 1.0, dow: 3, rel_vol: 0.6369 }, prob: 0.518723 },
  { feat: { gap: 0.04615, atr_pct: 0.14918, log_adv: 7.4258, prior_ret: 0.04334, gap_to_atr: 0.3094, reg_norm: 1.0, dow: 3, rel_vol: 0.7883 }, prob: 0.560111 },
  { feat: { gap: 0.06723, atr_pct: 0.1443, log_adv: 7.853, prior_ret: -0.3, gap_to_atr: 0.4659, reg_norm: 1.0, dow: 1, rel_vol: 3.1106 }, prob: 0.708625 },
];

test('metaProbFromVector matches the exported sklearn LogisticRegression (pinned fixtures)', () => {
  for (const { feat, prob } of META_FIXTURES) {
    assert.ok(Math.abs(metaProbFromVector(feat) - prob) < 1e-4,
      `meta prob for ${JSON.stringify(feat)} = ${metaProbFromVector(feat)} != ${prob}`);
  }
});

test('gapMetaFeatures reproduces the rig feature formulas (gap, dow Mon=0, prior_ret)', () => {
  const c = flatBase(25, 20, 3_000_000);
  // prior (last base) day closes green so prior_ret > 0; gap day opens +6%
  c[c.length - 1] = { ...c[c.length - 1], open: 19.5, close: 20 };   // prior_ret = 20/19.5-1
  c.push({ date: '2026-03-02', open: 21.2, high: 21.6, low: 21.0, close: 21.5, volume: 6_000_000 }); // Monday
  const f = gapMetaFeatures(c);
  assert.ok(f, 'features should build');
  assert.ok(Math.abs(f.gap - (21.2 / 20 - 1)) < 1e-4, 'gap = open/prevClose - 1');
  assert.ok(Math.abs(f.prior_ret - (20 / 19.5 - 1)) < 1e-4, 'prior_ret = prevClose/prevOpen - 1');
  assert.equal(f.dow, 0, '2026-03-02 is a Monday → weekday 0 (Python convention)');
  assert.equal(f.reg_norm, null, 'reg_norm is filled by the route, not the feature builder');
});

test('metaProb injects regime and metaTier splits at the training median', () => {
  const c = flatBase(25, 20, 3_000_000);
  c.push({ date: '2026-03-02', open: 21.2, high: 21.6, low: 21.0, close: 21.5, volume: 6_000_000 });
  const feat = gapMetaFeatures(c);
  const p = metaProb(feat, 'risk-on');
  assert.ok(p > 0 && p < 1, 'probability in (0,1)');
  // risk-on reg_norm (1.0) has a positive coefficient → not below risk-off
  assert.ok(metaProb(feat, 'risk-on') >= metaProb(feat, 'risk-off'));
  assert.equal(metaTier(META_MODEL.median_prob + 0.01), 'HIGH');
  assert.equal(metaTier(META_MODEL.median_prob - 0.01), 'LOW');
  assert.equal(metaProb(null, 'risk-on'), null, 'null features → null prob (never fabricate)');
});
