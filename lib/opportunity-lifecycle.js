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
  WATCHING: 'WATCHING',
  BUILDING: 'BUILDING',
  OPENING_RANGE_FORMING: 'OPENING_RANGE_FORMING',
  ARMED: 'ARMED',
  ACTIONABLE_NOW: 'ACTIONABLE_NOW',
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
// Pre-setup states a retired name may sit at without churning back and forth.
const PRE_SETUP_STATES = Object.freeze(new Set([STATES.WATCHING, STATES.BUILDING, STATES.OPENING_RANGE_FORMING]));

const isRetired = s => RETIRED_STATES.has(s);
const isPostEntry = s => POST_ENTRY_STATES.has(s);
const isTerminal = s => s === STATES.CLOSED;

// ── Reason codes ─────────────────────────────────────────────────────────────
const REASON = Object.freeze({
  BOOTSTRAP: 'BOOTSTRAP',
  WATCH_RESET: 'WATCH_RESET',
  BUILDING_MOMENTUM: 'BUILDING_MOMENTUM',
  OR_FORMING: 'OR_FORMING',
  ARMED_PENDING_TRIGGER: 'ARMED_PENDING_TRIGGER',
  ACTIONABLE_CONFIRMED: 'ACTIONABLE_CONFIRMED',
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

// ── Core decision: prior state + evidence → [nextState, reasonCode] ───────────
// Pure. Ordered by precedence: post-entry lock → confirmed failure → expiration →
// stale demotion → over-extension → soft stall → actionable gate → armed → building.
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

  // 1. CONFIRMED invalidation — decisive enough to fire even from ACTIONABLE_NOW.
  if (ev.breakoutFailed === true) return [STATES.FAILED, REASON.FAIL_BREAKOUT];
  if ((ev.closesBelowVwap || 0) >= cfg.vwapLossConfirm) return [STATES.FAILED, REASON.FAIL_VWAP_LOSS];

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

  // 6. Actionable gate. A post-FAILED cooldown blocks re-arming to ACTIONABLE (hysteresis).
  if (isActionableEligible(ev, cfg)) {
    if (cooldownActive) return [STATES.ARMED, REASON.COOLDOWN_HOLD];
    return [STATES.ACTIONABLE_NOW, isRetired(prev) ? REASON.REVIVED : REASON.ACTIONABLE_CONFIRMED];
  }

  // 7. Armed — setup complete, awaiting the trigger.
  if (fresh && ev.nearTrigger === true && ev.aboveVwap === true) return [STATES.ARMED, REASON.ARMED_PENDING_TRIGGER];

  // 8. Opening range forming.
  if (ev.session === 'regular' && ev.openingRangeForming === true) return [STATES.OPENING_RANGE_FORMING, REASON.OR_FORMING];

  // 9. Building.
  if (ev.momentumOk === true || ev.nearTrigger === true) return [STATES.BUILDING, REASON.BUILDING_MOMENTUM];

  // 10. Default watch.
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

  const changed = to !== prev && reasonCode != null;

  // Carry-forward mutations expressed immutably.
  let next = {
    ...base,
    state: to,
    updatedAt: now,
    lastMetrics: ev.metrics ? { ...ev.metrics } : (base.lastMetrics || null),
    lastFreshness: ev.freshness ? { ...ev.freshness } : (base.lastFreshness || null),
    history: base.history,
  };

  if (changed) {
    next = { ...next, history: [...base.history, transitionRecord(prev, to, now, reasonCode, ev, cfg)] };
    if (to === STATES.FAILED) next = { ...next, cooldownUntil: new Date(Date.parse(now) + cfg.cooldownMs).toISOString() };
    if (to === STATES.MANAGING && !next.entryAlertAt) next = { ...next, entryAlertAt: now };
  }

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
  const board = { actionableNow: [], buildingNearTrigger: [], tooExtended: [], retiredToday: [], managing: [], closed: [] };
  for (const r of records) {
    if (!r) continue;
    switch (r.state) {
      case STATES.ACTIONABLE_NOW: board.actionableNow.push(r); break;
      case STATES.TOO_EXTENDED: board.tooExtended.push(r); break;
      case STATES.MANAGING: board.managing.push(r); break;
      case STATES.CLOSED: board.closed.push(r); break;
      case STATES.STALLING:
      case STATES.FAILED:
      case STATES.EXPIRED: board.retiredToday.push(r); break;
      default: board.buildingNearTrigger.push(r); break;   // WATCHING/BUILDING/OR_FORMING/ARMED
    }
  }
  return {
    ...board,
    counts: Object.fromEntries(Object.entries(board).map(([k, v]) => [k, v.length])),
  };
}

module.exports = {
  STATES, RETIRED_STATES, POST_ENTRY_STATES, REASON, DEFAULTS,
  isRetired, isPostEntry, isTerminal, isActionableEligible,
  createCandidate, advanceLifecycle, summarizeBoard,
};
