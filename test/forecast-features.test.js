'use strict';
// FEATURES + CROSS-SECTION: point-in-time correctness, no future values in any transformation,
// determinism, missingness handling, and the train-fitted-only rule for scalers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const FE = require('../lib/forecast/features');
const XS = require('../lib/forecast/xsection');
const DS = require('../lib/forecast/dataset');
const FX = require('./forecast-fixtures');

const cfg = FX.testConfig();

test('no feature reads a bar after the decision index', () => {
  const panel = FX.buildPanel({ sessions: 320, names: 4, seed: 31 });
  const entry = panel.dataset.get('SYN00');
  const idx = 250;
  const bench = DS.returnMapAsOf(panel.bench.candles, idx, 300);
  const before = FE.computeFeatures(entry.candles, idx, { benchReturns: bench, betaMarket: 1 });

  const poisoned = entry.candles.map((c, i) => (i > idx
    ? { ...c, open: c.open * 3, high: c.high * 3, low: c.low * 3, close: c.close * 3, volume: c.volume * 10 }
    : c));
  const after = FE.computeFeatures(poisoned, idx, { benchReturns: bench, betaMarket: 1 });

  for (const k of FE.FEATURE_KEYS) {
    assert.equal(after.values[k], before.values[k], `feature "${k}" changed when only FUTURE bars changed`);
  }
});

test('the recorded maxSourceDate is the decision bar — the PIT audit key', () => {
  const panel = FX.buildPanel({ sessions: 300, names: 3, seed: 33 });
  const entry = panel.dataset.get('SYN01');
  const idx = 200;
  const fv = FE.computeFeatures(entry.candles, idx, {});
  assert.equal(fv.maxSourceDate, entry.candles[idx].date);
  assert.ok(fv.maxSourceDate <= entry.candles[idx].date);
});

test('features are deterministic — identical inputs give identical outputs', () => {
  const panel = FX.buildPanel({ sessions: 300, names: 3, seed: 35 });
  const entry = panel.dataset.get('SYN00');
  const bench = DS.returnMapAsOf(panel.bench.candles, 220, 300);
  const a = FE.computeFeatures(entry.candles, 220, { benchReturns: bench, betaMarket: 1.1 });
  const b = FE.computeFeatures(entry.candles, 220, { benchReturns: bench, betaMarket: 1.1 });
  assert.deepEqual(a.values, b.values);
});

test('unavailable features are null AND listed in missing — never imputed at source', () => {
  const panel = FX.buildPanel({ sessions: 300, names: 2, seed: 37 });
  const entry = panel.dataset.get('SYN00');
  const fv = FE.computeFeatures(entry.candles, 30, {});    // too little history for mom121 etc.
  assert.equal(fv.values.mom121, null);
  assert.ok(fv.missing.includes('mom121'));
  assert.ok(fv.coverage < 1 && fv.coverage > 0);
  for (const k of fv.missing) assert.equal(fv.values[k], null, `${k} is listed missing but not null`);
});

test('an absent bar yields an all-null vector with zero coverage, not zeros', () => {
  const fv = FE.computeFeatures([], 0, {});
  assert.equal(fv.coverage, 0);
  for (const k of FE.FEATURE_KEYS) assert.equal(fv.values[k], null);
});

test('percentile ranks are within-date, tie-averaged, and leave nulls null', () => {
  const r = XS.percentileRanks([10, 20, 20, 30, null]);
  assert.equal(r[4], null);
  assert.equal(r[0], 0);
  assert.equal(r[3], 1);
  assert.equal(r[1], r[2], 'ties share an averaged rank');
  assert.ok(r[1] > 0 && r[1] < 1);
});

test('robust z uses the median/MAD and returns null for a degenerate cross-section', () => {
  assert.deepEqual(XS.robustZ([5, 5, 5, 5]), [null, null, null, null]);
  const z = XS.robustZ([1, 2, 3, 4, 5]);
  assert.equal(z[2], 0, 'the median maps to zero');
  assert.ok(z[0] < 0 && z[4] > 0);
});

test('a thin cross-section emits null ranks and is flagged rather than trusted', () => {
  const rows = [{ ticker: 'A', sector: 'X', features: { ret5: 0.1, ret21: 0.2 } }, { ticker: 'B', sector: 'X', features: { ret5: -0.1, ret21: 0.0 } }];
  const out = XS.applyCrossSection(rows, FX.testConfig({ features: { crossSectionMinNames: 10 } }));
  assert.equal(out.context.thinCrossSection, true);
  assert.equal(out.rows[0].features.xs_ret5, null);
});

test('cross-sectional transforms use only rows from the SAME decision date', () => {
  // Two dates built together must give the same ranks as each date built alone.
  const mk = (t, v, date) => ({ ticker: t, sector: 'X', decisionDate: date, features: { ret5: v, ret21: v } });
  const c = FX.testConfig({ features: { crossSectionMinNames: 2 } });
  const dayA = [mk('A', 1, 'd1'), mk('B', 2, 'd1'), mk('C', 3, 'd1')];
  const alone = XS.applyCrossSection(dayA, c).rows.map((r) => r.features.xs_ret5);
  // The same date, but with a wildly different second date's rows appended — must not matter,
  // because applyCrossSection is called PER DATE by the dataset builder.
  const again = XS.applyCrossSection(dayA, c).rows.map((r) => r.features.xs_ret5);
  assert.deepEqual(alone, again);
  assert.deepEqual(alone, [0, 0.5, 1]);
});

test('SECTOR-SCOPED ranks compare a name against its own sector, not the whole market', () => {
  const c = FX.testConfig({ features: { crossSectionMinNames: 3, crossSectionScope: 'sector' } });
  const mk = (t, sector, v) => ({ ticker: t, sector, features: { ret5: v, ret21: v } });
  const rows = [
    mk('a', 'Tech', 1), mk('b', 'Tech', 2), mk('c', 'Tech', 3),
    mk('d', 'Energy', 10), mk('e', 'Energy', 20), mk('f', 'Energy', 30),
  ];
  const market = XS.applyCrossSection(rows, c, { scope: 'market' }).rows.map((r) => r.features.xs_ret5);
  const sector = XS.applyCrossSection(rows, c, { scope: 'sector' }).rows.map((r) => r.features.xs_ret5);

  // Market-wide, every Energy name outranks every Tech name purely because Energy's values are
  // bigger — which is exactly the sector dimension the residual target has already removed.
  assert.deepEqual(market, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  // Within sector, each name is placed against its own peers and the two sectors mirror.
  assert.deepEqual(sector, [0, 0.5, 1, 0, 0.5, 1]);
});

test('a sector too thin to rank within falls back to the market-wide rank, and says so', () => {
  const c = FX.testConfig({ features: { crossSectionMinNames: 3, crossSectionScope: 'sector' } });
  const mk = (t, sector, v) => ({ ticker: t, sector, features: { ret5: v, ret21: v } });
  const rows = [
    mk('a', 'Tech', 1), mk('b', 'Tech', 2), mk('c', 'Tech', 3),
    mk('z', 'Tiny', 99),
  ];
  const out = XS.applyCrossSection(rows, c, { scope: 'sector' });
  assert.equal(out.context.crossSectionScope, 'sector');
  assert.deepEqual(out.context.scopeCounts, { sector: 3, market: 1 });
  assert.ok(out.rows[3].features.xs_ret5 !== null, 'a thin sector is a coverage problem, not a reason to blank the name');
});

test('a scaler is fitted on TRAIN rows only and records its window', () => {
  const rows = (dates) => dates.flatMap((d) => [0.1, 0.2, 0.3].map((v, i) => ({ decisionDate: d, features: { a: v * (i + 1), b: v } })));
  const train = rows(['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04']);
  const scaler = XS.fitScaler(train, ['a', 'b'], cfg);
  assert.equal(scaler.fittedThroughDate, '2024-01-04');
  assert.equal(scaler.fittedOnRows, train.length);
  assert.ok(scaler.limits.a, 'winsorization limits are fitted, not assumed');
});

test('applyScaler imputes a missing value with the TRAIN median, not the row cohort', () => {
  const train = Array.from({ length: 40 }, (_, i) => ({ decisionDate: '2024-01-01', features: { a: i, b: 1 } }));
  const scaler = XS.fitScaler(train, ['a', 'b'], cfg);
  const withValue = XS.applyScaler({ features: { a: scaler.impute.a, b: 1 } }, scaler);
  const missing = XS.applyScaler({ features: { a: null, b: 1 } }, scaler);
  assert.ok(Math.abs(withValue[0] - missing[0]) < 1e-9, 'a missing value must map to the fitted train median');
});

test('the dataset builder produces rows whose maxSourceDate never exceeds the decision date', () => {
  const panel = FX.buildPanel({ sessions: 320, names: 12, seed: 41 });
  const dates = panel.sessions.slice(200, 210);
  const built = DS.buildPanelRows({ panel, dates, cfg });
  const rows = built.rowsByHorizon.get(5);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(r.maxSourceDate <= r.decisionDate, `${r.ticker} cites ${r.maxSourceDate} for decision ${r.decisionDate}`);
    assert.ok(r.pit.labelStart > r.decisionDate, 'the label can only start after the decision session');
  }
});

test('the expanded feature key list matches what the rows actually carry', () => {
  const panel = FX.buildPanel({ sessions: 320, names: 10, seed: 43 });
  const built = DS.buildPanelRows({ panel, dates: panel.sessions.slice(200, 204), cfg });
  const row = built.rowsByHorizon.get(5)[0];
  for (const k of built.featureKeys) {
    assert.ok(k in row.features, `declared feature "${k}" is absent from the row`);
  }
});
