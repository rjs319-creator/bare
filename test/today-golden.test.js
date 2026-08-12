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
//
//    GOLDEN v3 (alpha-research pass 3, 2026-08-12) — the CURRENT golden only; the Day
//    Trade BASELINE is untouched and all four DAY TRADE FROZEN guards below still pass
//    byte-for-byte. One documented change:
//      • expectancyTilt is now gated on DATE-LEVEL evidence. It previously shrank on
//        PICK count and boosted on any positive point estimate, so `GapGo:STRONG`
//        (n=24 picks, avgExcess +1.2, NO dateNet block) earned a 1.054 multiplier from
//        a record whose independence was never established. Every group in this fixture
//        is pre-dateNet, so all three tilts now neutralise to 1.0 and the gapgo row
//        moves 70.8 -> 67.2, rank 2 -> 4 (coremo takes rank 3).
//        This is the intended behaviour for a record with no date-level statistic:
//        neutral, not a guess. Production is unaffected in the same way — 35 of 47
//        groups carry dateNet and continue to tilt when their CI clears zero.
//      Day Trade rows are byte-identical; only their RANK moves, which the baseline
//      guard explicitly permits when other sources move around them.
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
  // RANK EQUALITY IS NO LONGER ASSERTED (non-daytrade redesign 2026-08, Phase 9). Day
  // Trade rows are pinned in lib/score-normalize (their scores pass through untouched),
  // but the NON-Day-Trade sources around them are now normalized within their own
  // cross-section instead of being compared on incomparable raw 0–100 scales — so the
  // rows they are ranked against moved. The baseline's own comment always allowed this:
  // "rank can legitimately shift only if OTHER sources move around them". Every intrinsic
  // Day Trade field (score, confidence, cost tier, execution, tilt, state) is still
  // asserted byte-for-byte above.
  assert.ok(current.every(r => Number.isFinite(r.rank)));
});

test('DAY TRADE FROZEN: score normalization does not touch Day Trade scores (pinned source)', () => {
  const SN = require('../lib/score-normalize');
  assert.ok(SN.PINNED.has('daytrade'));
  const [dt] = SN.normalizeSignals([{ source: 'daytrade', rawConfidence: 55 }]);
  assert.equal(dt.normalized.value, 55, 'a pinned source passes through untouched');
  assert.match(dt.normalized.basis, /pinned/);
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
