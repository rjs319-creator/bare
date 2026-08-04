'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  STATES, REASON, createCandidate, advanceLifecycle, summarizeBoard, isActionableEligible,
} = require('../lib/opportunity-lifecycle');

// A fully-fresh, fully-passing evaluation at a given instant. Callers override fields.
function ev(overrides = {}) {
  return {
    now: '2026-07-08T14:00:00Z',        // 10:00 ET
    session: 'regular',
    freshness: { freshnessStatus: 'FRESH_TODAY', barIsToday: true },
    aboveVwap: true, momentumOk: true, residualOk: true, relVolOk: true,
    triggerConfirmed: true, remainingRR: 2.0, extensionAtr: 1.0,
    metrics: { last: 10, residualVsSpy: 1.2, extensionAtr: 1.0 },
    ...overrides,
  };
}
const at = (h, m) => `2026-07-08T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

test('createCandidate: starts in WATCHING with a bootstrap transition', () => {
  const c = createCandidate({ ticker: 'ABC', strategy: 'daytrade', at: at(13, 0) });
  assert.equal(c.state, STATES.WATCHING);
  assert.equal(c.history.length, 1);
  assert.equal(c.history[0].from, null);
  assert.equal(c.history[0].to, STATES.WATCHING);
  assert.equal(c.history[0].reasonCode, REASON.BOOTSTRAP);
});

test('isActionableEligible: the full current-session gate', () => {
  const cfg = { minRemainingRR: 1.0, maxExtensionAtr: 2.5 };
  assert.equal(isActionableEligible(ev(), cfg), true);
  assert.equal(isActionableEligible(ev({ aboveVwap: false }), cfg), false);
  assert.equal(isActionableEligible(ev({ triggerConfirmed: false }), cfg), false);
  assert.equal(isActionableEligible(ev({ relVolOk: false }), cfg), false);
  assert.equal(isActionableEligible(ev({ remainingRR: 0.5 }), cfg), false);
  // Not fresh ⇒ never eligible, even with everything else green.
  assert.equal(isActionableEligible(ev({ freshness: { freshnessStatus: 'PRIOR_SESSION', barIsToday: false } }), cfg), false);
});

test('ladder: WATCHING → BUILDING → ARMED → ACTIONABLE_NOW', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev({ now: at(13, 35), triggerConfirmed: false, relVolOk: false, momentumOk: true, nearTrigger: false }));
  assert.equal(c.state, STATES.BUILDING);
  c = advanceLifecycle(c, ev({ now: at(13, 40), triggerConfirmed: false, nearTrigger: true }));
  assert.equal(c.state, STATES.ARMED);
  c = advanceLifecycle(c, ev({ now: at(13, 45) }));   // full gate
  assert.equal(c.state, STATES.ACTIONABLE_NOW);
  assert.equal(c.history.at(-1).reasonCode, REASON.ACTIONABLE_CONFIRMED);
});

test('stale current-session data cannot remain ACTIONABLE_NOW (→ STALLING)', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());                       // ACTIONABLE_NOW
  assert.equal(c.state, STATES.ACTIONABLE_NOW);
  c = advanceLifecycle(c, ev({ now: at(14, 5), freshness: { freshnessStatus: 'PRIOR_SESSION', barIsToday: false } }));
  assert.equal(c.state, STATES.STALLING);
  assert.equal(c.history.at(-1).reasonCode, REASON.STALL_STALE_DATA);
});

test('two consecutive VWAP closes CONFIRM failure (→ FAILED); a single close does NOT', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());                       // ACTIONABLE_NOW
  // One close below VWAP but price back above at eval time — noisy wick, must NOT retire.
  c = advanceLifecycle(c, ev({ now: at(14, 5), closesBelowVwap: 1 }));
  assert.equal(c.state, STATES.ACTIONABLE_NOW, 'a single VWAP close must not retire a valid candidate');
  // Second consecutive close → confirmed failure.
  c = advanceLifecycle(c, ev({ now: at(14, 10), closesBelowVwap: 2, aboveVwap: false, metrics: { residualVsSpy: -1.1 }, volumeFading: true }));
  assert.equal(c.state, STATES.FAILED);
  const t = c.history.at(-1);
  assert.equal(t.reasonCode, REASON.FAIL_VWAP_LOSS);
  assert.match(t.explanation, /2 closes below VWAP/);
  assert.match(t.explanation, /trailing SPY by 1\.1%/);
});

test('a single noisy bar (momentum blip within tolerance) does not retire', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());
  // closesBelowVwap:1 (below the confirm threshold), still above VWAP, momentum fine.
  c = advanceLifecycle(c, ev({ now: at(14, 5), closesBelowVwap: 1, lowerHighs: 1, noNewHighBars: 2 }));
  assert.equal(c.state, STATES.ACTIONABLE_NOW);
});

test('over-extension demotes to TOO_EXTENDED', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());
  c = advanceLifecycle(c, ev({ now: at(14, 20), extensionAtr: 3.2, metrics: { extensionAtr: 3.2 } }));
  assert.equal(c.state, STATES.TOO_EXTENDED);
  assert.match(c.history.at(-1).explanation, /3\.2 ATR above VWAP/);
});

test('hysteresis: after FAILED, cannot immediately re-ACTIONABLE (cooldown → ARMED), then revives', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());                                   // ACTIONABLE_NOW
  c = advanceLifecycle(c, ev({ now: at(14, 0), breakoutFailed: true }));
  assert.equal(c.state, STATES.FAILED);
  assert.ok(c.cooldownUntil, 'cooldown armed on failure');
  // 5 min later, criteria fully green again — but cooldown (15 min) holds it at ARMED.
  c = advanceLifecycle(c, ev({ now: at(14, 5) }));
  assert.equal(c.state, STATES.ARMED);
  assert.equal(c.history.at(-1).reasonCode, REASON.COOLDOWN_HOLD);
  // 20 min after failure — cooldown elapsed → back to ACTIONABLE (via ARMED, so a normal
  // confirmation rather than a direct-from-retired revival).
  c = advanceLifecycle(c, ev({ now: at(14, 20) }));
  assert.equal(c.state, STATES.ACTIONABLE_NOW);
  assert.equal(c.history.at(-1).reasonCode, REASON.ACTIONABLE_CONFIRMED);
});

test('a retired → actionable revival is DEBOUNCED: cooldown, then 2 consecutive confirmations', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());                                          // ACTIONABLE_NOW
  // Soft stall — a momentum roll-over from actionable. NOW arms a cooldown (the old engine
  // set none, which is exactly what allowed ACTIONABLE ⇄ STALLING to cycle on 60s ticks).
  c = advanceLifecycle(c, ev({ now: at(14, 0), momentumOk: false, triggerConfirmed: false, relVolOk: false }));
  assert.equal(c.state, STATES.STALLING);
  assert.ok(c.cooldownUntil, 'a soft retirement must arm a cooldown');
  // Fully green 5 min later — cooldown holds it at ARMED (waiting), never straight back in.
  c = advanceLifecycle(c, ev({ now: at(14, 5) }));
  assert.equal(c.state, STATES.ARMED);
  assert.equal(c.history.at(-1).reasonCode, REASON.COOLDOWN_HOLD);
});

test('a retired name held through cooldown revives only after CONSECUTIVE qualifying evals', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());                                          // ACTIONABLE_NOW
  c = advanceLifecycle(c, ev({ now: at(14, 0), momentumOk: false, triggerConfirmed: false, relVolOk: false }));
  assert.equal(c.state, STATES.STALLING);
  // Not eligible during the cooldown → stays STALLING (streak untouched).
  c = advanceLifecycle(c, ev({ now: at(14, 10), momentumOk: false, triggerConfirmed: false, relVolOk: false }));
  assert.equal(c.state, STATES.STALLING);
  // Cooldown (20 min) elapsed. First fully-qualifying eval only ARMS the revival streak.
  c = advanceLifecycle(c, ev({ now: at(14, 25) }));
  assert.equal(c.state, STATES.STALLING, 'one qualifying eval after retirement must not revive');
  assert.equal(c.reviveStreak, 1);
  // Second consecutive qualifying eval → confirmed revival, reason REVIVED.
  c = advanceLifecycle(c, ev({ now: at(14, 30) }));
  assert.equal(c.state, STATES.ACTIONABLE_NOW);
  assert.equal(c.history.at(-1).reasonCode, REASON.REVIVED);
  assert.equal(c.reviveStreak, 0, 'streak resets after a confirmed revival');
});

test('a non-qualifying eval RESETS the revival streak (no slow-drip revival)', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());
  c = advanceLifecycle(c, ev({ now: at(14, 0), momentumOk: false, triggerConfirmed: false, relVolOk: false }));
  assert.equal(c.state, STATES.STALLING);
  c = advanceLifecycle(c, ev({ now: at(14, 25) }));                       // qualifies → streak 1
  assert.equal(c.reviveStreak, 1);
  c = advanceLifecycle(c, ev({ now: at(14, 30), momentumOk: false, triggerConfirmed: false, relVolOk: false }));
  assert.equal(c.reviveStreak, 0, 'a failed eval must break the streak');
  assert.equal(c.state, STATES.STALLING);
});

test('hysteresis band: post-retirement re-entry demands STRICTLY better evidence', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());
  c = advanceLifecycle(c, ev({ now: at(14, 0), momentumOk: false, triggerConfirmed: false, relVolOk: false }));
  assert.equal(c.state, STATES.STALLING);
  // remainingRR 1.05 passes the 1.0 FIRST-entry floor but NOT the 1.2 re-entry floor —
  // evidence oscillating just above the entry threshold can never flap the state back.
  c = advanceLifecycle(c, ev({ now: at(14, 25), remainingRR: 1.05 }));
  c = advanceLifecycle(c, ev({ now: at(14, 30), remainingRR: 1.05 }));
  c = advanceLifecycle(c, ev({ now: at(14, 35), remainingRR: 1.05 }));
  assert.equal(c.state, STATES.STALLING, 'inside the hysteresis band the name stays retired');
  // Extension 2.4 passes first-entry (2.5) but not re-entry (2.2) — same rule.
  c = advanceLifecycle(c, ev({ now: at(14, 40), extensionAtr: 2.4, metrics: { extensionAtr: 2.4 } }));
  assert.equal(c.state, STATES.STALLING);
});

test('post-entry lock: entry alert → MANAGING → CLOSED, and history is never rewound', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());                                   // ACTIONABLE_NOW
  c = advanceLifecycle(c, ev({ now: at(14, 0), hasEntryAlert: true }));
  assert.equal(c.state, STATES.MANAGING);
  assert.equal(c.entryAlertAt, '2026-07-08T14:00:00.000Z');
  // Even if the setup "fails" now, a fired alert can NEVER go back to a pre-entry state.
  c = advanceLifecycle(c, ev({ now: at(14, 10), hasEntryAlert: true, breakoutFailed: true, closesBelowVwap: 3 }));
  assert.equal(c.state, STATES.MANAGING, 'a fired alert cannot be disappeared into FAILED');
  c = advanceLifecycle(c, ev({ now: at(14, 30), hasEntryAlert: true, exited: true, exitReason: 'stop' }));
  assert.equal(c.state, STATES.CLOSED);
  assert.equal(c.history.at(-1).reasonCode, REASON.CLOSED_STOP);
  // Terminal: further evals do not change or erase it.
  const closed = advanceLifecycle(c, ev({ now: at(15, 0) }));
  assert.equal(closed.state, STATES.CLOSED);
});

test('FAILED history is preserved and retired names keep being observed & graded', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev());
  c = advanceLifecycle(c, ev({ now: at(14, 0), breakoutFailed: true }));
  const lenAtFail = c.history.length;
  assert.equal(c.state, STATES.FAILED);
  // A retired name that later runs is flagged false-retirement (observed, not deleted).
  c = advanceLifecycle(c, ev({ now: at(14, 40), becameRunner: true, aboveVwap: false, momentumOk: false }));
  assert.ok(c.falseRetirement, 'false retirement flagged');
  assert.equal(c.history.at(-1).reasonCode, REASON.FALSE_RETIREMENT_OBSERVED);
  assert.ok(c.history.length > lenAtFail, 'audit history only grows');
  // Flag is set once, not re-appended every eval.
  const again = advanceLifecycle(c, ev({ now: at(14, 45), becameRunner: true, momentumOk: false }));
  assert.equal(again.history.at(-1).reasonCode, REASON.FALSE_RETIREMENT_OBSERVED);   // unchanged tail
  assert.equal(again.history.length, c.history.length);
});

test('immutability: advanceLifecycle never mutates the input record or its history', () => {
  const c0 = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  const histRef = c0.history;
  const histLen = c0.history.length;
  const c1 = advanceLifecycle(c0, ev());
  assert.notEqual(c1, c0);
  assert.equal(c0.state, STATES.WATCHING, 'input state unchanged');
  assert.equal(c0.history, histRef, 'input history array identity unchanged');
  assert.equal(c0.history.length, histLen, 'input history not appended to');
  assert.equal(c1.state, STATES.ACTIONABLE_NOW);
});

test('every transition carries the full evidence envelope', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(13, 30) });
  c = advanceLifecycle(c, ev({ strategyVersion: 'lifecycle-v1' }));
  const t = c.history.at(-1);
  for (const k of ['from', 'to', 'at', 'reasonCode', 'explanation', 'metrics', 'freshness', 'strategyVersion']) {
    assert.ok(k in t, `transition carries ${k}`);
  }
  assert.equal(t.strategyVersion, 'lifecycle-v1');
  assert.equal(t.freshness.barIsToday, true);
});

test('no-change evals do not append transitions but do refresh updatedAt', () => {
  let c = advanceLifecycle(createCandidate({ ticker: 'ABC', at: at(13, 30) }), ev());
  const len = c.history.length;
  const c2 = advanceLifecycle(c, ev({ now: at(14, 5) }));   // still ACTIONABLE_NOW
  assert.equal(c2.state, STATES.ACTIONABLE_NOW);
  assert.equal(c2.history.length, len, 'no phantom transition when state is unchanged');
  assert.equal(c2.updatedAt, '2026-07-08T14:05:00.000Z');
});

test('summarizeBoard buckets records into the UI sections', () => {
  const mk = state => ({ ...createCandidate({ ticker: state, at: at(13, 30) }), state });
  const board = summarizeBoard([
    mk(STATES.ACTIONABLE_NOW), mk(STATES.BUILDING), mk(STATES.ARMED),
    mk(STATES.TOO_EXTENDED), mk(STATES.FAILED), mk(STATES.STALLING),
    mk(STATES.MANAGING), mk(STATES.CLOSED), null,
  ]);
  assert.equal(board.counts.actionableNow, 1);
  // ARMED now has its own "Armed / Waiting for Trigger" lane (the redesign separates
  // "waiting for the trigger" from generic building/watch), so it is no longer folded in.
  assert.equal(board.counts.buildingNearTrigger, 1);   // BUILDING only
  assert.equal(board.counts.armed, 1);                  // ARMED gets its own lane
  assert.equal(board.counts.tooExtended, 1);
  assert.equal(board.counts.retiredToday, 2);           // FAILED + STALLING
  assert.equal(board.counts.managing, 1);
  assert.equal(board.counts.closed, 1);
});

test('premarket: a premarket-categorized setup can be actionable; a regular one cannot pre-open', () => {
  let c = createCandidate({ ticker: 'ABC', at: at(12, 0) });
  // Regular-only setup pre-open → not actionable (falls to building/watching).
  c = advanceLifecycle(c, ev({ now: at(12, 0), session: 'premarket', premarketSetup: false, nearTrigger: true }));
  assert.notEqual(c.state, STATES.ACTIONABLE_NOW);
  // Explicit premarket setup → eligible.
  let p = createCandidate({ ticker: 'PRE', at: at(12, 0) });
  p = advanceLifecycle(p, ev({ now: at(12, 0), session: 'premarket', premarketSetup: true }));
  assert.equal(p.state, STATES.ACTIONABLE_NOW);
});
