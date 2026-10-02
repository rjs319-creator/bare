'use strict';
// FILING RED FLAGS — shadow route handlers (weight 0; AVOID-side prospective ledger).
//
//   op=redflags             public read  — current 🚩 snapshot (+ `symbol=` → that name's
//                                          events and active flags), recent ledger days
//   op=redflagstick         PRIVILEGED   — EDGAR daily index (tick day + the day before) →
//                                          NT / 8-K items / 5.02 text / going-concern FTS →
//                                          eligibility facts → CAS-union day shard + state
//
// Graded by the Scoreboard as section `RedFlags` (tier = flag id for kit-eligible rows,
// EXCLUDED for the rest) on the `redflags` contract (next-open, 1m, long basis). The lane
// is an AVOID hypothesis: the registry rows expect NEGATIVE cost-net SPY-excess, and the
// evidence-negative-lane machinery (lib/negative-lanes) is what turns a proven-negative tier
// into the "proven-negative lane" label elsewhere. Nothing here gates, ranks or sizes.
//
// TIME BUDGET + PARTIAL PERSIST. Stages run cheapest-first (index → NT → FTS → 8-K items →
// 5.02 docs → history). Each stage receives the REMAINING budget; whatever finished is
// persisted as a UNION into the day shard with `partial:true` until a pass completes every
// stage untruncated — a re-tick (or the next night's "day before" read) fills the rest.

const STORE = require('./store');
const RFS = require('./filing-redflags-store');
const FEED = require('./filing-redflags-feed');
const RF = require('./filing-redflags');
const EDGAR = require('./edgar');
const { decisionFacts } = require('./insider-cluster-feed');
const { mapLimit } = require('./map-limit');
const { fetchDailyHistory } = require('./screener');

const TICK_BUDGET_MS = 150_000;      // inside the 240s chain deadline with room for history + CAS writes
const HISTORY_RESERVE_MS = 35_000;   // kept back for the eligibility fan-out
const HISTORY_CAP = 40;              // names classified per tick
const HISTORY_CONCURRENCY = 3;
const KNOWN_LOOKBACK_DAYS = 3;       // shards read for already-stored accessions (tick day + the day before + slack)

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const today = () => new Date().toISOString().slice(0, 10);

// ── The tick, every side effect injectable ───────────────────────────────────
async function tickCore({
  date = today(), store = RFS, fetchIndex = FEED.fetchDailyIndex, cikMap = EDGAR.loadCikMap,
  fetchSubmissions = EDGAR.fetchSubmissionsRecent, fetchDoc = FEED.fetchPrimaryDocText, fetchFts = FEED.fetchGoingConcernHits,
  history = (t) => fetchDailyHistory(t, '6mo'), now = Date.now, budgetMs = TICK_BUDGET_MS, throttleMs = FEED.THROTTLE_MS,
} = {}) {
  const t0 = now();
  const left = () => Math.max(0, budgetMs - (now() - t0));
  const stageBudget = () => Math.max(0, left() - HISTORY_RESERVE_MS);
  const dates = [FEED.addDays(date, -1), date];
  const truncated = [];

  // 1) index rows for both dates, joined to SEC's ticker map, minus accessions already stored
  const idx = [];
  for (const d of dates) idx.push(await fetchIndex(d));
  const cikToTicker = FEED.cikToTickerMap(await cikMap());
  const priorDays = await store.readAllRedflagDays({ since: FEED.addDays(date, -KNOWN_LOOKBACK_DAYS) });
  const known = new Set(priorDays.flatMap((d) => (d.picks || []).map((p) => p.accession)));
  const rows = idx.flatMap((x) => FEED.selectRows(x.rows, cikToTicker, known));
  let state = await store.readState();

  // 2) NT first-in-window (pure)
  const nt = FEED.ntEvents(rows, state);
  state = nt.state;

  // 3) going-concern FTS — one bounded query over the two dates; a failure is counted, not fatal
  let gc = { events: [], state, hits: 0, error: null };
  if (stageBudget() > 0) {
    try {
      const hits = await fetchFts({ startdt: dates[0], enddt: dates[1], throttleMs });
      const r = FEED.goingConcernEvents(hits, state, known);
      gc = { events: r.events, state: r.state, hits: hits.length, error: null };
      state = r.state;
    } catch (e) { gc = { ...gc, error: String((e && e.message) || e).slice(0, 160) }; truncated.push('fts'); }
  } else truncated.push('fts');

  // 4) 8-K items, then 5) 5.02 primary documents — both budgeted and throttled
  const k8 = await FEED.classify8kRows(rows, { fetchSubmissions, budgetMs: stageBudget(), throttleMs, now });
  if (k8.stats.truncated) truncated.push('8k-items');
  const k502 = await FEED.classify502Rows(k8.textCandidates, { fetchDoc, budgetMs: stageBudget(), throttleMs, now });
  if (k502.stats.truncated || k502.stats.overCap) truncated.push('5.02-docs');

  // 6) eligibility facts → ledger rows (history-capped; the overflow is counted, never silent)
  const events = [...nt.events, ...gc.events, ...k8.events, ...k502.events];
  const { picks, historyMisses } = await classifyHistory(events.slice(0, HISTORY_CAP), date, { history, left });
  if (events.length > HISTORY_CAP) truncated.push('history-cap');

  // 7) persist: union shard, monotone state, display snapshot
  const stats = {
    at: new Date(now()).toISOString(), ms: now() - t0, indexRows: rows.length, nt: nt.events.length,
    goingConcern: { hits: gc.hits, events: gc.events.length, error: gc.error }, eightK: k8.stats, item502: k502.stats,
    events: events.length, historyMisses, truncated,
  };
  const partial = truncated.length > 0;
  await store.writeDayUnion(date, { picks, indexDates: idx.map((x) => ({ date: x.date, missing: x.missing, rows: x.rows.length })), stats, partial });
  await store.writeStateUnion(state);
  const days = await store.readAllRedflagDays({ since: FEED.addDays(date, -RF.FROZEN.flagWindowDays - 1) });
  const snapshot = RFS.buildCurrent([...days.filter((d) => d.date !== date), { date, picks: mergedPicks(days, date, picks) }], date);
  await store.writeCurrent(snapshot);
  return { ok: true, date, partial, counts: RFS.countRows(picks), snapshot: snapshot.counts, stats };
}

// The day's rows as the snapshot should see them: what is already stored for `date` plus
// this pass (the shard union may not be readable yet — Blob read-back lags).
function mergedPicks(days, date, picks) {
  const stored = days.find((d) => d.date === date);
  return RFS.mergeDay(stored || null, { date, picks }).picks;
}

// Eligibility facts per event (bounded concurrency). A name whose history cannot be read —
// or that the budget no longer covers — is logged EXCLUDED with the reason, never dropped.
async function classifyHistory(events, tickDate, { history, left }) {
  const picks = [];
  let historyMisses = 0;
  await mapLimit(events, HISTORY_CONCURRENCY, async (ev) => {
    let facts = null;
    if (left() > 0) {
      try { const d = await history(ev.ticker); facts = decisionFacts(d && d.candles); } catch { facts = null; }
    }
    if (!facts) historyMisses++;
    picks.push(RF.ledgerRow(ev, facts, tickDate));
  });
  return { picks: picks.sort((a, b) => (a.key < b.key ? -1 : 1)), historyMisses };
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function runRedflagsTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const date = (req.query && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))) ? String(req.query.date) : today();
  try {
    return res.status(200).json(await tickCore({ date }));
  } catch (e) {
    // The index or the state read failed before anything could be classified: nothing is
    // written, and the failure is reported rather than persisted as a quiet day.
    return res.status(502).json({ ok: false, error: `redflags tick failed — nothing written: ${String((e && e.message) || e)}` });
  }
}

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

async function runRedflags(req, res) {
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const snap = await RFS.readCurrent();
  const symbol = String((req.query && req.query.symbol) || '').toUpperCase().replace(/\./g, '-');
  if (symbol && !SYMBOL_RE.test(symbol)) { noStore(res); return res.status(400).json({ ok: false, error: 'invalid symbol' }); }
  // Never CDN-cache the empty state: a pre-first-tick response cached at the edge renders as
  // "no red flags anywhere" for every client behind that node.
  if (snap) cached(res); else noStore(res);
  const base = {
    ok: true, state: 'SHADOW', weight: 0, side: 'AVOID', frozen: RF.FROZEN, flags: RF.FLAGS,
    available: !!snap,
    disclosure: 'Shadow AVOID-side research lane from SEC filings (late-filing notices, restatement / auditor-change / listing-deficiency 8-K items, CEO/CFO departures, first going-concern language). Hypothesised to precede SPY-underperformance; UNVALIDATED prospectively. NOT a sell signal, NOT a short signal, affects no ranking.',
  };
  if (symbol) {
    const days = await RFS.readAllRedflagDays({ since: FEED.addDays(today(), -RF.FROZEN.flagWindowDays - 1) });
    const events = days.flatMap((d) => (d.picks || []).filter((p) => p.ticker === symbol));
    return res.status(200).json({ ...base, symbol, active: (snap && snap.symbols && snap.symbols[symbol]) || null, events });
  }
  const recent = await RFS.readAllRedflagDays({ limit: 10 });
  return res.status(200).json({
    ...base,
    ...(snap ? { asOf: snap.asOf, counts: snap.counts, symbols: snap.symbols } : { reason: 'no snapshot yet — op=redflagstick has not run' }),
    recent: recent.map((d) => ({ date: d.date, partial: d.partial, counts: d.counts, picks: (d.picks || []).map((p) => ({ ticker: p.ticker, flag: p.flag, tier: p.tier, eventDate: p.eventDate, form: p.form })) })),
    grading: 'Scoreboard section RedFlags, contract redflags (next-open, 1m, long basis; the hypothesis is a NEGATIVE record); registry rows redflag-* decide, placebo = same name 126 sessions earlier (research pass over the shards)',
  });
}

module.exports = { runRedflags, runRedflagsTick, tickCore, TICK_BUDGET_MS, HISTORY_CAP, HISTORY_RESERVE_MS };
