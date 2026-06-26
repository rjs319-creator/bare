'use strict';
// Core Momentum engine — the survivorship-safe small/mid SECTOR-NEUTRAL 12-1 momentum
// strategy validated in research/ (steps 14-21; mirrors research/momentum_score.py
// ScoreConfig.stable_core). SSOT for the server ops (lib/stablecore-routes.js) and the
// Core tab. The two must stay in sync, like lib/apex.js ↔ index.html.
//
// LIVE / forward use, so it screens TODAY's in-band universe from FMP. Survivorship bias
// only distorts *backtests* (already handled in research) — a forward screener that tracks
// the real outcomes of the names it actually picks is unaffected. That's why this is far
// simpler than the research rig: current market cap from the screener, no PIT-shares rebuild.
//
// STRATEGY (validated): cap $800M-5B, exclude top realized-vol tercile, exclude Healthcare
// (binary FDA events kill momentum); rank by sector-neutral 12-1 (12-month return skipping
// the last month, minus the sector median); equal-weight the top quintile with a rank buffer
// (enter top 20%, hold until out of top 40%); quarterly rebalance; ~63-session time exit.

const FMP = process.env.FMP_API_KEY;
const BASE = 'https://financialmodelingprep.com/stable';

// ── strategy constants (do not tune without OOS evidence — see research caveats) ──
const CAP_LO = 800e6, CAP_HI = 5e9, ADV_FLOOR = 3e6;
const EXCLUDE_SECTORS = new Set(['Healthcare']);
const EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX']);
const HIVOL_TERCILE = 2 / 3;                 // drop names with vol above this within-pool quantile
const ENTER_Q = 0.20, HOLD_Q = 0.40;          // rank-buffer hysteresis
const LOOKBACK = 252, SKIP = 21, VOL_LB = 63;  // 12-1 signal; 63d realized vol
const MAX_HOLD = 63;                          // ~quarter time exit
const CATA_STOP = 0.30, TARGET_UP = 0.50;     // WIDE levels: research showed tight stops bleed a

// ── small math helpers ──
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function quantile(arr, q) { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

async function fmpGet(path) {
  if (!FMP) throw new Error('FMP_API_KEY not configured');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}/${path}${sep}apikey=${FMP}`);
  if (!res.ok) throw new Error(`FMP ${res.status} on ${path.split('?')[0]}`);
  const j = await res.json();
  if (j && j['Error Message']) throw new Error(`FMP: ${j['Error Message']}`);
  return j;
}

// Current in-band US common-stock universe (one call, paginated by FMP's limit).
async function fetchUniverse() {
  const rows = await fmpGet(`company-screener?marketCapMoreThan=${CAP_LO}&marketCapLowerThan=${CAP_HI}&country=US&isEtf=false&isActivelyTrading=true&limit=5000`);
  if (!Array.isArray(rows)) return [];
  return rows.filter(r =>
    r && r.symbol && !r.isEtf && !r.isFund &&
    EXCHANGES.has(r.exchangeShortName) &&
    r.sector && !EXCLUDE_SECTORS.has(r.sector) &&
    r.marketCap >= CAP_LO && r.marketCap <= CAP_HI &&
    r.price > 1 && r.volume > 0 &&
    /^[A-Z]{1,5}$/.test(r.symbol)               // drop preferreds / warrants / odd tickers
  ).map(r => ({ symbol: r.symbol, sector: r.sector, marketCap: r.marketCap, price: r.price, volume: r.volume, company: r.companyName }));
}

// ~1.5y of daily closes (enough for 252+21 lookback + a buffer), oldest→newest.
async function fetchCloses(symbol, days = 420) {
  const from = new Date(Date.now() - days * 2.0 * 86400e3).toISOString().slice(0, 10); // calendar≈2×trading
  const rows = await fmpGet(`historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&from=${from}`);
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows
    .map(r => ({ date: r.date, close: r.close, dollar: (r.close || 0) * (r.volume || 0) }))
    .filter(r => r.date && r.close > 0)
    .sort((a, b) => a.date < b.date ? -1 : 1);
}

// 12-1 momentum, 63d annualized vol, 20d avg dollar volume from a close series.
function featuresFromCloses(closes) {
  const n = closes.length;
  if (n < LOOKBACK + 1) return null;
  const end = closes[n - 1 - SKIP].close, start = closes[n - 1 - LOOKBACK].close;
  if (!(start > 0) || !(end > 0)) return null;
  const m121 = end / start - 1;
  const rets = [];
  for (let k = n - VOL_LB; k < n; k++) { const x = closes[k].close / closes[k - 1].close - 1; if (Number.isFinite(x)) rets.push(Math.max(-0.5, Math.min(0.5, x))); }
  const v = sd(rets); const vol63 = v ? v * Math.sqrt(252) : null;
  let s = 0, c = 0; for (let k = Math.max(0, n - 20); k < n; k++) { s += closes[k].dollar; c++; }
  const adv20 = c ? s / c : 0;
  return { m121, vol63, adv20, lastClose: closes[n - 1].close };
}

// Trade levels for the ledger/outcome resolver. WIDE on purpose: the strategy is a
// ~quarter time-hold, so the EXPIRED-at-MAX_HOLD realized return is what we want to
// measure — tight stops fired on noise and bled money in research (op=exits arc).
function levelsFor(price) {
  return { entry: +price.toFixed(2), stop: +(price * (1 - CATA_STOP)).toFixed(2), target: +(price * (1 + TARGET_UP)).toFixed(2) };
}

// Build the book from per-name features. `held` = Set of symbols held last rebalance
// (for the rank buffer). Returns the ranked, filtered, equal-weighted book + diagnostics.
function buildBook(features, held = new Set()) {
  // features: [{ symbol, sector, marketCap, m121, vol63, adv20, price }]
  let pool = features.filter(f =>
    f && f.m121 != null && f.vol63 != null && f.vol63 > 0 &&
    f.marketCap >= CAP_LO && f.marketCap <= CAP_HI &&
    f.adv20 >= ADV_FLOOR && !EXCLUDE_SECTORS.has(f.sector));
  if (pool.length < 30) return { book: [], pool: pool.length, note: 'universe too small (still building cache?)' };

  // exclude the top realized-vol tercile
  const volCut = quantile(pool.map(f => f.vol63), HIVOL_TERCILE);
  pool = pool.filter(f => f.vol63 <= volCut);

  // sector-neutral score = 12-1 minus the within-sector median 12-1
  const bySec = {}; for (const f of pool) (bySec[f.sector] || (bySec[f.sector] = [])).push(f.m121);
  const med = {}; for (const s in bySec) med[s] = median(bySec[s]);
  for (const f of pool) f.score = f.m121 - med[f.sector];

  const scores = pool.map(f => f.score);
  const enterCut = quantile(scores, 1 - ENTER_Q), holdCut = quantile(scores, 1 - HOLD_Q);
  const selected = pool.filter(f => f.score >= enterCut || (held.has(f.symbol) && f.score >= holdCut));
  selected.sort((a, b) => b.score - a.score);
  const w = selected.length ? 1 / selected.length : 0;

  const book = selected.map(f => ({
    ticker: f.symbol, company: f.company || f.symbol, sector: f.sector,
    score: +f.score.toFixed(4), mom12_1: +(f.m121 * 100).toFixed(1), vol: +(f.vol63 * 100).toFixed(1),
    marketCap: Math.round(f.marketCap), advM: +(f.adv20 / 1e6).toFixed(1), weight: +w.toFixed(4),
    held: held.has(f.symbol), levels: levelsFor(f.price ?? f.lastClose),
  }));
  return { book, pool: pool.length, volCut: +(volCut * 100).toFixed(1), enterCut: +enterCut.toFixed(4), holdCut: +holdCut.toFixed(4) };
}

// Quarterly rebalance gate: rebalance in the first half of Jan/Apr/Jul/Oct.
function isRebalanceWindow(date = new Date()) {
  const m = date.getUTCMonth();                 // 0=Jan
  return (m % 3 === 0) && date.getUTCDate() <= 15;
}
const quarterKey = (date = new Date()) => `${date.getUTCFullYear()}Q${Math.floor(date.getUTCMonth() / 3) + 1}`;

module.exports = {
  CAP_LO, CAP_HI, ADV_FLOOR, EXCLUDE_SECTORS, HIVOL_TERCILE, ENTER_Q, HOLD_Q, LOOKBACK, SKIP, VOL_LB, MAX_HOLD,
  fmpGet, fetchUniverse, fetchCloses, featuresFromCloses, levelsFor, buildBook, isRebalanceWindow, quarterKey, quantile,
};
