'use strict';
// EARLY-RUNNER / DUD ENGINE regression tests — the redesign's specified scenarios that are
// NOT already covered by daytrade-hims-regression / opportunity-lifecycle / lifecycle-wiring.
const test = require('node:test');
const assert = require('node:assert');

const { isActionableFresh, computeFreshness } = require('../lib/freshness');
const { selectDeepPool, computeLivePlan, classifyPool, collectTransitions, buildCanonicalCard, runActionability } = require('../lib/daytrade-actionability');
const { advanceLifecycle, STATES } = require('../lib/opportunity-lifecycle');
const { intradayEv } = require('../lib/lifecycle-eval');
const { buildIntradayFeatures } = require('../lib/intraday-features');
const { cusumStep } = require('../lib/intraday-discovery');
const { classifyTransition, buildAlert } = require('../lib/daytrade-alerts');
const { runnerScore, dudScore } = require('../lib/runner-dud');
const { gradeHorizons } = require('../lib/outcome-grade');
const CFG = require('../lib/daytrade-config');

// A regular-hours instant (10:30 ET on a Wednesday) used throughout.
const NOW = '2026-07-08T14:30:00.000Z';
const bar = (hm, o, h, l, c, v) => ({ t: `2026-07-08T${hm}:00.000Z`, o, h, l, c, v });
const risingBars = () => [
  bar('13:30', 100, 100.5, 99.9, 100.4, 5000), bar('13:35', 100.4, 100.8, 100.3, 100.7, 5200),
  bar('13:40', 100.7, 101.0, 100.6, 100.9, 5400), bar('13:45', 100.9, 101.0, 100.7, 100.9, 4800),
  bar('13:50', 100.9, 101.0, 100.8, 100.95, 4600), bar('13:55', 100.95, 101.0, 100.8, 100.9, 4400),
  bar('14:00', 100.9, 101.5, 100.9, 101.4, 6000), bar('14:05', 101.4, 102.0, 101.3, 101.9, 6500),
  bar('14:10', 101.9, 102.4, 101.8, 102.3, 7000), bar('14:15', 102.3, 102.6, 102.2, 102.5, 7200),
  bar('14:20', 102.5, 102.8, 102.4, 102.7, 7400), bar('14:25', 102.7, 103.0, 102.6, 102.9, 7600),
  bar('14:30', 102.9, 103.1, 102.8, 103.0, 7800),
];

// ── Freshness: BOTH halves required; future-dated fails closed ────────────────
test('10. stale quote + fresh bar fails actionability freshness', () => {
  const f = computeFreshness({ barDate: '2026-07-08', intradayBarAsOf: NOW, quoteAsOf: '2026-07-08T14:00:00Z', now: new Date(NOW) });
  assert.equal(isActionableFresh(f, { now: new Date(NOW) }), false);   // quote 30 min old
});

test('11. fresh quote + stale bar fails actionability freshness', () => {
  const f = computeFreshness({ barDate: '2026-07-08', intradayBarAsOf: '2026-07-08T13:30:00Z', quoteAsOf: NOW, now: new Date(NOW) });
  assert.equal(isActionableFresh(f, { now: new Date(NOW) }), false);   // bar 60 min old
});

test('11b. fresh quote + fresh bar passes', () => {
  const f = computeFreshness({ barDate: '2026-07-08', intradayBarAsOf: '2026-07-08T14:25:00Z', quoteAsOf: '2026-07-08T14:29:30Z', now: new Date(NOW) });
  assert.equal(isActionableFresh(f, { now: new Date(NOW) }), true);
});

test('12. future-dated data fails closed (never "extra fresh")', () => {
  const future = '2026-07-08T15:30:00Z';   // an hour ahead of NOW
  const f = computeFreshness({ barDate: '2026-07-08', intradayBarAsOf: future, quoteAsOf: future, now: new Date(NOW) });
  assert.equal(isActionableFresh(f, { now: new Date(NOW) }), false);
});

// ── Global deep-pool selection: no family can consume the budget ──────────────
test('2. a globally strong explosive/expanded candidate is not crowded out by 30+ momentum rows', () => {
  const ml = Array.from({ length: 40 }, (_, i) => ({ ticker: `ML${i}`, scan: 'momentum_liquid', relVol: 1.6, pctChange: 5.2, excessPct: 1 }));
  const monster = { ticker: 'BOOM', scan: 'explosive_small', relVol: 12, pctChange: 22, excessPct: 20 };
  const expanded = { ticker: 'EXPX', scan: 'momentum_liquid', source: 'expanded', relVol: 8, pctChange: 15, excessPct: 13 };
  const pool = selectDeepPool([...ml, monster, expanded], { maxNames: 30 });
  const names = pool.map(p => p.ticker);
  assert.ok(names.includes('BOOM'), 'strongest cross-sectional name must get live validation');
  assert.ok(names.includes('EXPX'), 'expanded-universe name must compete in the same ranking');
  assert.ok(names.indexOf('BOOM') < 3, 'monster anomaly ranks at the top');
});

test('2b. an already-ACTIONABLE name keeps its validation slot over new watchers (failure detection first)', () => {
  const crowd = Array.from({ length: 60 }, (_, i) => ({ ticker: `N${i}`, relVol: 5, pctChange: 9, excessPct: 8 }));
  const held = { ticker: 'HELD', relVol: 1.1, pctChange: 1.5, excessPct: 0.2 };
  const prior = { HELD: { state: STATES.ACTIONABLE_NOW } };
  const pool = selectDeepPool([...crowd, held], { priorRecords: prior, maxNames: 30 });
  assert.equal(pool[0].ticker, 'HELD', 'active lifecycle names are revalidated first');
});

test('deep-pool cap is configurable (maxNames is honored)', () => {
  const picks = Array.from({ length: 50 }, (_, i) => ({ ticker: `T${i}`, relVol: 2, pctChange: 5, excessPct: 1 }));
  assert.equal(selectDeepPool(picks, { maxNames: 7 }).length, 7);
  assert.equal(CFG.STAGE2.MAX_NAMES >= 5, true);
});

// ── Live plan recomputation ───────────────────────────────────────────────────
test('13. a live trigger generates a newly recomputed plan (never the stale daily levels)', () => {
  const f = buildIntradayFeatures({ todayBars: risingBars(), now: NOW, dailyAtr: 2, plan: { entry: 90, stop: 88, target: 94 } });
  const lp = computeLivePlan(f, { now: NOW });
  assert.ok(lp, 'live plan computed from intraday evidence');
  assert.equal(lp.basis, 'live-intraday');
  assert.ok(Math.abs(lp.entry - 103) < 0.2, `entry anchored to the LIVE price (${lp.entry}), not yesterday's close (90)`);
  assert.ok(lp.stop < lp.entry && lp.target > lp.entry, 'ordered plan');
  assert.ok(lp.expiresAt, 'plan carries an explicit expiry');
});

test('13b. an actionable card surfaces the live plan; the stale daily plan survives only as provenance', () => {
  const spyFlat = risingBars().map(b => ({ ...b, o: 500, h: 500.4, l: 499.8, c: 500.1 }));
  const f = buildIntradayFeatures({ todayBars: risingBars(), priorSessions: [risingBars().map(b => ({ ...b, v: b.v / 2 }))], spyTodayBars: spyFlat, now: NOW, dailyAtr: 2, plan: { entry: 90, stop: 88, target: 94 } });
  const lp = computeLivePlan(f, { now: NOW });
  const ev = intradayEv({ ticker: 'ABC', candidateDate: '2026-07-08', entry: 90, stop: 88, target: 94 }, { ...f, livePlan: lp, remainingRR: lp.remainingRR }, { now: NOW, quote: { price: 103, asOf: NOW } });
  const rec = advanceLifecycle(null, { strategy: 'daytrade', ...ev });
  assert.equal(rec.state, STATES.ACTIONABLE_NOW);
  const card = buildCanonicalCard({ ticker: 'ABC', entry: 90, stop: 88, target: 94, rr: 2, date: '2026-07-07' }, ev, rec, { now: NOW });
  assert.equal(card.planBasis, 'live-intraday');
  assert.equal(card.entry, lp.entry);
  assert.equal(card.stop, lp.stop);
  assert.notEqual(card.stop, 88, 'old daily stop is never displayed as the live plan');
  assert.equal(card.originalPlan.stop, 88, 'original plan preserved as provenance');
  assert.equal(card.planValid, true);
});

test('13c. an actionable state WITHOUT a live plan fails closed (planValid=false)', () => {
  const rec = { ticker: 'X', state: STATES.ACTIONABLE_NOW, history: [], setupId: 'X|2026-07-08|s1' };
  const card = buildCanonicalCard({ ticker: 'X', entry: 90, stop: 88, target: 94 }, { metrics: {} }, rec, { now: NOW });
  assert.equal(card.planValid, false);
  assert.equal(card.entry, null, 'no live plan → no buy levels surfaced');
});

// ── Persistent lifecycle across refreshes ─────────────────────────────────────
test('4. persistent lifecycle state survives multiple refreshes (cooldown blocks instant re-arm)', async () => {
  const failedEv = { ticker: 'HYST', now: NOW, session: 'regular', freshness: { freshnessStatus: 'FRESH_TODAY' }, breakoutFailed: true };
  const failed = advanceLifecycle(null, { strategy: 'daytrade', ...failedEv });
  assert.equal(failed.state, STATES.FAILED);
  // A later "refresh" evaluates fully-green evidence 5 minutes later, with the PERSISTED record.
  const green = {
    ticker: 'HYST', now: '2026-07-08T14:35:00.000Z', session: 'regular',
    actionableFresh: true, freshness: { freshnessStatus: 'FRESH_TODAY' },
    aboveVwap: true, momentumOk: true, residualOk: true, relVolOk: true, triggerConfirmed: true,
    remainingRR: 2, extensionAtr: 1,
  };
  const out = await runActionability([{ ticker: 'HYST', pctChange: 5, relVol: 2 }], {
    now: '2026-07-08T14:35:00.000Z', doStage2: false, priorRecords: { HYST: failed },
  });
  // Without persistence this would be a fresh WATCHING→? one-shot; with it, the cooldown holds.
  assert.notEqual(out.records.HYST.state, STATES.ACTIONABLE_NOW, 'cooldown must survive the refresh');
  assert.ok(out.records.HYST.history.length >= failed.history.length, 'history carried forward');
});

test('4b. a tracked name that drops out of the scan is carried forward, not erased', async () => {
  const prior = advanceLifecycle(null, { ticker: 'GONE', now: NOW, session: 'regular', freshness: { freshnessStatus: 'FRESH_TODAY' }, momentumOk: true });
  const out = await runActionability([{ ticker: 'OTHER', pctChange: 3, relVol: 2 }], { now: NOW, doStage2: false, priorRecords: { GONE: prior } });
  assert.ok(out.records.GONE, 'absent name still tracked');
  assert.ok(out.byTicker.GONE.card, 'absent name still renders a card');
});

// ── Transition alerts: exactly once ───────────────────────────────────────────
test('5. a transition alert fires exactly once (no transition on an unchanged state)', () => {
  const prior = {};
  const ev = { ticker: 'ALRT', now: NOW, session: 'regular', freshness: { freshnessStatus: 'FRESH_TODAY' }, momentumOk: true };
  const by1 = classifyPool([{ ticker: 'ALRT', pctChange: 4, relVol: 2, barIsToday: true, freshness: { freshnessStatus: 'FRESH_TODAY' } }], { now: NOW, priorRecords: prior });
  const t1 = collectTransitions(prior, by1);
  assert.ok(t1.length >= 1, 'first evaluation produces a bootstrap-side transition');
  // Second refresh with the SAME evidence → same state → NO transition → no alert.
  const persisted = Object.fromEntries(Object.entries(by1).map(([t, x]) => [t, x.record]));
  const by2 = classifyPool([{ ticker: 'ALRT', pctChange: 4, relVol: 2, barIsToday: true, freshness: { freshnessStatus: 'FRESH_TODAY' } }], { now: '2026-07-08T14:31:00.000Z', priorRecords: persisted });
  const t2 = collectTransitions(persisted, by2);
  assert.equal(t2.length, 0, 'unchanged state re-emits nothing');
});

test('5b. alert classification: entries loud, retirements reasoned, watch silent', () => {
  assert.equal(classifyTransition({ from: STATES.ARMED, to: STATES.ACTIONABLE_NOW }).kind, 'entry');
  assert.equal(classifyTransition({ from: STATES.ACTIONABLE_NOW, to: STATES.FAILED }).kind, 'retire');
  assert.equal(classifyTransition({ from: STATES.ACTIONABLE_NOW, to: STATES.TOO_EXTENDED }).kind, 'caution');
  assert.equal(classifyTransition({ from: null, to: STATES.WATCHING }), null);
  assert.equal(classifyTransition({ from: STATES.WATCHING, to: STATES.BUILDING }), null);
});

test('5c. an alert carries plan, evidence, latency and the dedup identity', () => {
  const a = buildAlert({
    ticker: 'ALRT', from: STATES.ARMED, to: STATES.ACTIONABLE_NOW, at: NOW, reasonCode: 'ACTIONABLE_CONFIRMED',
    setupId: 'ALRT|2026-07-08|s1', firstSeenAt: '2026-07-08T13:40:00.000Z',
    card: { currentPrice: 103, livePlan: { entry: 103, stop: 101, target: 107, rr: 2, trigger: 101, expiresAt: '2026-07-08T16:30:00Z', basis: 'live-intraday' }, remainingRR: 2, runnerScore: 70, dudScore: 15, scoreBasis: 'deterministic', triggerConfirmed: true, aboveVwap: true, execution: { quoteAgeSeconds: 5 } },
  }, { now: NOW });
  assert.equal(a.id, 'daytrade|ALRT|ALRT|2026-07-08|s1|ACTIONABLE_NOW');
  assert.equal(a.alertLatencyMin, 50);
  assert.equal(a.plan.stop, 101);
  assert.ok(a.drivers.positive.length >= 2);
});

// ── Revival identity: the failed original cannot reuse its plan ───────────────
test('14. a revival mints a NEW setupId and requires a live (new) plan', () => {
  const failedEv = { ticker: 'REV', now: NOW, session: 'regular', freshness: { freshnessStatus: 'FRESH_TODAY' }, breakoutFailed: true };
  const failed = advanceLifecycle(null, { strategy: 'daytrade', ...failedEv });
  const s1 = failed.setupId;
  // Revival AFTER cooldown expiry with fully-green strict evidence.
  const later = '2026-07-08T15:00:00.000Z';
  const green = {
    ticker: 'REV', now: later, session: 'regular', actionableFresh: true,
    freshness: { freshnessStatus: 'FRESH_TODAY' },
    aboveVwap: true, momentumOk: true, residualOk: true, relVolOk: true, triggerConfirmed: true,
    remainingRR: 2, extensionAtr: 1,
  };
  const revived = advanceLifecycle(failed, { strategy: 'daytrade', ...green });
  assert.equal(revived.state, STATES.ACTIONABLE_NOW);
  assert.notEqual(revived.setupId, s1, 'revival = new setup identity');
  // And the card for the revived setup shows ONLY a live-recomputed plan.
  const card = buildCanonicalCard({ ticker: 'REV', entry: 90, stop: 88, target: 94 }, { ...green, metrics: {}, livePlan: null }, revived, { now: later });
  assert.equal(card.planValid, false, 'without a live plan the revived setup cannot carry buy levels');
  assert.equal(card.entry, null);
});

// ── Discovery: change detection before the +2% floor ──────────────────────────
test('1. CUSUM flags a liquid name accelerating abnormally, below the +2% day floor', () => {
  // 0.05%/min drift on a name whose normal per-minute vol is 0.02% → z=2.5/min.
  let s = { lastPrice: 100, lastTs: 0, ewmaPmVol: 0.0002, cusum: 0 };
  let price = 100, t = 0, alarmed = 0;
  for (let i = 0; i < 10; i++) {
    price *= 1.0005; t += 60000;   // +0.05% per minute
    s = { ...cusumStep(s, price, t), ewmaPmVol: 0.0002 };   // hold the baseline vol fixed for the test
    if (s.cusum >= CFG.DISCOVERY.CUSUM_H) { alarmed = i + 1; break; }
  }
  assert.ok(alarmed > 0 && alarmed <= 10, `alarms within minutes (${alarmed} min)`);
  assert.ok((price / 100 - 1) * 100 < 2, `day move still under the +2% Building floor (${((price / 100 - 1) * 100).toFixed(2)}%)`);
});

test('1b. a discovery anomaly enters the lifecycle as WATCH/BUILDING — never actionable from daily-shape evidence', () => {
  const anomaly = { ticker: 'NEWX', scan: 'discovery', source: 'discovery', last: 12.4, pctChange: 1.4, excessPct: 1.2, relVol: null, barIsToday: true, freshness: { freshnessStatus: 'FRESH_TODAY' }, date: '2026-07-08' };
  const by = classifyPool([anomaly], { now: NOW });
  const st = by.NEWX.record.state;
  assert.ok([STATES.WATCHING, STATES.BUILDING].includes(st), `enters as watch/building (${st})`);
  assert.equal(by.NEWX.card.actionable, false, 'no actionable state without full Stage-2 evidence');
});

test('cusumStep: a calm name does not alarm', () => {
  let s = { lastPrice: 100, lastTs: 0, ewmaPmVol: 0.0002, cusum: 0 };
  let price = 100, t = 0;
  for (let i = 0; i < 30; i++) {
    price *= (i % 2 === 0 ? 1.0001 : 0.9999); t += 60000;
    s = { ...cusumStep(s, price, t), ewmaPmVol: 0.0002 };
  }
  assert.ok(s.cusum < CFG.DISCOVERY.CUSUM_H, `no alarm on noise (cusum ${s.cusum})`);
});

// ── Expanded universe: canonical envelope required ────────────────────────────
test('3. an expanded-universe row classified without Stage-2 evidence is never actionable', () => {
  const expRow = { ticker: 'EXPA', scan: 'momentum_liquid', source: 'expanded', pctChange: 6, relVol: 2.4, barIsToday: false, freshness: { freshnessStatus: 'PRIOR_SESSION' }, date: '2026-07-07', entry: 50, stop: 48, target: 54 };
  const by = classifyPool([expRow], { now: NOW });
  const card = by.EXPA.card;
  assert.equal(card.actionable, false);
  assert.equal(card.lifecycleState, STATES.PRIOR_SESSION_WATCH);
  assert.equal(card.currentSessionFresh, false);
});

// ── Runner/dud research scores ────────────────────────────────────────────────
test('runner/dud scores are independent, bounded, and null without intraday evidence', () => {
  const strong = { triggerConfirmed: true, aboveVwap: true, mom15: 0.01, residualVsSpy: 1.2, timeOfDayRelVol: 3.5, remainingRR: 2, extensionAtr: 1, currentVwap: 100 };
  const weak = { triggerConfirmed: false, aboveVwap: false, mom15: -0.01, residualVsSpy: -1, closesBelowVwap: 2, volumeFading: true, lowerHighs: 2, currentVwap: 100, stopBreached: true };
  const r1 = runnerScore(strong), d1 = dudScore(strong);
  const r2 = runnerScore(weak), d2 = dudScore(weak);
  assert.ok(r1.score > 60 && d1.score < 40, `strong: runner ${r1.score} dud ${d1.score}`);
  assert.ok(r2.score < 40 && d2.score > 60, `weak: runner ${r2.score} dud ${d2.score}`);
  assert.equal(runnerScore({}), null, 'no evidence → null, never fabricated');
  assert.equal(dudScore(null), null);
});

// ── Multi-horizon grading ─────────────────────────────────────────────────────
test('30/60/120-minute horizon labels use only post-decision bars within each horizon', () => {
  const decisionAt = '2026-07-08T14:30:00.000Z';
  const fwd = [
    { t: '2026-07-08T14:40:00.000Z', o: 100, h: 100.4, l: 99.8, c: 100.2, v: 1 },
    { t: '2026-07-08T15:20:00.000Z', o: 100.2, h: 100.6, l: 100.0, c: 100.5, v: 1 },
    { t: '2026-07-08T16:20:00.000Z', o: 100.5, h: 101.2, l: 100.4, c: 101.1, v: 1 },   // +0.5-ATR barrier (ATR=2 → up 101)
  ];
  const h = gradeHorizons({ decisionPrice: 100, decisionAt, atr: 2, forwardBars: fwd });
  assert.equal(h.h30.barrier, 'TIMEOUT', '30-min window ends before the barrier hit');
  assert.equal(h.h60.barrier, 'TIMEOUT');
  assert.equal(h.h120.barrier, 'SUCCESS', 'the 16:20 barrier-hit bar is inside the 120-min window');
});

// ── Regime policy: no hard suppression without a passed evidence gate ─────────
test('20. regime context cannot hard-suppress unless the policy explicitly passed its evidence gate', () => {
  assert.equal(CFG.REGIME.HARD_SUPPRESS, false, 'hard suppression is off by default');
  assert.equal(CFG.REGIME.EVIDENCE_GATE, 'not-passed');
  // The route computes: suppress = riskOff && HARD_SUPPRESS === true — so with the gate
  // not passed, risk-off can never empty the lists.
  const suppress = true && CFG.REGIME.HARD_SUPPRESS === true;
  assert.equal(suppress, false);
});

// ── Execution context: unknown is never favorable ─────────────────────────────
test('execution fields default to unknown, never favorable', () => {
  const rec = advanceLifecycle(null, { ticker: 'EXEC', now: NOW, session: 'regular', freshness: { freshnessStatus: 'FRESH_TODAY' }, momentumOk: true });
  const card = buildCanonicalCard({ ticker: 'EXEC' }, { metrics: {} }, rec, { now: NOW });
  assert.equal(card.execution.spreadStatus, 'unknown');
  assert.equal(card.execution.haltStatus, 'unknown');
  assert.equal(card.execution.spreadPct, null);
});
