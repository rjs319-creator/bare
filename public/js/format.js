// Pure formatting helpers — shared across the UI. No app state, no DOM.

// HTML-escape a value for safe interpolation into innerHTML.
export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Compact dollar amount: 950 → "$950", 8200 → "$8.2k", 44000 → "$44k".
export function fmtMoney(n) {
  n = n || 0;
  return n >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : '$' + Math.round(n);
}

// Relative age of a timestamp (ISO string, epoch ms, or Date): "just now" /
// "5m ago" / "3h ago" / "2d ago". THE single source of truth for every "…ago"
// surface — app.js stampText, hcAgeText, and today.js cache banners all delegate
// here so the same payload age renders identically everywhere. Convention:
// under 90s = "just now", then ROUNDED minutes/hours/days with cutoffs at
// 1h/24h. Unparseable/missing input reads "a while ago" — vague but honest,
// never "NaNm ago" and never epoch-1970 as a real age.
export function timeAgo(ts) {
  const t = ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return 'a while ago';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
