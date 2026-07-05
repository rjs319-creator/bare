// 🌊 SECOND WAVE route — mirrors the Anomaly tick/serve split.
//   op=secondwavetick : detect first-leg movers → AI second-wave forecast → forward-log → cache.
//   op=secondwave     : fast serve of the cached result.
// Detection reads the warm candle caches (no re-scan). Unlike Anomaly, we do NOT drop
// names with news — a legible catalyst is exactly what a second wave needs. Forward-logged
// to secondwave/<date>.json for the Scoreboard (do PRIMED names get the second leg?).
const { readJSON, writeJSON, hasStore } = require('./store');
const { isFirstLegCandidate, parseResult, rankItems, investigate, MAX_INVESTIGATE } = require('./secondwave');
const { benchFor } = require('./readthrough');

const CACHE_KEY = 'secondwave/latest.json';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const DISCLAIMER = 'First-leg movers the crowd has NOT piled into yet — the AI forecasts a reflexive SECOND wave. PRIMED = fresh story, crowd still light; EARLY = needs a trigger; FADED = already crowded/late. Attention is hard to predict — a LEAD to forward-track, NOT a buy signal.';

// ~10-session trailing return from daily candles.
function ret10(candles) {
  if (!candles || candles.length < 12) return null;
  const last = candles[candles.length - 1].close, base = candles[candles.length - 11].close;
  if (!(last > 0) || !(base > 0)) return null;
  return +(((last - base) / base) * 100).toFixed(1);
}

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
      const m = dayMetrics(e.candles); const r10 = ret10(e.candles);
      if (!isFirstLegCandidate(m, r10)) continue;
      const last = e.candles[e.candles.length - 1].date;
      if (!asOf || last > asOf) asOf = last;
      out.push({ ticker: t, ret10: r10, relVol: +m.relVol.toFixed(1), pctChange: +m.pctChange.toFixed(1), score: r10 * m.relVol });
    }
  }
  return { movers: out.sort((a, b) => b.score - a.score).slice(0, limit), asOf };
}

function tierFor(c) {
  return c.classification === 'PRIMED' ? 'Primed' : c.classification === 'EARLY' ? 'Early' : 'Faded';
}

async function logSurfaced(asOf, items) {
  if (!hasStore() || !asOf || !items.length) return 0;
  const { SECTOR_OF } = require('./universe');
  const { writeSecondWaveDay } = require('./store');
  const picks = items.map(c => ({
    ticker: c.ticker, tier: tierFor(c), date: asOf, entry: null, short: false,
    bench: benchFor(SECTOR_OF[c.ticker]), classification: c.classification, virality: c.virality,
  }));
  await writeSecondWaveDay(asOf, { picks }).catch(() => {});
  return picks.length;
}

async function runSecondWaveTick(req, res) {
  const t0 = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, error: 'no ANTHROPIC_API_KEY' });
  try {
    const { movers, asOf } = await detect(MAX_INVESTIGATE);
    if (!movers.length) {
      const empty = { asOf, items: [], notes: 'no first-leg movers detected', generatedAt: new Date().toISOString() };
      if (hasStore()) await writeJSON(CACHE_KEY, empty, 0).catch(() => {});
      return res.json({ ok: true, ...empty, elapsedMs: Date.now() - t0 });
    }
    const raw = await investigate(movers);
    const { items, notes } = parseResult(raw, movers);
    const ranked = rankItems(items);
    const logged = await logSurfaced(asOf, ranked);
    const payload = { asOf, items: ranked, notes, detected: movers.length, candidates: movers, logged, generatedAt: new Date().toISOString() };
    if (hasStore()) await writeJSON(CACHE_KEY, payload, 0).catch(() => {});
    return res.json({ ok: true, asOf, itemCount: ranked.length, logged, detected: movers.length, elapsedMs: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

async function runSecondWave(req, res) {
  const cached = hasStore() ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
  if (cached) {
    const ageMins = cached.generatedAt ? Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) : null;
    const stale = cached.generatedAt ? (Date.now() - new Date(cached.generatedAt).getTime() >= REFRESH_MS) : true;
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.json({ ok: true, cached: true, stale, disclaimer: DISCLAIMER, ...cached, ageMins });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: false, error: 'warming up — building the second-wave scan (try Refresh in a moment)', items: [], disclaimer: DISCLAIMER });
}

module.exports = { runSecondWave, runSecondWaveTick, detect, tierFor, logSurfaced, ret10, CACHE_KEY };
