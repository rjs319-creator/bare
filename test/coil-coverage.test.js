'use strict';
// PHASE 3 — Coil observation coverage expansion (docs/premove-transition-v2.md).
// The capture is deterministic, covers the whole score distribution (stratified
// controls), preserves scope-specific calibration stamps, and the reliability
// battery keeps the two stages (abnormal break vs executable trade) separate
// with censoring intact.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const CAP = require('../lib/coil-capture');
const REL = require('../lib/coil-reliability');
const coil = require('../lib/coil');

// Synthetic ranked cohort: 40 names across all 10 deciles, valid candles each.
function candlesFor(px) {
  return Array.from({ length: 70 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 5 + Math.floor(i / 5) * 7 + (i % 5)));
    const c = px * (1 + (i % 2 ? 0.003 : -0.003));
    return { date: d.toISOString().slice(0, 10), open: c, high: c * 1.004, low: c * 0.996, close: c, volume: 2e6 };
  });
}
function rankedCohort(n = 40) {
  return Array.from({ length: n }, (_, i) => ({
    ticker: `T${String(i).padStart(2, '0')}`,
    score: 100 - i,
    percentile: +(1 - i / (n - 1)).toFixed(3),
    feats: { price: 50, bbPctile: 0.1 + i / 200 },
    prob: { decile: 9 - Math.floor(i / (n / 10)), band: i < 8 ? 'high' : i < 20 ? 'elevated' : 'normal', pct: 8 - i * 0.1, pctMajor: 4, lift: 2 },
    candles: candlesFor(50),
    meta: {},
  }));
}

test('capture keeps the top-15 selected AND adds deterministic decile-stratified controls', () => {
  const ranked = rankedCohort(40);
  const rows = CAP.buildCoilTickRows({ ranked, scope: 'micro', calScope: 'small', cohortCount: 40 });
  const selected = rows.filter(r => r.sampleKind === 'selected');
  const controls = rows.filter(r => r.sampleKind === 'decile-stratified');
  assert.equal(selected.length, CAP.SELECT_TOPN);
  assert.ok(controls.length > 0, 'controls must exist');
  // Deciles NOT covered by the top-15 must appear among the controls.
  const controlDeciles = new Set(controls.map(r => r.decile));
  for (const d of [0, 1, 2, 3, 4, 5]) {
    assert.ok(controlDeciles.has(d), `low decile ${d} must be sampled as a control`);
  }
  // No double capture.
  const tickers = rows.map(r => r.ticker);
  assert.equal(new Set(tickers).size, tickers.length, 'a ticker is captured at most once per scope');
  // Determinism: same cohort in, byte-identical rows out.
  const again = CAP.buildCoilTickRows({ ranked, scope: 'micro', calScope: 'small', cohortCount: 40 });
  assert.deepEqual(again, rows);
});

test('every captured row carries PIT provenance and its own scope calibration stamp', () => {
  const rows = CAP.buildCoilTickRows({ ranked: rankedCohort(20), scope: 'micro', calScope: 'small', cohortCount: 20 });
  for (const r of rows) {
    assert.equal(r.scope, 'micro');
    assert.equal(r.calScope, 'small', 'micro shares the small table by existing convention — RECORDED, not silent');
    assert.equal(r.captureVersion, CAP.COIL_CAPTURE_VERSION);
    assert.ok(r.dailyVol > 0);
    assert.ok(r.decisionPrice > 0);
    assert.ok(r.dataCutoff, 'data cutoff recorded');
    assert.ok(r.universeSnapshotId.includes('micro#20'));
    assert.ok(r.plan == null || (r.plan.entry > 0 && r.plan.stop > 0), 'plan levels valid when present');
    assert.ok(Number.isFinite(r.dollarVol), 'dollar volume from decision-time candles');
  }
});

test('large scope keeps the large calibration stamp (never pooled into small)', () => {
  const rows = CAP.buildCoilTickRows({ ranked: rankedCohort(20), scope: 'large', calScope: 'large', cohortCount: 20 });
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.calScope, 'large');
});

test('reliability battery separates the two stages and excludes unmatured windows', () => {
  // One ledger row whose plan triggers and hits the target; one whose forward
  // window is not matured (censored from every rate).
  const winCandles = candlesFor(50).slice(0, 40);
  // decision on bar 29; trigger 52 gap-fills at open 52.5; target 56 hit bar 33.
  const decisionDate = winCandles[29].date;
  winCandles[31] = { ...winCandles[31], open: 52.5, high: 53, low: 52 };
  winCandles[33] = { ...winCandles[33], high: 57 };
  const rows = [
    { ticker: 'WIN', scope: 'small', selected: true, date: decisionDate, dailyVol: 0.004,
      explodeProbPct: 8, band: 'high', decile: 9, plan: { entry: 52, stop: 47, target: 56 } },
    { ticker: 'OPEN', scope: 'small', selected: false, date: winCandles[38].date, dailyVol: 0.004,
      explodeProbPct: 3, band: 'normal', decile: 2, plan: { entry: 52, stop: 47, target: 56 } },
  ];
  const hist = new Map([['WIN', winCandles], ['OPEN', winCandles]]);
  const rep = REL.buildCoilReliability(rows, hist);

  assert.equal(rep.version, REL.COIL_RELIABILITY_VERSION);
  assert.equal(rep.horizonSessions, coil.COIL_HORIZON);
  // OPEN's decision is 1 bar from the end → both stages censored → only WIN scores.
  assert.equal(rep.overall.breakMatured, 1, 'unmatured stage-one window is excluded');
  assert.equal(rep.overall.execResolved, 1, 'censored executable window is excluded');
  assert.equal(rep.overall.triggerConversionPct, 100);
  assert.equal(rep.overall.targetBeforeStopGivenFillPct, 100);
  assert.ok(Number.isFinite(rep.overall.meanNetR) && rep.overall.meanNetR > 0);
  // Selected-vs-controls split exists because a control row is present.
  assert.ok(rep.selectedVsControls, 'controls comparison present');
  assert.equal(rep.selectedVsControls.selected.n, 1);
  assert.equal(rep.selectedVsControls.controls.n, 1);
});

test('scope groups are reported separately (micro never inherits large results)', () => {
  const c = candlesFor(50).slice(0, 40);
  const date = c[29].date;
  const rows = [
    { ticker: 'A', scope: 'large', selected: true, date, dailyVol: 0.004, explodeProbPct: 4, band: 'high', decile: 9, plan: null },
    { ticker: 'B', scope: 'micro', selected: true, date, dailyVol: 0.004, explodeProbPct: 9, band: 'high', decile: 9, plan: null },
  ];
  const hist = new Map([['A', c], ['B', c]]);
  const rep = REL.buildCoilReliability(rows, hist);
  assert.ok(rep.byScope.large && rep.byScope.micro);
  assert.equal(rep.byScope.large.n, 1);
  assert.equal(rep.byScope.micro.n, 1);
  assert.equal(REL.SCOPE_TIER.micro, 'micro', 'micro pays micro costs');
  assert.equal(REL.SCOPE_TIER.expanded, 'small', 'expanded pays small-cap costs, never the cheapest tier');
});
