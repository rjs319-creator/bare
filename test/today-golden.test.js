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

test('golden: buildToday over the frozen fixture matches the current golden projection', () => {
  const now = project(buildToday(SOURCES, null, null, null));
  assert.deepEqual(now, read('today-golden.json'));
});

const dayTradeRows = (proj) => Object.values(proj.horizons).flat()
  .filter(r => r.source === 'daytrade')
  .sort((a, b) => a.ticker.localeCompare(b.ticker));

test('DAY TRADE FROZEN: rows match the immutable pre-redesign baseline byte-for-byte', () => {
  const baseline = dayTradeRows(read('today-golden-baseline.json'));
  const current = dayTradeRows(project(buildToday(SOURCES, null, null, null)));
  assert.ok(baseline.length >= 2, 'baseline must carry Day Trade rows');
  // rank can legitimately shift only if OTHER sources move around them — every
  // intrinsic field (score, confidence, cost, execution, tilt, state) must be identical.
  const strip = (r) => { const { rank, ...rest } = r; return rest; };
  assert.deepEqual(current.map(strip), baseline.map(strip));
  // and in fact the whole board is unchanged in default mode, so ranks match too:
  assert.deepEqual(current.map(r => r.rank), baseline.map(r => r.rank));
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
