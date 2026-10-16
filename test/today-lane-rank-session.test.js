'use strict';
// Review Prompt 4.5 / 8: a rank shown inside a horizon lane must be local to that lane
// (a five-item lane cannot open with "#130"), every blocker on an excluded row must be
// counted, and the board states which exchange session it was built in — from the
// INJECTED clock, never the wall clock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildToday, boardHashOf } = require('../lib/decision-routes');
const EL = require('../lib/eligibility');
const { SOURCES } = require('../test/fixtures/today-sources');

const NO_DATA_GATE = { dataGate: null };
// Saturday 2026-07-25 12:00 ET — market closed; the last completed session is Fri 07-24.
const SAT = Date.parse('2026-07-25T16:00:00Z');
// Friday 2026-07-24 10:30 ET — regular session; the last COMPLETED one is Thu 07-23.
const FRI_RTH = Date.parse('2026-07-24T14:30:00Z');

const LANE_KEYS = ['topByHorizon', 'researchByHorizon', 'actionableByHorizon', 'qualifiedLeadsByHorizon'];

test('laneRank is 1..n inside every horizon lane, while the global rank is untouched', () => {
  const p = buildToday(SOURCES, null, null, null, { nowMs: SAT, ...NO_DATA_GATE });
  let lanesSeen = 0, localDiffersFromGlobal = false;
  for (const key of LANE_KEYS) {
    for (const [hz, list] of Object.entries(p[key] || {})) {
      if (!list.length) continue;
      lanesSeen++;
      assert.deepEqual(list.map(x => x.laneRank), list.map((_, i) => i + 1), `${key}.${hz} laneRank is local and 1-based`);
      for (const x of list) {
        assert.ok(Number.isInteger(x.rank) && x.rank >= 1, 'global rank still present');
        if (x.rank !== x.laneRank) localDiffersFromGlobal = true;
      }
    }
  }
  assert.ok(lanesSeen >= 2, 'fixture populates more than one lane');
  assert.ok(localDiffersFromGlobal, 'at least one lane row has a global rank that is NOT its lane position');
});

test('laneRank is display scope only: the ranked horizons rows and the board hash are unchanged', () => {
  const p = buildToday(SOURCES, null, null, null, { nowMs: SAT, ...NO_DATA_GATE });
  const all = Object.values(p.horizons).flat();
  assert.ok(all.every(x => x.laneRank === undefined), 'the full ranked cross-section carries no lane-local rank');
  const again = buildToday(SOURCES, null, null, null, { nowMs: FRI_RTH, ...NO_DATA_GATE });
  assert.equal(boardHashOf(all), boardHashOf(Object.values(again.horizons).flat()), 'sibling fields and the clock do not move the board hash');
});

test('excluded rows carry EVERY reason code, and rejectionReasonCounts counts every one of them', () => {
  const p = buildToday(SOURCES, null, null, null, { nowMs: SAT, ...NO_DATA_GATE });
  const g = p.governanceGate;
  assert.ok(g && g.excludedCount > 0, 'fixture has excluded rows');
  for (const x of g.excluded) {
    assert.ok(Array.isArray(x.codes) && x.codes.length >= 1, 'codes[] present');
    assert.equal(x.code, x.codes[0], 'legacy single code is still the first');
  }
  const multi = g.excluded.filter(x => x.codes.length > 1);
  assert.ok(multi.length > 0, 'fixture has a row blocked for several reasons (unborrowable short from an uncleared source)');
  const total = Object.values(g.rejectionReasonCounts).reduce((a, b) => a + b, 0);
  assert.ok(total > g.excludedCount, 'counts sum over reasons, not rows');
  assert.equal(typeof g.rejectionReasonCountsNote, 'string');
  assert.match(g.rejectionReasonCountsNote, /several|more than one/i);
});

test('gateSignals: a short that is unborrowable AND mis-drawn is counted under both blockers', () => {
  const sig = { source: 'gapdown', ticker: 'GRML', side: 'short', entry: 9.6, stop: 16.95, target: null,
    planInvalidReason: 'invalid_target_geometry', liquidity: { dollarVol: 2e7 } };
  const gate = EL.gateSignals([sig], { nowMs: SAT });
  const [x] = gate.excluded;
  assert.ok(x.codes.includes(EL.REASON_CODE.INVALID_GEOMETRY));
  assert.ok(x.codes.includes(EL.REASON_CODE.NO_BORROW));
});

test('session block comes from the injected clock (closed Saturday → last completed session is Friday)', () => {
  const p = buildToday(SOURCES, null, null, null, { nowMs: SAT, ...NO_DATA_GATE });
  assert.deepEqual(p.session, { etDate: '2026-07-25', marketSession: 'closed', isTradingDay: false, lastCompletedSession: '2026-07-24' });
});

test('session block during regular hours: today is a trading day but NOT yet a completed session', () => {
  const p = buildToday(SOURCES, null, null, null, { nowMs: FRI_RTH, ...NO_DATA_GATE });
  assert.deepEqual(p.session, { etDate: '2026-07-24', marketSession: 'regular', isTradingDay: true, lastCompletedSession: '2026-07-23' });
});
