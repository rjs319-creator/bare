// NOTIFICATION PREFERENCES + DELIVERY DECISION — pure logic, no DOM, no storage I/O.
// app.js supplies the persisted prefs/state and applies the decisions; keeping the policy
// pure makes it unit-testable (test/daytrade-ui-contract.test.js) and closes the two client
// defects: (1) the 3 newest unread items re-fired a browser notification every 60s until
// the Alerts tab was opened; (2) no per-class preference existed — early-watch research
// pings and confirmed triggers were indistinguishable, and quiet hours / rate caps did not
// exist at all.

export const DEFAULT_PREFS = Object.freeze({
  earlyWatch: false,          // opt-in — research pings are off until asked for
  confirmedTrigger: true,
  retirement: true,
  sound: false,
  browserNotifications: true, // still gated by the OS permission, of course
  quietHours: { enabled: false, startET: 20, endET: 7 },   // hours 0-23, wraps midnight
  maxPerHour: 6,
  maxPerDay: 20,
});

// Which preference class governs a feed item. Non-daytrade items (sharp/stance/crowd) are
// governed only by the global toggles, never the per-class ones.
export function classOfItem(item) {
  if (!item || item.type !== 'daytrade') return null;
  if (item.kind === 'early_watch') return 'earlyWatch';
  if (item.kind === 'entry' || item.kind === 'revive') return 'confirmedTrigger';
  if (item.kind === 'retire' || item.kind === 'caution') return 'retirement';
  return 'confirmedTrigger';   // unknown daytrade kinds default to the strictest-audited class
}

export function inQuietHours(quiet, etHour) {
  if (!quiet || !quiet.enabled) return false;
  const s = quiet.startET, e = quiet.endET;
  if (s === e) return false;
  return s < e ? (etHour >= s && etHour < e) : (etHour >= s || etHour < e);
}

// state = { notifiedIds: string[], sentLog: number[] (epoch ms of prior notifications) }
// Returns { notify: boolean, reason } — reason names the FIRST gate that blocked, for tests
// and for an honest "why didn't this notify" diagnostic.
export function shouldNotify(item, prefs, state, nowMs, etHour) {
  const p = { ...DEFAULT_PREFS, ...(prefs || {}), quietHours: { ...DEFAULT_PREFS.quietHours, ...((prefs || {}).quietHours || {}) } };
  const s = { notifiedIds: [], sentLog: [], ...(state || {}) };
  if (!p.browserNotifications) return { notify: false, reason: 'browser-notifications-off' };
  if (item && item.id && s.notifiedIds.includes(item.id)) return { notify: false, reason: 'already-notified' };
  const cls = classOfItem(item);
  if (cls && !p[cls]) return { notify: false, reason: `class-off:${cls}` };
  if (inQuietHours(p.quietHours, etHour)) return { notify: false, reason: 'quiet-hours' };
  const hourAgo = nowMs - 3600_000, dayAgo = nowMs - 86_400_000;
  const lastHour = s.sentLog.filter(t => t > hourAgo).length;
  const lastDay = s.sentLog.filter(t => t > dayAgo).length;
  if (lastHour >= p.maxPerHour) return { notify: false, reason: 'hourly-cap' };
  if (lastDay >= p.maxPerDay) return { notify: false, reason: 'daily-cap' };
  return { notify: true, reason: 'ok' };
}

// Housekeeping helpers so app.js stores bounded state.
export function recordNotified(state, item, nowMs) {
  const s = { notifiedIds: [], sentLog: [], ...(state || {}) };
  return {
    notifiedIds: [...s.notifiedIds, item.id].slice(-300),
    sentLog: [...s.sentLog, nowMs].filter(t => t > nowMs - 86_400_000).slice(-200),
  };
}
