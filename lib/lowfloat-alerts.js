'use strict';
// ALERTS FOR THE LOW-FLOAT / CONTINUATION STACK.
//
// Alerts fire on MEANINGFUL STATE TRANSITIONS, never on score fluctuations. That distinction
// is the whole design: a score wobbling between 61 and 64 is noise, and a system that alerts
// on it trains the user to ignore it. A move from BREAKOUT_PENDING to BREAKOUT_CONFIRMED is
// information.
//
// Suppression: a transition alerts once per (ticker, transition) per session unless the
// trigger level materially changes or the cooldown expires. State is per session day, so a
// new session starts clean.

const { SCHEMA_VERSION } = require('./lowfloat-config');
const { STRUCTURE_STATES } = require('./intraday-continuation');
const { ACTION_STATES } = require('./intraday-actionability');

const COOLDOWN_MS = 20 * 60 * 1000;
const MAX_PER_TICKER_PER_DAY = 6;
const MAX_PER_CYCLE = 10;
// A trigger that moved by more than this fraction is a materially different setup and may
// re-alert inside the cooldown.
const MATERIAL_TRIGGER_CHANGE = 0.02;

const S = STRUCTURE_STATES;

// The transitions worth interrupting someone for, with their severity and message builder.
const ALERTABLE = [
  { from: [S.WATCH], to: S.EARLY_IGNITION, kind: 'EARLY_IGNITION', severity: 'info' },
  { from: [S.EARLY_IGNITION], to: S.COMPRESSION, kind: 'COMPRESSION', severity: 'info' },
  { from: [S.COMPRESSION, S.EARLY_IGNITION, S.CONSTRUCTIVE_PULLBACK], to: S.BREAKOUT_PENDING, kind: 'BREAKOUT_PENDING', severity: 'info' },
  { from: [S.BREAKOUT_PENDING, S.COMPRESSION], to: S.BREAKOUT_ATTEMPT, kind: 'BREAKOUT_ATTEMPT', severity: 'info' },
  { from: [S.BREAKOUT_ATTEMPT, S.BREAKOUT_PENDING, S.COMPRESSION], to: S.BREAKOUT_CONFIRMED, kind: 'BREAKOUT_CONFIRMED', severity: 'high' },
  { from: [S.BREAKOUT_CONFIRMED], to: S.BREAKOUT_RETEST, kind: 'BREAKOUT_RETEST', severity: 'info' },
  { from: null, to: S.FAILED_BREAKOUT, kind: 'FAILED_BREAKOUT', severity: 'high', constructiveFromOnly: true },
  { from: null, to: S.DISTRIBUTION, kind: 'DISTRIBUTION', severity: 'high', constructiveFromOnly: true },
  { from: null, to: S.STALE_DATA, kind: 'STALE_DATA', severity: 'info' },
];

const CONSTRUCTIVE = new Set([
  S.EARLY_IGNITION, S.CONSTRUCTIVE_PULLBACK, S.COMPRESSION, S.BREAKOUT_PENDING,
  S.BREAKOUT_ATTEMPT, S.BREAKOUT_CONFIRMED, S.BREAKOUT_RETEST,
]);

const money = v => (Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');

function buildMessage(kind, rec) {
  const t = rec.ticker;
  switch (kind) {
    case 'EARLY_IGNITION':
      return `${t}: Early low-float ignition detected. Float turnover and five-minute volume are accelerating. Watch only.`;
    case 'COMPRESSION':
      return `${t}: Range is compressing after the ignition move. Watching for a break of ${money(rec.trigger)}.`;
    case 'BREAKOUT_PENDING':
      return `${t}: Breakout pending at ${money(rec.trigger)}. Do not enter yet — wait for a completed five-minute close above the level.`;
    case 'BREAKOUT_ATTEMPT':
      return `${t}: Trading above ${money(rec.trigger)} on the forming candle. NOT confirmed until the bar closes.`;
    case 'BREAKOUT_CONFIRMED':
      return rec.actionState === ACTION_STATES.PAPER_ENTRY_ELIGIBLE || rec.actionState === ACTION_STATES.LIVE_VALIDATED_ENTRY
        ? `${t}: Breakout confirmed. ${rec.actionState === ACTION_STATES.LIVE_VALIDATED_ENTRY ? 'Entry' : 'Paper entry'} zone ${money(rec.entryZoneLow)}–${money(rec.entryZoneHigh)}. Do not chase above ${money(rec.maximumChasePrice)}.`
        : `${t}: Breakout confirmed, but the entry is blocked (${(rec.blockingReasons || []).slice(0, 2).join(', ') || 'see card'}).`;
    case 'BREAKOUT_RETEST':
      return `${t}: Retesting the breakout level at ${money(rec.trigger)} on contracting volume.`;
    case 'FAILED_BREAKOUT':
      return `${t}: Breakout failed on a completed bar. New entries blocked.`;
    case 'DISTRIBUTION':
      return `${t}: Distribution risk — drawdown from the high with lower highs. Avoid unless VWAP is reclaimed.`;
    case 'STALE_DATA':
      return `${t}: Intraday data went stale. No entry decision can be made.`;
    default:
      return `${t}: ${kind}`;
  }
}

// Special-case alert that is not a structure transition: high explosion potential with poor
// trade quality is exactly the situation the user most needs told, because the stock looks
// exciting and the entry is not.
function explosionQualityDivergence(rec, prior) {
  const e = rec.explosionPotentialScore ?? 0;
  const q = rec.tradeQualityScore ?? 0;
  if (e < 65 || q >= 40) return null;
  if (prior && prior.divergenceAlerted) return null;
  return {
    kind: 'HIGH_EXPLOSION_POOR_QUALITY',
    severity: 'info',
    message: rec.manualSpreadCheckRequired
      ? `${rec.ticker}: High explosion potential but poor trade quality. Manual spread check required.`
      : `${rec.ticker}: High explosion potential (${e}) but poor trade quality (${q}). The stock may keep moving; the entry is not suitable.`,
  };
}

// Pure: given the current records and the prior alert state, produce the alerts to emit and
// the next state. No I/O — the caller persists.
function buildAlerts(records, priorState = {}, { now = new Date(), sessionDate = null } = {}) {
  const nowMs = new Date(now).getTime();
  const prior = (priorState && priorState.byTicker) || {};
  const dayCounts = (priorState && priorState.dayCounts) || {};
  const nextByTicker = { ...prior };
  const nextCounts = { ...dayCounts };
  const alerts = [];
  let suppressed = 0;

  for (const rec of records || []) {
    const t = rec.ticker;
    const p = prior[t] || null;
    const fromState = p ? p.structureState : null;
    const toState = rec.structureState;
    const entry = { ...(p || {}), structureState: toState, lastSeenAt: new Date(now).toISOString(), trigger: rec.trigger ?? null };

    if (toState && fromState !== toState) {
      for (const rule of ALERTABLE) {
        if (rule.to !== toState) continue;
        if (rule.from && !rule.from.includes(fromState)) continue;
        if (rule.constructiveFromOnly && !(fromState && CONSTRUCTIVE.has(fromState))) continue;

        const key = `${fromState || 'NEW'}->${toState}`;
        const last = (p && p.alerted && p.alerted[key]) || null;
        const triggerMoved = last && Number.isFinite(rec.trigger) && Number.isFinite(last.trigger) && last.trigger > 0
          ? Math.abs(rec.trigger - last.trigger) / last.trigger > MATERIAL_TRIGGER_CHANGE
          : false;
        const cooled = last ? (nowMs - Date.parse(last.at)) > COOLDOWN_MS : true;
        if (last && !cooled && !triggerMoved) { suppressed++; break; }
        if ((nextCounts[t] || 0) >= MAX_PER_TICKER_PER_DAY) { suppressed++; break; }
        if (alerts.length >= MAX_PER_CYCLE) { suppressed++; break; }

        alerts.push({
          schemaVersion: SCHEMA_VERSION,
          id: `${sessionDate}|${t}|${key}|${new Date(now).toISOString()}`,
          ticker: t, sessionDate, kind: rule.kind, severity: rule.severity,
          transition: key, from: fromState, to: toState,
          message: buildMessage(rule.kind, rec),
          trigger: rec.trigger ?? null,
          entryZoneLow: rec.entryZoneLow ?? null,
          maximumChasePrice: rec.maximumChasePrice ?? null,
          actionState: rec.actionState ?? null,
          at: new Date(now).toISOString(),
        });
        entry.alerted = { ...(entry.alerted || {}), [key]: { at: new Date(now).toISOString(), trigger: rec.trigger ?? null } };
        nextCounts[t] = (nextCounts[t] || 0) + 1;
        break;
      }
    }

    const div = explosionQualityDivergence(rec, p);
    if (div && (nextCounts[t] || 0) < MAX_PER_TICKER_PER_DAY && alerts.length < MAX_PER_CYCLE) {
      alerts.push({
        schemaVersion: SCHEMA_VERSION,
        id: `${sessionDate}|${t}|DIVERGENCE|${new Date(now).toISOString()}`,
        ticker: t, sessionDate, kind: div.kind, severity: div.severity,
        transition: null, from: fromState, to: toState,
        message: div.message, actionState: rec.actionState ?? null,
        at: new Date(now).toISOString(),
      });
      entry.divergenceAlerted = true;
      nextCounts[t] = (nextCounts[t] || 0) + 1;
    } else if (div) {
      suppressed++;
    }

    nextByTicker[t] = entry;
  }

  return {
    alerts,
    suppressed,
    nextState: { sessionDate, byTicker: nextByTicker, dayCounts: nextCounts, updatedAt: new Date(now).toISOString() },
  };
}

module.exports = { ALERTABLE, CONSTRUCTIVE, COOLDOWN_MS, MAX_PER_TICKER_PER_DAY, MAX_PER_CYCLE, buildAlerts, buildMessage, explosionQualityDivergence };
