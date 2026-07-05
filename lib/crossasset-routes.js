// 🌐 CROSS-ASSET route — tick/serve split.
//   op=crossassettick : AI sweeps cross-asset moves + names levered US stocks → tape-verify
//                       (drop names with no data; record today's move + anchor date) →
//                       forward-log → cache.
//   op=crossasset     : fast serve.
// Detection is AI-generated (the tell originates OUTSIDE the US tape), then grounded against
// our price data. Forward-logged to crossasset/<date>.json for the Scoreboard.
const { readJSON, writeJSON, hasStore } = require('./store');
const { parseResult, rankItems, investigate } = require('./crossasset');
const { benchFor } = require('./readthrough');

const CACHE_KEY = 'crossasset/latest.json';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const TAPE_DEADLINE_MS = 52000;
const DISCLAIMER = 'US stocks levered to a move in a DIFFERENT asset (a commodity, an overnight foreign market/ADR, crypto, or rates) that they may not have caught up to yet. LEAD = still lagging the tell; INLINE = already tracking; WEAK = loose link. Cross-asset lead-lag is noisy — a LEAD to forward-track, NOT a buy signal.';

// Confirm each AI-named ticker trades (drop no-data/hallucinated) and record today's move +
// a common anchor date (SPY's last session). Bounded by a wall-clock deadline.
async function tapeVerify(items, t0) {
  const { fetchDailyHistory } = require('./screener');
  const { dayMetrics } = require('./daytrade');
  const spy = await fetchDailyHistory('SPY').catch(() => null);
  const asOf = spy && spy.candles.length ? spy.candles[spy.candles.length - 1].date : null;
  const kept = []; let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      if (Date.now() - t0 > TAPE_DEADLINE_MS) { kept.push({ ...it, movedPct: null }); continue; }
      try {
        const d = await fetchDailyHistory(it.ticker);
        if (!d || !d.candles || !d.candles.length) continue;   // drop names with no data
        const m = dayMetrics(d.candles);
        kept.push({ ...it, movedPct: m && m.pctChange != null ? +m.pctChange.toFixed(1) : null });
      } catch { /* drop */ }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { kept, asOf };
}

function tierFor(c) {
  return c.classification === 'LEAD' ? 'Lead' : c.classification === 'INLINE' ? 'Inline' : 'Weak';
}

async function logSurfaced(asOf, items) {
  if (!hasStore() || !asOf || !items.length) return 0;
  const { SECTOR_OF } = require('./universe');
  const { writeCrossAssetDay } = require('./store');
  const picks = items.map(c => ({
    ticker: c.ticker, tier: tierFor(c), date: asOf, entry: null, short: false,
    bench: benchFor(SECTOR_OF[c.ticker]), classification: c.classification, confidence: c.confidence,
  }));
  await writeCrossAssetDay(asOf, { picks }).catch(() => {});
  return picks.length;
}

async function runCrossAssetTick(req, res) {
  const t0 = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, error: 'no ANTHROPIC_API_KEY' });
  try {
    const raw = await investigate();
    const parsed = parseResult(raw);
    if (!parsed.items.length) {
      const empty = { asOf: null, items: [], notes: parsed.notes || 'no cross-asset leads', generatedAt: new Date().toISOString() };
      if (hasStore()) await writeJSON(CACHE_KEY, empty, 0).catch(() => {});
      return res.json({ ok: true, ...empty, elapsedMs: Date.now() - t0 });
    }
    const { kept, asOf } = await tapeVerify(parsed.items, t0);
    const ranked = rankItems(kept);
    const logged = await logSurfaced(asOf, ranked);
    const payload = { asOf, items: ranked, notes: parsed.notes, logged, generatedAt: new Date().toISOString() };
    if (hasStore()) await writeJSON(CACHE_KEY, payload, 0).catch(() => {});
    return res.json({ ok: true, asOf, itemCount: ranked.length, logged, elapsedMs: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

async function runCrossAsset(req, res) {
  const cached = hasStore() ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
  if (cached) {
    const ageMins = cached.generatedAt ? Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) : null;
    const stale = cached.generatedAt ? (Date.now() - new Date(cached.generatedAt).getTime() >= REFRESH_MS) : true;
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.json({ ok: true, cached: true, stale, disclaimer: DISCLAIMER, ...cached, ageMins });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: false, error: 'warming up — building the cross-asset scan (try Refresh in a moment)', items: [], disclaimer: DISCLAIMER });
}

module.exports = { runCrossAsset, runCrossAssetTick, tapeVerify, tierFor, logSurfaced, CACHE_KEY };
