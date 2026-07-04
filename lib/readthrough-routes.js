// 🔗 READ-THROUGH route — op=readthrough. Serves the cached beneficiary graph and lazily
// regenerates past a refresh window (Market Pulse pattern: generation is a slow Fable call
// so it is cache-gated, never a blocking cron step). Triggers come from the day's Gap & Go
// ledger (already earnings-filtered + cause-tagged) — no re-scan. Each beneficiary is then
// checked against the live tape and any that ALREADY moved today are demoted (the edge is
// the lag). Read-only w.r.t. the app's other state; writes only its own cache doc.
const { readJSON, writeJSON, hasStore, readAllGapDays, writeReadThroughDay } = require('./store');
const { buildTriggers, parseGraph, alreadyMovedFlag, rankItems, callFable } = require('./readthrough');

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

const CACHE_KEY = 'readthrough/latest.json';
const REFRESH_MS = 6 * 60 * 60 * 1000;      // regenerate at most every 6 hours
const PRICE_DEADLINE_MS = 57000;            // stop the per-beneficiary tape checks before the 60s wall
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

async function generate(t0) {
  const days = await readAllGapDays();
  if (!days.length) return { items: [], notes: 'no gap-ledger days yet', triggerDate: null, triggers: [] };
  const latest = days.reduce((a, b) => (a.date > b.date ? a : b));
  const triggers = buildTriggers(latest);
  if (!triggers.length) return { items: [], notes: 'no gappers on the latest ledger day', triggerDate: latest.date, triggers: [] };

  const rawInput = await callFable(triggers);          // one bounded Fable-5 call (parametric)
  const { items, notes } = parseGraph(rawInput, triggers);
  await attachTapeMoves(items, t0);
  const ranked = rankItems(items);
  const logged = await logSurfaced(latest.date, ranked);   // forward-log the counterfactual archive
  return { items: ranked, notes, triggerDate: latest.date, triggers, regime: latest.regime || null, logged };
}

// op=readthrough — serve cache, regenerate at most every 6 hours (or ?force=1).
async function runReadThrough(req, res) {
  const t0 = Date.now();
  const force = req.query.force === '1';
  const cached = hasStore() ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
  const fresh = cached && cached.generatedAt && (Date.now() - new Date(cached.generatedAt).getTime() < REFRESH_MS);
  if (cached && fresh && !force) {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.json({ ok: true, cached: true, refreshMins: 360, disclaimer: DISCLAIMER, ...cached, ageMins: Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) });
  }

  let result = null, genErr = null;
  try { result = await generate(t0); } catch (e) { genErr = e && e.message; }

  if (!result) {
    if (cached) {   // never leave the UI empty
      res.setHeader('Cache-Control', 's-maxage=600');
      return res.json({ ok: true, cached: true, stale: true, disclaimer: DISCLAIMER, ...cached, ageMins: Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: genErr || 'read-through unavailable (no API key or no data)', items: [], disclaimer: DISCLAIMER });
  }

  const payload = { ...result, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 };
  if (hasStore()) await writeJSON(CACHE_KEY, payload, 0).catch(() => {});
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({ ok: true, cached: false, refreshMins: 360, disclaimer: DISCLAIMER, ...payload, ageMins: 0 });
}

module.exports = { runReadThrough, generate, attachTapeMoves, tierFor, logSurfaced, CACHE_KEY };
