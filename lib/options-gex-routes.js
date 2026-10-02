'use strict';
// DEALER GEX / GAMMA-FLIP OVERLAY — ROUTES (the only storage-owning layer for lib/options-gex).
//
//   op=optionsgextick  PRIVILEGED writer (nightly `optionsgex` chain): SPY + QQQ + the Session
//                      Board's tickers → one FULL CBOE chain each (memoized body) → pure GEX /
//                      flip / max-pain → write-once doc per decision session + a latest pointer.
//                      Idempotent: an existing session doc is a no-op unless ?force=1.
//                      Budget by TIME: a 100s deadline inside the chain budget; names not reached
//                      are RECORDED as truncated, never silently skipped.
//   op=optionsgex      public read of the latest overlay (never scans). Empty → no-store.
//
// Storage: optionsflow-v2/gex/<session>.json, optionsflow-v2/gex/latest.json
// Weight 0 everywhere: the Session Board attaches gammaFlipDistancePct to `live` as a labelled
// regime read; nothing scores on it (hypothesis gex-gamma-flip-intraday-regime).
// CBOE terms: the per-strike rows persisted are our own derived analytics (bounded to ±10% of
// spot), never the raw chain.

const { readJSON, writeJSON, hasStore } = require('./store');
const { sessionInfoAt, lastCompletedRegularSession } = require('./market-session');
const { fetchFullChain, resolveChainProvider } = require('./options-chain-provider');
const { computeGex, GEX_VERSION } = require('./options-gex');

const GEX_PREFIX = 'optionsflow-v2/gex/';
const LATEST_KEY = `${GEX_PREFIX}latest.json`;
const SESSIONBOARD_SNAPSHOT = 'sessionboard/latest.json';
const CORE_TICKERS = Object.freeze(['SPY', 'QQQ']);
const MAX_BOARD_TICKERS = 20;
const DEADLINE_MS = 100_000;
const CONCURRENCY = 3;
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

const sessionKey = (session) => `${GEX_PREFIX}${session}.json`;

// The decision session a run attests: today's during/after RTH, else the last completed one.
function decisionSession(now = new Date()) {
  const info = sessionInfoAt(now);
  const live = info.isTradingDay && (info.marketSession === 'regular' || info.marketSession === 'afterhours');
  return live ? info.etDate : lastCompletedRegularSession(now);
}

// Session Board tickers (shown + held-out), validated, capped — merged after the core set.
function boardTickers(snapshot, { max = MAX_BOARD_TICKERS } = {}) {
  const items = [...((snapshot && snapshot.items) || []), ...((snapshot && snapshot.heldOut) || [])];
  const out = [];
  for (const it of items) {
    const t = String((it && it.ticker) || '').toUpperCase();
    if (TICKER_RE.test(t) && !out.includes(t) && !CORE_TICKERS.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// Compact per-ticker record for the overlay doc and the Session Board join.
function overlayRecord(ticker, gex) {
  if (!gex || !gex.available) return { ticker, available: false, reason: gex ? gex.reason : 'no chain' };
  return {
    ticker, available: true,
    spot: gex.spot, asOf: gex.asOf, source: gex.source, gammaSource: gex.gammaSource,
    netGex: gex.netGex, callGex: gex.callGex, putGex: gex.putGex,
    gammaFlip: gex.gammaFlip, gammaFlipDistancePct: gex.gammaFlipDistancePct, regime: gex.regime,
    maxPainNearestExpiry: gex.maxPainNearestExpiry,
    control: gex.control, contracts: gex.contracts, perStrike: gex.perStrike,
  };
}

async function computeForTicker(ticker, { fetchChain, nowMs, seed }) {
  try {
    const result = await fetchChain(ticker);
    return overlayRecord(ticker, result ? computeGex({ result, nowMs, seed }) : null);
  } catch (e) {
    return { ticker, available: false, reason: `chain-fetch-error: ${String((e && e.message) || e).slice(0, 120)}` };
  }
}

/**
 * Build the overlay for a ticker list under a time budget. Pure apart from the injected
 * fetch; returns { records, truncatedAt } — truncation is recorded, never silent.
 */
async function buildOverlay(tickers, { fetchChain, now = Date.now, deadlineMs = DEADLINE_MS, concurrency = CONCURRENCY, seed } = {}) {
  const t0 = now();
  const records = [];
  let idx = 0, truncatedAt = null;
  const worker = async () => {
    while (idx < tickers.length) {
      if (now() - t0 > deadlineMs) { if (truncatedAt == null) truncatedAt = idx; return; }
      const ticker = tickers[idx++];
      records.push(await computeForTicker(ticker, { fetchChain, nowMs: now(), seed }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tickers.length) }, worker));
  const order = new Map(tickers.map((t, i) => [t, i]));
  return { records: [...records].sort((a, b) => order.get(a.ticker) - order.get(b.ticker)), truncatedAt, elapsedMs: now() - t0 };
}

function defaultDeps() {
  return {
    now: Date.now, hasStore, readJSON, writeJSON, fetchChain: fetchFullChain,
    provider: () => resolveChainProvider(),
  };
}

/** op=optionsgextick — PRIVILEGED writer. */
async function runOptionsGexTick(req, res, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  if (!deps.hasStore()) return res.status(200).json({ ok: false, op: 'optionsgextick', error: 'Blob storage not configured' });
  res.setHeader('Cache-Control', 'no-store');
  const session = decisionSession(new Date(deps.now()));
  const force = req.query && (req.query.force === '1' || req.query.refresh === '1');
  const existing = await deps.readJSON(sessionKey(session), null).catch(() => null);
  if (existing && !force) return res.status(200).json({ ok: true, op: 'optionsgextick', session, skipped: 'session already captured', tickers: (existing.records || []).length });

  const board = await deps.readJSON(SESSIONBOARD_SNAPSHOT, null).catch(() => null);
  const tickers = [...CORE_TICKERS, ...boardTickers(board)];
  const seed = Number(String(session).replace(/-/g, '')) || 1;    // deterministic per session
  const { records, truncatedAt, elapsedMs } = await buildOverlay(tickers, { fetchChain: deps.fetchChain, now: deps.now, seed });
  const doc = {
    version: GEX_VERSION, session, generatedAt: new Date(deps.now()).toISOString(),
    provider: deps.provider(), tickers, truncatedAt, elapsedMs,
    available: records.filter((r) => r.available).length,
    records,
    weight: 0,
    note: 'Dealer-gamma regime read (weight 0). Derived from 15-min delayed open interest under an assumed sign convention; not a forecast.',
  };
  await deps.writeJSON(sessionKey(session), doc, 0);
  await deps.writeJSON(LATEST_KEY, doc, 0);
  return res.status(200).json({ ok: true, op: 'optionsgextick', session, tickers: tickers.length, available: doc.available, truncatedAt, elapsedMs });
}

/** op=optionsgex — public read of the latest overlay. */
async function runOptionsGexRead(req, res, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  if (!deps.hasStore()) return res.status(200).json({ ok: false, op: 'optionsgex', error: 'Blob storage not configured' });
  const doc = await deps.readJSON(LATEST_KEY, null).catch(() => null);
  if (!doc || !Array.isArray(doc.records) || !doc.records.length) {
    res.setHeader('Cache-Control', 'no-store');       // never CDN-cache an empty state
    return res.status(200).json({ ok: true, op: 'optionsgex', empty: true, records: [] });
  }
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({ ok: true, op: 'optionsgex', ...doc });
}

/** Ticker → { gammaFlipDistancePct, gammaFlip, asOf } for the Session Board join. {} when absent. */
async function loadLatestGex(injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  if (!deps.hasStore()) return {};
  const doc = await deps.readJSON(LATEST_KEY, null).catch(() => null);
  const out = {};
  for (const r of (doc && doc.records) || []) {
    if (!r || !r.ticker || !r.available) continue;
    out[r.ticker] = { gammaFlipDistancePct: r.gammaFlipDistancePct, gammaFlip: r.gammaFlip, asOf: r.asOf, session: doc.session };
  }
  return out;
}

module.exports = {
  GEX_PREFIX, LATEST_KEY, CORE_TICKERS, MAX_BOARD_TICKERS, DEADLINE_MS,
  decisionSession, boardTickers, overlayRecord, buildOverlay,
  runOptionsGexTick, runOptionsGexRead, loadLatestGex,
};
