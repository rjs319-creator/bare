'use strict';
// COMPLETED-BAR SEMANTICS + LIVE-PLAN AUTHORITY + LIFECYCLE REACHABILITY (redesign spec).
//
//   • A forming 5-minute bar can never confirm an ORB; the completed bar can (boundary
//     tests minute-by-minute around a bar close).
//   • A forming-bar break is surfaced ONLY as a labeled PROVISIONAL observation.
//   • Same-time-of-day volume compares equivalent COMPLETED intervals.
//   • Stop-breach/target-hit/expiry check the ACTIVE frozen live plan, not the stale
//     daily stop; a current-session day collapse invokes the configured rule.
//   • REVERSAL_RECLAIM is reachable through the PRODUCTION Stage-2 wiring (stage2EvFor),
//     and the failed original's plan is never reused as the reclaim plan.
//   • An actionable state requires a usable live plan (requireLivePlan).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildIntradayFeatures, splitCompletedForming, timeOfDayRelVol,
} = require('../lib/intraday-features');
const { intradayEv } = require('../lib/lifecycle-eval');
const { advanceLifecycle, createCandidate, STATES, REASON } = require('../lib/opportunity-lifecycle');
const { stage2EvFor, LIFECYCLE_CFG } = require('../lib/daytrade-actionability');

// July → EDT (UTC-4). A bar at ET HH:MM is UTC (HH+4):MM.
function bar(etHHMM, o, h, l, c, v) {
  const [H, M] = etHHMM.split(':').map(Number);
  const t = `2026-07-08T${String(H + 4).padStart(2, '0')}:${String(M).padStart(2, '0')}:00.000Z`;
  return { t, o, h, l, c, v };
}
const etNow = (hhmm, ss = '00') => {
  const [H, M] = hhmm.split(':').map(Number);
  return `2026-07-08T${String(H + 4).padStart(2, '0')}:${String(M).padStart(2, '0')}:${ss}.000Z`;
};

// OR 09:30–09:55 trades 99.9–101.0; price then coils UNDER the OR high until the 10:30 bar,
// whose close (101.5) is the FIRST close above the trigger.
function coilThenBreak() {
  return [
    bar('09:30', 100, 100.6, 99.9, 100.4, 2000), bar('09:35', 100.4, 100.9, 100.2, 100.7, 2000),
    bar('09:40', 100.7, 101.0, 100.5, 100.8, 2000), bar('09:45', 100.8, 101.0, 100.6, 100.9, 2000),
    bar('09:50', 100.9, 101.0, 100.7, 100.95, 2000), bar('09:55', 100.95, 101.0, 100.8, 100.9, 2000),
    bar('10:00', 100.9, 100.95, 100.7, 100.8, 2200), bar('10:05', 100.8, 100.9, 100.6, 100.85, 2200),
    bar('10:10', 100.85, 100.95, 100.7, 100.9, 2300), bar('10:15', 100.9, 100.95, 100.75, 100.85, 2300),
    bar('10:20', 100.85, 100.95, 100.7, 100.9, 2400), bar('10:25', 100.9, 100.98, 100.8, 100.95, 2400),
    bar('10:30', 100.95, 101.6, 100.9, 101.5, 4000),   // the breakout bar
  ];
}

test('1/2. boundary minutes: the forming 10:30 bar cannot confirm the ORB; the completed bar can', () => {
  const bars = coilThenBreak();
  // 10:30:00 through 10:34:xx — the 10:30 bar is FORMING. Its 101.5 close-so-far is not evidence.
  for (const hhmm of ['10:30', '10:31', '10:32', '10:33', '10:34']) {
    const f = buildIntradayFeatures({ todayBars: bars, now: etNow(hhmm) });
    assert.equal(f.triggerConfirmed, false, `${hhmm}: forming bar must not confirm`);
    assert.equal(f.last, 100.95, `${hhmm}: last = the 10:25 completed close`);
    assert.equal(f.dataQuality.formingBarPresent, true, `${hhmm}: forming bar present and excluded`);
  }
  // 10:35:00 — the 10:30 bar is COMPLETED. Now it confirms.
  const g = buildIntradayFeatures({ todayBars: bars, now: etNow('10:35') });
  assert.equal(g.triggerConfirmed, true, '10:35: completed breakout bar confirms');
  assert.equal(g.last, 101.5);
  // 10:29:59 — one second before the 10:25 bar's completed status is unaffected; the 10:30
  // bar does not exist yet in a live feed, but if published early it is future → excluded.
  const h = buildIntradayFeatures({ todayBars: bars, now: etNow('10:29', '59') });
  assert.equal(h.triggerConfirmed, false);
  assert.equal(h.last, 100.95);
});

test('splitCompletedForming: publication tolerance and future exclusion', () => {
  const bars = coilThenBreak();
  // Exactly at 10:35:00 the 10:30 bar's end == now → completed (within tolerance).
  const { completed, forming } = splitCompletedForming(bars, etNow('10:35'));
  assert.equal(completed.length, 13);
  assert.equal(forming.length, 0);
  // At 10:34:56 (within the 5s default tolerance of the 10:35 end) it also counts.
  const tol = splitCompletedForming(bars, etNow('10:34', '56'));
  assert.equal(tol.completed.length, 13, 'publication tolerance admits a bar ending within 5s');
  // At 10:34:54 it does not.
  const noTol = splitCompletedForming(bars, etNow('10:34', '54'));
  assert.equal(noTol.completed.length, 12);
  assert.equal(noTol.forming.length, 1);
  // A future-dated bar is neither completed nor forming.
  const future = splitCompletedForming(bars, etNow('10:20'));
  assert.equal(future.completed.length + future.forming.length, 11);
});

test('3. a forming-bar break is surfaced as a labeled PROVISIONAL observation only', () => {
  const f = buildIntradayFeatures({ todayBars: coilThenBreak(), now: etNow('10:32') });
  assert.equal(f.triggerConfirmed, false);
  assert.ok(f.provisionalBreak, 'provisional observation exists');
  assert.equal(f.provisionalBreak.source, 'forming-bar');
  assert.equal(f.provisionalBreak.aboveTrigger, true);
  assert.match(f.provisionalBreak.note, /PROVISIONAL/);
  // And the completed-evidence provenance is stamped.
  assert.equal(f.dataQuality.evidenceBasis, 'completed-bars');
});

test('same-time-of-day volume compares equivalent COMPLETED intervals', () => {
  const bars = coilThenBreak();
  const prior = coilThenBreak().map(b => ({ ...b, v: b.v / 2 }));
  // Mid-bar (10:32): today's side must NOT include the forming 10:30 bar's partial volume.
  const f = buildIntradayFeatures({ todayBars: bars, priorSessions: [prior], now: etNow('10:32') });
  // Cutoff = 10:25 (last completed bar start). Both sides sum bars 09:30..10:25 → exactly 2×.
  assert.equal(f.timeOfDayRelVol, 2);
  // Direct check: the helper is pure over the same completed window.
  const todayCompleted = splitCompletedForming(bars, etNow('10:32')).completed;
  assert.equal(timeOfDayRelVol(todayCompleted, [prior], 55), 2);
});

test('dayChangePct/gapPct derive from the most recent prior session close (production day-collapse input)', () => {
  const prior = [bar('15:55', 100, 100.2, 99.8, 100, 3000)].map(b => ({ ...b, t: b.t.replace('2026-07-08', '2026-07-07') }));
  const today = [bar('09:30', 94, 94.5, 92.8, 93, 5000), bar('09:35', 93, 93.4, 92.9, 93.2, 4000)];
  const f = buildIntradayFeatures({ todayBars: today, priorSessions: [prior], now: etNow('09:41') });
  assert.equal(f.prevClose, 100);
  assert.equal(f.dayChangePct, -6.8);   // 93.2 vs 100
  assert.equal(f.gapPct, -6);           // open 94 vs 100
});

test('15. a current-session day collapse invokes the configured rule (FAILED / DAY_COLLAPSE)', () => {
  const prior = [bar('15:55', 100, 100.2, 99.8, 100, 3000)].map(b => ({ ...b, t: b.t.replace('2026-07-08', '2026-07-07') }));
  const today = [bar('09:30', 94, 94.5, 92.8, 93.4, 5000), bar('09:35', 93.4, 93.8, 93.2, 93.6, 4000)];
  const f = buildIntradayFeatures({ todayBars: today, priorSessions: [prior], now: etNow('09:41') });
  const ev = intradayEv({ ticker: 'CLPS', candidateDate: '2026-07-08' }, f, { now: etNow('09:41') });
  assert.equal(ev.dayCollapsed, true);
  const rec = advanceLifecycle(null, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG);
  assert.equal(rec.state, STATES.FAILED);
  assert.equal(rec.history.at(-1).reasonCode, REASON.DAY_COLLAPSE);
});

// Minimal feature object for plan-authority tests (intradayEv tolerates missing fields).
const fWithPlan = (last, livePlan) => ({
  hasIntraday: true, bars: 10, nowSinceOpen: 60, asOf: etNow('10:30'), completedAsOf: etNow('10:25'),
  last, livePlan, dailyAtr: 1, aboveVwap: true, triggerConfirmed: true, breakoutFailed: false,
  openingRange: { high: 100, low: 98 }, orComplete: true, openingRangeForming: false,
  mom15: 0.01, mom5: 0.005, residual15: 0.005, timeOfDayRelVol: 2,
});

test('10. the ACTIVE live-plan stop — not the stale daily stop — causes failure (STOP_REACHED)', () => {
  const lp = { basis: 'live-intraday', entry: 101, stop: 100, target: 103, expiresAt: etNow('12:30') };
  // Price 99.9: BELOW the live-plan stop (100) but far ABOVE the stale daily stop (95).
  const ev = intradayEv({ ticker: 'STP', candidateDate: '2026-07-08', stop: 95 }, fWithPlan(99.9, lp), { now: etNow('10:31') });
  assert.equal(ev.stopBreached, true);
  assert.equal(ev.stopBasis, 'live-plan');
  const rec = advanceLifecycle(null, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG);
  assert.equal(rec.state, STATES.FAILED);
  assert.equal(rec.history.at(-1).reasonCode, REASON.STOP_REACHED);
  // Without a live plan the daily stop is only a LABELED fallback.
  const evDaily = intradayEv({ ticker: 'STP', candidateDate: '2026-07-08', stop: 95 }, fWithPlan(94.5, null), { now: etNow('10:31') });
  assert.equal(evDaily.stopBasis, 'daily-plan');
});

test('target reached against the ACTIVE live plan retires the setup as TARGET_REACHED (no position implied)', () => {
  const lp = { basis: 'live-intraday', entry: 101, stop: 100, target: 103, expiresAt: etNow('12:30') };
  const ev = intradayEv({ ticker: 'TGT', candidateDate: '2026-07-08' }, fWithPlan(103.2, lp), { now: etNow('10:31') });
  assert.equal(ev.targetReached, true);
  const rec = advanceLifecycle(null, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG);
  assert.equal(rec.state, STATES.TARGET_REACHED);
  assert.equal(rec.history.at(-1).reasonCode, REASON.TARGET_REACHED);
  assert.match(rec.history.at(-1).explanation, /no position implied/);
});

test('an expired frozen plan produces an explicit PLAN_EXPIRED transition, never a silent re-mint', () => {
  // Prior record: ACTIONABLE with a plan whose entry window closed 10 minutes ago.
  let prior = createCandidate({ ticker: 'EXP', at: etNow('10:00') });
  prior = { ...prior, state: STATES.ACTIONABLE_NOW, activePlan: { basis: 'live-intraday', entry: 101, stop: 100, target: 103, expiresAt: etNow('10:20'), setupId: prior.setupId } };
  const f = fWithPlan(101.5, null);
  const ev = stage2EvFor({ ticker: 'EXP', candidateDate: '2026-07-08' }, f, { now: etNow('10:31'), priorRec: prior });
  assert.equal(ev.planExpired, true);
  assert.equal(ev.livePlan, null, 'no fresh plan is minted over an expired one');
  const rec = advanceLifecycle(prior, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG);
  assert.equal(rec.state, STATES.EXPIRED);
  assert.equal(rec.history.at(-1).reasonCode, REASON.PLAN_EXPIRED);
});

// A genuine collapse-then-reclaim session: OR 99.9–101, breakout, dump below VWAP, then a
// confirmed reclaim (2 completed closes above VWAP, close back above the OR high).
function reclaimSession() {
  return [
    bar('09:30', 100, 100.6, 99.9, 100.4, 2000), bar('09:35', 100.4, 100.9, 100.2, 100.7, 2000),
    bar('09:40', 100.7, 101.0, 100.5, 100.8, 2000), bar('09:45', 100.8, 101.0, 100.6, 100.9, 2000),
    bar('09:50', 100.9, 101.0, 100.7, 100.95, 2000), bar('09:55', 100.95, 101.0, 100.8, 101.0, 2000),
    bar('10:00', 101.0, 101.6, 100.9, 101.4, 2500),   // breaks out
    bar('10:05', 101.4, 101.5, 99.2, 99.4, 4000),     // dumps below VWAP
    bar('10:10', 99.4, 99.8, 99.1, 99.5, 3000),       // second close below VWAP → FAILED earlier
    bar('10:15', 99.5, 101.0, 99.4, 100.9, 5000),     // reclaim close 1 (above running VWAP)
    bar('10:20', 100.9, 101.6, 100.8, 101.3, 5000),   // reclaim close 2 + back above OR high
  ];
}

test('13/14. REVERSAL_RECLAIM is reachable via PRODUCTION wiring, on a NEW plan (never the failed original)', () => {
  const NOW = etNow('10:25');
  const bars = reclaimSession();
  const prior = reclaimSession().map(b => ({ ...b, v: b.v / 2, t: b.t.replace('2026-07-08', '2026-07-07') }));
  const spy = reclaimSession().map(b => ({ ...b, o: 500, h: 500.2, l: 499.8, c: 500 }));
  const f = buildIntradayFeatures({ todayBars: bars, priorSessions: [prior], spyTodayBars: spy, now: NOW, dailyAtr: 1.5 });
  assert.ok(f.closesAboveVwapStreak >= 2, `confirmed reclaim streak (${f.closesAboveVwapStreak})`);
  assert.equal(f.triggerConfirmed, true);

  // The FAILED original, with its plan retired (never reusable as live).
  let failedRec = createCandidate({ ticker: 'RCLM', at: etNow('10:12') });
  failedRec = {
    ...failedRec, state: STATES.FAILED,
    retiredPlan: { basis: 'live-intraday', entry: 101.4, stop: 100.2, target: 103.8, expiresAt: etNow('12:00') },
    history: [...failedRec.history, { from: 'ACTIONABLE_NOW', to: 'FAILED', at: etNow('10:12'), reasonCode: 'FAIL_VWAP_LOSS' }],
  };

  const ev = stage2EvFor(
    { ticker: 'RCLM', candidateDate: '2026-07-08' }, f,
    { now: NOW, quote: { price: 101.3, asOf: NOW }, priorRec: failedRec },
  );
  assert.equal(ev.archetype, 'reversal_reclaim', 'production wiring sets the archetype');
  assert.equal(ev.reclaimConfirmed, true);
  assert.equal(ev.newPlan, true, 'the reclaim plan was minted THIS cycle');
  assert.notEqual(ev.livePlan.entry, failedRec.retiredPlan.entry, 'not the failed original plan');

  const rec = advanceLifecycle(failedRec, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG);
  assert.equal(rec.state, STATES.REVERSAL_RECLAIM);
  assert.notEqual(rec.setupId, failedRec.setupId, 'a confirmed reclaim mints a NEW setup identity');
});

test('an actionable state requires a usable live plan under the production config (requireLivePlan)', () => {
  const green = {
    ticker: 'NOPLAN', now: etNow('10:31'), session: 'regular', actionableFresh: true,
    freshness: { freshnessStatus: 'FRESH_TODAY' },
    aboveVwap: true, momentumOk: true, residualOk: true, relVolOk: true, triggerConfirmed: true,
    remainingRR: 2, extensionAtr: 1, livePlan: null,
  };
  const rec = advanceLifecycle(null, { strategy: 'daytrade', ...green }, LIFECYCLE_CFG);
  assert.notEqual(rec.state, STATES.ACTIONABLE_NOW, 'no live plan → cannot be ACTIONABLE_NOW');
  // The generic engine default (no requireLivePlan) is unchanged for other consumers.
  const generic = advanceLifecycle(null, { strategy: 'daytrade', ...green });
  assert.equal(generic.state, STATES.ACTIONABLE_NOW);
});
