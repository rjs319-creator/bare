'use strict';

const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/redundancy');
const D = require('../lib/decision');

// Family map mirroring the production one, for the prior-fallback tests.
const FAM = { momo1: 'priceTrend', momo2: 'priceTrend', vol1: 'volumeAccum', news1: 'catalystForcedFlow' };
const familyOf = (a) => FAM[a] || null;

// Build rows: algorithm fires on `tickers` for each date in `dates`, with excess from fn.
function rows(algorithm, dates, tickers, exFn) {
  const out = [];
  for (const date of dates) for (const ticker of tickers) out.push({ date, ticker, algorithm, excess: exFn(date, ticker) });
  return out;
}
const DATES = Array.from({ length: 20 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);

test('pearson returns null below three paired points and 1 for identical series', () => {
  assert.strictEqual(R.pearson([1, 2], [1, 2]), null);
  assert.ok(Math.abs(R.pearson([1, 2, 3, 4], [1, 2, 3, 4]) - 1) < 1e-9);
  assert.ok(Math.abs(R.pearson([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-9);
});

test('pearson returns null for a zero-variance series (no fabricated correlation)', () => {
  assert.strictEqual(R.pearson([2, 2, 2, 2], [1, 2, 3, 4]), null);
});

test('redundancyOf takes the max channel and floors negative correlation at zero', () => {
  assert.strictEqual(R.redundancyOf({ overlapRate: 0.2, returnCorr: 0.9 }), 0.9);
  assert.strictEqual(R.redundancyOf({ overlapRate: 0.8, returnCorr: 0.1 }), 0.8);
  // Anti-correlated + non-overlapping = genuinely independent, not redundant.
  assert.strictEqual(R.redundancyOf({ overlapRate: 0, returnCorr: -0.9 }), 0);
  assert.strictEqual(R.redundancyOf({ overlapRate: null, returnCorr: null }), null);
});

test('two identical algorithms are measured as redundant → credit far below the prior', () => {
  // Same names, same dates, same outcomes: the textbook double-count.
  const ex = (d, t) => (t.charCodeAt(0) % 5) - 2 + DATES.indexOf(d) * 0.1;
  const model = R.buildRedundancyModel(
    [...rows('momo1', DATES, ['AAA', 'BBB', 'CCC'], ex), ...rows('momo2', DATES, ['AAA', 'BBB', 'CCC'], ex)],
    { priorCredit: 0.3, familyOf },
  );
  const p = model.pairs.find(x => x.a === 'momo1' && x.b === 'momo2');
  assert.strictEqual(p.method, 'measured');
  assert.strictEqual(p.overlapRate, 1);
  assert.ok(p.returnCorr > 0.99, `expected ~1 corr, got ${p.returnCorr}`);
  assert.strictEqual(p.redundancy, 1);
  // Measured credit is ~0; shrunk toward the 0.3 prior it must still land well under it.
  assert.ok(p.credit < 0.3, `identical algos must earn LESS credit than the 0.3 prior, got ${p.credit}`);
  assert.strictEqual(model.verdict, 'more-redundant-than-assumed');
});

test('disjoint, uncorrelated algorithms in the SAME family beat the static 0.3 prior', () => {
  // The failure mode of the hand-assigned map: same family, but they never co-fire and
  // their outcomes are unrelated. The static rule wrongly charges them 0.3.
  const a = rows('momo1', DATES, ['AAA', 'BBB'], (d) => Math.sin(DATES.indexOf(d)) * 3);
  const b = rows('momo2', DATES, ['XXX', 'YYY'], (d) => Math.cos(DATES.indexOf(d) * 2.7) * 3);
  const model = R.buildRedundancyModel([...a, ...b], { priorCredit: 0.3, familyOf });
  const p = model.pairs.find(x => x.a === 'momo1' && x.b === 'momo2');
  assert.strictEqual(p.sameFamily, true);
  assert.strictEqual(p.overlapRate, 0);
  assert.ok(p.credit > 0.3, `independent same-family pair should out-earn the prior, got ${p.credit}`);
});

test('a pair below the sample gates falls back to the static prior and says so', () => {
  const short = DATES.slice(0, 3);
  const model = R.buildRedundancyModel(
    [...rows('momo1', short, ['AAA'], () => 1), ...rows('momo2', short, ['AAA'], () => 1)],
    { priorCredit: 0.3, familyOf },
  );
  const p = model.pairs.find(x => x.a === 'momo1' && x.b === 'momo2');
  assert.strictEqual(p.method, 'prior');
  assert.strictEqual(p.credit, 0.3, 'same-family thin pair must inherit the family prior');
  assert.match(p.note, /Below the sample gate/);
  assert.strictEqual(model.verdict, 'insufficient');
  assert.strictEqual(model.summary.measurablePairs, 0);
});

test('credit is shrunk toward the prior — never a cliff from asserted to measured', () => {
  const ex = (d, t) => (t.charCodeAt(0) % 5) - 2 + DATES.indexOf(d) * 0.1;
  const few = R.buildRedundancyModel(
    [...rows('momo1', DATES.slice(0, 9), ['AAA', 'BBB'], ex), ...rows('momo2', DATES.slice(0, 9), ['AAA', 'BBB'], ex)],
    { priorCredit: 0.3, familyOf },
  ).pairs[0];
  const many = R.buildRedundancyModel(
    [...rows('momo1', DATES, ['AAA', 'BBB'], ex), ...rows('momo2', DATES, ['AAA', 'BBB'], ex)],
    { priorCredit: 0.3, familyOf },
  ).pairs[0];
  assert.ok(few.shrinkWeight < many.shrinkWeight, 'more paired dates must carry more measurement weight');
  // Both are identical-signal pairs (measured credit ~0), so more data ⇒ credit closer to 0.
  assert.ok(many.credit < few.credit, `expected more data to pull credit lower: ${many.credit} vs ${few.credit}`);
});

test('confirmationLift measures whether agreement actually pays', () => {
  // Co-selected names do +5; solo names do 0. Agreement genuinely predicts.
  const co = ['AAA'], solo = ['ZZZ'];
  const a = [...rows('momo1', DATES, co, () => 5), ...rows('momo1', DATES, solo, () => 0)];
  const b = [...rows('vol1', DATES, co, () => 5), ...rows('vol1', DATES, ['QQQ'], () => 0)];
  const lift = R.confirmationLift(a, b);
  assert.strictEqual(lift.coSelections, DATES.length);
  assert.ok(lift.lift > 0, 'co-selected outperformance must show as positive lift');
  assert.strictEqual(lift.coAvgExcess, 5);
  assert.strictEqual(lift.soloAvgExcess, 0);
  assert.strictEqual(lift.coWinRate, 1);
});

test('confirmationLift reports a NEGATIVE lift when agreement does not pay', () => {
  const a = [...rows('momo1', DATES, ['AAA'], () => -2), ...rows('momo1', DATES, ['ZZZ'], () => 4)];
  const b = [...rows('vol1', DATES, ['AAA'], () => -2), ...rows('vol1', DATES, ['QQQ'], () => 4)];
  const lift = R.confirmationLift(a, b);
  assert.ok(lift.lift < 0, 'agreement that underperforms must surface as negative lift');
});

test('effectiveEvidence with NO model reduces exactly to the current family rule', () => {
  const opts = { model: null, priorCredit: D.CORR_DISCOUNT, familyOf };
  // Two same-family sources: 1 + 0.3 — identical to independentEvidence's arithmetic.
  const same = R.effectiveEvidence(['momo1', 'momo2'], opts);
  const legacy = D.independentEvidence(['priceTrend', 'priceTrend']);
  assert.strictEqual(same.score, legacy.score, 'drop-in must not change behaviour without data');
  assert.strictEqual(same.method, 'prior');

  // Two different-family sources: 1 + 1.
  const diff = R.effectiveEvidence(['momo1', 'vol1'], opts);
  assert.strictEqual(diff.score, D.independentEvidence(['priceTrend', 'volumeAccum']).score);
});

test('effectiveEvidence charges a source against its WORST already-counted peer', () => {
  // momo1 and momo2 are measured near-duplicates; news1 is independent of both.
  const ex = (d, t) => (t.charCodeAt(0) % 5) - 2 + DATES.indexOf(d) * 0.1;
  const model = R.buildRedundancyModel([
    ...rows('momo1', DATES, ['AAA', 'BBB'], ex),
    ...rows('momo2', DATES, ['AAA', 'BBB'], ex),
    ...rows('news1', DATES, ['MMM', 'NNN'], (d) => Math.cos(DATES.indexOf(d) * 3.1) * 4),
  ], { priorCredit: 0.3, familyOf });

  const ev = R.effectiveEvidence(['momo1', 'momo2', 'news1'], { model, priorCredit: 0.3, familyOf });
  assert.strictEqual(ev.method, 'measured');
  const momo2Credit = ev.credits.find(c => c.source === 'momo2');
  assert.strictEqual(momo2Credit.against, 'momo1');
  assert.ok(momo2Credit.credit < 0.3, 'a measured duplicate must be charged below the prior');
  // Three sources, but they are NOT worth three independent votes.
  assert.ok(ev.score < 2.5, `three sources with one duplicate should score < 2.5, got ${ev.score}`);
});

test('effectiveEvidence is order-independent in total sources and flags redundant agreement', () => {
  const ex = (d, t) => (t.charCodeAt(0) % 5) - 2 + DATES.indexOf(d) * 0.1;
  const model = R.buildRedundancyModel(
    [...rows('momo1', DATES, ['AAA', 'BBB'], ex), ...rows('momo2', DATES, ['AAA', 'BBB'], ex)],
    { priorCredit: 0.3, familyOf },
  );
  const ev = R.effectiveEvidence(['momo1', 'momo2'], { model, priorCredit: 0.3, familyOf });
  assert.strictEqual(ev.sourceCount, 2);
  assert.ok(ev.redundantAgreement, 'two measured duplicates must flag as redundant agreement');
});

test('buildRedundancyModel is defensive: malformed rows and empty input never throw', () => {
  assert.strictEqual(R.buildRedundancyModel(null).algorithms.length, 0);
  assert.strictEqual(R.buildRedundancyModel([]).verdict, 'insufficient');
  const junk = R.buildRedundancyModel([{}, { date: '2026-01-01' }, { ticker: 'A' }, null, { date: 'd', ticker: 't', algorithm: 'x' }]);
  assert.strictEqual(junk.algorithms.length, 1, 'only the well-formed row should survive');
  assert.strictEqual(junk.algorithms[0].resolved, 0);
});

test('unresolved rows count as picks but never as resolved evidence', () => {
  const model = R.buildRedundancyModel(
    rows('momo1', DATES, ['AAA'], () => null).map(r => ({ ...r, excess: null })),
    { priorCredit: 0.3, familyOf },
  );
  const a = model.algorithms[0];
  assert.strictEqual(a.picks, DATES.length);
  assert.strictEqual(a.resolved, 0);
  assert.strictEqual(a.avgExcess, null);
  assert.strictEqual(a.measurable, false);
});

test('creditFor falls back to the static rule for an unknown pair', () => {
  const model = { credits: {} };
  assert.strictEqual(R.creditFor(model, 'momo1', 'momo2', { priorCredit: 0.3, familyOf }), 0.3);
  assert.strictEqual(R.creditFor(model, 'momo1', 'news1', { priorCredit: 0.3, familyOf }), 1);
  assert.strictEqual(R.creditFor(model, 'momo1', 'momo1', { priorCredit: 0.3, familyOf }), 0, 'a source cannot confirm itself');
});

// ── Integration: the measured model wired through rankSignals ────────────────

const mkSig = (over = {}) => D.makeSignal({
  ticker: 'AAA', source: 'screener', sources: ['screener'], horizon: 'swing',
  side: 'long', rawConfidence: 70, price: 10, family: 'priceTrend',
  evidenceFamilies: ['priceTrend'], liquidity: { dollarVol: 5e7 }, ...over,
}).signal;

test('rankSignals without a redundancy model is byte-identical to the legacy path', () => {
  const sigs = [mkSig({ sources: ['screener', 'momentum'], evidenceFamilies: ['priceTrend', 'priceTrend'] })];
  const before = D.rankSignals(sigs, { regime: { riskOn: true }, scoreboard: null });
  const after = D.rankSignals(sigs, { regime: { riskOn: true }, scoreboard: null, redundancy: null });
  assert.deepStrictEqual(after, before, 'passing redundancy:null must not change ranking');
  assert.strictEqual(before[0].evidence.measured, undefined);
});

test('rankSignals ignores a model whose pairs are all below the sample gates', () => {
  const thin = R.buildRedundancyModel(
    [...rows('screener', DATES.slice(0, 2), ['AAA'], () => 1), ...rows('momentum', DATES.slice(0, 2), ['AAA'], () => 1)],
    { priorCredit: D.CORR_DISCOUNT, familyOf: (s) => D.SOURCE_FAMILY[s] || null },
  );
  const sigs = [mkSig({ sources: ['screener', 'momentum'], evidenceFamilies: ['priceTrend', 'priceTrend'] })];
  const base = D.rankSignals(sigs, { regime: { riskOn: true }, scoreboard: null });
  const withThin = D.rankSignals(sigs, { regime: { riskOn: true }, scoreboard: null, redundancy: thin });
  assert.strictEqual(withThin[0].score, base[0].score, 'a thin model must not move the score');
});

test('a measured duplicate pair lowers the evidence score vs the asserted prior', () => {
  const ex = (d, t) => (t.charCodeAt(0) % 5) - 2 + DATES.indexOf(d) * 0.1;
  const model = R.buildRedundancyModel(
    [...rows('screener', DATES, ['AAA', 'BBB'], ex), ...rows('momentum', DATES, ['AAA', 'BBB'], ex)],
    { priorCredit: D.CORR_DISCOUNT, familyOf: (s) => D.SOURCE_FAMILY[s] || null },
  );
  const sigs = [mkSig({ sources: ['screener', 'momentum'], evidenceFamilies: ['priceTrend', 'priceTrend'] })];
  const base = D.rankSignals(sigs, { regime: { riskOn: true }, scoreboard: null })[0];
  const meas = D.rankSignals(sigs, { regime: { riskOn: true }, scoreboard: null, redundancy: model })[0];
  assert.strictEqual(meas.evidence.measured, true);
  assert.ok(meas.evidence.score < base.evidence.score,
    `measured duplicates must score below the 0.3-prior assumption: ${meas.evidence.score} vs ${base.evidence.score}`);
  assert.strictEqual(meas.evidence.priorScore, base.evidence.score, 'the prior score stays visible for audit');
  // familyCount is a DIFFERENT question (kinds of evidence) and must not be disturbed.
  assert.strictEqual(meas.evidence.familyCount, base.evidence.familyCount);
});

test('a single-source signal is never touched by the redundancy model', () => {
  const ex = (d, t) => (t.charCodeAt(0) % 5) - 2 + DATES.indexOf(d) * 0.1;
  const model = R.buildRedundancyModel(
    [...rows('screener', DATES, ['AAA', 'BBB'], ex), ...rows('momentum', DATES, ['AAA', 'BBB'], ex)],
    { priorCredit: D.CORR_DISCOUNT, familyOf: (s) => D.SOURCE_FAMILY[s] || null },
  );
  const sigs = [mkSig({ sources: ['screener'] })];
  const base = D.rankSignals(sigs, { regime: { riskOn: true }, scoreboard: null })[0];
  const meas = D.rankSignals(sigs, { regime: { riskOn: true }, scoreboard: null, redundancy: model })[0];
  assert.strictEqual(meas.score, base.score, 'one source cannot be redundant with itself');
});
