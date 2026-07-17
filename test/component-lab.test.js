'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CL = require('../lib/component-lab');

// Deterministic dataset generator. Treatment probability RISES with priorReturn (the confounder),
// with overlap across the whole range so matches exist. Outcome depends on priorReturn (+ an
// optional TRUE treatment effect). noise is deterministic. All same regime/sector/liquidity so
// matching is driven by priorReturn.
function makeRecords(n, trueEffect, oneRegime = false) {
  const recs = [];
  for (let i = 0; i < n; i++) {
    const priorReturn = i % 21;                    // 0..20
    const treated = ((i * 29) % 100) < (30 + priorReturn * 2); // 30%→70% as priorReturn rises
    const noise = ((i * 13) % 11) - 5;             // -5..5, period 11 (coprime to priorReturn's 21)
    const ret = 10 + 0.5 * priorReturn + (treated ? trueEffect : 0) + noise;
    // Two regimes by default so a real effect can be confirmed as regime-robust.
    const regime = oneRegime ? 'on' : (i % 2 === 0 ? 'on' : 'off');
    recs.push({
      ticker: 'T' + i, date: '2026-0' + (1 + (i % 6)) + '-15', section: 'X', tier: 'A',
      ret, targetBeforeStop: ret > 0, mfe: Math.max(0, ret) + 2, mae: 3,
      features: { priorReturn, logDollarVol: 18, regime, sector: 'Tech', flag: treated },
    });
  }
  return recs;
}
const COMP = [{ key: 'flag', label: 'Test component', blurb: '', detect: f => f.flag === true }];

test('§2: matching corrects confounding — a NULL component reads additive naively but ~0 matched', () => {
  const out = CL.runComponentLab(makeRecords(240, 0), { components: COMP });
  const c = out.components[0];
  assert.ok(c.matchedPairs >= 20, `pairs=${c.matchedPairs}`);
  assert.ok(c.naiveDifference > 1, `naive should be biased positive, got ${c.naiveDifference}`);
  assert.ok(Math.abs(c.incrementalReturn) < 1.2, `matched should be ~0, got ${c.incrementalReturn}`);
  assert.ok(['redundant', 'inconclusive'].includes(c.verdict), `verdict=${c.verdict}`);
  // The correction is the whole point: matched materially below naive.
  assert.ok(c.confoundingCorrection < -0.5, `correction=${c.confoundingCorrection}`);
});

test('§2: a component with a TRUE positive effect survives matching → additive / retain', () => {
  const out = CL.runComponentLab(makeRecords(240, 4), { components: COMP });
  const c = out.components[0];
  assert.ok(c.incrementalReturn > 2, `matched incremental should recover the effect, got ${c.incrementalReturn}`);
  assert.equal(c.verdict, 'additive');
  assert.equal(c.recommendation, 'retain');
  assert.equal(c.significant, true);
});

test('§2: a component with a TRUE negative effect → harmful / disable recommendation (never auto-removed)', () => {
  const out = CL.runComponentLab(makeRecords(240, -4), { components: COMP });
  const c = out.components[0];
  assert.ok(c.incrementalReturn < -2);
  assert.equal(c.verdict, 'harmful');
  assert.equal(c.recommendation, 'disable'); // a recommendation, not an action
});

test('§2 discipline: a real effect on ONE regime is softened to "observe" (not confirmed out-of-regime)', () => {
  const out = CL.runComponentLab(makeRecords(240, 4, true), { components: COMP });
  const c = out.components[0];
  assert.equal(c.verdict, 'additive');            // the in-sample statistical read stands
  assert.equal(c.regimeRobust, false);
  assert.equal(c.recommendation, 'observe');       // but the ACTION is held back
  assert.equal(c.verdictRecommendation, 'retain'); // what it would have been if regime-robust
  assert.ok(c.caveat);
});

test('§2: insufficient data is blocked honestly, never a fabricated verdict', () => {
  const few = makeRecords(240, 0).filter((_, i) => i < 25); // tiny, lopsided groups
  const out = CL.runComponentLab(few, { components: COMP });
  const c = out.components[0];
  assert.ok(['insufficient'].includes(c.verdict));
  assert.equal(c.recommendation, 'observe');
});

test('§2: reports treated/control samples, CI, per-regime stability, and source examples', () => {
  const out = CL.runComponentLab(makeRecords(240, 4), { components: COMP });
  const c = out.components[0];
  assert.ok(c.treatedN > 0 && c.controlN > 0);
  assert.ok(c.treatedGroup && c.controlGroup && c.treatedGroup.winRate != null);
  assert.ok(Array.isArray(c.ci) && c.ci.length === 2 && c.ci[0] <= c.ci[1]);
  assert.ok(c.byRegime && c.byRegime.on && c.byRegime.on.n > 0);
  // Provenance: examples link back to exact source records (ticker + date + section).
  assert.ok(c.examples.length >= 1 && c.examples[0].treated.ticker && c.examples[0].treated.date && c.examples[0].control.ticker);
});

test('pairedStats: mean, se, t, and a 95% CI', () => {
  const s = CL.pairedStats([2, 2, 2, 2]);      // zero variance → big t
  assert.equal(s.mean, 2);
  assert.equal(s.n, 4);
  assert.ok(s.ci[0] <= 2 && s.ci[1] >= 2);
});
