// 🕵️ ANOMALY-FIRST route — TWO ops (mirrors Read-Through):
//   op=anomalytick : detect no-news movers → AI investigation (Sonnet + web_search) →
//                    forward-log → write cache. Slow (~50s); cron-driven + manual Refresh.
//   op=anomaly     : serve the cached result (fast). Never blocks on the AI call.
// Detection reads the pre-warmed candle cache (no re-scan); the news feed drops movers with
// a known headline; the investigator classifies the survivors and catches catalysts our
// feed missed. Forward-logged to anomaly/<date>.json for the Scoreboard.
const { readJSON, writeJSON, hasStore, writeAnomalyDay } = require('./store');
const { isAnomalyCandidate, parseResult, rankItems, investigate, MAX_INVESTIGATE } = require('./anomaly');
const { benchFor } = require('./readthrough');

const CACHE_KEY = 'anomaly/latest.json';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const NEWS_DEADLINE_MS = 16000;              // cap the per-mover news checks before the AI call
const DISCLAIMER = 'Names quietly moving up on volume with NO company news — the AI investigates each for a hidden catalyst. ACCUMULATION = none found (possible stealth buying); EXPLAINED = a public reason exists (already priced); NOISE = technical/illiquid. A LEAD to forward-track, NOT a buy signal.';

// Scan the candle caches for quiet up-movers (pure predicate in lib/anomaly). Returns the
// movers plus the latest trading date seen (the forward-log anchor).
async function detect(limit) {
  const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const { dayMetrics } = require('./daytrade');
  const scopes = [['large', LARGE], ['small', SMALL_CAPS], ['micro', MICRO_CAPS]];
  const docs = {};
  await Promise.all(scopes.map(async ([s]) => { docs[s] = await loadCandleCache(s).catch(() => null); }));
  const out = []; let asOf = null;
  for (const [s, list] of scopes) {
    const doc = docs[s]; if (!doc) continue;
    for (const t of list) {
      const e = cacheGet(doc, t); if (!e || !e.candles || !e.candles.length) continue;
      const m = dayMetrics(e.candles); if (!isAnomalyCandidate(m)) continue;
      const last = e.candles[e.candles.length - 1].date;
      if (!asOf || last > asOf) asOf = last;
      out.push({ ticker: t, pct5d: m.pct5d, relVol: +m.relVol.toFixed(1), pctChange: +m.pctChange.toFixed(1), gapPct: +(m.gapPct || 0).toFixed(1), score: m.pct5d * m.relVol });
    }
  }
  return { movers: out.sort((a, b) => b.score - a.score).slice(0, limit), asOf };
}

// Drop movers that DO have recent company news — the defining anomaly condition is "no
// public reason". Deadline-bounded; a name we can't check in time is kept (never hidden).
async function filterNoNews(cands, t0, deadline) {
  const { fetchCompanyNews } = require('./fundamentals');
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10);
  const kept = []; let i = 0;
  const worker = async () => {
    while (i < cands.length) {
      const c = cands[i++];
      if (Date.now() - t0 > deadline) { kept.push({ ...c, newsChecked: false }); continue; }
      const news = await fetchCompanyNews(c.ticker, from, today).catch(() => []);
      if (!Array.isArray(news) || news.length === 0) kept.push({ ...c, newsChecked: true });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return kept;
}

function tierFor(c) {
  return c.classification === 'ACCUMULATION' ? 'Accumulation' : c.classification === 'EXPLAINED' ? 'Explained' : 'Noise';
}

// Counterfactual archive: log EVERY investigated mover (all three classes) so the board can
// test whether ACCUMULATION actually beats EXPLAINED/NOISE. Benchmarked vs the mover's own
// sector ETF (beat your peers). Anchored at the detection date. Idempotent per date.
async function logSurfaced(asOf, items) {
  if (!hasStore() || !asOf || !items.length) return 0;
  const { SECTOR_OF } = require('./universe');
  const picks = items.map(c => ({
    ticker: c.ticker, tier: tierFor(c), date: asOf, entry: null, short: false,
    bench: benchFor(SECTOR_OF[c.ticker]), classification: c.classification, confidence: c.confidence,
  }));
  await writeAnomalyDay(asOf, { picks }).catch(() => {});
  return picks.length;
}

// op=anomalytick — Stage 1: detect → investigate → log → cache. Cron + Refresh driven.
async function runAnomalyTick(req, res) {
  const t0 = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, error: 'no ANTHROPIC_API_KEY' });
  try {
    const { movers, asOf } = await detect(25);
    const noNews = await filterNoNews(movers, t0, NEWS_DEADLINE_MS);
    const cands = noNews.slice(0, MAX_INVESTIGATE);
    if (!cands.length) {
      const empty = { asOf, items: [], notes: 'no no-news movers detected', detected: movers.length, generatedAt: new Date().toISOString() };
      if (hasStore()) await writeJSON(CACHE_KEY, empty, 0).catch(() => {});
      return res.json({ ok: true, ...empty, elapsedMs: Date.now() - t0 });
    }
    const raw = await investigate(cands);
    const { items, notes } = parseResult(raw, cands);
    const ranked = rankItems(items);
    const logged = await logSurfaced(asOf, ranked);
    const payload = { asOf, items: ranked, notes, detected: movers.length, noNews: noNews.length, candidates: cands, logged, generatedAt: new Date().toISOString() };
    if (hasStore()) await writeJSON(CACHE_KEY, payload, 0).catch(() => {});
    return res.json({ ok: true, asOf, itemCount: ranked.length, logged, detected: movers.length, elapsedMs: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// op=anomaly — serve the cached result (fast). ?force=1 kicks a fresh tick first (handled
// client-side); this endpoint itself never calls the AI, so a viewer never waits.
async function runAnomaly(req, res) {
  const cached = hasStore() ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
  if (cached) {
    const ageMins = cached.generatedAt ? Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) : null;
    const stale = cached.generatedAt ? (Date.now() - new Date(cached.generatedAt).getTime() >= REFRESH_MS) : true;
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.json({ ok: true, cached: true, stale, disclaimer: DISCLAIMER, ...cached, ageMins });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: false, error: 'warming up — building the anomaly scan (try Refresh in a moment)', items: [], disclaimer: DISCLAIMER });
}

module.exports = { runAnomaly, runAnomalyTick, detect, filterNoNews, tierFor, logSurfaced, CACHE_KEY };
