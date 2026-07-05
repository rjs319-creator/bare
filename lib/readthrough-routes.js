// 🔗 READ-THROUGH route — TWO-STAGE split so more triggers fit under the 60s wall AND
// users never wait on the slow Fable call:
//   Stage 1  op=readthroughtick : Fable-only (its own 60s invocation → more triggers),
//            writes the raw graph to readthrough/raw.json. Cron-driven (daily) + Refresh.
//   Stage 2  op=readthrough     : reads the raw graph, does the FAST (~8s) live-tape
//            enrichment + rank + forward-log, caches readthrough/latest.json, serves.
// Triggers come from the day's Gap & Go ledger (earnings-filtered + cause-tagged) — no
// re-scan. Beneficiaries that ALREADY moved today are demoted (the edge is the lag).
const { readJSON, writeJSON, hasStore, readAllGapDays, writeReadThroughDay } = require('./store');
const { buildTriggers, parseGraph, alreadyMovedFlag, rankItems, callFable, MAX_TRIGGERS_RAW, TICK_TIMEOUT_MS } = require('./readthrough');

// Freshness tier for the forward-log: the falsifiable test is whether the un-moved (Fresh)
// read-throughs outperform the already-moved (Moved) ones. `null` tape → Unknown.
function tierFor(it) {
  if (!it.moved || it.moved.alreadyMoved == null) return 'Unknown';
  return it.moved.alreadyMoved ? 'Moved' : 'Fresh';
}

// Counterfactual archive: log EVERY surfaced beneficiary (Fresh or Moved), anchored at the
// trigger/catalyst date so the Scoreboard measures forward excess vs SPY from the catalyst.
// entry:null → the resolver uses the beneficiary's close at that date. Idempotent per date.
async function logSurfaced(triggerDate, items) {
  if (!hasStore() || !triggerDate || !items.length) return 0;
  const picks = items.map(it => ({
    ticker: it.beneficiary_ticker, tier: tierFor(it), date: triggerDate, entry: null, short: false,
    trigger: it.trigger_ticker, linkType: it.link_type, directness: it.directness,
    sector: it.beneficiary_sector || null, bench: it.bench || null,   // sector ETF benchmark (null → SPY)
  }));
  await writeReadThroughDay(triggerDate, { picks }).catch(() => {});
  return picks.length;
}

const RAW_KEY = 'readthrough/raw.json';     // Stage-1 output: the Fable graph, pre-tape
const CACHE_KEY = 'readthrough/latest.json'; // Stage-2 output: tape-enriched, ranked, served
const REFRESH_MS = 6 * 60 * 60 * 1000;      // re-enrich (Stage 2) at most every 6 hours
const PRICE_DEADLINE_MS = 58000;            // tape runs AFTER the Fable call in the self-contained tick; stop just before the 60s wall (unchecked names → 'unknown', still logged)
const DISCLAIMER = 'Second-order read-throughs — names economically linked to today\'s movers that may not have repriced yet. A LEAD to track, NOT a buy signal: the link may already be priced (we demote names that already moved) and brand-new relationships can be missed. Forward-tracked before it is trusted.';

// Attach a live "already moved today?" flag to each beneficiary. Bounded by a wall-clock
// deadline from t0 so the Fable call + these fetches stay under the function limit; any
// name we can't check in time is left `unknown` (never silently dropped).
async function attachTapeMoves(items, t0) {
  const { fetchDailyHistory } = require('./screener');
  const { dayMetrics } = require('./daytrade');
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      if (Date.now() - t0 > PRICE_DEADLINE_MS) { it.moved = { movedPct: null, alreadyMoved: null }; continue; }
      try {
        const d = await fetchDailyHistory(it.beneficiary_ticker);
        it.moved = alreadyMovedFlag(d ? dayMetrics(d.candles) : null);
      } catch { it.moved = { movedPct: null, alreadyMoved: null }; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return items;
}

// ── STAGE 1 — op=readthroughtick: the SLOW Fable-only call, alone in its own 60s
// invocation so it can take more triggers (MAX_TRIGGERS_RAW). Writes the raw graph
// (pre-tape) to RAW_KEY. Cron-driven daily + triggered by the UI Refresh button.
async function runReadThroughTick(req, res) {
  const t0 = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, error: 'no ANTHROPIC_API_KEY' });
  try {
    const days = await readAllGapDays();
    const latest = days.length ? days.reduce((a, b) => (a.date > b.date ? a : b)) : null;
    const triggers = latest ? buildTriggers(latest, MAX_TRIGGERS_RAW) : [];
    if (!triggers.length) {
      const empty = { triggerDate: latest ? latest.date : null, items: [], notes: 'no gappers on the latest ledger day', triggers: [], regime: latest ? latest.regime || null : null, generatedAt: new Date().toISOString() };
      if (hasStore()) await writeJSON(RAW_KEY, empty, 0).catch(() => {});
      return res.json({ ok: true, ...empty, rawCount: 0, elapsedMs: Date.now() - t0 });
    }
    // Single Fable call (3 triggers ~50s), then INLINE tape-enrich + forward-log — the whole
    // thing self-contained in one invocation so the daily cron just fire-and-forgets the tick.
    const rawInput = await callFable(triggers, TICK_TIMEOUT_MS).catch(() => null);
    const { items, notes } = parseGraph(rawInput, triggers);
    const raw = { triggerDate: latest.date, items, notes, triggers, regime: latest.regime || null, generatedAt: new Date().toISOString() };
    if (hasStore()) await writeJSON(RAW_KEY, raw, 0).catch(() => {});   // raw kept for serve fallback
    // Inline enrich (tape deadline-guarded to just under the wall) + write the served cache.
    await attachTapeMoves(items, t0);
    const ranked = rankItems(items);
    const logged = await logSurfaced(latest.date, ranked);
    const payload = { items: ranked, notes, triggerDate: latest.date, triggers, regime: latest.regime || null, logged, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 };
    if (hasStore()) await writeJSON(CACHE_KEY, payload, 0).catch(() => {});
    return res.json({ ok: true, triggerDate: latest.date, rawCount: items.length, itemCount: ranked.length, logged, elapsedMs: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// Stage 2 core: take the raw graph, attach live tape, rank, forward-log. Fast (~8s).
async function enrich(raw, t0) {
  const items = (raw.items || []).map(it => ({ ...it }));
  await attachTapeMoves(items, t0);
  const ranked = rankItems(items);
  const logged = await logSurfaced(raw.triggerDate, ranked);
  return { items: ranked, notes: raw.notes || '', triggerDate: raw.triggerDate, triggers: raw.triggers || [], regime: raw.regime || null, logged, rawAt: raw.generatedAt };
}

// ── STAGE 2 — op=readthrough: serve the enriched cache; when stale, re-enrich from the
// raw graph (fast). ?force=1 forces a re-enrich. It never calls Fable — that's Stage 1,
// so a viewer never waits ~55s; the daily cron keeps the raw graph fresh.
async function runReadThrough(req, res) {
  const t0 = Date.now();
  const force = req.query.force === '1';
  const cached = hasStore() ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
  const fresh = cached && cached.generatedAt && (Date.now() - new Date(cached.generatedAt).getTime() < REFRESH_MS);
  if (cached && fresh && !force) {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.json({ ok: true, cached: true, refreshMins: 360, disclaimer: DISCLAIMER, ...cached, ageMins: Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) });
  }

  const raw = hasStore() ? await readJSON(RAW_KEY, null).catch(() => null) : null;
  if (raw) {
    let result = null, enrErr = null;
    try { result = await enrich(raw, t0); } catch (e) { enrErr = e && e.message; }
    if (result) {
      const payload = { ...result, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 };
      if (hasStore()) await writeJSON(CACHE_KEY, payload, 0).catch(() => {});
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
      return res.json({ ok: true, cached: false, refreshMins: 360, disclaimer: DISCLAIMER, ...payload, ageMins: 0 });
    }
    if (cached) { res.setHeader('Cache-Control', 's-maxage=600'); return res.json({ ok: true, cached: true, stale: true, disclaimer: DISCLAIMER, ...cached, ageMins: Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) }); }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: enrErr || 'enrich failed', items: [], disclaimer: DISCLAIMER });
  }

  // No raw graph yet — the tick hasn't run. Serve any stale enriched cache; else prompt.
  if (cached) {
    res.setHeader('Cache-Control', 's-maxage=600');
    return res.json({ ok: true, cached: true, stale: true, disclaimer: DISCLAIMER, ...cached, ageMins: Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: false, error: 'warming up — building the graph (try Refresh in a moment)', items: [], disclaimer: DISCLAIMER });
}

module.exports = { runReadThrough, runReadThroughTick, enrich, attachTapeMoves, tierFor, logSurfaced, CACHE_KEY, RAW_KEY };
