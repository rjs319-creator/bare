'use strict';
// END-TO-END PIPELINE on a synthetic panel with a PLANTED, KNOWN signal.
//
// This is the test that would catch a wiring mistake no unit test can see: cross-fitting feeding
// the wrong frames to the stack, the score losing its ordering, the fallback hierarchy silently
// collapsing, or a "signal" that survives having its labels shuffled.
//
// It runs at the repository's real fallback tier (whatever this machine can actually do) and
// additionally with FIXTURE foundation models, so the multi-model paths are exercised offline.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/forecast');
const FX = require('./forecast-fixtures');

const cfg = FX.testConfig({
  walkforward: { minTrainSessions: 70, testSessions: 30, innerFolds: 3, holdoutFraction: 0.2, scheme: 'expanding' },
});
const caps = F.capabilities.detectCapabilities(cfg);

// One shared build — the pipeline tests are the slowest in this suite.
const panel = FX.buildPanel({ sessions: 700, names: 45, seed: 101, plantedAlpha: true });
const STRIDE = 2;
const decisionDates = panel.sessions.filter((_, i) => i % STRIDE === 0 && i >= 130 && i < panel.sessions.length - 15);
const built = F.dataset.buildPanelRows({ panel, dates: decisionDates, cfg });
const rows5 = built.rowsByHorizon.get(5);

test('lib/forecast contains NO research-data reads — the isolation invariant is honoured', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'lib', 'forecast');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    // A require that escapes lib/ into the repo-root research/ tree would reintroduce the
    // coupling test/research-isolation.test.js exists to prevent. `../research/...` is
    // lib/research/ — the app-side research harness — and is fine; `../../research/...` is not.
    const req = src.match(/require\((['"])\.\.\/\.\.\/research\/[^'"]*\1\)/g);
    if (req) offenders.push(`${name}: ${req.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `lib/forecast must stay free of research-side requires:\n${offenders.join('\n')}`);
  assert.equal(typeof F.panel.loadPanel, 'undefined', 'the filesystem loader belongs on the research side');
  assert.equal(typeof require('../research/lib/forecast-panel').loadPanel, 'function');
});

test('the panel builds labelled rows for every horizon with plausible universe sizes', () => {
  for (const h of cfg.horizons) assert.ok((built.rowsByHorizon.get(h) || []).length > 1000, `horizon ${h} produced too few rows`);
  assert.ok(built.universeSizes.every((u) => u.size > 20));
});

test('walk-forward runs, every fold passes the leakage audit, and the arms are all present', () => {
  const res = F.walkforward.runHorizon({
    horizon: 5, rows: rows5, featureKeys: built.featureKeys, cfg, caps, panel,
    decisionDates, sessions: panel.sessions, stride: STRIDE,
  });
  assert.ok(res.folds.length >= 2, `expected multiple folds, got ${res.folds.length}`);
  assert.equal(res.auditOk, true, `leakage audit failed: ${JSON.stringify(res.audits)}`);

  const board = F.scoreboard.makeScoreboard(res.scoreboardRows);
  const models = new Set(board.rows.map((r) => r.model));
  for (const m of ['ridge', 'meta-ranker', 'static-ensemble', 'dynamic-ensemble', 'control-random', 'control-shuffled-label', 'control-delayed-signal']) {
    assert.ok(models.has(m), `arm "${m}" is missing from the scoreboard`);
  }
  assert.equal(board.counts['walk-forward-oos'], board.rows.length, 'every fold row is stamped walk-forward OOS');

  const cmp = F.scoreboard.compare(board);
  const by = Object.fromEntries(cmp.map((r) => [r.model, r]));

  // THE PLANTED SIGNAL MUST BE FOUND, and the controls must not find it.
  assert.ok(by.ridge.meanRankIC > 0.05, `the baseline missed a planted reversal signal: rankIC=${by.ridge.meanRankIC}`);
  assert.ok(by['control-random'].meanRankIC < by.ridge.meanRankIC / 3, 'the random control must not rival the model');
  assert.ok(by['control-shuffled-label'].meanRankIC < by.ridge.meanRankIC / 3, 'SHUFFLED LABELS MUST NOT PRODUCE AN EDGE — this failing means leakage');
  assert.ok(Math.abs(by['control-random'].meanRankIC) < 0.05);

  // Cost accounting must actually reduce the result.
  for (const r of cmp) {
    if (Number.isFinite(r.grossSharpe) && Number.isFinite(r.netSharpe)) {
      assert.ok(r.netSharpe < r.grossSharpe, `${r.model}: net must be below gross`);
    }
  }
});

test('every base forecast inherits its row\'s point-in-time stamps', () => {
  const rows = rows5.filter((r) => r.decisionDate >= decisionDates[0] && r.decisionDate <= decisionDates[120]);
  const axis = F.folds.buildAxis(panel.sessions);
  const cf = F.crossfit.crossFitBase({
    trainRows: rows, featureKeys: built.featureKeys, cfg, caps, panel, horizon: 5, axis,
  });
  assert.ok(cf.frames.length > 0);
  for (const frame of cf.frames.slice(0, 50)) {
    const b = frame.base.ridge;
    if (!b) continue;
    assert.equal(b.pit.asOf, frame.decisionDate, 'the forecast must carry the row\'s as-of date');
    assert.ok(b.pit.maxSourceTs && b.pit.maxSourceTs <= frame.decisionDate, 'and its provable source cutoff');
    assert.equal(F.contract.validateForecast(b).valid, true);
  }
});

test('frames carry the execution context, so costs are charged at the RIGHT tier', () => {
  // REGRESSION. Frames once dropped `adv`/`price`, so every downstream cost lookup fell to the
  // most expensive ("micro", 1.5% round trip) tier — a ~9x over-charge against this liquid
  // universe that made every after-cost number wrong. The frame must carry what the cost model
  // needs; it may not rely on the caller still holding the row.
  const BT = require('../lib/forecast/backtest');
  const rows = rows5.filter((r) => r.decisionDate <= decisionDates[120]);
  const axis = F.folds.buildAxis(panel.sessions);
  const cf = F.crossfit.crossFitBase({ trainRows: rows, featureKeys: built.featureKeys, cfg, caps, panel, horizon: 5, axis });
  assert.ok(cf.frames.length > 0);
  for (const f of cf.frames.slice(0, 100)) {
    assert.ok(Number.isFinite(f.adv) && f.adv > 0, `frame ${f.rowKey} lost its dollar volume`);
    assert.ok(Number.isFinite(f.price) && f.price > 0, `frame ${f.rowKey} lost its price`);
    assert.notEqual(BT.costFor({ adv: f.adv }).tier, 'micro', 'a liquid fixture name must not be charged the micro tier');
  }
  // …and the arm predictions must pass that context through to the backtest.
  const preds = F.arms.armPredictions(cf.frames.slice(0, 50), (fr) => fr.features.ret5);
  assert.ok(preds.every((p) => Number.isFinite(p.adv)), 'arm predictions must carry adv for the cost model');
});

test('the meta-ranker tunes on CHRONOLOGICAL INNER VALIDATION, never the test block', () => {
  const META = F.metaRanker;
  const frames = [];
  for (let d = 0; d < 60; d++) {
    const date = `2024-${String(1 + Math.floor(d / 28)).padStart(2, '0')}-${String(1 + (d % 28)).padStart(2, '0')}`;
    for (let i = 0; i < 20; i++) {
      frames.push({
        rowKey: `T${i}|${date}`, ticker: `T${i}`, decisionDate: date, horizon: 5,
        features: { ret5: i / 20 }, base: {}, label: { residualReturn: i / 1000, labelEnd: date },
      });
    }
  }
  const split = META.innerValidationSplit(frames, { validFraction: 0.25 });
  assert.ok(split, 'a 60-date history must be splittable');
  assert.ok(split.validStart > split.train[split.train.length - 1].decisionDate, 'validation is strictly later than training');
  for (const r of split.train) {
    assert.ok(r.label.labelEnd < split.validStart, 'a training label that is still open at the boundary must be purged');
  }
  assert.ok(split.valid.every((r) => r.decisionDate >= split.validStart));
  assert.equal(META.innerValidationSplit(frames.slice(0, 40), { validFraction: 0.25, minTrainDates: 100 }), null, 'too short to split honestly returns null rather than improvising');

  // lambdarank must cover the whole group, not a 30-name head — the truncation was the defect.
  const p = META.paramsFor(cfg, 'lambdarank', 900);
  assert.ok(p.lambdarank_truncation_level >= 900, `truncation ${p.lambdarank_truncation_level} still optimizes only a head`);
  assert.equal(META.paramsFor(cfg, 'regression', 900).lambdarank_truncation_level, undefined);
});

test('the meta-ranker ABSTAINS when inner validation shows no edge over the baseline', () => {
  const META = F.metaRanker;
  const caps4 = F.capabilities.detectCapabilities(cfg);
  if (!caps4.components.lightgbm.available) return;   // gate is a LightGBM-path behaviour

  // Frames whose features carry NO information about the label, but whose baseline column
  // (`ens_point`) is a perfect predictor. Any honest meta-ranker must fail to beat that baseline
  // on inner validation and stand down.
  const rnd = FX.rng(97);
  const frames = [];
  for (let d = 0; d < 90; d++) {
    const date = `2024-${String(1 + Math.floor(d / 28)).padStart(2, '0')}-${String(1 + (d % 28)).padStart(2, '0')}`;
    for (let i = 0; i < 40; i++) {
      const y = rnd() - 0.5;
      frames.push({
        rowKey: `T${i}|${date}`, ticker: `T${i}`, decisionDate: date, horizon: 5,
        features: { noise1: rnd(), noise2: rnd(), noise3: rnd() },
        base: { ridge: { availability: 'ok', point: y, intervalWidth80: 0.04, downsideTail: -0.02, upsideTail: 0.02, sigma: 0.01 } },
        label: { residualReturn: y, labelEnd: date },
        evaluationType: 'cross-fitted', producedByModelTrainedThrough: '2023-12-31',
      });
    }
  }
  const r = META.fitAndScore({
    trainFrames: frames, predictFrames: frames.slice(0, 200), baseNames: ['ridge'],
    featureKeys: ['noise1', 'noise2', 'noise3'], cfg, caps: caps4, id: 'gate-test',
    ensembleWeights: { ridge: 1 },
  });
  assert.equal(r.ok, false, 'a model that cannot beat a perfect baseline must not rank');
  assert.equal(r.abstained, true, 'standing down is a DECISION, not a failure');
  assert.match(r.reason, /incremental value over the baseline/);
  const gate = r.innerValidation.gate;
  assert.ok(Number.isFinite(gate.baselineMeanRankIC) && gate.baselineMeanRankIC > 0.9, 'the baseline column really is near-perfect here');
  assert.ok(gate.edgeOverBaseline < 0, 'the candidate is measured AGAINST the baseline on the same rows');
  assert.equal(gate.passed, false);
});

test('the run is reproducible: the same seed and inputs give identical scoreboard numbers', () => {
  const run = () => F.scoreboard.compare(F.scoreboard.makeScoreboard(F.walkforward.runHorizon({
    horizon: 3, rows: built.rowsByHorizon.get(3), featureKeys: built.featureKeys, cfg, caps, panel,
    decisionDates, sessions: panel.sessions, stride: STRIDE,
  }).scoreboardRows));
  const a = run(), b = run();
  assert.deepEqual(a.map((r) => [r.model, r.meanRankIC, r.netSharpe]), b.map((r) => [r.model, r.meanRankIC, r.netSharpe]));
});

test('FIXTURE foundation models exercise the multi-model path and are stamped synthetic', () => {
  const multiCfg = FX.testConfig({
    models: { enabled: ['ridge', 'chronos2', 'moirai2'] },
    walkforward: { minTrainSessions: 70, testSessions: 30, innerFolds: 2, holdoutFraction: 0.2, scheme: 'expanding' },
  });
  const res = F.walkforward.runHorizon({
    horizon: 5, rows: rows5.slice(0, 12000), featureKeys: built.featureKeys, cfg: multiCfg, caps, panel,
    decisionDates, sessions: panel.sessions, stride: STRIDE, fixture: 'auto',
  });
  const models = new Set(res.scoreboardRows.map((r) => r.model));
  assert.ok(models.has('chronos2') && models.has('moirai2'), 'the fixture path must produce foundation arms');
  assert.ok(models.has('meta-no-foundation'), 'with foundation models present, the without-them control must run');
  assert.equal(res.auditOk, true);

  const weights = res.foldReports.find((f) => !f.skipped).diagnostics.weights;
  assert.ok(['ridge', 'chronos2', 'moirai2'].every((m) => m in weights.weights), 'every component gets a weight');
  const sum = Object.values(weights.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
});

test('the meta-ranker actually receives the ensemble point, its rank and trailing reliability', () => {
  const keys = F.metaRanker.metaFeatureKeys(['ridge'], ['ret5']);
  for (const k of ['ens_point', 'ens_rank', 'reliability_best', 'base_disagreement', 'ridge_point', 'ridge_avail']) {
    assert.ok(keys.includes(k), `meta feature "${k}" is not declared`);
  }
  const frames = Array.from({ length: 6 }, (_, i) => ({
    rowKey: `T${i}|D1`, ticker: `T${i}`, decisionDate: 'D1', horizon: 5,
    features: { ret5: i / 10 },
    base: { ridge: { availability: 'ok', point: (i - 3) / 100, intervalWidth80: 0.04, downsideTail: -0.03, upsideTail: 0.05, sigma: 0.02 } },
    label: { residualReturn: (i - 3) / 100 },
  }));
  const prepared = F.metaRanker.prepareRows(frames, ['ridge'], ['ret5'], {
    ensemblePointOf: (f) => F.ensemble.weightedPoint(f, { ridge: 1 }).point,
    reliability: { best: 0.021 },
  });
  assert.ok(prepared.every((r) => Number.isFinite(r.features.ens_point)), 'ens_point must be populated, not left null');
  assert.ok(prepared.every((r) => Number.isFinite(r.features.ens_rank)), 'ens_rank must be populated');
  assert.equal(prepared[0].features.reliability_best, 0.021);
  assert.equal(prepared[0].features.ridge_avail, 1);
  // ens_rank is a within-date percentile, so it spans [0,1] across this one date.
  const ranks = prepared.map((r) => r.features.ens_rank).sort((a, b) => a - b);
  assert.equal(ranks[0], 0);
  assert.equal(ranks[ranks.length - 1], 1);
});

test('inference produces ranked, bounded, fully-stamped scored rows for the latest date', () => {
  const asOf = decisionDates[decisionDates.length - 1];
  const out = F.infer.runInference({ panel, cfg, caps, asOf, horizons: [5], trainSessions: 400, dateStride: STRIDE });
  assert.equal(out.ok, true, out.reason);
  const h = out.horizons[5];
  assert.equal(h.ok, true, h.reason);
  assert.ok(h.rows.length > 10);

  let prevScore = Infinity;
  for (const r of h.rows) {
    assert.equal(r.schema, 'ForecastScoredRow');
    assert.equal(r.evaluationType, 'live-prediction', 'a served row must never look like a backtest');
    assert.ok(r.opportunityScore === null || (r.opportunityScore >= 0 && r.opportunityScore <= 100));
    assert.ok(typeof r.scoreStatus === 'string');
    assert.equal(r.pit.asOf, asOf);
    assert.equal(r.targetDefinition, cfg.target.definition);
    assert.ok(r.quality.survivorshipSafe === false);
    assert.ok('ridge' in r.componentAvailability);
    assert.ok(Number.isFinite(r.estimatedCostPct));
    assert.ok(r.rank >= 1 && r.rank <= h.rows.length);
    assert.ok(r.lineage.manifestHash, 'every served row carries its lineage');
    prevScore = r.opportunityScore ?? prevScore;
  }
  assert.equal(h.rows[0].rank, 1);
  assert.ok(h.rows[0].expectedResidualReturn >= h.rows[h.rows.length - 1].expectedResidualReturn - 1e-9
    || h.rankerBackend !== 'dynamic-ensemble-fallback', 'the top row should not be the worst forecast');
  assert.ok(out.manifest.manifestHash);
  assert.ok(Array.isArray(out.capabilities.degraded));
});

test('inference refuses rather than guesses when the as-of date is not on the axis', () => {
  const out = F.infer.runInference({ panel, cfg, caps, asOf: '1999-01-01', horizons: [5] });
  assert.equal(out.ok, false);
  assert.match(out.reason, /not a session/);
});

test('the FINAL HOLDOUT is scored once and stamped so it can never feed weighting', () => {
  const hold = F.walkforward.runHoldout({
    horizon: 5, rows: rows5, featureKeys: built.featureKeys, cfg, caps, panel,
    decisionDates, sessions: panel.sessions, stride: STRIDE,
  });
  assert.equal(hold.ok, true, hold.reason);
  assert.ok(hold.rows.every((r) => r.evaluationType === 'final-holdout'));
  assert.ok(hold.fold.testStart > hold.fold.trainEnd);
  const board = F.scoreboard.makeScoreboard(hold.rows);
  assert.equal(board.oos().length, 0, 'holdout rows are NOT walk-forward OOS');
  assert.equal(F.scoreboard.productionEligibleInputs(board, '2099-01-01').length, 0, 'the holdout may never influence weighting');

  // The holdout gets its own embargo: training must stop far enough back that the last
  // development labels cannot straddle the boundary.
  const gap = panel.sessions.indexOf(hold.fold.testStart) - panel.sessions.indexOf(hold.fold.trainEnd) - 1;
  assert.ok(gap >= hold.fold.embargoSessions, `holdout embargo gap is ${gap}, needs >= ${hold.fold.embargoSessions}`);
  assert.equal(hold.audit.ok, true, `holdout leakage audit failed: ${hold.audit.failedChecks.join(', ')}`);
});
