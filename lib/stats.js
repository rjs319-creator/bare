// Shared statistics helpers used across trackers and validation summaries.

// Wilson score interval for a binomial proportion — a conservative lower/upper
// bound on a win rate that accounts for sample size (so a lucky 3/3 doesn't read
// as "100%"). z=1.645 ≈ 90% one-sided. Returns { lo, hi } in [0,1].
function wilson(wins, n, z = 1.645) {
  if (!n) return { lo: 0, hi: 0 };
  const p = wins / n, z2 = z * z, denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// Positional ranks of an array (ties broken by original order — the same convention the
// other in-module rank-IC copies use across the app).
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  idx.forEach(([, i], k) => { r[i] = k; });
  return r;
}

// Spearman rank correlation — the app's "rank-IC": does a numeric signal order realized
// outcomes? Returns null below minN or when either series has no spread (can't correlate).
function spearman(xs, ys, minN = 2) {
  const n = xs.length;
  if (n < minN || ys.length !== n) return null;
  const rx = ranks(xs), ry = ranks(ys), m = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : null;
}

// NYSE full-day market holidays (observed dates), America/New_York. Half-days
// (early closes) are NOT listed — the market is open, so we still log. EXTEND THIS
// each year; an unlisted future holiday simply logs a stale-priced snapshot (the
// old behavior), it does not error.
const MARKET_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

function isMarketHoliday(date) { return MARKET_HOLIDAYS.has(date); }

// Today's date (America/New_York) + market-closed flags — the app's trading-day
// anchor. isMarketClosed = weekend OR a known full-day holiday; the daily log/
// snapshot ops skip when it's set so a closed session isn't recorded as a distinct
// cohort priced off the prior session's stale bars.
function nowET() {
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const wd = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const isWeekend = wd === 'Sat' || wd === 'Sun';
  const isHoliday = MARKET_HOLIDAYS.has(date);
  return { date, isWeekend, isHoliday, isMarketClosed: isWeekend || isHoliday };
}

module.exports = { wilson, spearman, ranks, nowET, isMarketHoliday, MARKET_HOLIDAYS };
