'use strict';
// ARK DAILY-HOLDINGS DIFF — shadow route handlers (weight 0; CERN logOnly types).
//
//   op=ark      public read  — per-fund as-of pointers, recent trades docs, the frozen gates
//   op=arktick  PRIVILEGED   — fetch the six CSVs → snapshot per fund (as-of keyed) → diff vs
//                              the fund's last processed snapshot → net per ticker → ADV20 from
//                              the candle cache → ARK_NET_BUY / ARK_NET_SELL events → trades
//                              doc for op=cerntick (which runs right after, same capture chain)
//
// Every side effect is injectable (store, CSV fetch, candle history, clock) so the tests
// drive the whole tick in memory. Fail-closed per fund: a fund whose CSV is unreachable,
// mis-schemed or whose prior snapshot cannot be read produces no diff and keeps its pointer,
// so the NEXT advancing file diffs across the gap instead of losing it.
const STORE = require('./store');
const A = require('./ark-holdings');
const D = require('./ark-diff');
const S = require('./ark-store');
const { mapLimit } = require('./map-limit');
const { fetchDailyHistory } = require('./screener');
const { lastCompletedRegularSession } = require('./market-session');

const ADV_NAMES_CAP = 80;          // net rows priced per tick (ARK trades 20-40 names/day)
const ADV_CONCURRENCY = 4;
const ADV_BUDGET_MS = 90_000;      // inside the chain step budget with room for the writes
const HISTORY_RANGE = '6mo';

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const decisionDate = () => lastCompletedRegularSession(new Date()) || new Date().toISOString().slice(0, 10);

// Trailing-20 dollar ADV for the net rows, time-boxed; misses are counted, never zeroed.
async function advFor(tickers, { history, now, t0, budgetMs = ADV_BUDGET_MS }) {
  const adv = new Map();
  let misses = 0;
  await mapLimit(tickers, ADV_CONCURRENCY, async (t) => {
    if (now() - t0 > budgetMs) { misses++; return; }
    try {
      const d = await history(t);
      const x = D.adv20Usd(d && d.candles);
      if (x == null) misses++; else adv.set(t, x);
    } catch { misses++; }
  });
  return { adv, misses };
}

// One fund: store its snapshot if the as-of advanced, diff against the last processed one.
// → { report, trades?, advanceTo? }  (pure apart from the injected store)
async function processFund(fund, cur, latest, { store, fetchedAt }) {
  const base = { asOf: cur.asOf, holdings: cur.holdings.length };
  const prevAsOf = (latest.funds[fund] && latest.funds[fund].asOf) || null;
  if (prevAsOf && cur.asOf <= prevAsOf) return { report: { ...base, status: 'unchanged', trades: 0 } };
  await S.writeArkSnapshotFund(fund, cur, { store, fetchedAt });
  if (!prevAsOf) return { report: { ...base, status: 'first-snapshot', trades: 0 }, advanceTo: cur.asOf };
  const prevDoc = await S.readArkSnapshot(prevAsOf, { store });
  const prev = prevDoc && prevDoc.funds && prevDoc.funds[fund];
  if (!prev) return { report: { ...base, status: 'prior-snapshot-unreadable', trades: 0, prevAsOf } };   // pointer kept → diff spans the gap next time
  const trades = D.diffFundHoldings({ fund, asOf: prev.asOf, holdings: prev.holdings }, { fund, asOf: cur.asOf, holdings: cur.holdings });
  return { report: { ...base, status: 'diffed', trades: trades.length, prevAsOf }, trades: { asOf: cur.asOf, prevAsOf, trades }, advanceTo: cur.asOf };
}

const latestAsOf = (fundTrades, funds) => funds.map((f) => fundTrades[f].asOf).sort().pop();

async function tickCore({ date = decisionDate(), store = STORE, fetchImpl, history = (t) => fetchDailyHistory(t, HISTORY_RANGE), funds = A.ARK_FUNDS, now = Date.now } = {}) {
  const t0 = now();
  const fetchedAt = new Date(now()).toISOString();
  const fetched = await A.fetchAllArkHoldings({ fetchImpl, funds });
  const latest = await S.readArkLatest({ store });

  const reports = {}, fundTrades = {}, advance = {};
  for (const [fund, cur] of Object.entries(fetched.funds)) {
    const r = await processFund(fund, cur, latest, { store, fetchedAt });
    reports[fund] = r.report;
    if (r.trades) fundTrades[fund] = r.trades;
    if (r.advanceTo) advance[fund] = r.advanceTo;
  }

  // Net across funds → ADV → events. Each net row carries the latest as-of among its legs
  // (the trade session); the decision session is the tick date.
  const allTrades = Object.values(fundTrades).flatMap((f) => f.trades);
  const net = D.netTradesByTicker(allTrades).map((n) => ({ ...n, asOf: latestAsOf(fundTrades, n.funds) }));
  const { adv, misses } = await advFor(net.slice(0, ADV_NAMES_CAP).map((n) => n.ticker), { history, now, t0 });
  const netAdv = D.withAdv(net, adv);
  const events = D.selectCernEvents(netAdv, { sessionDate: date });

  if (Object.keys(fundTrades).length) await S.writeArkTradesDoc(date, { funds: fundTrades, net: netAdv, events }, { store });
  if (Object.keys(advance).length) await S.advanceArkLatest(advance, { store });

  return { ok: true, date, funds: reports, errors: fetched.errors, net: netAdv.length, events, adv: { requested: Math.min(net.length, ADV_NAMES_CAP), misses, overCap: Math.max(0, net.length - ADV_NAMES_CAP) }, ms: now() - t0 };
}

async function runArkTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  try {
    return res.status(200).json(await tickCore({}));
  } catch (e) {
    return res.status(502).json({ ok: false, error: `ark tick failed — nothing further written: ${String((e && e.message) || e)}` });
  }
}

async function runArk(req, res, { store = STORE } = {}) {
  if (!store.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const [latest, docs] = await Promise.all([S.readArkLatest({ store }), S.readRecentArkTrades({ store })]);
  const hasData = docs.length > 0 || Object.keys(latest.funds).length > 0;
  if (hasData) cached(res); else noStore(res);   // never CDN-cache the empty state
  return res.status(200).json({
    ok: true, state: 'SHADOW', weight: 0,
    frozen: { ADV_LOOKBACK_SESSIONS: D.ADV_LOOKBACK_SESSIONS, EVENT_MIN_PCT_OF_ADV: D.EVENT_MIN_PCT_OF_ADV, EVENT_MAX_ADV_USD: D.EVENT_MAX_ADV_USD },
    funds: latest.funds, sources: A.ARK_CSV_URLS,
    recent: docs.map((d) => ({ date: d.date, funds: Object.keys(d.funds || {}), net: (d.net || []).length, events: (d.events || []).length, top: (d.events || []).slice(0, 10).map((e) => ({ type: e.type, symbol: e.symbol, ...e.meta })) })),
    grading: 'CERN decay ledger (op=cerndecay) per type ARK_NET_BUY / ARK_NET_SELL; registry rows ark-net-buy-pressure / ark-net-sell-avoid (min N 300, placebo −126 sessions, ARKK factor control)',
    disclosure: 'Shadow research ledger of ARK ETF daily share changes. logOnly CERN types: never sized, never a TRADE/PROBE, excluded from alphabook. NOT a buy or sell signal; affects no ranking.',
  });
}

module.exports = { runArk, runArkTick, tickCore, ADV_NAMES_CAP, ADV_BUDGET_MS };
