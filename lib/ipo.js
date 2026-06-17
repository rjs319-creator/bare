// Lockup-expiry feed for CERN's LOCKUP_EXPIRY event type.
//
// At IPO, insiders and early investors are typically locked up for ~180 days.
// When that lockup expires, a wave of newly-sellable shares hits the market —
// mechanical supply unrelated to fundamentals. The stock often dips into the
// expiry and reverts after the flow clears. We find IPOs from ~6 months ago and
// schedule their 180d lockup release as a forced-flow event (direction -1).
//
// Source: FMP IPO calendar (paid Starter key). Finnhub IPO calendar as fallback.
const FMP_KEY = process.env.FMP_API_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const US_EXCH = /nasdaq|nyse|amex|new york|nms|ngs|ngm|bats/i;

async function fmpIpos(from, to) {
  if (!FMP_KEY) return null;
  try {
    const r = await fetch(`https://financialmodelingprep.com/api/v3/ipo_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`);
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows)) return null;
    return rows.map(x => ({ symbol: x.symbol, date: x.date, exchange: x.exchange }));
  } catch { return null; }
}
async function finnhubIpos(from, to) {
  if (!FINNHUB_KEY) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/calendar/ipo?from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    if (!r.ok) return null;
    const rows = ((await r.json()) || {}).ipoCalendar || [];
    return rows.map(x => ({ symbol: x.symbol, date: x.date, exchange: x.exchange }));
  } catch { return null; }
}

// IPOs whose 180d lockup expires in [now-lookbackDays, now+aheadDays].
// => query IPOs in [now-(lockup+lookback), now-(lockup-ahead)].
async function fetchLockupExpiries({ nowMs = Date.now(), lockupDays = 180, lookbackDays = 70, aheadDays = 10 } = {}) {
  const from = iso(nowMs - (lockupDays + lookbackDays) * DAY);
  const to = iso(nowMs - (lockupDays - aheadDays) * DAY);
  let rows = await fmpIpos(from, to);
  if (rows == null) rows = await finnhubIpos(from, to);
  if (!rows) return [];
  const out = [];
  for (const x of rows) {
    if (!x.symbol || !x.date) continue;
    if (x.exchange && !US_EXCH.test(String(x.exchange))) continue;   // tradeable US listings
    const ipoMs = Date.parse(x.date + 'T00:00:00Z');
    if (isNaN(ipoMs)) continue;
    const ticker = String(x.symbol).toUpperCase().replace(/\./g, '-');
    if (!/^[A-Z][A-Z\-]{0,5}$/.test(ticker)) continue;
    const lockupMs = ipoMs + lockupDays * DAY;
    out.push({ ticker, ipoDate: x.date, lockupDate: iso(lockupMs), lockupMs });
  }
  // Dedupe by ticker (keep the earliest IPO if duplicates).
  const seen = new Map();
  for (const x of out.sort((a, b) => (a.ipoDate < b.ipoDate ? -1 : 1))) if (!seen.has(x.ticker)) seen.set(x.ticker, x);
  return [...seen.values()];
}

module.exports = { fetchLockupExpiries };
