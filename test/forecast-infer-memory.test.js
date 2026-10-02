'use strict';
// forecastshadowtick OOM (site audit 2026-10-02, nightly addendum): the in-process inference on
// 517 names × 3y reached ~1 GB RSS and died under co-location. The fixes are memory-shape only —
// labels built one horizon at a time (reusing the betas the feature pass already computed),
// feature/meta objects built in one pass so V8 keeps fast properties — and MUST leave the
// outputs byte-identical. These tests pin that parity on the synthetic fixture panel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/forecast');
const DS = require('../lib/forecast/dataset');
const TARGETS = require('../lib/forecast/targets');
const { applyCrossSection } = require('../lib/forecast/xsection');
const { metaFeaturesFor } = require('../lib/forecast/meta-ranker');
const { buildPanel, testConfig } = require('./forecast-fixtures');

const cfg = F.config.resolveConfig(testConfig());
const panel = buildPanel({ sessions: 420, names: 40, seed: 7 });
const date = panel.sessions[300];

test('buildDate ≡ buildDateFeatures + rowsForHorizon, horizon by horizon (same rows, same labels, same pit stamps)', () => {
  const whole = DS.buildDate({ panel, date, cfg, requireLabel: true });
  const built = DS.buildDateFeatures({ panel, date, cfg, requireLabel: true });
  assert.ok(built.rows.length > 10, 'fixture date should carry rows');
  for (const h of cfg.horizons) {
    const rows = DS.rowsForHorizon(built, h, { requireLabel: true });
    assert.deepEqual(rows, whole.rowsByHorizon.get(h));
  }
  assert.deepEqual(built.diagnostics, whole.diagnostics);
});

test('labels built per horizon with precomputed betas equal the all-horizon build without them', () => {
  const ticker = [...panel.dataset.keys()][3];
  const all = TARGETS.buildLabels({ panel, ticker, date, cfg });
  for (const h of cfg.horizons) {
    const one = TARGETS.buildLabels({ panel, ticker, date, cfg: { ...cfg, horizons: [h] }, betas: all.betas });
    assert.deepEqual(one.labels[h], all.labels[h]);
    assert.deepEqual(one.unobservable[h], all.unobservable[h]);
    assert.deepEqual(one.betas, all.betas);
  }
});

test('the cross-section feature object has the same keys, order and values as a spread-then-append build', () => {
  const built = DS.buildDateFeatures({ panel, date, cfg, requireLabel: true });
  const base = built.rows.map((r) => ({ ...r, features: Object.fromEntries(Object.entries(r.features).filter(([k]) => !k.startsWith('xs_') && !k.startsWith('z_') && !k.startsWith('ctx'))) }));
  const { rows } = applyCrossSection(base, cfg, { transforms: ['rank'] });
  // Reference construction (the pre-fix shape): spread + append.
  const ref = rows.map((r) => { const f = { ...r.features }; return f; });
  rows.forEach((r, i) => {
    assert.deepEqual(Object.keys(r.features), Object.keys(ref[i]));
    assert.deepEqual(r.features, built.rows[i].features);
  });
});

test('meta features keep every base-model column and the frame fields, in one fast-shaped object', () => {
  const frame = { rowKey: 'k', ticker: 'AAA', decisionDate: date, horizon: 5, features: { a: 1, xs_a: 0.5 }, base: { ridge: { availability: 'ok', point: 0.01, intervalWidth80: 0.1, downsideTail: -0.05, upsideTail: 0.06, sigma: 0.04 }, other: null } };
  const out = metaFeaturesFor(frame, ['ridge', 'other'], ['xs_a'], { ensemblePoint: 0.01, reliability: { best: 0.2 } });
  assert.equal(out.rowKey, 'k');
  assert.deepEqual(Object.keys(out.features), ['a', 'xs_a', 'ridge_point', 'ridge_iw80', 'ridge_down', 'ridge_up', 'ridge_sigma', 'ridge_avail', 'other_point', 'other_iw80', 'other_down', 'other_up', 'other_sigma', 'other_avail', 'base_count', 'base_disagreement', 'base_spread', 'ens_point', 'ens_rank', 'reliability_best']);
  assert.equal(out.features.ridge_point, 0.01);
  assert.equal(out.features.other_avail, 0);
  assert.equal(out.features.base_count, 1);
  assert.equal(out.features.base_disagreement, null);
  assert.equal(out.features.reliability_best, 0.2);
});

test('runInference still scores the fixture panel at every horizon', () => {
  const caps = F.capabilities.detectCapabilities(cfg, { probeReport: { python: false, lightgbm: false, chronos: false, moirai: false } });
  const out = F.infer.runInference({ panel, cfg, caps, asOf: panel.sessions[panel.sessions.length - 1], trainSessions: 250, dateStride: 5 });
  assert.equal(out.ok, true, out.reason);
  for (const h of cfg.horizons) assert.ok(out.horizons[h], `horizon ${h} missing`);
});
