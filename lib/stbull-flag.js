'use strict';
// STOCKTWITS BULL-RATIO FLAG — shadow research overlay (weight 0; display + ledger only).
//
// Hypothesis (WEAK PRIOR, imported from the TradingAgents audit and adjacent to the
// app's own fade-the-loudest result, which survived only as a short-side AVOID filter):
// EXTREME one-sided retail bullishness on an attention name — user-labeled bull share
// ≥ 90% with enough labeled messages among the last 30 posts — marks crowd
// over-extension and flags a contrarian AVOID candidate. Unvalidated prospectively.
//
// The flag changes NO ranking, selection, sizing, alerts or governance. It accrues a
// prospective ledger whose outcome construction is byte-identical to the dilution
// overlay's (5-session next-open SPY-excess via lib/dilution-routes excess5), gated by
// the same frozen promotion path: ≥ 50 resolved decision dates, then a formal
// date-clustered evaluation, then a manual reviewed registry change.

const FROZEN = Object.freeze({
  version: 'stbull-flag-v1',
  source: 'stocktwits',
  universe: 'trending-equities-top30',
  streamMessages: 30,          // last N messages per symbol stream
  minLabeled: 10,              // labeled messages required before the ratio means anything
  minBullPct: 90,              // flag threshold: bull share of labeled messages
  holdSessions: 5,             // scored horizon (mirrors the dilution overlay)
  prospectiveGate: Object.freeze({
    minResolvedDates: 50,
    evaluation: 'formal date-clustered eval (HAC + block bootstrap) — the running mean served by op=stbull is explicitly NOT the gate',
    promotion: 'manual reviewed registry change; the first permitted step is an annotation, never selection',
  }),
  experimentId: 'stbull-ratio-2026-08',
});

const TRENDING_URL = 'https://api.stocktwits.com/api/2/trending/symbols/equities.json?limit=30';
const streamUrl = (sym) => `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json?limit=${FROZEN.streamMessages}`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };
const FETCH_TIMEOUT_MS = 10000;
const STREAM_CONCURRENCY = 4;

async function getJSON(url, fetchImpl) {
  const f = fetchImpl || fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await f(url, { headers: HEADERS, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Trending equities (ticker symbols). THROWS on failure or an empty list — the tick
 * fails closed rather than writing a "nothing trending" snapshot from a broken fetch. */
async function fetchTrending(fetchImpl) {
  const d = await getJSON(TRENDING_URL, fetchImpl);
  const syms = (d && Array.isArray(d.symbols) ? d.symbols : [])
    .map((s) => String(s && s.symbol || '').toUpperCase())
    .filter((s) => /^[A-Z][A-Z.]{0,7}$/.test(s) && !s.endsWith('.X'));   // equities only — .X is StockTwits' crypto suffix
  if (!syms.length) throw new Error('trending list empty');
  return [...new Set(syms)];
}

/** Last messages for one symbol stream. Throws on failure (caller records the miss). */
async function fetchSymbolStream(sym, fetchImpl) {
  const d = await getJSON(streamUrl(sym), fetchImpl);
  if (!d || !Array.isArray(d.messages)) throw new Error('no messages array');
  return d.messages;
}

/** Count user-labeled sentiment tags in a message list. Pure. */
function labeledRatio(messages) {
  let bull = 0, bear = 0;
  const total = (messages || []).length;
  for (const m of messages || []) {
    const s = m && m.entities && m.entities.sentiment && m.entities.sentiment.basic;
    if (s === 'Bullish') bull++;
    else if (s === 'Bearish') bear++;
  }
  const labeled = bull + bear;
  return { bull, bear, labeled, total, bullPct: labeled ? Math.round((bull / labeled) * 1000) / 10 : null };
}

/**
 * Build the flag snapshot from per-symbol ratio rows [{ticker, bull, bear, labeled,
 * total, bullPct}]. Flag rule (FROZEN): labeled >= minLabeled AND bullPct >= minBullPct.
 * Every fetched row is kept in `universe` for research; `symbols` holds only flagged
 * names. Pure.
 */
function buildFlagSet(rows, asOf) {
  const universe = {};
  const symbols = {};
  let flagged = 0;
  for (const r of rows || []) {
    if (!r || !r.ticker) continue;
    const t = String(r.ticker).toUpperCase();
    universe[t] = { bull: r.bull, bear: r.bear, labeled: r.labeled, total: r.total, bullPct: r.bullPct };
    if (r.labeled >= FROZEN.minLabeled && r.bullPct != null && r.bullPct >= FROZEN.minBullPct) {
      symbols[t] = universe[t];
      flagged++;
    }
  }
  return { version: FROZEN.version, asOf, symbols, universe, counts: { flagged, scanned: Object.keys(universe).length } };
}

/**
 * The ledger day's decision unit: tickers flagged TODAY that were NOT flagged in the
 * previous ledger day's snapshot (fresh threshold crossings) — repeat-flag days are
 * not independent decisions. First ledger day: every flagged name. Pure.
 */
function selectFreshFlags(snap, prevFlaggedTickers) {
  const prev = new Set(prevFlaggedTickers || []);
  return Object.entries((snap && snap.symbols) || {})
    .filter(([t]) => !prev.has(t))
    .map(([t, v]) => ({ ticker: t, bullPct: v.bullPct, labeled: v.labeled }));
}

module.exports = {
  FROZEN, TRENDING_URL, STREAM_CONCURRENCY,
  fetchTrending, fetchSymbolStream, labeledRatio, buildFlagSet, selectFreshFlags, streamUrl,
};
