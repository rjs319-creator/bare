'use strict';
// GOLDEN-FIXTURE GUARD (quant-redesign-3 Phase 1/6).
//
// 1. The live board over the frozen all-source fixture must match the CURRENT golden
//    (test/fixtures/today-golden.json). Any drift is either a bug or a deliberate,
//    documented change regenerated via `node scripts/capture-today-golden.js`.
// 2. DAY TRADE NON-REGRESSION: the Day Trade rows must match the frozen baseline
//    (test/fixtures/today-golden-baseline.json) — normalized inputs, scores, cost
//    treatment and relative ordering are contractually frozen.
//
//    BASELINE v2 (predictive-redesign, 2026-07-31): regenerated ONCE for two documented
//    deterministic corrections confirmed in docs/predictive-redesign-audit.md — no other
//    Day Trade behavior changed:
//      • defect #13: unknown dollar-volume now takes the CONSERVATIVE cost tier ('small'),
//        not the cheapest ('liquid') — daytrade fixture rows carry no dollar-volume, so
//        their costTier/costPenalty/score shift accordingly (production daytrade cards now
//        propagate measured avgDollarVol, so live rows are usually measured, not assumed);
//      • defect #11: the canonical card's `lifecycleState` now reaches makeSignal's
//        stateHint instead of being silently dropped (no state change in this fixture).
//    The file must not be regenerated again outside an equally documented correction.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildToday } = require('../lib/decision-routes');
const N = require('../lib/decision-normalizers');
const { SOURCES, project } = require('./fixtures/today-sources');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));

// MODE NOTE (non-daytrade redesign 2026-08 §9). The DEFAULT eligibility mode is now
// fail-closed 'enforce', so the served board is the cleared-only subset. The golden
// therefore pins the UNGATED ranking ('annotate'): it proves this pass changed no score,
// no tilt, no cost treatment and no relative order — only which rows are allowed through.
const ANNOTATE = { eligibilityMode: 'annotate' };
const rowsOnly = (p) => ({ topByHorizon: p.topByHorizon, horizons: p.horizons });

test('golden: the UNGATED ranking over the frozen fixture is byte-identical to the golden projection', () => {
  const now = project(buildToday(SOURCES, null, null, null, ANNOTATE));
  const golden = read('today-golden.json');
  assert.deepEqual(rowsOnly(now), rowsOnly(golden), 'no score/tilt/cost/order drift');
  assert.equal(now.counts.signals, golden.counts.signals);
  assert.deepEqual(now.counts.byHorizon, golden.counts.byHorizon);
});

test('golden: the ENFORCED default board is a strict subset of the ungated ranking (never a new row)', () => {
  const ungatedIds = new Set(Object.values(project(buildToday(SOURCES, null, null, null, ANNOTATE)).horizons).flat().map(r => r.id));
  const enforced = Object.values(project(buildToday(SOURCES, null, null, null)).horizons).flat();
  assert.ok(enforced.length <= ungatedIds.size);
  for (const r of enforced) assert.ok(ungatedIds.has(r.id), `${r.id} appeared only under enforcement`);
});

const dayTradeRows = (proj) => Object.values(proj.horizons).flat()
  .filter(r => r.source === 'daytrade')
  .sort((a, b) => a.ticker.localeCompare(b.ticker));

test('DAY TRADE FROZEN: rows match the immutable pre-redesign baseline byte-for-byte', () => {
  const baseline = dayTradeRows(read('today-golden-baseline.json'));
  const current = dayTradeRows(project(buildToday(SOURCES, null, null, null, ANNOTATE)));
  assert.ok(baseline.length >= 2, 'baseline must carry Day Trade rows');
  // rank can legitimately shift only if OTHER sources move around them — every
  // intrinsic field (score, confidence, cost, execution, tilt, state) must be identical.
  const strip = (r) => { const { rank, ...rest } = r; return rest; };
  assert.deepEqual(current.map(strip), baseline.map(strip));
  // and the ungated board is unchanged by this pass, so ranks match too:
  assert.deepEqual(current.map(r => r.rank), baseline.map(r => r.rank));
});

test('DAY TRADE FROZEN: enforcement leaves every intrinsic Day Trade field identical (only rank may move)', () => {
  const baseline = dayTradeRows(read('today-golden-baseline.json'));
  const enforced = dayTradeRows(project(buildToday(SOURCES, null, null, null)));
  const strip = (r) => { const { rank, ...rest } = r; return rest; };
  assert.deepEqual(enforced.map(strip), baseline.map(strip),
    'the fail-closed default must not alter a single Day Trade score, cost tier or state');
});

test('DAY TRADE FROZEN: normalized inputs from fromDayTrade are unchanged by the redesign', () => {
  const rows = N.fromDayTrade(SOURCES.daytrade);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => ({
    source: r.source, section: r.section, tier: r.tier, horizon: r.horizon, side: r.side,
    ticker: r.ticker, entry: r.entry, stop: r.stop, target: r.target, rr: r.rr,
    rawConfidence: r.rawConfidence, scoringVersion: r.scoringVersion,
  })), [
    { source: 'daytrade', section: 'daytrade', tier: 'B', horizon: 'intraday', side: 'long',
      ticker: 'CCC', entry: 30.2, stop: 28.5, target: 34, rr: 2, rawConfidence: 55, scoringVersion: 'daytrade-v2' },
    { source: 'daytrade', section: 'daytrade', tier: 'A', horizon: 'intraday', side: 'long',
      ticker: 'DTX', entry: 8.35, stop: 7.8, target: 9.6, rr: 2.3, rawConfidence: 55, scoringVersion: 'daytrade-v2' },
  ]);
});
