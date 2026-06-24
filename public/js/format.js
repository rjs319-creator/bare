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

// Relative time from an ISO timestamp: "just now" / "5m ago" / "3h ago" / "2d ago".
export function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
