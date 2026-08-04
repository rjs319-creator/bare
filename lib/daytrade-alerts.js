'use strict';
// DAY-TRADE ALERTS — server-authoritative, transition-only, deduplicated, TWO-CLASS.
//
// Two clearly separated bullish notification classes (the redesign's core contract):
//   A. EARLY WATCH (kind 'early_watch') — an upward early-state progression
//      (SCOUT → PRIMED → IGNITION → EARLY_CONFIRMED) on a setup. EXPLICITLY not an entry:
//      the payload states what changed, what confirmation is still missing, what invalidates
//      it, how fresh the data is, and carries an honest uncalibrated-evidence label. Never
//      shows probabilities, never carries buy levels.
//   B. CONFIRMED TRIGGER (kind 'entry' / 'revive') — only after the lifecycle's execution
//      gate passed (fresh bar+quote, trigger, VWAP structure, residual, R:R, extension). It
//      carries the live plan (entry zone / stop / target), remaining R:R, evidence and risks.
// Plus 'retire' / 'caution' maintenance alerts — SUPPRESSED unless this episode previously
// received an entry/early alert (a retirement the user never heard about is board-only).
//
// ANTI-FLAPPING GUARANTEES (layered, in order):
//   1. transition-only — an unchanged state emits nothing;
//   2. episode identity — the lifecycle mints a new setupId ONLY on a material structural
//      change, so a non-material revival reuses the same dedup key and cannot re-alert;
//   3. persisted id dedup — each (setupId, toState) / (setupId, earlyState) alerts at most
//      once per day, with the id set written to the durable log BEFORE the user-facing feed;
//   4. budgets — per-ticker/day and per-cycle caps; overflow is COUNTED and reported, never
//      silently dropped.
//
// ALERT-STATE STAMPING. Emission is written back onto the lifecycle record (alertState +
// entryAlertEmittedAt) so "already alerted" is durable, survives restarts, and retire-alert
// suppression / the Managing lane can key off it. NOTE entryAlertEmittedAt ≠ entryAlertAt:
// a notification is NOT a position — the post-entry MANAGING lock still requires an explicit
// entry signal (ev.hasEntryAlert), never a mere notification.
//
// HONEST DELIVERY: alerts are produced whenever the lifecycle advances (op=daytrade — page
// traffic or the scheduled board tick). Web Push delivery exists ONLY when the operator has
// configured VAPID keys (lib/push-notify); otherwise the in-app feed is the delivery path.

const { readJSON, writeJSON, hasStore, readNotifyFeed, writeNotifyFeed } = require('./store');
const { STATES } = require('./opportunity-lifecycle');
const CFG = require('./daytrade-config');

const alertsKey = date => `lifecycle/daytrade/alerts/${date}.json`;
const FEED_CAP = 80;   // matches the existing notify-feed rolling cap

const EARLY_RANK = Object.fromEntries(CFG.ALERTS.EARLY_LADDER.map((s, i) => [s, i]));
const EARLY_LABEL = { SCOUT: 'scout', PRIMED: 'primed', IGNITION: 'igniting', EARLY_CONFIRMED: 'early move confirmed' };

// Which lifecycle transitions alert, and how loudly. Everything else is board-only.
const ACTIVE_BEFORE = new Set([STATES.ACTIONABLE_NOW, STATES.REVERSAL_RECLAIM, STATES.ARMED, STATES.MANAGING, STATES.OPENING_RANGE_FORMING]);
function classifyTransition(tr) {
  const { from, to, reasonCode } = tr;
  if (to === STATES.ACTIONABLE_NOW || to === STATES.REVERSAL_RECLAIM) {
    return { kind: reasonCode === 'REVIVED' ? 'revive' : 'entry', sev: 'high' };
  }
  if (to === STATES.TOO_EXTENDED && ACTIVE_BEFORE.has(from)) return { kind: 'caution', sev: 'low' };
  if ((to === STATES.FAILED || to === STATES.STALLING || to === STATES.EXPIRED) && ACTIVE_BEFORE.has(from)) {
    return { kind: 'retire', sev: 'med' };
  }
  return null;
}

const nyClock = iso => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

// What confirmation the lifecycle's actionable gate is still missing for a watched name —
// derived from the SAME gate fields the engine checks, so the copy can never drift from the
// actual requirement.
function confirmationMissing(c) {
  const missing = [];
  if (c.triggerConfirmed !== true) missing.push('no confirmed trigger above the opening range');
  if (c.aboveVwap !== true) missing.push('not holding above VWAP');
  if (!(c.timeOfDayRelVol >= 1.5)) missing.push('time-of-day volume not yet abnormal');
  if (c.remainingRR != null && c.remainingRR < 1.0) missing.push('remaining reward:risk below floor');
  if (c.currentSessionFresh !== true) missing.push('current-session data not fully fresh');
  return missing.length ? missing : ['full execution-quality gate not yet evaluated'];
}

function freshnessLine(c, nowIso) {
  const age = c.execution && c.execution.quoteAgeSeconds != null ? `quote ${c.execution.quoteAgeSeconds}s old` : 'quote age unknown';
  const bar = c.intradayBarAsOf ? `bar ${nyClock(c.intradayBarAsOf)}` : 'no intraday bar';
  return `${age} · ${bar}`;
}

// ── EARLY WATCH alert (class A) ───────────────────────────────────────────────
// tr = { ticker, from, to (early state), at, setupId, card, firstDetectedAt }
function buildEarlyAlert(tr, { now } = {}) {
  const c = tr.card || {};
  const at = tr.at || now || new Date().toISOString();
  const sinceFirstMin = tr.firstDetectedAt
    ? Math.max(0, Math.round((Date.parse(at) - Date.parse(tr.firstDetectedAt)) / 60000)) : null;
  return {
    id: `daytrade|${tr.ticker}|${tr.setupId || 'legacy'}|early|${tr.to}`,
    ticker: tr.ticker,
    at, atET: nyClock(at),
    kind: 'early_watch', sev: 'low',
    actionability: 'watch-only — NOT a confirmed entry, NOT a buy recommendation',
    earlyState: tr.to,
    earlyFrom: tr.from || null,
    setupId: tr.setupId || null,
    whatChanged: (c.earlyWhy && c.earlyWhy.length) ? c.earlyWhy : [`early state advanced to ${tr.to}`],
    confirmationMissing: confirmationMissing(c),
    invalidation: 'loses VWAP, momentum decelerates, or the abnormal-activity signal (CUSUM) resets',
    dataFreshness: freshnessLine(c, at),
    // Honest evidence label — deterministic thresholds being measured for lead time, never a
    // probability. Mirrors lib/daytrade-early-state BASIS.
    evidenceLabel: c.earlyBasis || 'early-signal research state (deterministic, uncalibrated — not a probability)',
    sinceFirstDetectionMin: sinceFirstMin,
    price: c.currentPrice ?? null,
    // Deliberately NO plan / entry / stop / target on an early alert.
  };
}

// ── CONFIRMED TRIGGER / maintenance alert (class B) ───────────────────────────
function buildAlert(tr, { now } = {}) {
  const cls = classifyTransition(tr);
  if (!cls) return null;
  const c = tr.card || {};
  const at = tr.at || now || new Date().toISOString();
  const lp = c.livePlan || null;
  const latencyMin = tr.firstSeenAt ? Math.max(0, Math.round((Date.parse(at) - Date.parse(tr.firstSeenAt)) / 60000)) : null;
  const drivers = {
    positive: [
      c.triggerConfirmed === true ? 'trigger confirmed above the opening range' : null,
      c.aboveVwap === true ? 'holding above VWAP' : null,
      c.timeOfDayRelVol != null && c.timeOfDayRelVol >= 1.5 ? `${c.timeOfDayRelVol}× time-of-day volume` : null,
      c.residualVsSpy != null && c.residualVsSpy > 0 ? `+${c.residualVsSpy}% vs SPY` : null,
      c.residualSector15 != null && c.residualSector15 > 0 ? `outpacing its sector` : null,
    ].filter(Boolean),
    negative: [
      c.stopBreached ? 'stop breached' : null,
      c.breakoutFailed ? 'breakout failed' : null,
      c.extensionAtr != null && c.extensionAtr > 2 ? `${c.extensionAtr} ATR extended` : null,
      c.residualVsSpy != null && c.residualVsSpy < 0 ? `${c.residualVsSpy}% vs SPY` : null,
      c.execution && c.execution.spreadStatus === 'unknown' ? 'spread unknown (not assumed favorable)' : null,
    ].filter(Boolean),
  };
  return {
    // (setupId, toState) is the once-per-day dedup identity.
    id: `daytrade|${tr.ticker}|${tr.setupId || 'legacy'}|${tr.to}`,
    ticker: tr.ticker,
    at, atET: nyClock(at),
    kind: cls.kind, sev: cls.sev,
    actionability: (cls.kind === 'entry' || cls.kind === 'revive')
      ? 'confirmed trigger — execution gate passed at emission time; conditions can invalidate at any moment'
      : 'maintenance — a previously alerted setup changed state',
    transition: { from: tr.from, to: tr.to, reasonCode: tr.reasonCode },
    setupId: tr.setupId || null,
    explanation: tr.explanation || null,
    alertLatencyMin: latencyMin,
    // Live evidence at alert time (point-in-time; graded later from post-decision bars only).
    price: c.currentPrice ?? null,
    quoteAgeSeconds: c.execution ? c.execution.quoteAgeSeconds : null,
    plan: lp ? { entry: lp.entry, stop: lp.stop, target: lp.target, rr: lp.rr, trigger: lp.trigger, expiresAt: lp.expiresAt, basis: lp.basis } : null,
    remainingRR: c.remainingRR ?? null,
    // Research scores (deterministic baselines — NOT calibrated probabilities; labeled so).
    runnerScore: c.runnerScore ?? null,
    dudScore: c.dudScore ?? null,
    scoreBasis: c.scoreBasis ?? null,
    drivers,
    catalyst: c.catalyst || null,
    detection: c.detection || null,
  };
}

// Plain-English one-liner for the compact feed item. Early copy must NEVER read as a buy.
function feedTitle(a) {
  switch (a.kind) {
    case 'early_watch': return `🛰 ${a.ticker} early watch — ${EARLY_LABEL[a.earlyState] || a.earlyState} (watching, not a trade)`;
    case 'entry': return `⚡ ${a.ticker} confirmed trigger ${a.atET}`;
    case 'revive': return `🔁 ${a.ticker} setup re-confirmed after retirement ${a.atET}`;
    case 'retire': return `🛑 ${a.ticker} retired — ${String(a.transition && a.transition.reasonCode || '').replace(/_/g, ' ').toLowerCase()}`;
    case 'caution': return `⚠️ ${a.ticker} too extended — do not chase`;
    default: return `${a.ticker} ${a.transition ? a.transition.to : a.earlyState || ''}`;
  }
}
function feedDetail(a) {
  if (a.kind === 'early_watch') {
    const bits = [
      (a.whatChanged || []).slice(0, 2).join('; '),
      `still missing: ${(a.confirmationMissing || []).slice(0, 2).join('; ')}`,
      'Not a confirmed entry.',
    ].filter(Boolean);
    return bits.join(' — ').slice(0, 240);
  }
  const bits = [];
  if (a.plan) bits.push(`entry ${a.plan.entry} · stop ${a.plan.stop} · target ${a.plan.target} (live plan)`);
  if (a.explanation) bits.push(a.explanation);
  return bits.join(' — ').slice(0, 240);
}

// ── Alert-state stamping (durable "already alerted") ─────────────────────────
// Immutable: returns a NEW record carrying the emitted alert ids. entryAlertEmittedAt marks
// notification emission ONLY — it never flips the record into MANAGING (that requires an
// explicit position-entry signal).
function withAlertMarks(record, emittedForTicker) {
  if (!record || !emittedForTicker || !emittedForTicker.length) return record;
  const prev = record.alertState || {};
  const keys = new Set(prev.keys || []);
  let entryAlertEmittedAt = record.entryAlertEmittedAt || null;
  let lastAt = prev.lastAt || null;
  for (const a of emittedForTicker) {
    keys.add(a.id);
    if ((a.kind === 'entry' || a.kind === 'revive') && !entryAlertEmittedAt) entryAlertEmittedAt = a.at;
    lastAt = a.at;
  }
  return {
    ...record,
    entryAlertEmittedAt,
    alertState: { keys: [...keys].slice(-60), lastAt },
  };
}

// Has this episode (setupId) previously produced ANY user-facing alert? Used to suppress
// retirement/caution noise for setups the user never heard about.
function episodeWasAlerted(record, setupId) {
  const keys = (record && record.alertState && record.alertState.keys) || [];
  const prefix = `daytrade|${record && record.ticker}|${setupId}|`;
  return keys.some(k => typeof k === 'string' && k.startsWith(prefix));
}

// BUDGETS — per-ticker/day then per-cycle, deterministic order (high sev first, then time).
// Overflow is counted and reported as suppressed — never silently dropped. Pure.
function applyAlertBudgets(fresh, priorCountByTicker = {}) {
  const sevRank = { high: 0, med: 1, low: 2 };
  const ordered = [...fresh].sort((a, b) => (sevRank[a.sev] ?? 3) - (sevRank[b.sev] ?? 3) || (a.at < b.at ? -1 : 1));
  const perTicker = { ...priorCountByTicker };
  const budgeted = [];
  const overBudget = [];
  for (const a of ordered) {
    const n = perTicker[a.ticker] || 0;
    if (n >= CFG.ALERTS.MAX_PER_TICKER_PER_DAY) { overBudget.push({ id: a.id, reason: 'ticker-day-budget' }); continue; }
    if (budgeted.length >= CFG.ALERTS.MAX_PER_CYCLE) { overBudget.push({ id: a.id, reason: 'cycle-budget' }); continue; }
    perTicker[a.ticker] = n + 1;
    budgeted.push(a);
  }
  return { budgeted, overBudget };
}

// ── Emission ─────────────────────────────────────────────────────────────────
// transitions       — reason-coded lifecycle transitions (class B input)
// opts.earlyTransitions — upward early-state progressions (class A input)
// opts.records      — current lifecycle records (for retirement-suppression checks)
// Dedup against the persisted day log FIRST, then budgets, then the feed. Never throws;
// without Blob returns the built alerts with persisted:false.
async function emitDaytradeAlerts(transitions, { date, now, earlyTransitions = [], records = {} } = {}) {
  const builtLifecycle = (transitions || []).map(tr => buildAlert(tr, { now })).filter(Boolean);
  const builtEarly = (earlyTransitions || []).map(tr => buildEarlyAlert(tr, { now })).filter(Boolean);

  // Retirement/caution suppression: only alert a retirement the user could care about —
  // i.e. this episode previously emitted an entry/revive/early alert. Others are board-only.
  const suppressedRetirements = [];
  const relevant = builtLifecycle.filter(a => {
    if (a.kind !== 'retire' && a.kind !== 'caution') return true;
    const rec = records[a.ticker];
    // In-cycle pairing: an entry alert emitted THIS cycle also makes its retirement relevant.
    const inCycle = builtLifecycle.some(b => b.ticker === a.ticker && (b.kind === 'entry' || b.kind === 'revive'));
    if ((rec && episodeWasAlerted(rec, a.setupId)) || inCycle) return true;
    suppressedRetirements.push({ id: a.id, reason: 'episode-never-alerted' });
    return false;
  });

  const built = [...relevant, ...builtEarly];
  const base = { suppressed: suppressedRetirements.length, suppressedDetail: suppressedRetirements };
  if (!built.length) return { alerts: [], emitted: 0, persisted: hasStore(), ...base };
  if (!hasStore()) return { alerts: built, emitted: built.length, persisted: false, ...base };
  try {
    const doc = await readJSON(alertsKey(date), { alerts: [] }).catch(() => ({ alerts: [] }));
    const have = new Set((doc.alerts || []).map(a => a.id));
    let fresh = built.filter(a => !have.has(a.id));

    const perTicker = {};
    for (const a of doc.alerts || []) perTicker[a.ticker] = (perTicker[a.ticker] || 0) + 1;
    const { budgeted, overBudget } = applyAlertBudgets(fresh, perTicker);
    fresh = budgeted;
    if (!fresh.length) {
      return { alerts: [], emitted: 0, persisted: true, ...base, suppressed: base.suppressed + overBudget.length, suppressedDetail: [...suppressedRetirements, ...overBudget] };
    }
    const merged = [...(doc.alerts || []), ...fresh];
    await writeJSON(alertsKey(date), {
      date, alerts: merged, updatedAt: new Date().toISOString(),
      suppressed: [...(doc.suppressed || []), ...suppressedRetirements, ...overBudget].slice(-200),
    }, 0);

    // Compact items into the shared notification feed (badge + notification conventions).
    try {
      const feed = await readNotifyFeed().catch(() => ({ items: [] }));
      const items = feed.items || [];
      const haveFeed = new Set(items.map(i => i.id));
      let added = 0;
      for (const a of fresh) {
        if (haveFeed.has(a.id)) continue;
        items.unshift({ ts: a.at, id: a.id, type: 'daytrade', kind: a.kind, sev: a.sev, go: 'daytrade', title: feedTitle(a), detail: feedDetail(a) });
        added++;
      }
      if (added) { feed.items = items.slice(0, FEED_CAP); await writeNotifyFeed(feed); }
    } catch { /* feed write is best-effort; the durable log already has the alerts */ }

    // Optional Web Push delivery (no-op unless VAPID env is configured — see lib/push-notify).
    try {
      const push = require('./push-notify');
      if (push.isConfigured()) await push.sendAlerts(fresh.map(a => ({ id: a.id, kind: a.kind, sev: a.sev, title: feedTitle(a), body: feedDetail(a) })));
    } catch { /* push is best-effort and feature-flagged */ }

    return {
      alerts: fresh, emitted: fresh.length, persisted: true, totalToday: merged.length,
      ...base, suppressed: base.suppressed + overBudget.length, suppressedDetail: [...suppressedRetirements, ...overBudget],
    };
  } catch (e) {
    return { alerts: [], emitted: 0, persisted: false, reason: String((e && e.message) || e), ...base };
  }
}

// op=daytradealerts — today's (or ?date=) structured Day Trade alert log, newest first.
async function runDaytradeAlerts(req, res) {
  const { etDate } = require('./freshness');
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : etDate(new Date());
  const doc = await readJSON(alertsKey(date), { alerts: [] }).catch(() => ({ alerts: [] }));
  const alerts = [...(doc.alerts || [])].sort((a, b) => (a.at < b.at ? 1 : -1));
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.json({
    ok: true, date, count: alerts.length, alerts, durable: hasStore(),
    suppressedToday: (doc.suppressed || []).length,
    delivery: 'Alerts are produced whenever the lifecycle advances (op=daytrade — page traffic or the scheduled board tick) and surfaced via the in-app feed, opt-in browser notifications, and Web Push when the operator has configured VAPID keys.',
    generatedAt: new Date().toISOString(),
  });
}

module.exports = {
  classifyTransition, buildAlert, buildEarlyAlert, emitDaytradeAlerts, runDaytradeAlerts,
  feedTitle, feedDetail, alertsKey, withAlertMarks, episodeWasAlerted, applyAlertBudgets, EARLY_RANK,
};
