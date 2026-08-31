'use strict';
// CONTRACT, REGISTRY & SCOREBOARD: record shapes, artifact compatibility, lineage, and the
// distinction between evaluation types that decides what may influence production.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/forecast/contract');
const REG = require('../lib/forecast/registry');
const SB = require('../lib/forecast/scoreboard');
const CFG = require('../lib/forecast/config');
const CAPS = require('../lib/forecast/capabilities');
const FX = require('./forecast-fixtures');

const cfg = FX.testConfig();

test('a usable forecast validates and carries its PIT stamps', () => {
  const f = C.makeForecast({
    ticker: 'AAA', horizon: 5, point: 0.01,
    quantiles: { 0.05: -0.03, 0.5: 0.01, 0.95: 0.05 },
    probabilities: { 0: 0.55 },
    pit: { asOf: '2024-01-05', tradableAt: '2024-01-08', labelStart: '2024-01-08', labelEnd: '2024-01-12', maxSourceTs: '2024-01-05' },
  });
  const v = C.validateForecast(f);
  assert.equal(v.valid, true, v.errors.join('; '));
  assert.equal(f.pit.marketTimezone, 'America/New_York');
  assert.equal(f.pit.session, 'regular');
  assert.ok(Object.isFrozen(f), 'records are immutable');
});

test('an UNUSABLE forecast can never carry a point estimate or quantiles', () => {
  const f = C.makeForecast({ ticker: 'AAA', horizon: 5, point: 0.01, quantiles: { 0.5: 0.01 }, probabilities: { 0: 0.9 }, availability: C.AVAILABILITY.PACKAGE_MISSING });
  assert.equal(f.point, null);
  assert.deepEqual(f.quantiles, {});
  assert.deepEqual(f.probabilities, {});
  assert.equal(C.validateForecast(f).valid, true);
});

test('out-of-range probabilities are dropped, never clamped into a plausible-looking number', () => {
  const f = C.makeForecast({ ticker: 'A', horizon: 1, point: 0, probabilities: { 0: 1.7, '0.03': -0.2, '0.05': 0.4 } });
  assert.deepEqual(Object.keys(f.probabilities), ['0.05']);
  assert.equal(f.probabilities['0.05'], 0.4);
});

test('quality flags default to the CONSERVATIVE value', () => {
  const q = C.makeQualityFlags({});
  assert.equal(q.survivorshipSafe, false);
  assert.equal(q.sectorBasisPointInTime, false);
  assert.equal(q.sectorKnown, false);
  assert.equal(q.suspectedCorporateAction, false);
});

test('validateForecast rejects a usable record with neither a point nor a quantile', () => {
  const bad = C.makeForecast({ ticker: 'A', horizon: 1, availability: C.AVAILABILITY.OK });
  const v = C.validateForecast(bad);
  assert.equal(v.valid, false);
  assert.match(v.errors.join(' '), /point estimate or at least one quantile/);
});

test('scored-row quantile keys match the Forecast key format exactly', () => {
  const q = { 0.05: -0.03, 0.1: -0.02, '0.50': 0, 0.9: 0.02, 0.95: 0.03 };
  const row = C.makeScoredRow({ ticker: 'A', horizon: 5, quantiles: q });
  const fc = C.makeForecast({ ticker: 'A', horizon: 5, point: 0, quantiles: q });
  assert.deepEqual(Object.keys(row.quantiles), Object.keys(fc.quantiles), 'one key format across every endpoint');
  assert.deepEqual(Object.keys(row.quantiles), ['0.05', '0.10', '0.50', '0.90', '0.95']);
  assert.equal(row.quantiles['0.10'], -0.02);
});

test('a scored row exposes score, uncertainty, availability and eligibility', () => {
  const r = C.makeScoredRow({
    ticker: 'AAA', horizon: 5, opportunityScore: 82, scoreStatus: 'uncalibrated-percentile',
    expectedResidualReturn: 0.012, probabilities: { 0: 0.6 }, componentAvailability: { ridge: 'ok', chronos2: 'package-missing' },
    modelWeights: { ridge: 1 }, eligible: true,
  });
  assert.equal(r.opportunityScore, 82);
  assert.equal(r.componentAvailability.chronos2, 'package-missing');
  assert.equal(r.evaluationType, 'live-prediction');
  assert.equal(r.eligible, true);
  assert.equal(C.makeScoredRow({}).eligible, false, 'eligibility defaults to false');
});

// ── configuration & reproducibility ─────────────────────────────────────────

test('the config hash changes when a setting changes and is stable otherwise', () => {
  const a = CFG.resolveConfig({});
  const b = CFG.resolveConfig({});
  assert.equal(a.configHash, b.configHash);
  const c = CFG.resolveConfig({ target: { betaLookback: 250 } });
  assert.notEqual(a.configHash, c.configHash);
});

test('the resolved config is deep-frozen so a consumer cannot mutate a run\'s settings', () => {
  const c = CFG.resolveConfig({});
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.target) && Object.isFrozen(c.models.ridge));
  assert.throws(() => { 'use strict'; c.seed = 1; }, TypeError);
});

test('stableStringify is order-independent so the hash does not depend on key order', () => {
  assert.equal(CFG.stableStringify({ a: 1, b: 2 }), CFG.stableStringify({ b: 2, a: 1 }));
});

// ── registry & artifact compatibility ───────────────────────────────────────

const caps = CAPS.detectCapabilities(cfg, {
  probeReport: { installed: true, python: 'p', pythonSource: 't', pythonVersion: '3.12.0', pythonVersionInfo: [3, 12], packages: { lightgbm: { available: true, version: '4.6.0' }, chronos: { available: false }, uni2ts: { available: false }, torch: { available: false } }, error: null },
});

test('a manifest hashes its content and records the runtime it actually ran on', () => {
  const m1 = REG.makeManifest({ runType: 'walk-forward', cfg, caps, dataCutoff: '2026-01-01' });
  const m2 = REG.makeManifest({ runType: 'walk-forward', cfg, caps, dataCutoff: '2026-01-01' });
  assert.equal(m1.manifestHash, m2.manifestHash, 'identical inputs give an identical manifest hash');
  const m3 = REG.makeManifest({ runType: 'walk-forward', cfg, caps, dataCutoff: '2026-02-01' });
  assert.notEqual(m1.manifestHash, m3.manifestHash);
  assert.equal(m1.runtime.node, process.version);
  assert.equal(m1.capabilities.metaBackend, 'lightgbm');
});

test('an artifact is REFUSED when the feature schema, target or config changed', () => {
  const keys = ['a', 'b', 'c'];
  const art = REG.makeArtifactRecord({ kind: 'model', model: 'ridge', horizon: 5, cfg, trainCutoff: '2025-01-01', dataCutoff: '2025-01-01', featureKeys: keys });
  assert.equal(REG.checkCompatibility(art, { cfg, horizon: 5, featureKeys: keys, dataCutoff: '2026-01-01' }).compatible, true);

  const changedSchema = REG.checkCompatibility(art, { cfg, horizon: 5, featureKeys: [...keys, 'd'], dataCutoff: '2026-01-01' });
  assert.equal(changedSchema.compatible, false);
  assert.match(changedSchema.mismatches.join(' '), /feature schema hash differs/);

  const otherTarget = CFG.resolveConfig({ target: { definition: 'market-relative-v1' } });
  const changedTarget = REG.checkCompatibility(art, { cfg: otherTarget, horizon: 5, featureKeys: keys });
  assert.equal(changedTarget.compatible, false);
  assert.match(changedTarget.mismatches.join(' '), /targetDefinition/);

  const wrongHorizon = REG.checkCompatibility(art, { cfg, horizon: 10, featureKeys: keys });
  assert.equal(wrongHorizon.compatible, false);
});

test('an artifact trained PAST the consumer cutoff is refused as a leak', () => {
  const art = REG.makeArtifactRecord({ kind: 'model', model: 'ridge', horizon: 5, cfg, trainCutoff: '2026-06-01', dataCutoff: '2026-06-01', featureKeys: ['a'] });
  const r = REG.checkCompatibility(art, { cfg, horizon: 5, featureKeys: ['a'], dataCutoff: '2026-01-01' });
  assert.equal(r.compatible, false);
  assert.match(r.mismatches.join(' '), /would leak future information/);
});

test('lineage records the calibrator status and the ensemble weights actually used', () => {
  const manifest = REG.makeManifest({ runType: 'inference', cfg, caps, dataCutoff: '2026-01-01' });
  const l = REG.lineageFor({
    manifest, fold: 'f3',
    models: { ridge: { artifactId: 'abc' } },
    weights: { weights: { ridge: 1 }, status: 'fallback', asOf: '2026-01-01' },
    calibrators: { 0: { status: 'calibrated', method: 'isotonic', n: 900, fittedThroughDate: '2025-12-01' } },
    scoreMapping: null,
  });
  assert.equal(l.manifestHash, manifest.manifestHash);
  assert.equal(l.ensembleWeights._status, 'fallback');
  assert.equal(l.calibrators['0'].status, 'calibrated');
});

// ── scoreboard ──────────────────────────────────────────────────────────────

test('the scoreboard rejects an unknown evaluation type', () => {
  assert.throws(() => SB.buildRow({ model: 'ridge', horizon: 5, fold: 'f0', evaluationType: 'made-up', predictions: [], cfg }), /unknown evaluationType/);
});

test('a scoreboard row separates IC, probability and backtest metrics by evaluation type', () => {
  const preds = Array.from({ length: 300 }, (_, i) => ({
    decisionDate: `D${Math.floor(i / 30)}`, labelEnd: `D${Math.floor(i / 30) + 1}`,
    score: (i % 30) / 30, actual: ((i % 30) / 30 - 0.5) * 0.02,
    probabilities: { 0: (i % 30) / 30, drawdown: 0.2 },
    classes: { 0: (i % 30) > 15 ? 1 : 0, '0.03': 0, '0.05': 0, drawdown: 0 },
    quantiles: { 0.1: -0.02, 0.5: 0, 0.9: 0.02 }, availability: 'ok',
  }));
  const row = SB.buildRow({ model: 'ridge', role: 'baseline', horizon: 5, fold: 'f0', evaluationType: 'walk-forward-oos', predictions: preds, cfg });
  assert.equal(row.evaluationType, 'walk-forward-oos');
  assert.ok(row.ic.meanRankIC > 0.9, 'a perfectly ordered score should have a near-1 rank IC');
  assert.ok(Number.isFinite(row.probability['0'].brier));
  assert.ok(row.quantileCoverage[0.5]);
  assert.equal(row.identity.targetDefinition, cfg.target.definition);
  assert.equal(row.identity.configHash, cfg.configHash);
});

test('per-date IC series is retained so folds can be POOLED with a dependence-aware interval', () => {
  const mkFold = (fold, offset) => SB.buildRow({
    model: 'ridge', role: 'baseline', horizon: 5, fold, evaluationType: 'walk-forward-oos', cfg,
    withBreakdowns: true,
    predictions: Array.from({ length: 40 * 12 }, (_, i) => {
      const d = offset + Math.floor(i / 12);
      const k = i % 12;
      return {
        decisionDate: `2024-${String(1 + Math.floor(d / 28)).padStart(2, '0')}-${String(1 + (d % 28)).padStart(2, '0')}`,
        labelEnd: '2024-12-31', score: k, actual: k * 0.001,
        sector: k % 2 ? 'Technology' : 'Energy', adv: k < 6 ? 1e6 : 5e7,
      };
    }),
  });
  const board = SB.makeScoreboard([mkFold('f0', 0), mkFold('f1', 40)]);
  assert.ok(board.rows[0].icPerDate.length > 10, 'the per-date series must be kept');

  const u = SB.pooledIcUncertainty(board, { model: 'ridge', horizon: 5 });
  assert.ok(u, 'a pooled interval should be produced from two folds of dates');
  assert.equal(u.folds, 2);
  assert.ok(u.dates > board.rows[0].icPerDate.length, 'pooling must concatenate the folds, not average them');
  assert.ok(Array.isArray(u.bootstrapCi90) && u.bootstrapCi90[0] <= u.bootstrapCi90[1]);
  assert.match(u.method, /moving-block bootstrap/);

  assert.ok(board.rows[0].breakdowns.sector.Technology, 'sector breakdown present');
  assert.ok(board.rows[0].breakdowns.liquidity.micro || board.rows[0].breakdowns.liquidity.mega, 'liquidity breakdown present');
  assert.ok(board.rows[0].breakdowns.year['2024'], 'year breakdown present');
});

test('a breakdown bucket with too few dates reports its size and a NULL estimate', () => {
  const M = require('../lib/forecast/metrics');
  const rows = [];
  for (let d = 0; d < 30; d++) for (let i = 0; i < 10; i++) rows.push({ decisionDate: `D${d}`, score: i, actual: i, tag: 'big' });
  for (let i = 0; i < 10; i++) rows.push({ decisionDate: 'D0', score: i, actual: i, tag: 'tiny' });
  const b = M.breakdown(rows, (r) => r.tag, { minDates: 10 });
  assert.ok(Number.isFinite(b.big.meanRankIC));
  assert.equal(b.tiny.meanRankIC, null);
  assert.equal(b.tiny.n, 10, 'the thin bucket is reported, not silently dropped');
  assert.match(b.tiny.note, /fewer than 10 usable dates/);
});

test('the compare table groups by model and horizon at ONE evaluation type', () => {
  const mk = (model, evaluationType) => SB.buildRow({
    model, role: 'x', horizon: 5, fold: 'f0', evaluationType, cfg,
    predictions: Array.from({ length: 60 }, (_, i) => ({ decisionDate: `D${Math.floor(i / 20)}`, labelEnd: 'D9', score: i, actual: i })),
  });
  const board = SB.makeScoreboard([mk('ridge', 'walk-forward-oos'), mk('meta-ranker', 'walk-forward-oos'), mk('ridge', 'final-holdout')]);
  const oos = SB.compare(board, { evaluationType: 'walk-forward-oos' });
  assert.equal(oos.length, 2);
  assert.deepEqual(oos.map((r) => r.model).sort(), ['meta-ranker', 'ridge']);
  assert.equal(SB.compare(board, { evaluationType: 'final-holdout' }).length, 1);
  assert.equal(board.counts['walk-forward-oos'], 2);
  assert.equal(board.counts['final-holdout'], 1);
});
