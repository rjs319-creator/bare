'use strict';
// DAY-TRADE TRANSITION ALERTS — server-authoritative, transition-only, deduplicated.
//
// The lifecycle engine advances persisted records; only a REASON-CODED STATE TRANSITION can
// produce an alert, and each (setupId, toState) pair alerts AT MOST ONCE per day — repeated
// page refreshes, concurrent requests and CDN misses can never re-emit an alert because the
// dedup key is persisted in the day's alert log before the user-facing feed is written.
//
// Two sinks:
//   1. lifecycle/daytrade/alerts/<date>.json — the durable, structured, gradeable alert log
//      (full evidence payload per alert; append-only by id). op=daytradealerts serves it.
//   2. notify/feed.json — the app's existing notification feed (badge + browser notification
//      conventions), which gets a COMPACT item per alert. Same id → the feed's own dedup also
//      holds across writers.
//
// HONEST DELIVERY LIMITATION (stated, not hidden): there is no server-side Web Push, and the
// only cron runs once daily post-close. Alerts are produced whenever the lifecycle advances —
// i.e. on any op=daytrade evaluation (page open ≈ every 60s, shared via CDN) — and delivered
// through the feed + in-page notifications. True background push would need infrastructure
// this deployment doesn't have; we do not pretend otherwise.

const { readJSON, writeJSON, hasStore, readNotifyFeed, writeNotifyFeed } = require('./store');
const { STATES } = require('./opportunity-lifecycle');

const alertsKey = date => `lifecycle/daytrade/alerts/${date}.json`;
const FEED_CAP = 80;   // matches the existing notify-feed rolling cap

// Which transitions alert, and how loudly. Everything else is board-only.
//   entry   — a confirmed, execution-valid setup (the only buy-language alert)
//   retire  — a previously live/armed name confirmed invalid (exact reason attached)
//   caution — real strength but an unacceptable chase
//   revive  — a NEW setup on a previously retired name (new setupId, new plan)
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

// Build the full, structured, gradeable alert from a transition (card = canonical envelope).
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
    ].filter(Boolean),
    negative: [
      c.stopBreached ? 'stop breached' : null,
      c.breakoutFailed ? 'breakout failed' : null,
      c.extensionAtr != null && c.extensionAtr > 2 ? `${c.extensionAtr} ATR extended` : null,
      c.residualVsSpy != null && c.residualVsSpy < 0 ? `${c.residualVsSpy}% vs SPY` : null,
    ].filter(Boolean),
  };
  return {
    // (setupId, toState) is the once-per-day dedup identity.
    id: `daytrade|${tr.ticker}|${tr.setupId || 'legacy'}|${tr.to}`,
    ticker: tr.ticker,
    at, atET: nyClock(at),
    kind: cls.kind, sev: cls.sev,
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

// Plain-English one-liner for the compact feed item.
function feedTitle(a) {
  switch (a.kind) {
    case 'entry': return `⚡ ${a.ticker} confirmed runner — trigger met ${a.atET}`;
    case 'revive': return `🔁 ${a.ticker} new setup after retirement ${a.atET}`;
    case 'retire': return `🛑 ${a.ticker} retired — ${String(a.transition.reasonCode || '').replace(/_/g, ' ').toLowerCase()}`;
    case 'caution': return `⚠️ ${a.ticker} too extended — do not chase`;
    default: return `${a.ticker} ${a.transition.to}`;
  }
}
function feedDetail(a) {
  const bits = [];
  if (a.plan) bits.push(`entry ${a.plan.entry} · stop ${a.plan.stop} · target ${a.plan.target} (live plan)`);
  if (a.explanation) bits.push(a.explanation);
  return bits.join(' — ').slice(0, 240);
}

// Emit alerts for a batch of transitions: dedup against the persisted day log FIRST, then
// append the structured alerts and push compact items to the shared notify feed. Never
// throws; without Blob it returns the built alerts with persisted:false (in-memory only —
// the response can still surface them, but cross-refresh dedup needs storage).
async function emitDaytradeAlerts(transitions, { date, now } = {}) {
  const built = (transitions || []).map(tr => buildAlert(tr, { now })).filter(Boolean);
  if (!built.length) return { alerts: [], emitted: 0, persisted: hasStore() };
  if (!hasStore()) return { alerts: built, emitted: built.length, persisted: false };
  try {
    const doc = await readJSON(alertsKey(date), { alerts: [] }).catch(() => ({ alerts: [] }));
    const have = new Set((doc.alerts || []).map(a => a.id));
    const fresh = built.filter(a => !have.has(a.id));
    if (!fresh.length) return { alerts: [], emitted: 0, persisted: true };
    const merged = [...(doc.alerts || []), ...fresh];
    await writeJSON(alertsKey(date), { date, alerts: merged, updatedAt: new Date().toISOString() }, 0);

    // Compact items into the shared notification feed (badge + notification conventions).
    try {
      const feed = await readNotifyFeed().catch(() => ({ items: [] }));
      const items = feed.items || [];
      const haveFeed = new Set(items.map(i => i.id));
      let added = 0;
      for (const a of fresh) {
        if (haveFeed.has(a.id)) continue;
        items.unshift({ ts: a.at, id: a.id, type: 'daytrade', sev: a.sev, go: 'daytrade', title: feedTitle(a), detail: feedDetail(a) });
        added++;
      }
      if (added) { feed.items = items.slice(0, FEED_CAP); await writeNotifyFeed(feed); }
    } catch { /* feed write is best-effort; the durable log already has the alerts */ }

    return { alerts: fresh, emitted: fresh.length, persisted: true, totalToday: merged.length };
  } catch (e) {
    return { alerts: [], emitted: 0, persisted: false, reason: String((e && e.message) || e) };
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
    delivery: 'Alerts are produced whenever the lifecycle advances (any op=daytrade evaluation; ~60s while the page is open) and surfaced via the in-app feed + opt-in browser notifications. No server-side background push exists on this deployment — with the app closed, alerts accrue here and deliver on next open.',
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { classifyTransition, buildAlert, emitDaytradeAlerts, runDaytradeAlerts, feedTitle, feedDetail, alertsKey };
