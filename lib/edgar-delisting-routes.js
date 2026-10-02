'use strict';
// DELISTING-PENDING FLAG — shadow route handlers (weight 0; display + PIT event ledger).
//
//   op=delisting       public read  — current flag snapshot (tickers with a Form 25 / 15 notice
//                                     inside the frozen 45-day window) + ledger progress
//   op=delistingtick   PRIVILEGED   — EDGAR daily index (tick day + the day before) → delisting
//                                     notices → CIK→ticker join → union-monotonic `delist/<filingDate>.json`
//                                     shards via store.updateJSON (CAS) → rebuild `delist/current.json`
//
// The flag never touches ranking, selection, sizing, alerts or governance. It surfaces exactly
// where the 424B5 dilution flag surfaces (candidate-card badge, Session Board chip + checklist)
// and is labeled as unvalidated research. Promotion requires the registry row's gates
// (lib/research/hypothesis-registry.js `delisting-pending-avoid`) plus a manual registry change.

const STORE = require('./store');
const EDGAR = require('./edgar');
const DF = require('./edgar-delisting-feed');

const SHARD_PREFIX = 'delist/';
const SHARD_RE = /^delist\/\d{4}-\d{2}-\d{2}\.json$/;
const CURRENT_KEY = 'delist/current.json';
const shardKey = (date) => `${SHARD_PREFIX}${date}.json`;
// Shards read when rebuilding the snapshot: the flag window plus weekends/holidays slack.
// readAllByPrefix picks the NEWEST paths, so an old backlog can never crowd out the window.
const SNAPSHOT_SHARD_LIMIT = DF.FROZEN.flagWindowDays + 20;
const SNAPSHOT_CACHE_S = 60;

const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const today = () => new Date().toISOString().slice(0, 10);

// Persist one index day's events into its filing-date shards (events can carry a filing date
// other than the index day on late-posted indexes, so group by filedAt). CAS union — a re-tick
// or a concurrent writer can only add rows.
async function persistEvents(events, { store, nowIso }) {
  const byDate = new Map();
  for (const e of events) byDate.set(e.filedAt, [...(byDate.get(e.filedAt) || []), e]);
  const written = [];
  for (const [date, evs] of [...byDate.entries()].sort()) {
    await store.updateJSON(shardKey(date), (prior) => DF.mergeShard(prior, evs, { date, now: nowIso }), { initial: null, cacheMaxAge: 0 });
    written.push({ date, events: evs.length });
  }
  return written;
}

async function rebuildSnapshot(date, { store }) {
  const shards = await store.readAllByPrefix(SHARD_PREFIX, SHARD_RE, { limit: SNAPSHOT_SHARD_LIMIT });
  const events = shards.flatMap((s) => (s && Array.isArray(s.events)) ? s.events : []);
  const snap = { ...DF.buildPendingSet(events, date), shardsRead: shards.length, shardsUnreadable: shards.unreadable || 0 };
  await store.writeJSON(CURRENT_KEY, snap, SNAPSHOT_CACHE_S);
  return snap;
}

// The tick, with every side effect injectable (tests drive it without a network or a store).
async function tickCore({ date = today(), store = STORE, fetchIndex = DF.fetchDailyDelistings, cikMap = EDGAR.loadCikMap, now = Date.now } = {}) {
  const t0 = now();
  const nowIso = new Date(now()).toISOString();
  const dates = [DF.addDays(date, -1), date];
  const index = DF.buildCikTickerIndex(await cikMap());
  const indexDates = [], events = [];
  for (const d of dates) {
    const r = await fetchIndex(d);
    indexDates.push({ date: r.date, missing: r.missing, rows: r.rows.length });
    for (const row of r.rows) events.push(DF.toEvent(row, index));
  }
  const written = events.length ? await persistEvents(events, { store, nowIso }) : [];
  const snap = await rebuildSnapshot(date, { store });
  return {
    ok: true, date, indexDates, events: events.length,
    joined: { high: events.filter((e) => e.confidence === 'high').length, medium: events.filter((e) => e.confidence === 'medium').length, none: events.filter((e) => e.confidence === 'none').length },
    shardsWritten: written, snapshot: snap.counts, ms: now() - t0,
  };
}

async function runDelistingTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  try {
    return res.status(200).json(await tickCore({}));
  } catch (e) {
    // Fail closed and say so: a half-read index must not be written as a quiet day, and the
    // previous snapshot stays in place (a partial one would read as "no delisting anywhere").
    return res.status(502).json({ ok: false, error: `delisting tick failed — snapshot left unchanged: ${String((e && e.message) || e)}` });
  }
}

async function runDelisting(req, res) {
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const snap = await STORE.readJSON(CURRENT_KEY, null);
  // Never CDN-cache the empty state: a pre-first-tick response cached for 10 minutes renders as
  // "no delisting notice anywhere" on every client behind the same edge node.
  if (snap) cached(res); else noStore(res);
  return res.status(200).json({
    ok: true, state: 'SHADOW', weight: 0,
    frozen: DF.FROZEN, available: !!snap,
    ...(snap ? { asOf: snap.asOf, counts: snap.counts, symbols: snap.symbols, shardsRead: snap.shardsRead } : { reason: 'no snapshot yet — op=delistingtick has not run' }),
    disclosure: 'Shadow research flag from EDGAR Form 25 / 25-NSE / 15-12G / 15-15D filings (exchange delisting or deregistration notices). The ticker join is lossy and a Form 25 is also filed on a voluntary exchange transfer. Unvalidated prospectively; NOT a sell signal, NOT a short signal, affects no ranking.',
  });
}

module.exports = { runDelisting, runDelistingTick, tickCore, persistEvents, rebuildSnapshot, SHARD_PREFIX, SHARD_RE, CURRENT_KEY, shardKey, SNAPSHOT_SHARD_LIMIT };
