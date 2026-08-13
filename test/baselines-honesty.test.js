'use strict';
// THE BASELINE SCORECARD COMPARED TWO DIFFERENT RULERS (alpha-research pass 3).
//
// Three separate claims in one surface were not supported by the data behind it:
//
// (1) TWO METRIC SPACES, ONE TABLE. lib/research.js computes each factor arm as
//     `r = cohortRet[i] - mean(cohortRets)` over MAX_HOLD=63 sessions, GROSS — i.e.
//     cross-sectional excess vs THE COHORT. lib/maturity.js computes each strategy row
//     as excess vs SPY, at that strategy's own horizon, NET where a cost channel exists.
//     The block was headed "The baselines — the bar to beat" and the verdict read
//     "the bar to beat is a momentum rank (IC 0.10)". Those numbers cannot be compared.
//
// (2) A CONSTRUCTION IDENTITY REPORTED AS A MEASUREMENT. The equal-weight/random arms
//     hardcoded `topQuintileExcess: 0`. Zero is where the cohort mean sits by definition,
//     not something that was measured — and a random-pick baseline only discriminates
//     through its SAMPLING SPREAD, which is not recoverable from the persisted quintile
//     aggregates. A bare 0 with no error band makes any positive number look like it clears.
//
// (3) FOUR ARMS CLAIMED, TWO ENFORCED. `beatSpyAndSector` is the only gate; the null and
//     factor arms were displayed under a "bar to beat" heading and never applied to any
//     strategy, so a reader could only conclude they had been cleared.
//
// The fix is entirely about labelling — no measurement changed, and no dispersion was
// invented to fill the gap. These tests fail if any of the three claims comes back.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../lib/baselines');

const RESEARCH = {
  factors: [
    { key: 'mom126', label: 'Momentum 6mo', rankIC: 0.10, winRateSpread: 12, n: 4000, quintiles: [{ q: 1, avgR: -1.2 }, { q: 5, avgR: 1.8 }] },
    { key: 'proximity', label: 'Proximity', rankIC: 0.07, winRateSpread: 8, n: 4000, quintiles: [{ q: 1, avgR: -0.8 }, { q: 5, avgR: 1.1 }] },
    { key: 'volSurge', label: 'Volume surge', rankIC: -0.004, winRateSpread: 0, n: 4000, quintiles: [{ q: 1, avgR: 0.1 }, { q: 5, avgR: -0.1 }] },
  ],
};
const MATURITY = {
  strategies: [
    { id: 'screener', label: 'Breakout', kind: 'signal', grade: 'experimental', stats: { baselines: { market: { avgExcess: 0.4, n: 180 }, sector: { avgExcess: 0.2, n: 150 } } } },
  ],
};

const armOf = (out, key) => out.baselines.find(b => b.key === key);

// ── (1) the two rulers ───────────────────────────────────────────────────────────

test('every arm and every strategy row declares the basis it was measured on', () => {
  const out = B.assembleBaselines({ research: RESEARCH, maturity: MATURITY });
  for (const b of out.baselines) {
    if (b.kind === 'unavailable') continue;
    if (b.kind === 'benchmark') continue; // SPY/sector ARE the strategy basis
    assert.equal(b.basis, B.FACTOR_BASIS, `${b.key} must state its metric space`);
  }
  assert.equal(out.strategies[0].basis, B.STRATEGY_BASIS);
  assert.notEqual(B.FACTOR_BASIS, B.STRATEGY_BASIS, 'the whole point is that these differ');
});

test('the basis strings name the three things that actually differ', () => {
  // benchmark, horizon, cost treatment — a reader must be able to see WHY they differ,
  // not just be told that they do.
  assert.match(B.FACTOR_BASIS, /cohort/i);
  assert.match(B.FACTOR_BASIS, /63 sessions/);
  assert.match(B.FACTOR_BASIS, /gross/i);
  assert.match(B.STRATEGY_BASIS, /SPY/);
  assert.match(B.STRATEGY_BASIS, /horizon/i);
  assert.match(B.STRATEGY_BASIS, /net/i);
});

test('non-comparability is asserted on the payload, not left to the reader', () => {
  const out = B.assembleBaselines({ research: RESEARCH, maturity: MATURITY });
  assert.equal(out.comparability.comparable, false);
  assert.equal(out.comparability.factorBasis, B.FACTOR_BASIS);
  assert.equal(out.comparability.strategyBasis, B.STRATEGY_BASIS);
});

test('the strongest factor arm is flagged as NOT a threshold for the strategy rows', () => {
  const out = B.assembleBaselines({ research: RESEARCH, maturity: MATURITY });
  assert.equal(out.bestBar.key, 'momentum', 'still identifies the strongest naive screen');
  assert.equal(out.bestBar.rankIC, 0.10, 'the measurement itself is unchanged');
  assert.equal(out.bestBar.comparableToStrategies, false);
  assert.match(out.bestBar.comparabilityNote, /not a threshold/i);
});

test('the verdict no longer calls a factor rank "the bar to beat"', () => {
  const out = B.assembleBaselines({ research: RESEARCH, maturity: MATURITY });
  assert.ok(!/the bar to beat/i.test(out.verdict), `cross-space claim returned: ${out.verdict}`);
  assert.match(out.verdict, /different benchmark\/horizon\/cost basis/i,
    'the factor number may still be reported — but only with its basis attached');
});

// ── (2) the null arms ────────────────────────────────────────────────────────────

test('a null arm marks its zero as a construction identity, not a measurement', () => {
  const eq = armOf(B.assembleBaselines({ research: RESEARCH }), 'equalweight');
  assert.equal(eq.topQuintileExcess, 0, 'zero is still where the cohort mean sits');
  assert.equal(eq.byConstruction, true, 'but it must be labelled as definitional');
});

test('an unmeasured sampling spread is reported as unmeasured, never as zero', () => {
  // The failure mode being pinned: filling the gap with a made-up dispersion would be
  // worse than the original defect. null + dispersionMeasured:false is the honest state.
  for (const key of ['equalweight', 'random']) {
    const arm = armOf(B.assembleBaselines({ research: RESEARCH }), key);
    assert.equal(arm.dispersion, null, `${key}: spread is not derivable from the cached artifact`);
    assert.equal(arm.dispersionMeasured, false);
    assert.notEqual(arm.dispersion, 0, `${key}: a zero spread would assert certainty that was never computed`);
  }
});

test('a null arm declares that it cannot reject anything', () => {
  const rnd = armOf(B.assembleBaselines({ research: RESEARCH }), 'random');
  assert.equal(rnd.discriminates, false);
  assert.match(rnd.note, /spread/i, 'the note must say WHY it cannot discriminate');
});

test('the null arms are still present — this labels them, it does not delete them', () => {
  const out = B.assembleBaselines({ research: RESEARCH });
  assert.ok(armOf(out, 'equalweight'));
  assert.ok(armOf(out, 'random'));
  assert.equal(armOf(out, 'equalweight').available, true);
});

// ── (3) claimed arms vs enforced arms ────────────────────────────────────────────

test('only the two baselines actually computed per strategy are marked applied', () => {
  const out = B.assembleBaselines({ research: RESEARCH, maturity: MATURITY });
  const applied = out.baselines.filter(b => b.applied).map(b => b.key).sort();
  assert.deepEqual(applied, ['sector', 'spy']);
  // And every other arm must say so explicitly rather than leaving the field absent.
  for (const b of out.baselines.filter(x => !B.APPLIED_KEYS.includes(x.key))) {
    assert.equal(b.applied, false, `${b.key} must declare that it is not a gate`);
  }
});

test('the gap between the stated rule and the enforced rule is surfaced', () => {
  const out = B.assembleBaselines({ research: RESEARCH, maturity: MATURITY });
  assert.deepEqual(out.coverage.appliedBaselines, ['spy', 'sector']);
  assert.ok(out.coverage.unappliedBaselines.includes('equalweight'));
  assert.ok(out.coverage.unappliedBaselines.includes('momentum'));
  assert.equal(out.summary.unappliedBaselines, out.coverage.unappliedBaselines.length);
  assert.match(out.coverage.note, /not evidence any strategy cleared them/i);
});

test('a passing verdict does not imply the unenforced arms were cleared', () => {
  const out = B.assembleBaselines({
    research: RESEARCH,
    maturity: { strategies: [{ id: 'x', label: 'X', kind: 'signal', grade: 'validated', stats: { baselines: { market: { avgExcess: 2, n: 200 }, sector: { avgExcess: 1, n: 200 } } } }] },
  });
  assert.match(out.verdict, /ENFORCED/);
  assert.match(out.verdict, /context, not gates/i);
});

// ── the UI is where the misreading actually happened ─────────────────────────────

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
// Strip comments: the explanatory comments here necessarily quote the old strings, and a
// naive scan flags its own documentation.
const APP_CODE = APP.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('no surface still heads the naive screens as "the bar to beat"', () => {
  assert.ok(!/the bar to beat/i.test(APP_CODE), 'the cross-space heading returned');
});

test('the null row no longer renders a bare "0% excess bar"', () => {
  assert.ok(!/0% excess bar/.test(APP_CODE));
  assert.match(APP_CODE, /zero by construction · spread not measured/);
});

test('the tab description states which baselines are enforced', () => {
  const desc = APP_CODE.slice(APP_CODE.indexOf('baselines: \'Does each strategy'), APP_CODE.indexOf('baselines: \'Does each strategy') + 500);
  assert.match(desc, /Two baselines are enforced/);
  assert.match(desc, /not applied as gates/);
});

test('the renderer surfaces both the ruler mismatch and the coverage gap', () => {
  assert.match(APP_CODE, /d\.comparability && d\.comparability\.comparable === false/);
  assert.match(APP_CODE, /Different rulers/);
  assert.match(APP_CODE, /d\.coverage\.unappliedBaselines/);
  assert.match(APP_CODE, /Shown but not enforced/);
});
