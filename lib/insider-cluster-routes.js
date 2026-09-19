'use strict';
// INSIDER CLUSTER BUYS — shadow route handlers (weight 0; prospective ledger only).
//
//   op=insidercluster      public read  — recent ledger days, counts, the frozen gates
//   op=insiderclustertick  PRIVILEGED   — EDGAR daily index → universe Form 4s → buys →
//                                         FROZEN clusters → write-once ledger day
//
// Graded by the Scoreboard as section `InsiderCluster` (tier CLUSTER = the policy
// cohort; CLUSTER_EXCLUDED = liquid / illiquid / sub-$1 / 10b5-1, kept as a control) on
// the `insidercluster` contract (next-open, 1m). Registry maturity `shadow`, weight 0.
// Promotion needs the ROBUST gates the retrospective demanded (median / trimmed mean,
// dominant-event cap, absolute SPY-excess co-primary) on ≥50 episodes / ≥20 dates.

const STORE = require('./store');
const FEED = require('./insider-cluster-feed');
const IC = require('./insider-cluster');
const EDGAR = require('./edgar');
const { mapLimit } = require('./map-limit');
const { fetchDailyHistory } = require('./screener');

const HISTORY_CAP = 40;          // names classified per tick — inside the function budget
const HISTORY_CONCURRENCY = 3;
const TX_LOOKBACK_DAYS = 21;     // ≥ the 14-day cluster window + weekends/holidays

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const today = () => new Date().toISOString().slice(0, 10);

// The tick, with every side effect injectable (tests drive it without a network).
async function tickCore({ date = today(), store = STORE, fetchIndex = FEED.fetchDailyForm4, fetchXml = EDGAR.fetchForm4Xml,
  cikMap = EDGAR.loadCikMap, tickers = FEED.universeTickers(), history = (t) => fetchDailyHistory(t, '6mo'), now = Date.now } = {}) {
  const t0 = now();
  if (await store.blobExists(store.insiderClusterDayKey(date))) return { ok: true, date, ledger: 'already-written', ms: now() - t0 };

  // 1) the tick day + the day before (evening filers), universe CIKs only, new accessions only
  const dates = [FEED.addDays(date, -1), date];
  const idx = [];
  for (const d of dates) idx.push(await fetchIndex(d));
  const cikToTicker = FEED.universeCikMap(await cikMap(), tickers);
  const shards = await store.readInsiderClusterTxDays({ since: FEED.addDays(date, -TX_LOOKBACK_DAYS) });
  const known = new Set(shards.flatMap((s) => (s.buys || []).map((b) => b.accession)).concat(shards.flatMap((s) => s.accessions || [])));
  const filings = idx.flatMap((x) => FEED.selectUniverseFilings(x.filings, cikToTicker, known));

  // 2) ownership XML → buys → today's write-once tx shard (accessions recorded even when
  //    they carried no buy, so a re-tick never refetches them)
  const { buys, stats } = await FEED.fetchBuysForFilings(filings, { fetchXml, now });
  const shard = { date, indexDates: idx.map((x) => ({ date: x.date, missing: x.missing, form4: x.filings.length })), buys, accessions: filings.slice(0, filings.length - stats.truncated).map((f) => f.accession), stats };
  await store.writeInsiderClusterTxDay(date, shard);

  // 3) clusters whose LATEST filing is on one of the tick's dates; cooldown vs recent rows
  const recentDays = await store.readAllInsiderClusterDays({ since: FEED.addDays(date, -IC.LEDGER.cooldownCalendarDays) });
  const recentRows = recentDays.flatMap((d) => d.picks || []);
  const emitted = FEED.emitClusters([...shards, shard], { eventDates: dates, recentRows, tickDate: date });
  const fresh = emitted.filter((c) => !c.cooled);
  const picks = [];
  let historyMisses = 0;
  await mapLimit(fresh.slice(0, HISTORY_CAP), HISTORY_CONCURRENCY, async (c) => {
    let facts = null;
    try { const d = await history(c.ticker); facts = FEED.decisionFacts(d && d.candles); } catch { facts = null; }
    if (!facts) historyMisses++;
    picks.push(FEED.ledgerRow(c, facts, date));
  });
  picks.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
  const doc = {
    version: 'insidercluster-ledger-v1', date, universe: 'LARGE ∪ SMALL_CAPS ∪ MICRO_CAPS ∪ BIOTECH (lib/universe static lists)',
    indexDates: shard.indexDates, picks, counts: { emitted: emitted.length, cooled: emitted.length - fresh.length, overCap: Math.max(0, fresh.length - HISTORY_CAP), policy: picks.filter((p) => p.tier === IC.LEDGER.policyTier).length, excluded: picks.filter((p) => p.tier !== IC.LEDGER.policyTier).length, historyMisses },
    feed: stats, ms: now() - t0,
  };
  await store.writeInsiderClusterDay(date, doc);
  return { ok: true, date, ledger: 'written', counts: doc.counts, feed: stats, ms: doc.ms };
}

async function runInsiderClusterTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  try {
    return res.status(200).json(await tickCore({}));
  } catch (e) {
    // Fail closed and say so: a partial day must not be written as a quiet day.
    return res.status(502).json({ ok: false, error: `insider-cluster tick failed — nothing written: ${String((e && e.message) || e)}` });
  }
}

async function runInsiderCluster(req, res) {
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const days = await STORE.readAllInsiderClusterDays({ limit: 30 });
  if (days.length) cached(res); else noStore(res);   // never CDN-cache the empty state
  const rows = days.flatMap((d) => d.picks || []);
  return res.status(200).json({
    ok: true, state: 'SHADOW', weight: 0,
    frozen: { cluster: IC.CLUSTER, ledger: IC.LEDGER },
    days: days.length, rows: rows.length, policyRows: rows.filter((r) => r.tier === IC.LEDGER.policyTier).length,
    recent: days.slice(-10).map((d) => ({ date: d.date, counts: d.counts, picks: (d.picks || []).map((p) => ({ ticker: p.ticker, tier: p.tier, owners: p.owners, combinedValue: p.combinedValue, officerDirectorOnly: p.officerDirectorOnly, reasons: p.reasons })) })),
    grading: 'Scoreboard section InsiderCluster, contract insidercluster (next-open, 1m); promotion requires the robust gates in research/INSIDER-CLUSTER-RESIDUAL-2026-09.md',
    disclosure: 'Shadow research ledger of Form 4 insider cluster buys. Retrospective: relative-to-peers, lottery-skewed, flat vs SPY. NOT a buy signal; affects no ranking.',
  });
}

module.exports = { runInsiderCluster, runInsiderClusterTick, tickCore, HISTORY_CAP, TX_LOOKBACK_DAYS };
