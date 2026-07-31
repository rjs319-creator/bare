'use strict';
// CANONICAL FEATURE SCHEMA — tests that field-name drift (residual15 vs residualVsSpy),
// dropped features (momAccel) and silent zero-imputation are TEST FAILURES, not silent
// training corruption. Also guards the probability-language honesty contract.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MODEL_FEATURES, toModelRow, missingnessOf, validateFeaturePresence, FEATURE_SCHEMA_VERSION } = require('../lib/intraday-schema');
const { buildIntradayFeatures } = require('../lib/intraday-features');
const { intradayEv } = require('../lib/lifecycle-eval');
const { buildCanonicalCard } = require('../lib/daytrade-actionability');
const { buildSnapshot } = require('../lib/lifecycle-capture');
const { advanceLifecycle } = require('../lib/opportunity-lifecycle');
const { trainLogistic, predictProba, designRow, standardize } = require('../lib/survival-model');
const { gradesToRows, FEATURES } = require('../lib/survival-eval');

const NOW = '2026-07-08T14:29:00Z';

function acceleratingBars(n = 11, start = '2026-07-08T13:30:00Z') {
  const t0 = Date.parse(start);
  const bars = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    const gain = 0.05 + 0.09 * i;
    const o = c; c = +(c + gain).toFixed(3);
    bars.push({ t: new Date(t0 + i * 5 * 60000).toISOString(), o, h: c + 0.05, l: o - 0.05, c, v: 40000 + 5000 * i });
  }
  return bars;
}

function fullEv() {
  const bars = acceleratingBars();
  const spy = bars.map(b => ({ ...b, o: 500, h: 500.3, l: 499.8, c: 500.1 }));
  const f = buildIntradayFeatures({ todayBars: bars, priorSessions: [bars.map(b => ({ ...b, v: b.v / 2 }))], spyTodayBars: spy, now: NOW, dailyAtr: 2, plan: { entry: 100, stop: 98, target: 104 } });
  return { f, ev: intradayEv({ ticker: 'ABC', candidateDate: '2026-07-08', entry: 100, stop: 98, target: 104 }, f, { now: NOW, quote: { price: f.last, asOf: NOW } }) };
}

// ── 6. Residual naming consistent from calculation through training ──────────
test('6. every model feature is an OWN PROPERTY of the captured metrics (rename = failure)', () => {
  const { ev } = fullEv();
  const check = validateFeaturePresence(ev.metrics, MODEL_FEATURES);
  assert.deepEqual(check.missing, [], `metrics must carry every model feature; missing: ${check.missing.join(', ')}`);
  assert.equal(ev.metrics.schemaVersion, FEATURE_SCHEMA_VERSION, 'capture stamps the schema version');
});

test('6b. toModelRow aliases legacy residualVsSpy (PERCENT) to canonical residual15 (FRACTION)', () => {
  assert.equal(toModelRow({ residualVsSpy: 2.5 }).residual15, 0.025, 'legacy percent → fraction');
  assert.equal(toModelRow({ residual15: 0.01, residualVsSpy: 99 }).residual15, 0.01, 'canonical value wins when present');
  assert.equal(toModelRow({}).residual15, null, 'absent stays null — never a fabricated 0');
});

test('6c. survival training consumes the canonical schema (no divergent hand-kept list)', () => {
  assert.deepEqual(FEATURES, MODEL_FEATURES, 'survival FEATURES must BE the schema list');
  const rows = gradesToRows([{
    type: 'entry', decisionAt: '2026-07-08T14:00:00Z', ticker: 'A',
    features: { mom15: 0.01, residualVsSpy: 1.2, momAccel: null },
    outcome: { barrier: 'SUCCESS', netReturn: 0.004 }, ranking: { score: 50 },
  }]);
  assert.equal(rows[0].features.residual15, 0.012, 'legacy capture rows are aliased at training time');
  assert.equal(rows[0].features.momAccel, null, 'missing stays null into the model (indicators handle it)');
});

// ── 5. momAccel reaches the deterministic score and the immutable snapshot ───
test('5. momAccel flows: features → ev.metrics → card (score driver) → snapshot features', () => {
  const { ev } = fullEv();
  assert.ok(ev.metrics.momAccel != null && ev.metrics.momAccel > 0, 'accelerating fixture computes momAccel');
  const record = advanceLifecycle(null, { strategy: 'daytrade', ...ev });
  const card = buildCanonicalCard({ ticker: 'ABC', entry: 100, stop: 98, target: 104 }, ev, record, { now: NOW });
  assert.equal(card.momAccel, ev.metrics.momAccel, 'card exposes momAccel');
  assert.ok((card.runnerDrivers || []).some(d => /momentum accelerating/.test(d.label)),
    'the deterministic runner score actually consumed momAccel');
  const snap = buildSnapshot({ record, ev, pick: { ticker: 'ABC', atr: 2 } });
  assert.ok(snap.features.momAccel != null, 'immutable snapshot carries momAccel for training');
  assert.ok(snap.features.volAccel !== undefined, 'volume acceleration captured');
  assert.ok(snap.features.residual15 !== undefined, 'canonical residual captured');
});

// ── 7. Missing features are indicators, never genuine zeros ──────────────────
test('7. designRow separates "value is 0" from "value is missing"', () => {
  const rows = [{ features: { x: 1 } }, { features: { x: -1 } }, { features: { x: null } }];
  const { mean, std } = standardize(rows, ['x']);
  assert.equal(mean[0], 0, 'present-only mean (missing excluded, not zero-counted)');
  const presentZero = designRow({ x: 0 }, ['x'], mean, std);
  const missing = designRow({ x: null }, ['x'], mean, std);
  assert.equal(presentZero[1], 0, 'present value → missing flag 0');
  assert.equal(missing[0], 0, 'missing → value column neutral (training mean)');
  assert.equal(missing[1], 1, 'missing → indicator 1');
});

test('7b. the model LEARNS from missingness instead of silently zero-imputing', () => {
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push({ features: { x: 1 }, y: 1 });
  for (let i = 0; i < 50; i++) rows.push({ features: { x: -1 }, y: 0 });
  for (let i = 0; i < 40; i++) rows.push({ features: { x: null }, y: 1 });   // missing ⇒ mostly positive
  const model = trainLogistic(rows, ['x'], r => r.y, { iters: 800 });
  assert.ok(model, 'fits');
  assert.ok(model.missCoef && model.missCoef.length === 1, 'model carries missing-indicator weights');
  const pMissing = predictProba(model, { x: null });
  const pNeutral = predictProba(model, { x: 0 });
  assert.ok(pMissing > pNeutral, `missing carries its own signal (${pMissing.toFixed(3)} > ${pNeutral.toFixed(3)}) — not treated as x=0`);
});

test('7c. missingnessOf exposes per-feature flags for capture/UI', () => {
  const flags = missingnessOf({ mom15: 0.01, momAccel: null }, ['mom15', 'momAccel', 'volAccel']);
  assert.deepEqual(flags, { mom15: false, momAccel: true, volAccel: true });
});

// ── 16. Probability language stays hidden for uncalibrated/shadow scores ─────
test('16. deterministic and early-state outputs are labeled non-probabilistic; no promoted model', () => {
  const { SCORE_BASIS, activeModel } = require('../lib/runner-dud');
  assert.match(SCORE_BASIS, /not a probability/i);
  const am = activeModel();
  assert.equal(am.calibrated, false);
  assert.equal(am.promotionGate, 'not-passed');
  const { BASIS } = require('../lib/daytrade-early-state');
  assert.match(BASIS, /not a buy signal or probability/i);
  const { ev } = fullEv();
  const record = advanceLifecycle(null, { strategy: 'daytrade', ...ev });
  const card = buildCanonicalCard({ ticker: 'ABC', entry: 100, stop: 98, target: 104 }, ev, record, { now: NOW });
  assert.match(card.scoreBasis || '', /uncalibrated|not a probability/i, 'the card itself carries the disclaimer basis');
});

// ── Early-state annotations never leak into the actionable gate ───────────────
test('early states are watch-only: they cannot make a record actionable by themselves', () => {
  const { computeEarlyState } = require('../lib/daytrade-early-state');
  assert.equal(computeEarlyState({ f: null, discovery: { cusum: 12, z: 1 } }).state, 'PRIMED', 'alarm-level cusum without a shock = PRIMED');
  assert.equal(computeEarlyState({ f: null, discovery: { cusum: 12, z: 4 } }).state, 'IGNITION', 'a standardized shock = IGNITION');
  // A pick with ONLY discovery evidence (no fresh intraday bar/quote) stays non-actionable.
  const { classifyPool } = require('../lib/daytrade-actionability');
  const by = classifyPool([{ ticker: 'D1', source: 'discovery', scan: 'discovery', cusum: 12, z: 4, candidateDate: '2026-07-07' }], { now: NOW });
  assert.equal(by.D1.card.actionable, false, 'discovery evidence alone never yields buy language');
  assert.equal(by.D1.card.earlyState, 'IGNITION', 'but the research annotation is surfaced');
});

test('an extended name is disqualified from early states (late ≠ early)', () => {
  const { computeEarlyState } = require('../lib/daytrade-early-state');
  const out = computeEarlyState({ f: { extensionAtr: 4, mom5: 0.01, momAccel: 0.01, volAccel: 3, bars: 10, aboveVwap: true }, discovery: { cusum: 9, z: 3 } });
  assert.equal(out.state, null);
  assert.match(out.why[0] || '', /extended/i);
});
