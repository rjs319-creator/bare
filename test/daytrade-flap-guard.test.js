'use strict';
// ANTI-FLAPPING + TWO-STAGE ALERT CONTRACT — the integration tests the redesign spec
// demands. These reproduce the production defect (ACTIONABLE_NOW → STALLING → ACTIONABLE_NOW
// on repeated evaluations) and prove the layered guards hold: episode-stable setup identity,
// cooldowns, hysteresis, revival confirmation, dedup keys, retirement suppression, budgets,
// early-watch language, and stale-daily priority decay.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { STATES, REASON, advanceLifecycle } = require('../lib/opportunity-lifecycle');
const {
  classifyPool, collectTransitions, collectEarlyTransitions, selectDeepPoolDetailed,
  stampEarlyState, LIFECYCLE_CFG,
} = require('../lib/daytrade-actionability');
const {
  buildAlert, buildEarlyAlert, classifyTransition, feedTitle, feedDetail,
  withAlertMarks, episodeWasAlerted, applyAlertBudgets, emitDaytradeAlerts,
} = require('../lib/daytrade-alerts');
const CFG = require('../lib/daytrade-config');

const NOW = '2026-07-08T14:30:00.000Z';   // 10:30 ET — regular session
const at = (h, m) => `2026-07-08T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

// A fully-green actionable evaluation for the pure engine.
const green = (now, extra = {}) => ({
  ticker: 'FLAP', now, session: 'regular', actionableFresh: true,
  freshness: { freshnessStatus: 'FRESH_TODAY' },
  aboveVwap: true, momentumOk: true, residualOk: true, relVolOk: true, triggerConfirmed: true,
  remainingRR: 2, extensionAtr: 1,
  // Production contract (requireLivePlan): actionable requires a usable current live plan.
  livePlan: { basis: 'live-intraday', entry: 100, stop: 98, target: 104, trigger: 99.5, expiresAt: '2026-07-08T20:00:00.000Z' },
  ...extra,
});
const stall = (now) => green(now, { momentumOk: false, triggerConfirmed: false, relVolOk: false });

// ── THE spec-mandated regression: ACTIONABLE_NOW → STALLING → ACTIONABLE_NOW ──
test('flap loop cannot re-emit entry alerts or mint new setup ids without material change', () => {
  // Simulate the durable alert-log dedup across cycles with an id set, exactly as the
  // production day log does.
  const emittedIds = new Set();
  const alertsFor = (transitions) => {
    const built = transitions.map(tr => buildAlert(tr, { now: tr.at })).filter(Boolean);
    const fresh = built.filter(a => !emittedIds.has(a.id));
    fresh.forEach(a => emittedIds.add(a.id));
    return fresh;
  };

  // Cycle 1: confirmed → ONE entry alert.
  let rec = advanceLifecycle(null, { strategy: 'daytrade', ...green(at(14, 30)) }, LIFECYCLE_CFG);
  assert.equal(rec.state, STATES.ACTIONABLE_NOW);
  const s1 = rec.setupId;
  let fresh = alertsFor([{ ticker: 'FLAP', from: null, to: rec.state, at: at(14, 30), reasonCode: 'ACTIONABLE_CONFIRMED', setupId: rec.setupId, card: {} }]);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].kind, 'entry');

  // Cycle 2: momentum blip → STALLING (retire transition, cooldown armed).
  rec = advanceLifecycle(rec, { strategy: 'daytrade', ...stall(at(14, 31)) }, LIFECYCLE_CFG);
  assert.equal(rec.state, STATES.STALLING);
  assert.ok(rec.cooldownUntil, 'soft retirement arms a cooldown');

  // Cycles 3..10: alternating green/stall ticks INSIDE the cooldown — the exact production
  // flap pattern. Nothing may revive, nothing may alert as an entry, no new setup id.
  const newAlerts = [];
  for (let i = 0; i < 8; i++) {
    const ev = i % 2 === 0 ? green(at(14, 32 + i)) : stall(at(14, 32 + i));
    const before = rec.state;
    rec = advanceLifecycle(rec, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG);
    assert.notEqual(rec.state, STATES.ACTIONABLE_NOW, `tick ${i}: cooldown blocks re-actionable`);
    if (rec.state !== before) {
      const last = rec.history.at(-1);
      if (last && last.reasonCode) {
        newAlerts.push(...alertsFor([{ ticker: 'FLAP', from: before, to: rec.state, at: last.at, reasonCode: last.reasonCode, setupId: rec.setupId, card: {} }]));
      }
    }
  }
  assert.equal(rec.setupId, s1, 'no new setup id was minted by the flap loop');
  assert.equal(newAlerts.filter(a => a.kind === 'entry' || a.kind === 'revive').length, 0,
    'the flap loop emitted zero additional bullish alerts');

  // Even after the cooldown expires and it revives (2 consecutive greens, non-material),
  // the setupId is UNCHANGED — so the revive alert's dedup id collides with the ledger and
  // cannot re-notify. (COOLDOWN_HOLD may park it in ARMED first; both paths share the id.)
  rec = advanceLifecycle(rec, { strategy: 'daytrade', ...green(at(15, 5)) }, LIFECYCLE_CFG);
  rec = advanceLifecycle(rec, { strategy: 'daytrade', ...green(at(15, 6)) }, LIFECYCLE_CFG);
  rec = advanceLifecycle(rec, { strategy: 'daytrade', ...green(at(15, 7)) }, LIFECYCLE_CFG);
  assert.equal(rec.state, STATES.ACTIONABLE_NOW, 'eventually revives once genuinely stable');
  assert.equal(rec.setupId, s1, 'revival without material change keeps the episode identity');
  const last = rec.history.at(-1);
  const reAlerts = alertsFor([{ ticker: 'FLAP', from: STATES.STALLING, to: rec.state, at: last.at, reasonCode: last.reasonCode, setupId: rec.setupId, card: {} }]);
  assert.equal(reAlerts.length, 0, 'same setupId → same dedup id → no duplicate bullish alert');
});

// ── Early Watch alerts: language + once-per-state-per-episode ─────────────────
test('early alerts carry watch-only language and never confirmed-buy copy', () => {
  const a = buildEarlyAlert({
    ticker: 'ERLY', from: 'SCOUT', to: 'IGNITION', at: NOW, setupId: 'ERLY|2026-07-08|s1',
    firstDetectedAt: at(14, 10),
    card: { earlyWhy: ['interval shock z=3.1', 'participation accelerating'], earlyBasis: 'early-signal research state (deterministic, uncalibrated — a watch annotation, not a buy signal or probability)', triggerConfirmed: false, aboveVwap: true, currentPrice: 12.4, execution: { quoteAgeSeconds: 20 } },
  }, { now: NOW });
  assert.equal(a.kind, 'early_watch');
  assert.match(a.actionability, /NOT a confirmed entry/);
  assert.ok(a.confirmationMissing.length >= 1, 'states what confirmation is still missing');
  assert.ok(a.invalidation, 'states invalidation conditions');
  assert.equal(a.sinceFirstDetectionMin, 20);
  assert.equal(a.plan, undefined, 'an early alert NEVER carries buy levels');
  const title = feedTitle(a); const detail = feedDetail(a);
  for (const text of [title, detail]) {
    assert.ok(!/buy|entry \d|confirmed runner|trigger met/i.test(text), `no buy language: "${text}"`);
  }
  assert.match(title, /watching, not a trade/);
  assert.match(detail, /Not a confirmed entry/);
});

test('early transitions fire on UPWARD progression only, at or above the notify floor', () => {
  const mkRec = (early) => stampEarlyState({ ticker: 'E1', setupId: 'E1|2026-07-08|s1', createdAt: at(14, 0), state: STATES.BUILDING, history: [] }, { earlyState: early, now: NOW });
  const byTicker = (early) => ({ E1: { record: mkRec(early), card: { discoveryEvidence: null }, ev: {} } });

  // SCOUT is below the PRIMED notify floor → silent.
  assert.equal(collectEarlyTransitions({}, byTicker('SCOUT'), { now: NOW }).length, 0);
  // null → PRIMED fires.
  const up = collectEarlyTransitions({}, byTicker('PRIMED'), { now: NOW });
  assert.equal(up.length, 1);
  assert.equal(up[0].to, 'PRIMED');
  // PRIMED → IGNITION fires; IGNITION → PRIMED (regression) is silent.
  assert.equal(collectEarlyTransitions({ E1: mkRec('PRIMED') }, byTicker('IGNITION'), { now: NOW }).length, 1);
  assert.equal(collectEarlyTransitions({ E1: mkRec('IGNITION') }, byTicker('PRIMED'), { now: NOW }).length, 0);
  // Unchanged state is silent (dedup would also catch it, but no transition even forms).
  assert.equal(collectEarlyTransitions({ E1: mkRec('IGNITION') }, byTicker('IGNITION'), { now: NOW }).length, 0);
});

test('early dedup ids are distinct per state and stable per episode', () => {
  const mk = (state) => buildEarlyAlert({ ticker: 'E2', from: null, to: state, at: NOW, setupId: 'E2|2026-07-08|s1', card: {} }, { now: NOW });
  assert.notEqual(mk('PRIMED').id, mk('IGNITION').id);
  assert.equal(mk('PRIMED').id, mk('PRIMED').id);
});

// ── Retirement suppression: silent unless the episode was alerted ─────────────
test('retire/caution alerts are suppressed when the user never heard about the episode', async () => {
  const retireTr = {
    ticker: 'QUIET', from: STATES.ARMED, to: STATES.STALLING, at: NOW,
    reasonCode: 'STALL_MOMENTUM_LOST', setupId: 'QUIET|2026-07-08|s1', card: {},
  };
  // No prior alert for this episode → suppressed (board-only), counted.
  const out1 = await emitDaytradeAlerts([retireTr], { date: '2026-07-08', now: NOW, records: { QUIET: { ticker: 'QUIET', alertState: null } } });
  assert.equal(out1.alerts.length, 0);
  assert.equal(out1.suppressed, 1);
  assert.equal(out1.suppressedDetail[0].reason, 'episode-never-alerted');

  // Same transition, but the episode HAD an entry alert → the retirement is relevant.
  const alerted = withAlertMarks({ ticker: 'QUIET', alertState: null }, [{ id: 'daytrade|QUIET|QUIET|2026-07-08|s1|ACTIONABLE_NOW', kind: 'entry', at: NOW }]);
  assert.equal(episodeWasAlerted(alerted, 'QUIET|2026-07-08|s1'), true);
  const out2 = await emitDaytradeAlerts([retireTr], { date: '2026-07-08', now: NOW, records: { QUIET: alerted } });
  assert.equal(out2.alerts.length, 1, 'previously-alerted episode retirement notifies');
  assert.equal(out2.alerts[0].kind, 'retire');
});

test('withAlertMarks stamps a durable notification trace WITHOUT entering a position state', () => {
  const rec = { ticker: 'MARK', state: STATES.ACTIONABLE_NOW, alertState: null };
  const marked = withAlertMarks(rec, [{ id: 'daytrade|MARK|MARK|2026-07-08|s1|ACTIONABLE_NOW', kind: 'entry', at: NOW }]);
  assert.equal(marked.entryAlertEmittedAt, NOW);
  assert.equal(marked.state, STATES.ACTIONABLE_NOW, 'a notification is NOT a position — no MANAGING flip');
  assert.equal(marked.entryAlertAt ?? null, null, 'the position-entry field is untouched');
  // Idempotent-ish accumulation: keys accumulate, first entry time is kept.
  const again = withAlertMarks(marked, [{ id: 'daytrade|MARK|MARK|2026-07-08|s1|STALLING', kind: 'retire', at: at(15, 0) }]);
  assert.equal(again.entryAlertEmittedAt, NOW);
  assert.equal(again.alertState.keys.length, 2);
});

// ── Budgets ───────────────────────────────────────────────────────────────────
test('alert budgets: per-ticker/day and per-cycle caps, high severity first, counted overflow', () => {
  const mk = (t, i, sev = 'low') => ({ id: `daytrade|${t}|s1|X${i}`, ticker: t, sev, at: at(14, 30 + i), kind: 'early_watch' });
  // Per-ticker cap: prior count already at the max → everything new for that ticker suppressed.
  const r1 = applyAlertBudgets([mk('AAA', 1), mk('AAA', 2)], { AAA: CFG.ALERTS.MAX_PER_TICKER_PER_DAY });
  assert.equal(r1.budgeted.length, 0);
  assert.equal(r1.overBudget.length, 2);
  assert.ok(r1.overBudget.every(x => x.reason === 'ticker-day-budget'));
  // Per-cycle cap: more distinct tickers than the cycle budget → excess counted.
  const many = Array.from({ length: CFG.ALERTS.MAX_PER_CYCLE + 4 }, (_, i) => mk(`T${i}`, i));
  const r2 = applyAlertBudgets(many, {});
  assert.equal(r2.budgeted.length, CFG.ALERTS.MAX_PER_CYCLE);
  assert.equal(r2.overBudget.filter(x => x.reason === 'cycle-budget').length, 4);
  // Severity ordering: a high-sev entry survives the cycle cap ahead of low-sev noise.
  const mixed = [...Array.from({ length: CFG.ALERTS.MAX_PER_CYCLE }, (_, i) => mk(`L${i}`, i)), { ...mk('HOT', 99), sev: 'high', kind: 'entry' }];
  const r3 = applyAlertBudgets(mixed, {});
  assert.ok(r3.budgeted.some(a => a.ticker === 'HOT'), 'high severity is never crowded out by low-sev volume');
});

// ── Stage-2 allocation: stale decay + discovery reserve under pressure ────────
test('a stale daily monster cannot outrank a fresh current-session mover in live priority', () => {
  // Yesterday's cached +12%/8× name vs today's live +4%/3× name, during RTH.
  const stale = { ticker: 'YDAY', pctChange: 12, relVol: 8, excessPct: 10, barIsToday: false };
  const freshP = { ticker: 'TDAY', pctChange: 4, relVol: 3, excessPct: 3, barIsToday: true };
  const { pool, diagnostics } = selectDeepPoolDetailed([stale, freshP], { maxNames: 1, now: NOW });
  assert.equal(pool.length, 1);
  assert.equal(pool[0].ticker, 'TDAY', 'the live mover wins the last slot');
  assert.equal(diagnostics.staleDecayed, 1, 'the stale pick was decayed (and disclosed)');
  const rej = diagnostics.rejected.find(r => r.ticker === 'YDAY');
  assert.ok(rej, 'the rejection is recorded');
  assert.equal(rej.reason, 'stage2-budget');
  assert.ok(rej.occupiedBy && rej.occupiedBy.ticker === 'TDAY', 'the occupying candidate is recorded');
});

test('a current-session discovery is guaranteed a Stage-2 slot even when the general pool is full', () => {
  // 40 stale general candidates with huge cached values + 1 modest fresh discovery anomaly.
  const generals = Array.from({ length: 40 }, (_, i) => ({
    ticker: `G${i}`, pctChange: 15 - i * 0.1, relVol: 9, excessPct: 12, barIsToday: false,
  }));
  const discovery = {
    ticker: 'FRESH', source: 'discovery', scan: 'discovery', cusum: 5, z: 2.1,
    pctChange: 2.1, relVol: 2.2, excessPct: 1.8, barIsToday: true, quoteAsOf: NOW,
  };
  const { pool, diagnostics } = selectDeepPoolDetailed([...generals, discovery], { maxNames: 10, now: NOW });
  assert.ok(pool.some(p => p.ticker === 'FRESH'), 'discovery reserve holds under general-pool pressure');
  const sel = diagnostics.selected.find(s => s.ticker === 'FRESH');
  assert.equal(sel.via, 'discovery-reserve');
});

// ── classifyTransition contract unchanged for lifecycle alerts ────────────────
test('lifecycle alert classes: entries loud, early states never classified as lifecycle alerts', () => {
  assert.equal(classifyTransition({ from: STATES.ARMED, to: STATES.ACTIONABLE_NOW, reasonCode: 'ACTIONABLE_CONFIRMED' }).kind, 'entry');
  assert.equal(classifyTransition({ from: STATES.STALLING, to: STATES.ACTIONABLE_NOW, reasonCode: 'REVIVED' }).kind, 'revive');
  assert.equal(classifyTransition({ from: STATES.WATCHING, to: STATES.BUILDING }), null);
});
