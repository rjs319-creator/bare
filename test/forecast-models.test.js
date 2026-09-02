'use strict';
// MODELS: the permanent Ridge/AR baseline, quantile shapes and monotonicity, probability bounds,
// calibration, capability detection, the fallback hierarchy, and how optional components fail.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/forecast/ridge');
const Q = require('../lib/forecast/quantiles');
const CAL = require('../lib/forecast/calibration');
const CAPS = require('../lib/forecast/capabilities');
const CONTRACT = require('../lib/forecast/contract');
const CHRONOS = require('../lib/forecast/chronos-adapter');
const MOIRAI = require('../lib/forecast/moirai-adapter');
const BM = require('../lib/forecast/base-models');
const FX = require('./forecast-fixtures');

const cfg = FX.testConfig();

function linearRows(n, seed = 5) {
  const rnd = FX.rng(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const a = rnd() * 2 - 1, b = rnd() * 2 - 1, vol21 = rnd();
    rows.push({
      decisionDate: `2024-01-${String(1 + (i % 28)).padStart(2, '0')}`,
      features: { a, b, vol21 },
      label: { residualReturn: 0.03 * a - 0.01 * b + (rnd() - 0.5) * 0.01 },
    });
  }
  return rows;
}

test('the ridge baseline recovers a known linear signal', () => {
  const m = R.fitRidge(linearRows(800), ['a', 'b', 'vol21'], cfg, { horizon: 5 });
  assert.equal(m.fitted, true);
  const up = R.predictPoint(m, { features: { a: 1, b: 0, vol21: 0.5 } });
  const down = R.predictPoint(m, { features: { a: -1, b: 0, vol21: 0.5 } });
  assert.ok(up > down, 'the sign of the dominant feature must be recovered');
  assert.ok(Math.abs(up - 0.03) < 0.01, `expected ~0.03, got ${up}`);
});

test('the ridge baseline is deterministic across refits', () => {
  const rows = linearRows(500, 9);
  const a = R.fitRidge(rows, ['a', 'b', 'vol21'], cfg, { horizon: 5 });
  const b = R.fitRidge(rows, ['a', 'b', 'vol21'], cfg, { horizon: 5 });
  const row = { features: { a: 0.3, b: -0.2, vol21: 0.4 } };
  assert.equal(R.predictPoint(a, row), R.predictPoint(b, row));
});

test('too little training data refuses to fit rather than fitting noise', () => {
  const m = R.fitRidge(linearRows(20), ['a', 'b', 'vol21'], cfg, { horizon: 5 });
  assert.equal(m.fitted, false);
  assert.match(m.reason, /insufficient training rows/);
});

test('an unfitted baseline returns an UNAVAILABLE forecast with no point estimate', () => {
  const m = R.fitRidge(linearRows(20), ['a', 'b', 'vol21'], cfg, { horizon: 5 });
  const f = R.forecast(m, { ticker: 'X', features: { a: 0, b: 0, vol21: 0.5 } }, cfg);
  assert.equal(f.point, null, 'a model that could not fit must not emit a number');
  assert.equal(f.availability, CONTRACT.AVAILABILITY.INSUFFICIENT_HISTORY);
  assert.equal(CONTRACT.validateForecast(f).valid, true);
});

test('baseline quantiles are non-decreasing and bracket the point estimate', () => {
  const m = R.fitRidge(linearRows(1200), ['a', 'b', 'vol21'], cfg, { horizon: 5 });
  const f = R.forecast(m, { ticker: 'X', features: { a: 0.5, b: 0.1, vol21: 0.6 } }, cfg);
  const levels = Object.keys(f.quantiles).map(Number).sort((x, y) => x - y);
  assert.deepEqual(levels, [...cfg.quantiles], 'every configured level is produced');
  for (let i = 1; i < levels.length; i++) {
    assert.ok(f.quantiles[levels[i].toFixed(2)] >= f.quantiles[levels[i - 1].toFixed(2)], 'quantiles must not decrease');
  }
  assert.ok(f.quantiles['0.05'] <= f.point && f.point <= f.quantiles['0.95']);
  assert.ok(f.intervalWidth80 > 0);
});

test('baseline threshold probabilities are in [0,1] and monotone in the threshold', () => {
  const m = R.fitRidge(linearRows(1200), ['a', 'b', 'vol21'], cfg, { horizon: 5 });
  const f = R.forecast(m, { ticker: 'X', features: { a: 0.2, b: 0, vol21: 0.5 } }, cfg);
  const p0 = f.probabilities['0'], p3 = f.probabilities['0.03'], p5 = f.probabilities['0.05'];
  for (const p of [p0, p3, p5]) assert.ok(p >= 0 && p <= 1, `probability out of range: ${p}`);
  assert.ok(p0 >= p3 && p3 >= p5, 'P(r>0) >= P(r>3%) >= P(r>5%)');
  assert.equal(f.probabilityStatus, 'uncalibrated-empirical-residual', 'the mapping is named, not implied');
});

test('isotonic repair produces the nearest non-decreasing quantile vector', () => {
  const { values, repaired } = Q.isotonicIncreasing([1, 3, 2, 5, 4]);
  assert.equal(repaired, true);
  for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1]);
  const clean = Q.isotonicIncreasing([1, 2, 3]);
  assert.equal(clean.repaired, false);
  assert.deepEqual(clean.values, [1, 2, 3]);
});

test('CDF interpolation gives sane, monotone survival probabilities including in the tails', () => {
  const qs = { 0.05: -0.05, 0.25: -0.01, 0.5: 0.0, 0.75: 0.02, 0.95: 0.06 };
  assert.ok(Math.abs(Q.survivalFromQuantiles(qs, 0) - 0.5) < 1e-9, 'the median maps to 0.5');
  assert.ok(Math.abs(Q.survivalFromQuantiles(qs, 0.02) - 0.25) < 1e-9);
  const far = Q.survivalFromQuantiles(qs, 0.5);
  assert.ok(far > 0 && far < 0.01, 'a threshold far beyond the top quantile decays, it does not snap to 0');
  const low = Q.survivalFromQuantiles(qs, -0.5);
  assert.ok(low > 0.99 && low <= 1);
  let prev = 1;
  for (const t of [-0.06, -0.02, 0, 0.02, 0.06, 0.1]) {
    const p = Q.survivalFromQuantiles(qs, t);
    assert.ok(p <= prev + 1e-12, 'survival must be non-increasing in the threshold');
    prev = p;
  }
});

test('quantile coverage reports the empirical-vs-nominal gap', () => {
  const rnd = FX.rng(3);
  const pairs = Array.from({ length: 4000 }, () => {
    const a = (rnd() - 0.5) * 2;
    return { actual: a, quantiles: { 0.1: -0.8, 0.5: 0, 0.9: 0.8 } };
  });
  const cov = Q.coverage(pairs, [0.1, 0.5, 0.9]);
  assert.ok(Math.abs(cov[0.5].empirical - 0.5) < 0.05);
  assert.ok(cov[0.9].empirical > cov[0.1].empirical);
  assert.ok(Number.isFinite(cov[0.5].pinball));
});

test('calibration refuses to claim calibration on a thin or single-class sample', () => {
  const thin = CAL.fit(Array.from({ length: 50 }, (_, i) => ({ x: i / 50, y: i % 2, date: 'd' })), cfg, { sourceEvaluationType: 'cross-fitted' });
  assert.equal(thin.status, CAL.STATUS.INSUFFICIENT_DATA);
  assert.equal(thin.apply(0.7), 0.7, 'the fallback is an explicit pass-through, not a fabricated probability');

  const oneClass = CAL.fit(Array.from({ length: 600 }, (_, i) => ({ x: i / 600, y: 0, date: 'd' })), cfg, { sourceEvaluationType: 'cross-fitted' });
  assert.equal(oneClass.status, CAL.STATUS.DEGENERATE);
});

test('isotonic calibration recovers a known miscalibration', () => {
  const rnd = FX.rng(17);
  const pairs = Array.from({ length: 4000 }, () => { const x = rnd(); return { x, y: rnd() < x * x ? 1 : 0, date: 'd' }; });
  const cal = CAL.fit(pairs, cfg, { sourceEvaluationType: 'cross-fitted', label: 'up' });
  assert.equal(cal.status, CAL.STATUS.CALIBRATED);
  for (const x of [0.2, 0.5, 0.8]) {
    assert.ok(Math.abs(cal.apply(x) - x * x) < 0.12, `calibrated ${x} -> ${cal.apply(x)} vs true ${x * x}`);
  }
  const p = cal.apply(0.5);
  assert.ok(p > 0 && p < 1, 'calibrated probabilities stay strictly inside (0,1)');
});

test('Platt calibration is available and monotone', () => {
  const rnd = FX.rng(19);
  const pairs = Array.from({ length: 3000 }, () => { const x = rnd() * 4 - 2; return { x, y: rnd() < 1 / (1 + Math.exp(-x)) ? 1 : 0, date: 'd' }; });
  const cal = CAL.fit(pairs, cfg, { method: 'platt', sourceEvaluationType: 'validation' });
  assert.equal(cal.status, CAL.STATUS.CALIBRATED);
  assert.ok(cal.apply(-1) < cal.apply(0) && cal.apply(0) < cal.apply(1));
});

test('date-constant columns are excluded from the within-date model matrix', () => {
  const XS = require('../lib/forecast/xsection');
  const FEAT = require('../lib/forecast/features');
  const model = XS.modelFeatureKeys();
  const all = XS.expandedFeatureKeys();
  // A column identical for every name on a date cannot change a within-date ordering, but a tree
  // can split on it to fit date means. Measured: 5 of the top 6 gains in the first LightGBM
  // meta-ranker were date-constant, and its OOS rank IC was reliably negative.
  for (const k of [...FEAT.DATE_CONSTANT_KEYS, ...XS.DATE_CONSTANT_CONTEXT_KEYS]) {
    assert.ok(all.includes(k), `${k} should still exist on the row`);
    assert.ok(!model.includes(k), `${k} is date-constant and must not reach the model matrix`);
  }
  // …but the context columns that DO vary within a date are kept.
  assert.ok(model.includes('ctxSectorRet21'), 'sector-level context varies within a date');
  assert.ok(model.includes('ctxRelToSector21'), 'name-vs-sector context varies within a date');
  assert.equal(XS.modelFeatureKeys({ includeDateConstant: true }).length, all.length, 'the exclusion is reversible by config');
});

test('the two pre-declared features exist and refuse to be proxied on short history', () => {
  const FEAT = require('../lib/forecast/features');
  assert.ok(FEAT.FEATURE_KEYS.includes('dist52wHigh'));
  assert.ok(FEAT.FEATURE_KEYS.includes('residMomVolAdj21'));
  const panel = FX.buildPanel({ sessions: 400, names: 3, seed: 71 });
  const entry = panel.dataset.get('SYN00');
  const DS = require('../lib/forecast/dataset');
  const full = FEAT.computeFeatures(entry.candles, 350, { benchReturns: DS.returnMapAsOf(panel.bench.candles, 350, 300), betaMarket: 1 });
  assert.ok(Number.isFinite(full.values.dist52wHigh) && full.values.dist52wHigh <= 0, 'a close is never above its own 52-week high');
  assert.ok(Number.isFinite(full.values.residMomVolAdj21));
  const short = FEAT.computeFeatures(entry.candles, 150, {});
  assert.equal(short.values.dist52wHigh, null, 'without a year of bars it is null, not a shorter-window proxy');
});

test('the ridge-rank arm fits the WITHIN-DATE z-scored target and is ranking-only', () => {
  const rows = [];
  const rnd = FX.rng(23);
  for (let d = 0; d < 40; d++) {
    const date = `2024-01-${String(1 + (d % 28)).padStart(2, '0')}`;
    // One date each week is 100x more volatile: a raw-target fit is dominated by it, a
    // within-date z-scored fit is not. That is the whole point of this arm.
    const scale = d % 7 === 0 ? 1 : 0.01;
    for (let i = 0; i < 30; i++) {
      const a = rnd() * 2 - 1;
      rows.push({ decisionDate: date, features: { a, b: rnd(), vol21: rnd() }, label: { residualReturn: scale * (0.05 * a + (rnd() - 0.5) * 0.02) } });
    }
  }
  const raw = R.fitRidge(rows, ['a', 'b', 'vol21'], cfg, { horizon: 5 });
  const ranked = R.fitRidgeRank(rows, ['a', 'b', 'vol21'], cfg, { horizon: 5 });
  assert.equal(ranked.fitted, true);
  assert.equal(ranked.targetBasis, 'within-date-z-scored-residual');
  assert.equal(ranked.rankingOnly, true, 'a z-score is not an expected return and must be flagged');

  // Both should find the sign of `a`; the z-scored fit should not be swamped by the loud dates.
  const up = (m) => R.predictPoint(m, { features: { a: 1, b: 0.5, vol21: 0.5 } });
  const dn = (m) => R.predictPoint(m, { features: { a: -1, b: 0.5, vol21: 0.5 } });
  assert.ok(up(ranked) > dn(ranked), 'the z-scored fit must recover the signal');
  assert.ok(up(raw) > dn(raw));
  const sep = (m) => (up(m) - dn(m)) / Math.max(1e-12, Math.abs(m.sigma));
  assert.ok(sep(ranked) > sep(raw), 'standardizing within date should sharpen the signal against its own noise');
});

// ── capability detection & the fallback hierarchy ────────────────────────────

// Capability tests must enable the optional models — the tiny fixture config deliberately runs
// baseline-only, and a model disabled by CONFIG is a different state from one that cannot run.
const capsCfg = FX.testConfig({ models: { enabled: ['ridge', 'chronos2', 'moirai2'] } });

const probeWith = (pkgs, py = [3, 12]) => ({
  installed: true, python: '/fake/python', pythonSource: 'test', pythonVersion: py.join('.'),
  pythonVersionInfo: py, packages: pkgs, error: null,
});
const pkg = (available, version = null) => ({ available, version });

test('the fallback hierarchy resolves every tier from a probe report', () => {
  const all = probeWith({ chronos: pkg(true, '2.1.0'), uni2ts: pkg(true, '1.3.0'), lightgbm: pkg(true, '4.6.0'), torch: pkg(true, '2.4.0') });
  assert.equal(CAPS.detectCapabilities(capsCfg, { probeReport: all }).tier, 1);

  const noMoirai = probeWith({ chronos: pkg(true, '2.1.0'), uni2ts: pkg(false), lightgbm: pkg(true, '4.6.0'), torch: pkg(true, '2.4.0') });
  assert.equal(CAPS.detectCapabilities(capsCfg, { probeReport: noMoirai }).tier, 2);

  const noChronos = probeWith({ chronos: pkg(false), uni2ts: pkg(true, '1.3.0'), lightgbm: pkg(true, '4.6.0'), torch: pkg(true, '2.4.0') });
  assert.equal(CAPS.detectCapabilities(capsCfg, { probeReport: noChronos }).tier, 3);

  const lgbmOnly = probeWith({ chronos: pkg(false), uni2ts: pkg(false), lightgbm: pkg(true, '4.6.0'), torch: pkg(false) });
  const t4 = CAPS.detectCapabilities(capsCfg, { probeReport: lgbmOnly });
  assert.equal(t4.tier, 4);
  assert.equal(t4.metaBackend, 'lightgbm');

  const nothing = probeWith({ chronos: pkg(false), uni2ts: pkg(false), lightgbm: pkg(false), torch: pkg(false) });
  const t5 = CAPS.detectCapabilities(capsCfg, { probeReport: nothing });
  assert.equal(t5.tier, 5);
  assert.equal(t5.metaBackend, 'ridge-xs');
  assert.deepEqual(t5.baseModels, ['ridge'], 'the ridge baseline is always available');
});

test('CHRONOS 1.x IS NOT SUBSTITUTED FOR CHRONOS-2', () => {
  const wrongGen = probeWith({ chronos: pkg(true, '1.5.3'), uni2ts: pkg(false), lightgbm: pkg(true, '4.6.0'), torch: pkg(true, '2.4.0') });
  const caps = CAPS.detectCapabilities(capsCfg, { probeReport: wrongGen });
  assert.equal(caps.components.chronos2.available, false);
  assert.equal(caps.components.chronos2.availability, CONTRACT.AVAILABILITY.INCOMPATIBLE_VERSION);
  assert.match(caps.components.chronos2.reason, /different model generation/);
  assert.equal(caps.tier, 4, 'the run falls back rather than pretending Chronos-1 is Chronos-2');
});

test('an old interpreter is reported as the reason, not as a bare missing package', () => {
  const old = probeWith({ chronos: pkg(false), uni2ts: pkg(false), lightgbm: pkg(true, '4.6.0'), torch: pkg(false) }, [3, 9, 6]);
  const caps = CAPS.detectCapabilities(capsCfg, { probeReport: old });
  assert.match(caps.components.chronos2.reason, /python 3\.9\.6 < 3\.10/);
  assert.ok(CAPS.setupHints(caps).some((h) => /Python >= 3\.10/.test(h)), 'the setup hint is actionable');
});

test('a foundation model without torch is unavailable, not silently degraded', () => {
  const noTorch = probeWith({ chronos: pkg(true, '2.1.0'), uni2ts: pkg(false), lightgbm: pkg(true, '4.6.0'), torch: pkg(false) });
  const caps = CAPS.detectCapabilities(capsCfg, { probeReport: noTorch });
  assert.equal(caps.components.chronos2.available, false);
  assert.match(caps.components.chronos2.reason, /torch is not/);
});

test('an unavailable foundation adapter returns a reason for EVERY row and no numbers', () => {
  const panel = FX.buildPanel({ sessions: 300, names: 5, seed: 51 });
  const date = panel.sessions[250];
  const rows = [...panel.dataset.keys()].map((t) => ({ ticker: t, securityId: t, decisionDate: date, betaMarket: 1 }));
  const caps = CAPS.detectCapabilities(capsCfg, { probeReport: probeWith({ chronos: pkg(false), uni2ts: pkg(false), lightgbm: pkg(false), torch: pkg(false) }) });

  for (const adapter of [CHRONOS, MOIRAI]) {
    const res = adapter.forecastBatch({ rows, panel, cfg: capsCfg, caps, horizon: 5 });
    assert.equal(res.size, rows.length, 'every requested row gets an answer');
    for (const f of res.values()) {
      assert.equal(f.point, null, 'no point estimate is invented');
      assert.equal(Object.keys(f.quantiles).length, 0);
      assert.ok(f.availabilityReason, 'the reason is always stated');
      assert.equal(CONTRACT.isUsable(f.availability), false);
    }
  }
});

test('fixture mode produces usable forecasts that are STAMPED synthetic', () => {
  const panel = FX.buildPanel({ sessions: 320, names: 5, seed: 53 });
  const date = panel.sessions[280];
  const rows = [...panel.dataset.keys()].map((t) => ({ ticker: t, securityId: t, decisionDate: date, betaMarket: 1 }));
  const caps = CAPS.detectCapabilities(capsCfg, { probeReport: probeWith({ chronos: pkg(false), uni2ts: pkg(false), lightgbm: pkg(false), torch: pkg(false) }) });
  const res = CHRONOS.forecastBatch({ rows, panel, cfg: capsCfg, caps, horizon: 5, fixture: 'auto' });
  const f = res.get(rows[0].ticker);
  assert.ok(Number.isFinite(f.point));
  assert.ok(f.model.modelId.startsWith('fixture:'), 'a fixture can never be mistaken for a real checkpoint');
  assert.ok(f.capabilityNotes.some((n) => /SYNTHETIC FIXTURE|synthetic-fixture/.test(n)));
  const levels = Object.keys(f.quantiles).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < levels.length; i++) {
    assert.ok(f.quantiles[levels[i].toFixed(2)] >= f.quantiles[levels[i - 1].toFixed(2)]);
  }
});

test('activeBaseModels always includes the permanent baseline and nothing unavailable', () => {
  const none = CAPS.detectCapabilities(capsCfg, { probeReport: probeWith({ chronos: pkg(false), uni2ts: pkg(false), lightgbm: pkg(false), torch: pkg(false) }) });
  assert.deepEqual(BM.activeBaseModels(capsCfg, none).map((m) => m.name), ['ridge']);

  const cfgAll = FX.testConfig({ models: { enabled: ['ridge', 'chronos2', 'moirai2'] } });
  const all = CAPS.detectCapabilities(cfgAll, { probeReport: probeWith({ chronos: pkg(true, '2.1.0'), uni2ts: pkg(true, '1.3.0'), lightgbm: pkg(true, '4.6.0'), torch: pkg(true, '2.4.0') }) });
  assert.deepEqual(BM.activeBaseModels(cfgAll, all).map((m) => m.name), ['ridge', 'chronos2', 'moirai2']);
  assert.equal(BM.activeBaseModels(cfgAll, all)[1].requiresFit, false, 'the foundation models are zero-shot');
  assert.equal(BM.activeBaseModels(cfgAll, all)[0].requiresFit, true, 'the ridge baseline is fitted per fold');
});
