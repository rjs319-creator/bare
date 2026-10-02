'use strict';
// ARK holdings Blob layout (all multi-writer-safe via lib/store updateJSON — CAS, never
// readJSON→writeJSON):
//   ark/<asOf>.json          snapshot: { version, date, funds: { ARKK: { asOf, fetchedAt, holdings, skipped } } }
//   ark/trades/<date>.json   the tick's diff: { version, date, funds: { ARKK: { asOf, prevAsOf, trades } }, net, events }
//                            keyed by the DECISION date (the tick session), merged by key on a same-day retry
//   ark/latest.json          pointer: { version, funds: { ARKK: { asOf } } } — last as-of processed per fund
// `store` is injectable so the routes test runs on an in-memory CAS double.
const STORE = require('./store');

const VERSION = 'ark-holdings-v1';
const ARK_PREFIX = 'ark/';
const ARK_TRADES_PREFIX = 'ark/trades/';
const ARK_LATEST_KEY = 'ark/latest.json';
const SNAPSHOT_RE = /^ark\/\d{4}-\d{2}-\d{2}\.json$/;
const TRADES_RE = /^ark\/trades\/\d{4}-\d{2}-\d{2}\.json$/;
const RECENT_TRADES_DOCS = 5;

const arkSnapshotKey = (date) => `${ARK_PREFIX}${date}.json`;
const arkTradesKey = (date) => `${ARK_TRADES_PREFIX}${date}.json`;

async function readArkLatest({ store = STORE } = {}) {
  const doc = await store.readJSON(ARK_LATEST_KEY, null);
  return doc && doc.funds ? doc : { version: VERSION, funds: {} };
}

const readArkSnapshot = (date, { store = STORE } = {}) => store.readJSON(arkSnapshotKey(date), null);

// Merge one fund into the as-of date's snapshot doc (union by fund; a retry re-writes its own fund only).
function writeArkSnapshotFund(fund, parsed, { store = STORE, fetchedAt = new Date().toISOString() } = {}) {
  return store.updateJSON(arkSnapshotKey(parsed.asOf), (cur) => ({
    version: VERSION, date: parsed.asOf,
    funds: { ...((cur && cur.funds) || {}), [fund]: { asOf: parsed.asOf, fetchedAt, rows: parsed.rows, skipped: parsed.skipped, holdings: parsed.holdings } },
  }), { initial: null });
}

// Union-by-key merge of the tick's diff into the decision date's trades doc. A same-day
// retry (a fund's CSV landing between two runs) unions funds / net tickers / type:symbol
// events with the later run winning per key; cross-run netting is deliberately not attempted.
const unionBy = (prevRows, nextRows, keyOf) => {
  const m = new Map((prevRows || []).map((r) => [keyOf(r), r]));
  for (const r of nextRows || []) m.set(keyOf(r), r);
  return [...m.values()];
};
function writeArkTradesDoc(date, { funds, net, events }, { store = STORE } = {}) {
  return store.updateJSON(arkTradesKey(date), (cur) => ({
    version: VERSION, date,
    funds: { ...((cur && cur.funds) || {}), ...funds },
    net: unionBy(cur && cur.net, net, (r) => r.ticker),
    events: unionBy(cur && cur.events, events, (e) => `${e.type}:${e.symbol}`),
    savedAt: new Date().toISOString(),
  }), { initial: null });
}

// Advance per-fund as-of pointers, monotonically (never back to an older as-of).
function advanceArkLatest(fundAsOf, { store = STORE } = {}) {
  return store.updateJSON(ARK_LATEST_KEY, (cur) => {
    const funds = { ...((cur && cur.funds) || {}) };
    let changed = false;
    for (const [fund, asOf] of Object.entries(fundAsOf || {})) {
      if (funds[fund] && funds[fund].asOf >= asOf) continue;
      funds[fund] = { asOf }; changed = true;
    }
    return changed ? { version: VERSION, funds, updatedAt: new Date().toISOString() } : cur;
  }, { initial: null });
}

// Newest N trades docs, date order.
async function readRecentArkTrades({ store = STORE, limit = RECENT_TRADES_DOCS } = {}) {
  const docs = await store.readAllByPrefix(ARK_TRADES_PREFIX, TRADES_RE, { limit });
  return (docs || []).filter((d) => d && d.date).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Flat event list from the newest trades docs — what lib/cern-run ingests each tick.
async function readRecentArkEvents(opts = {}) {
  const docs = await readRecentArkTrades(opts);
  return docs.flatMap((d) => (Array.isArray(d.events) ? d.events : []));
}

module.exports = {
  VERSION, ARK_PREFIX, ARK_TRADES_PREFIX, ARK_LATEST_KEY, SNAPSHOT_RE, TRADES_RE, RECENT_TRADES_DOCS,
  arkSnapshotKey, arkTradesKey, readArkLatest, readArkSnapshot, writeArkSnapshotFund, writeArkTradesDoc,
  advanceArkLatest, readRecentArkTrades, readRecentArkEvents,
};
