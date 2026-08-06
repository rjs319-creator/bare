'use strict';
// PERSISTENT CANDIDATE LIFECYCLE & ALERTS — tech-command-lifecycle-v1.
//
// A name the page once surfaced must never silently disappear. Every candidate is
// a persisted record with a first-seen timestamp, its ORIGINAL rationale (frozen),
// its current rationale, its full action history, and — when it leaves — the exact
// reason it left.
//
// Alerts fire ONLY on meaningful transitions, are deduplicated by
// (horizon, ticker, from→to, session-day), and are cooled down per name.
//
// Pure state machine: prior records + current rows → next records + transitions +
// alerts. The route layer owns reading/writing the store.

const LIFECYCLE_VERSION = 'tech-command-lifecycle-v1';

const HORIZONS = Object.freeze(['daytrade', 'swing', 'longterm']);

// Transitions worth pushing, per horizon-agnostic action vocabulary. Anything not
// listed changes the record but does not alert.
const ALERT_RULES = Object.freeze([
  { when: r => r.isNew && r.priorityAction, kind: 'new-high-priority-candidate', priority: 'normal' },
  { when: r => r.to === 'READY' && r.from !== 'READY', kind: 'trigger-armed', priority: 'normal' },
  { when: r => (r.to === 'TRIGGERED' || r.to === 'ENTER'), kind: 'trigger-confirmed', priority: 'high' },
  { when: r => (r.to === 'INVALIDATED' || r.to === 'EXIT_INVALIDATE' || r.to === 'EXIT_THESIS_BROKEN'), kind: 'invalidation', priority: 'high' },
  { when: r => r.to === 'TARGET_REACHED', kind: 'target-reached', priority: 'normal' },
  { when: r => r.to === 'THESIS_WEAKENING', kind: 'thesis-weakened', priority: 'normal' },
  { when: r => r.catalystAdded, kind: 'major-catalyst-added', priority: 'normal' },
  { when: r => r.contradictionAdded, kind: 'major-contradiction-discovered', priority: 'normal' },
  { when: r => r.optionsChanged, kind: 'options-confirmation-changed', priority: 'low' },
  { when: r => r.attentionSaturated, kind: 'attention-saturated', priority: 'low' },
  { when: r => r.becameStale, kind: 'data-became-stale', priority: 'low' },
]);

const PRIORITY_ACTIONS = Object.freeze(new Set(['TRIGGERED', 'ENTER', 'READY', 'ACCUMULATE']));
const COOLDOWN_MS = 30 * 60 * 1000;   // per (horizon, ticker, kind)
const MAX_HISTORY = 40;
const RETAIN_DAYS = 21;               // how long a departed candidate stays visible

const iso = d => new Date(d).toISOString();

/**
 * @param {{prior?: object, horizon: string, rows: Array, now?: Date, sessionDay?: string}} input
 *   rows: [{ ticker, action, rationale, trigger, invalidation, target, catalyst,
 *            contradicting, optionsState, attentionState, stale, subsector }]
 * @returns {{records: object, transitions: Array, alerts: Array, departed: Array}}
 */
function advance({ prior = {}, horizon, rows = [], now = new Date(), sessionDay = null } = {}) {
  const nowIso = iso(now);
  const day = sessionDay || nowIso.slice(0, 10);
  const priorRecords = (prior && prior.records) || {};
  const priorAlerts = (prior && prior.alertIndex) || {};

  const records = {};
  const transitions = [];
  const seen = new Set();

  for (const row of rows) {
    if (!row || !row.ticker) continue;
    const t = String(row.ticker).toUpperCase();
    seen.add(t);
    const p = priorRecords[t] || null;
    const from = p ? p.currentAction : null;
    const isNew = !p;
    // UNKNOWN EVIDENCE CARRIES THE PRIOR VALUE FORWARD. A rate-limited provider must
    // never erase a field and then "rediscover" it next cycle as a change — that turns
    // provider flakiness into an alert storm on a board where nothing moved. Same
    // contract the Day Trade engine uses for its early state (stampEarlyState).
    const catalyst = row.catalyst ?? (p ? p.catalyst ?? null : null);
    const optionsState = row.optionsState ?? (p ? p.optionsState ?? null : null);
    const attentionState = row.attentionState ?? (p ? p.attentionState ?? null : null);
    // A change is only a change against a KNOWN prior. First sight is covered by the
    // new-candidate alert, so it must not also fire as "a new catalyst was added".
    const catalystAdded = !!(p && catalyst && p.catalyst !== catalyst);
    const priorContradictions = (p && p.contradicting) || [];
    const contradictionAdded = !!p && (row.contradicting || []).some(c => !priorContradictions.includes(c));
    const optionsChanged = !!(p && optionsState && p.optionsState !== optionsState);
    const attentionSaturated = attentionState === 'SATURATED' && !!p && p.attentionState !== 'SATURATED';
    // Same contract as the flags above: BECOMING stale is a transition, but a
    // candidate that is already stale the first time we see it has not "become"
    // anything — firing here made every new prior-session name emit a
    // data-became-stale alert on first sight (76 of them in one observed tick).
    const becameStale = row.stale === true && !!p && p.stale !== true;

    const record = {
      ticker: t,
      horizon,
      subsector: row.subsector || (p && p.subsector) || null,
      firstSeenAt: p ? p.firstSeenAt : nowIso,
      lastEvaluatedAt: nowIso,
      // The ORIGINAL rationale is frozen at first sight and never rewritten.
      originalRationale: p ? p.originalRationale : (row.rationale || null),
      originalAction: p ? p.originalAction : row.action,
      currentRationale: row.rationale || null,
      currentAction: row.action,
      priorAction: from,
      trigger: row.trigger ?? null,
      invalidation: row.invalidation ?? null,
      target: row.target ?? null,
      catalyst,
      contradicting: row.contradicting || [],
      optionsState,
      attentionState,
      stale: row.stale === true,
      present: true,
      exitReason: null,
      history: appendHistory(p, from, row.action, nowIso, row.rationale),
    };
    records[t] = record;

    if (from !== row.action || isNew) {
      transitions.push({
        ticker: t, horizon, from, to: row.action, at: nowIso, isNew,
        whatChanged: describeChange({ isNew, from, to: row.action, catalystAdded, contradictionAdded, optionsChanged, becameStale, rationale: row.rationale }),
        priorityAction: PRIORITY_ACTIONS.has(row.action),
        catalystAdded, contradictionAdded, optionsChanged, attentionSaturated, becameStale,
      });
    } else if (catalystAdded || contradictionAdded || optionsChanged || attentionSaturated || becameStale) {
      transitions.push({
        ticker: t, horizon, from, to: row.action, at: nowIso, isNew: false,
        whatChanged: describeChange({ isNew: false, from, to: row.action, catalystAdded, contradictionAdded, optionsChanged, becameStale, rationale: row.rationale }),
        priorityAction: false,
        catalystAdded, contradictionAdded, optionsChanged, attentionSaturated, becameStale,
      });
    }
  }

  // ── Departed names: retained with an explicit reason, never deleted ────────
  const departed = [];
  for (const [t, p] of Object.entries(priorRecords)) {
    if (seen.has(t)) continue;
    const ageDays = (new Date(now).getTime() - Date.parse(p.firstSeenAt || nowIso)) / 86400000;
    const exitReason = p.exitReason || inferExitReason(p);
    const rec = {
      ...p, present: false, lastEvaluatedAt: nowIso, exitReason,
      history: appendHistory(p, p.currentAction, p.currentAction, nowIso, exitReason, { force: true }),
    };
    if (ageDays <= RETAIN_DAYS) {
      records[t] = rec;
      departed.push({ ticker: t, horizon, reason: exitReason, at: nowIso, lastAction: p.currentAction });
    }
    // Beyond the retention window the record ages out of the live board; it is
    // dropped here only after having explained itself for RETAIN_DAYS.
  }

  const { alerts, alertIndex } = emitAlerts(transitions, priorAlerts, { now, day });

  return {
    schema: LIFECYCLE_VERSION,
    horizon,
    generatedAt: nowIso,
    records,
    transitions,
    alerts,
    alertIndex,
    departed,
    counts: { tracked: Object.keys(records).length, present: seen.size, departed: departed.length, transitions: transitions.length, alerts: alerts.length },
  };
}

function appendHistory(prior, from, to, at, rationale, { force = false } = {}) {
  const h = (prior && prior.history) ? prior.history.slice() : [];
  const last = h[h.length - 1];
  // A re-evaluation that lands on the SAME state as the last recorded entry is a
  // no-op: history records changes, not heartbeats. `force` is for the one case
  // that is a real event without a state change — leaving the board.
  if (!force && last && last.to === to) return h;
  h.push({ from, to, at, rationale: rationale ? String(rationale).slice(0, 240) : null });
  return h.slice(-MAX_HISTORY);
}

function describeChange({ isNew, from, to, catalystAdded, contradictionAdded, optionsChanged, becameStale, rationale }) {
  if (isNew) return `New candidate at ${to}.${rationale ? ` ${rationale}` : ''}`;
  const parts = [];
  if (from !== to) parts.push(`${from} → ${to}`);
  if (catalystAdded) parts.push('a new catalyst was added');
  if (contradictionAdded) parts.push('a new contradiction was found');
  if (optionsChanged) parts.push('the options read changed');
  if (becameStale) parts.push('the inputs went stale');
  return parts.length ? parts.join('; ') : 'no material change';
}

function inferExitReason(p) {
  switch (p.currentAction) {
    case 'TRIGGERED': case 'ENTER': return 'left the board while active — the source stopped publishing it; treat any open position on your own plan';
    case 'READY': return 'the armed setup left the board without triggering';
    case 'INVALIDATED': case 'EXIT_INVALIDATE': case 'EXIT_THESIS_BROKEN': return 'invalidated and then aged off the board';
    case 'TARGET_REACHED': return 'target was reached and the setup completed';
    default: return 'no longer meets the board criteria';
  }
}

/** Dedup: one alert per (horizon, ticker, kind, session-day), plus a per-name cooldown. */
function emitAlerts(transitions, priorIndex, { now, day }) {
  const nowMs = new Date(now).getTime();
  const index = { ...priorIndex };
  const alerts = [];
  for (const tr of transitions) {
    for (const rule of ALERT_RULES) {
      let matched = false;
      try { matched = rule.when(tr) === true; } catch { matched = false; }
      if (!matched) continue;
      const key = `${tr.horizon}|${tr.ticker}|${rule.kind}|${day}`;
      const prev = index[key];
      if (prev && nowMs - prev < COOLDOWN_MS) continue;   // deduped / cooled down
      if (prev) continue;                                  // already sent this session-day
      index[key] = nowMs;
      alerts.push({
        id: key, ticker: tr.ticker, horizon: tr.horizon, kind: rule.kind,
        priority: rule.priority, from: tr.from, to: tr.to, at: tr.at,
        message: `${tr.ticker} (${tr.horizon}): ${tr.whatChanged}`,
      });
      break;   // one alert per transition — the first matching (highest-priority) rule wins
    }
  }
  // Bound the index so it cannot grow without limit across sessions.
  const cutoff = nowMs - 3 * 86400000;
  for (const [k, v] of Object.entries(index)) if (v < cutoff) delete index[k];
  return { alerts, alertIndex: index };
}

module.exports = {
  LIFECYCLE_VERSION, HORIZONS, ALERT_RULES, PRIORITY_ACTIONS, COOLDOWN_MS, RETAIN_DAYS,
  advance, appendHistory, describeChange, inferExitReason, emitAlerts,
};
