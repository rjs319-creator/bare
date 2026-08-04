'use strict';
// OPPORTUNITY LIFECYCLE — deterministic state machine for a Day Trade / Gap & Go candidate.
//
// A candidate is not a row in a static list; it has ONE current state and an append-only
// history of transitions. This module is the pure engine: given a candidate's prior record
// and a fresh evaluation snapshot, it computes the next state with a timestamped, reason-
// coded, evidence-carrying transition. No network, no storage, no clock of its own (the
// caller passes `ev.now`) so it runs identically in the live route, the cron tick, tests,
// and a replay/backtest.
//
// DESIGN GUARANTEES (from the redesign spec):
//   • Candidates are never silently erased. Non-actionable names move to RETIRED states and
//     keep being observed (false-retirement tracking) — they stay in "Retired Today".
//   • Once an entry alert fires the record is LOCKED post-entry (MANAGING → CLOSED only), so
//     performance can never be improved by disappearing a failed alert.
//   • Retiring requires CONFIRMED invalidation (2 VWAP closes, a broken breakout, multi-bar
//     stall) — a single noisy bar cannot retire a valid candidate.
//   • Hysteresis: entering FAILED starts a cooldown during which the name cannot re-arm to
//     ACTIONABLE_NOW, preventing ACTIONABLE↔FAILED oscillation.
//   • Immutable: every function returns a NEW record; inputs are never mutated.

const { isCurrentSessionFresh } = require('./freshness');

// ── States ───────────────────────────────────────────────────────────────────
const STATES = Object.freeze({
  PRIOR_SESSION_WATCH: 'PRIOR_SESSION_WATCH',   // historical discovery only — NEVER actionable now
  WATCHING: 'WATCHING',
  BUILDING: 'BUILDING',
  OPENING_RANGE_FORMING: 'OPENING_RANGE_FORMING',
  ARMED: 'ARMED',
  ACTIONABLE_NOW: 'ACTIONABLE_NOW',
  REVERSAL_RECLAIM: 'REVERSAL_RECLAIM',          // a NEW reclaim setup, not the stale continuation
  TOO_EXTENDED: 'TOO_EXTENDED',
  STALLING: 'STALLING',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  MANAGING: 'MANAGING',
  CLOSED: 'CLOSED',
});

// Retired = non-actionable but STILL OBSERVED (shown in "Retired Today", graded forward).
const RETIRED_STATES = Object.freeze(new Set([STATES.TOO_EXTENDED, STATES.STALLING, STATES.FAILED, STATES.EXPIRED]));
// Post-entry = an alert fired; history is permanent from here.
const POST_ENTRY_STATES = Object.freeze(new Set([STATES.MANAGING, STATES.CLOSED]));
// Pre-setup states a retired name may sit at without churning back and forth. PRIOR_SESSION_WATCH
// is a pre-setup watch too — historical-discovery-only, freely promotable once fresh intraday
// evidence arrives, but a retired name must never churn INTO it.
const PRE_SETUP_STATES = Object.freeze(new Set([STATES.WATCHING, STATES.BUILDING, STATES.OPENING_RANGE_FORMING, STATES.PRIOR_SESSION_WATCH]));
// The ONLY states that may carry current buy language / a green timing badge / a Today long.
const ACTIONABLE_STATES = Object.freeze(new Set([STATES.ACTIONABLE_NOW, STATES.REVERSAL_RECLAIM]));

const isRetired = s => RETIRED_STATES.has(s);
const isPostEntry = s => POST_ENTRY_STATES.has(s);
const isTerminal = s => s === STATES.CLOSED;
const isActionable = s => ACTIONABLE_STATES.has(s);

// ── Reason codes ─────────────────────────────────────────────────────────────
const REASON = Object.freeze({
  BOOTSTRAP: 'BOOTSTRAP',
  WATCH_RESET: 'WATCH_RESET',
  BUILDING_MOMENTUM: 'BUILDING_MOMENTUM',
  OR_FORMING: 'OR_FORMING',
  ARMED_PENDING_TRIGGER: 'ARMED_PENDING_TRIGGER',
  ACTIONABLE_CONFIRMED: 'ACTIONABLE_CONFIRMED',
  RECLAIM_CONFIRMED: 'RECLAIM_CONFIRMED',
  RECLAIM_UNCONFIRMED: 'RECLAIM_UNCONFIRMED',
  PRIOR_SESSION_HOLD: 'PRIOR_SESSION_HOLD',
  REVIVED: 'REVIVED',
  COOLDOWN_HOLD: 'COOLDOWN_HOLD',
  TOO_EXTENDED: 'TOO_EXTENDED',
  STALL_NO_NEW_HIGH: 'STALL_NO_NEW_HIGH',
  STALL_MOMENTUM_LOST: 'STALL_MOMENTUM_LOST',
  STALL_STALE_DATA: 'STALL_STALE_DATA',
  FAIL_VWAP_LOSS: 'FAIL_VWAP_LOSS',
  FAIL_BREAKOUT: 'FAIL_BREAKOUT',
  EXPIRED_NO_TRIGGER: 'EXPIRED_NO_TRIGGER',
  ENTRY_ALERT_FIRED: 'ENTRY_ALERT_FIRED',
  CLOSED_TARGET: 'CLOSED_TARGET',
  CLOSED_STOP: 'CLOSED_STOP',
  CLOSED_TIME: 'CLOSED_TIME',
  FALSE_RETIREMENT_OBSERVED: 'FALSE_RETIREMENT_OBSERVED',
});

const DEFAULTS = Object.freeze({
  minRemainingRR: 1.0,          // reward:risk floor to be actionable
  maxExtensionAtr: 2.5,         // distance above VWAP (in ATRs) beyond which it's a chase
  vwapLossConfirm: 2,           // consecutive 5-min closes below VWAP to CONFIRM failure
  stallBars: 6,                 // bars with no new high (+ fading volume) → stall
  cooldownMs: 15 * 60 * 1000,   // after FAILED, block re-arming to ACTIONABLE for this long
  reclaimMinRR: 1.5,            // reward:risk floor on a NEW reversal-reclaim structure
  // ── Anti-flapping (see lib/daytrade-config ANTIFLAP for the production values) ──
  // Cooldown after a SOFT retirement (STALLING / TOO_EXTENDED / EXPIRED). Before this
  // existed only FAILED had a cooldown, so ACTIONABLE ⇄ STALLING could cycle on 60s ticks.
  retireCooldownMs: 20 * 60 * 1000,
  // Consecutive qualifying evaluations required before a retired name revives.
  reviveConfirmEvals: 2,
  // Hysteresis: re-entering after retirement demands strictly better evidence than first
  // entry (enter 1.0 RR / 2.5 ATR; re-enter 1.2 RR / 2.2 ATR) so a value oscillating around
  // the entry threshold cannot flap the state.
  reenterMinRR: 1.2,
  reenterMaxExtensionAtr: 2.2,
  // Material-new-setup test (ATR-normalized): a revival mints a NEW setupId only when the
  // structure genuinely changed; otherwise the same episode identity is kept so the alert
  // dedup key still matches and the user is not re-alerted for the same underlying setup.
  materialTriggerAtr: 0.5,
  materialPriceAtr: 1.0,
  materialMinElapsedMs: 45 * 60 * 1000,
  strategyVersion: 'lifecycle-v1',
});

// ── Small pure helpers ───────────────────────────────────────────────────────
function toISO(now) {
  if (now == null) return new Date().toISOString();
  if (now instanceof Date) return now.toISOString();
  const ms = Date.parse(now);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

// "10:42 AM" in New York time — deterministic given the instant.
function nyClock(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
}

function isFresh(ev) {
  // STRICT signal from the Stage-2 producer (recent bar AND recent quote, no future-dated
  // data) wins whenever present — the production intraday path always sets it, so a name
  // missing either half of the evidence pair can never satisfy the actionable gate.
  if (ev.actionableFresh != null) return ev.actionableFresh === true;
  if (ev.freshness) return isCurrentSessionFresh(ev.freshness);
  return ev.isFresh === true;   // convenience for callers without a full freshness object
}

// Does the evaluation satisfy the full current-session "Actionable Now" gate? Conservative:
// every required condition must be EXPLICITLY true. Missing evidence is not eligibility.
function isActionableEligible(ev, cfg) {
  const sessionOk = ev.session === 'regular' || (ev.premarketSetup === true && ev.session === 'premarket');
  return isFresh(ev)
    && sessionOk
    && ev.aboveVwap === true
    && ev.momentumOk === true
    && ev.residualOk === true
    && ev.relVolOk === true
    && ev.triggerConfirmed === true
    && !ev.breakoutFailed
    && (ev.remainingRR ?? 0) >= cfg.minRemainingRR
    && (ev.extensionAtr ?? 0) <= cfg.maxExtensionAtr;
}

// A sharply-fallen name may sometimes recover, but that is a NEW setup — never the stale
// momentum pick continuing. To be a REVERSAL_RECLAIM every condition must be EXPLICITLY true
// on CURRENT-session evidence with a NEW plan: confirmed VWAP reclaim, an intraday/OR trigger
// reclaimed, positive short-term momentum + residual vs SPY, sufficient time-of-day relVol,
// acceptable reward:risk on the reclaim structure, and no reuse of the stale original plan.
function isReclaimEligible(ev, cfg) {
  return isFresh(ev)
    && ev.session === 'regular'
    && ev.reclaimConfirmed === true
    && ev.aboveVwap === true
    && ev.momentumOk === true
    && ev.residualOk === true
    && ev.relVolOk === true
    && ev.triggerConfirmed === true
    && ev.newPlan === true
    && (ev.remainingRR ?? 0) >= (cfg.reclaimMinRR ?? DEFAULTS.reclaimMinRR)
    && !ev.breakoutFailed;
}

// ── Core decision: prior state + evidence → [nextState, reasonCode] ───────────
// Pure. Ordered by precedence: post-entry lock → confirmed failure → expiration →
// stale demotion → over-extension → soft stall → reclaim archetype → actionable gate →
// armed → building → prior-session watch → default watch.
function decide(prev, record, ev, cfg, now) {
  // POST-ENTRY LOCK — an entry alert makes history permanent: MANAGING → CLOSED only.
  if (prev === STATES.CLOSED) return [STATES.CLOSED, null];
  if (prev === STATES.MANAGING || ev.hasEntryAlert === true) {
    if (ev.exited === true) {
      const r = ev.exitReason === 'stop' ? REASON.CLOSED_STOP
        : ev.exitReason === 'time' ? REASON.CLOSED_TIME : REASON.CLOSED_TARGET;
      return [STATES.CLOSED, r];
    }
    return [STATES.MANAGING, prev === STATES.MANAGING ? null : REASON.ENTRY_ALERT_FIRED];
  }

  const fresh = isFresh(ev);
  const cooldownActive = !!(record && record.cooldownUntil && now < record.cooldownUntil);

  // 0. REVERSAL-RECLAIM archetype — a name explicitly evaluated as a fresh reclaim setup
  // (a SEPARATE candidate from the failed original). It becomes actionable ONLY through its
  // own strict current-session gate; until then it is honestly "reclaim not confirmed".
  if (ev.archetype === 'reversal_reclaim') {
    if (isReclaimEligible(ev, cfg)) return [STATES.REVERSAL_RECLAIM, REASON.RECLAIM_CONFIRMED];
    if (ev.breakoutFailed === true) return [STATES.FAILED, REASON.FAIL_BREAKOUT];
    return [STATES.STALLING, REASON.RECLAIM_UNCONFIRMED];
  }

  // 1. CONFIRMED invalidation — decisive enough to fire even from ACTIONABLE_NOW. Uses
  // strategy-specific, NORMALIZED evidence (not a bare "down X%"): stop breach, breakout
  // failure, ≥2 VWAP-loss closes, or an ATR-normalized loss from the detection price past
  // the configured threshold (a HIMS-style collapse inconsistent with the long thesis).
  if (ev.breakoutFailed === true) return [STATES.FAILED, REASON.FAIL_BREAKOUT];
  if (ev.stopBreached === true) return [STATES.FAILED, REASON.FAIL_BREAKOUT];
  if ((ev.closesBelowVwap || 0) >= cfg.vwapLossConfirm) return [STATES.FAILED, REASON.FAIL_VWAP_LOSS];
  if (cfg.failLossAtr != null && (ev.lossFromDetectionAtr ?? 0) >= cfg.failLossAtr) return [STATES.FAILED, REASON.FAIL_VWAP_LOSS];

  // 2. Expiration — no valid trigger by the strategy deadline.
  if (ev.expired === true) return [STATES.EXPIRED, REASON.EXPIRED_NO_TRIGGER];

  // 3. Stale / missing current-session data — cannot REMAIN actionable/armed.
  if (!fresh && ev.session === 'regular'
    && (prev === STATES.ACTIONABLE_NOW || prev === STATES.ARMED || prev === STATES.OPENING_RANGE_FORMING)) {
    return [STATES.STALLING, REASON.STALL_STALE_DATA];
  }

  // 4. Over-extension / chase.
  if ((ev.extensionAtr ?? 0) > cfg.maxExtensionAtr) return [STATES.TOO_EXTENDED, REASON.TOO_EXTENDED];

  // 5. Soft stalls — MULTI-bar / multi-signal only (a single noisy bar must not retire).
  if ((ev.lowerHighs || 0) >= 2) return [STATES.STALLING, REASON.STALL_NO_NEW_HIGH];
  if ((ev.noNewHighBars || 0) >= cfg.stallBars && ev.volumeFading === true) return [STATES.STALLING, REASON.STALL_NO_NEW_HIGH];
  if (ev.momentumOk === false && (prev === STATES.ACTIONABLE_NOW || prev === STATES.ARMED)) return [STATES.STALLING, REASON.STALL_MOMENTUM_LOST];

  // 6. Actionable gate. A post-retirement cooldown blocks re-arming to ACTIONABLE, and a
  // retired name faces a strictly TIGHTER re-entry band than first entry (hysteresis) so
  // evidence oscillating around the entry threshold cannot flap the state.
  if (isActionableEligible(ev, cfg)) {
    if (cooldownActive) return [STATES.ARMED, REASON.COOLDOWN_HOLD];
    if (isRetired(prev)) {
      const rrOk = (ev.remainingRR ?? 0) >= (cfg.reenterMinRR ?? cfg.minRemainingRR);
      const extOk = (ev.extensionAtr ?? 0) <= (cfg.reenterMaxExtensionAtr ?? cfg.maxExtensionAtr);
      if (!rrOk || !extOk) return [prev, null];   // inside the hysteresis band — stays retired
      return [STATES.ACTIONABLE_NOW, REASON.REVIVED];
    }
    return [STATES.ACTIONABLE_NOW, REASON.ACTIONABLE_CONFIRMED];
  }

  // 7. Armed — setup complete, awaiting the trigger.
  if (fresh && ev.nearTrigger === true && ev.aboveVwap === true) return [STATES.ARMED, REASON.ARMED_PENDING_TRIGGER];

  // 8. Opening range forming.
  if (ev.session === 'regular' && ev.openingRangeForming === true) return [STATES.OPENING_RANGE_FORMING, REASON.OR_FORMING];

  // 9. Building.
  if (ev.momentumOk === true || ev.nearTrigger === true) return [STATES.BUILDING, REASON.BUILDING_MOMENTUM];

  // 10. Prior-session watch — the ONLY evidence is a completed prior-session bar during a
  // live session (the daily-cache discovery case). Historical discovery ONLY; it can never be
  // actionable now, and it is labeled distinctly so the UI never presents it as a live buy.
  if (ev.priorSessionOnly === true) return [STATES.PRIOR_SESSION_WATCH, prev === STATES.PRIOR_SESSION_WATCH ? null : REASON.PRIOR_SESSION_HOLD];

  // 11. Default watch.
  return [STATES.WATCHING, prev === STATES.WATCHING ? null : REASON.WATCH_RESET];
}

// Human-readable one-liner for a transition, mirroring the spec's example format.
function explain(to, reasonCode, ev, clock) {
  const m = ev.metrics || {};
  const trail = m.residualVsSpy != null && m.residualVsSpy < 0 ? `, trailing SPY by ${Math.abs(m.residualVsSpy).toFixed(1)}%` : '';
  switch (reasonCode) {
    case REASON.FAIL_VWAP_LOSS: return `Retired ${clock} — ${ev.closesBelowVwap} closes below VWAP${trail}${ev.volumeFading ? ', volume fading' : ''}.`;
    case REASON.FAIL_BREAKOUT: return `Retired ${clock} — broke the trigger then failed back below the opening-range midpoint${trail}.`;
    case REASON.STALL_NO_NEW_HIGH: return `Stalling ${clock} — no new high${ev.volumeFading ? ' as volume fades' : ''}${ev.lowerHighs >= 2 ? ', printing lower highs' : ''}.`;
    case REASON.STALL_MOMENTUM_LOST: return `Stalling ${clock} — intraday momentum rolled over${trail}.`;
    case REASON.STALL_STALE_DATA: return `Stalling ${clock} — current-session data went stale; cannot confirm it's still live.`;
    case REASON.TOO_EXTENDED: return `Too extended ${clock} — ${(m.extensionAtr ?? ev.extensionAtr ?? 0).toFixed(1)} ATR above VWAP; wait for a pullback.`;
    case REASON.EXPIRED_NO_TRIGGER: return `Expired ${clock} — no valid trigger by the strategy deadline.`;
    case REASON.ACTIONABLE_CONFIRMED: return `Actionable ${clock} — trigger confirmed above VWAP with volume and relative strength.`;
    case REASON.RECLAIM_CONFIRMED: return `Reclaim confirmed ${clock} — reclaimed VWAP and the intraday trigger on a NEW plan (not the failed momentum setup).`;
    case REASON.RECLAIM_UNCONFIRMED: return `Failed momentum setup — reclaim not confirmed ${clock}; needs a confirmed VWAP reclaim and a new trigger.`;
    case REASON.PRIOR_SESSION_HOLD: return `Prior-session watchlist ${clock} — discovered on a completed earlier-session bar; not a live setup right now.`;
    case REASON.REVIVED: return `Revived ${clock} — re-cleared the actionable criteria after retirement.`;
    case REASON.COOLDOWN_HOLD: return `Armed ${clock} — criteria met but held in post-failure cooldown before re-arming.`;
    case REASON.ARMED_PENDING_TRIGGER: return `Armed ${clock} — setup complete, waiting for the trigger.`;
    case REASON.OR_FORMING: return `Opening range forming ${clock} — building the range before a confirmed breakout.`;
    case REASON.BUILDING_MOMENTUM: return `Building ${clock} — constructive, approaching the setup.`;
    case REASON.ENTRY_ALERT_FIRED: return `Entry alert fired ${clock} — now managing the position.`;
    case REASON.CLOSED_TARGET: return `Closed ${clock} — target reached.`;
    case REASON.CLOSED_STOP: return `Closed ${clock} — stopped out.`;
    case REASON.CLOSED_TIME: return `Closed ${clock} — time stop.`;
    case REASON.FALSE_RETIREMENT_OBSERVED: return `Note ${clock} — a retired candidate subsequently became a strong runner (false-retirement).`;
    case REASON.BOOTSTRAP: return `Watching ${clock} — added to the radar.`;
    default: return `${to} ${clock}.`;
  }
}

// ── Material-new-setup test ──────────────────────────────────────────────────
// A revival keeps its setupId (same episode → the alert dedup key still matches) UNLESS the
// structure genuinely changed. Evidence of a material change (any one suffices):
//   • a new catalyst asserted by the evaluator;
//   • the live trigger level moved ≥ materialTriggerAtr ATRs from the retired plan's trigger;
//   • price structure displaced ≥ materialPriceAtr ATRs from the retired plan's entry;
//   • enough elapsed time since retirement that this is a genuinely new context.
// With NO usable evidence either way the answer is NOT material (conservative: fewer minted
// setups → fewer re-alerts; the revival still surfaces on the board under its old identity).
function materiallyNewSetup(base, ev, cfg, nowIso) {
  if (ev.newCatalyst === true) return true;
  const retiredAtIso = lastRetirementAt(base);
  if (retiredAtIso) {
    const elapsed = Date.parse(nowIso) - Date.parse(retiredAtIso);
    if (Number.isFinite(elapsed) && elapsed >= (cfg.materialMinElapsedMs ?? DEFAULTS.materialMinElapsedMs)) return true;
  }
  const oldPlan = base.retiredPlan || base.activePlan || null;
  const newPlan = ev.livePlan || null;
  const atr = (newPlan && newPlan.atr > 0) ? newPlan.atr : (oldPlan && oldPlan.atr > 0 ? oldPlan.atr : null);
  if (oldPlan && newPlan && atr > 0) {
    if (Number.isFinite(oldPlan.trigger) && Number.isFinite(newPlan.trigger)
      && Math.abs(newPlan.trigger - oldPlan.trigger) >= (cfg.materialTriggerAtr ?? DEFAULTS.materialTriggerAtr) * atr) return true;
    if (Number.isFinite(oldPlan.entry) && Number.isFinite(newPlan.entry)
      && Math.abs(newPlan.entry - oldPlan.entry) >= (cfg.materialPriceAtr ?? DEFAULTS.materialPriceAtr) * atr) return true;
  }
  return false;
}

// Most recent transition INTO a retired state (its timestamp anchors elapsed-time tests).
function lastRetirementAt(record) {
  const h = record && record.history;
  if (!Array.isArray(h)) return null;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i] && RETIRED_STATES.has(h[i].to)) return h[i].at || null;
  }
  return null;
}

function transitionRecord(from, to, at, reasonCode, ev, cfg) {
  return {
    from, to, at, reasonCode,
    explanation: explain(to, reasonCode, ev, nyClock(at)),
    metrics: ev.metrics ? { ...ev.metrics } : null,
    freshness: ev.freshness ? { ...ev.freshness } : null,
    strategyVersion: cfg.strategyVersion,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

// Create a fresh candidate in WATCHING with a bootstrap transition.
function createCandidate({ ticker, strategy = null, at = null, strategyVersion = DEFAULTS.strategyVersion, metrics = null, freshness = null } = {}) {
  const iso = toISO(at);
  const ev = { now: iso, metrics, freshness };
  return {
    ticker,
    strategy,
    state: STATES.WATCHING,
    createdAt: iso,
    updatedAt: iso,
    strategyVersion,
    // Setup identity: a REVIVED / RECLAIM_CONFIRMED transition mints a NEW setup id (with a
    // new live plan) — the failed original setup can never re-present under its old identity.
    setupSeq: 1,
    setupId: `${ticker}|${iso.slice(0, 10)}|s1`,
    cooldownUntil: null,
    entryAlertAt: null,
    falseRetirement: null,
    history: [transitionRecord(null, STATES.WATCHING, iso, REASON.BOOTSTRAP, ev, { strategyVersion })],
  };
}

// Advance a candidate by one evaluation. Returns a NEW record (never mutates input).
// `record` may be null → a candidate is created and then advanced in one call.
function advanceLifecycle(record, ev, opts = {}) {
  const base = record || createCandidate({ ticker: ev.ticker, strategy: ev.strategy, at: ev.now, strategyVersion: opts.strategyVersion });
  const cfg = { ...DEFAULTS, ...opts, strategyVersion: base.strategyVersion || opts.strategyVersion || DEFAULTS.strategyVersion };
  const now = toISO(ev.now);
  const prev = base.state;

  let [to, reasonCode] = decide(prev, base, ev, cfg, now);

  // Keep retired names in "Retired Today" rather than churning them back to a weaker
  // pre-setup state; only a genuine revival (ARMED / ACTIONABLE_NOW) pulls them out.
  if (isRetired(prev) && PRE_SETUP_STATES.has(to)) {
    to = prev;
    reasonCode = null;
  }

  // REVIVAL CONFIRMATION — a retired name must clear the (hysteresis-tightened) actionable
  // gate on `reviveConfirmEvals` CONSECUTIVE evaluations before it actually revives. The
  // first qualifying evaluation only arms the streak; a non-qualifying one resets it. This
  // is the debounce that stops one noisy bar from producing an entry alert.
  let reviveStreak = base.reviveStreak || 0;
  if (isRetired(prev) && to === STATES.ACTIONABLE_NOW && reasonCode === REASON.REVIVED) {
    reviveStreak += 1;
    if (reviveStreak < (cfg.reviveConfirmEvals ?? DEFAULTS.reviveConfirmEvals)) {
      to = prev;             // hold — qualifying, but not yet confirmed
      reasonCode = null;
    } else {
      reviveStreak = 0;      // confirmed — the streak has served its purpose
    }
  } else if (isRetired(prev)) {
    reviveStreak = 0;        // any non-qualifying evaluation breaks the streak
  }

  const changed = to !== prev && reasonCode != null;

  // Carry-forward mutations expressed immutably.
  let next = {
    ...base,
    state: to,
    updatedAt: now,
    reviveStreak,
    lastMetrics: ev.metrics ? { ...ev.metrics } : (base.lastMetrics || null),
    lastFreshness: ev.freshness ? { ...ev.freshness } : (base.lastFreshness || null),
    history: base.history,
  };

  if (changed) {
    next = { ...next, history: [...base.history, transitionRecord(prev, to, now, reasonCode, ev, cfg)] };
    if (to === STATES.FAILED) next = { ...next, cooldownUntil: new Date(Date.parse(now) + cfg.cooldownMs).toISOString() };
    // Soft retirements now cool down too — before this, only FAILED did, so
    // ACTIONABLE ⇄ STALLING could cycle on every evaluation tick.
    if (to === STATES.STALLING || to === STATES.TOO_EXTENDED || to === STATES.EXPIRED) {
      next = { ...next, cooldownUntil: new Date(Date.parse(now) + (cfg.retireCooldownMs ?? DEFAULTS.retireCooldownMs)).toISOString() };
    }
    if (to === STATES.MANAGING && !next.entryAlertAt) next = { ...next, entryAlertAt: now };
    // A confirmed reclaim is BY DEFINITION a new structure (its gate requires a new plan).
    // A revival mints a new setup ONLY when the structure materially changed; otherwise the
    // same episode identity is kept, so the alert dedup key still matches and the user is
    // never re-alerted for the same underlying setup.
    if (reasonCode === REASON.RECLAIM_CONFIRMED
      || (reasonCode === REASON.REVIVED && materiallyNewSetup(base, ev, cfg, now))) {
      const seq = (base.setupSeq || 1) + 1;
      next = { ...next, setupSeq: seq, setupId: `${base.ticker}|${now.slice(0, 10)}|s${seq}` };
    }
  }
  // Backfill identity for records created before setup identity existed.
  if (!next.setupId) next = { ...next, setupSeq: next.setupSeq || 1, setupId: `${next.ticker}|${(next.createdAt || now).slice(0, 10)}|s${next.setupSeq || 1}` };

  // False-retirement observation — a retired name that becomes a strong runner is flagged
  // ONCE and kept under observation (state unchanged), recorded as an audit annotation.
  if (isRetired(next.state) && ev.becameRunner === true && !next.falseRetirement) {
    next = {
      ...next,
      falseRetirement: { at: now, note: 'became a strong runner after retirement' },
      history: [...next.history, transitionRecord(next.state, next.state, now, REASON.FALSE_RETIREMENT_OBSERVED, ev, cfg)],
    };
  }

  return next;
}

// Bucket a set of candidate records into the UI sections (Actionable / Building / Extended /
// Retired / Managing / Closed). Pure — returns arrays + counts, mutates nothing.
function summarizeBoard(records = []) {
  const board = { actionableNow: [], reversalReclaim: [], armed: [], buildingNearTrigger: [], tooExtended: [], retiredToday: [], priorSessionWatch: [], managing: [], closed: [] };
  for (const r of records) {
    if (!r) continue;
    switch (r.state) {
      case STATES.ACTIONABLE_NOW: board.actionableNow.push(r); break;
      case STATES.REVERSAL_RECLAIM: board.reversalReclaim.push(r); break;
      case STATES.ARMED: board.armed.push(r); break;
      case STATES.TOO_EXTENDED: board.tooExtended.push(r); break;
      case STATES.MANAGING: board.managing.push(r); break;
      case STATES.CLOSED: board.closed.push(r); break;
      case STATES.PRIOR_SESSION_WATCH: board.priorSessionWatch.push(r); break;
      case STATES.STALLING:
      case STATES.FAILED:
      case STATES.EXPIRED: board.retiredToday.push(r); break;
      default: board.buildingNearTrigger.push(r); break;   // WATCHING/BUILDING/OR_FORMING
    }
  }
  return {
    ...board,
    counts: Object.fromEntries(Object.entries(board).map(([k, v]) => [k, v.length])),
  };
}

module.exports = {
  STATES, RETIRED_STATES, POST_ENTRY_STATES, ACTIONABLE_STATES, PRE_SETUP_STATES, REASON, DEFAULTS,
  isRetired, isPostEntry, isTerminal, isActionable, isActionableEligible, isReclaimEligible,
  createCandidate, advanceLifecycle, summarizeBoard, materiallyNewSetup, lastRetirementAt,
};
