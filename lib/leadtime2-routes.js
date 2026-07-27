'use strict';
// LEAD-TIME v2 route (op=leadtime2) — folded into api/tracker.js. Same ledgers as
// v1 (which is preserved unchanged at op=leadtime for historical comparison) but
// the valid measurement: volatility-normalized barriers, market/sector-residual
// outcomes, censor-aware windows, executable trigger fills, cost-net R, and
// RECURRING episodes (per-strategy contract cooldown) instead of
// first-occurrence-forever. See lib/leadtime2.js for the model contracts.

const {
  hasStore, readJSON, writeJSON,
} = require('./store');
const { fetchDailyHistory } = require('./screener');
const { SECTOR_OF } = require('./universe');
const { benchFor } = require('./readthrough');       // GICS sector → SPDR sector ETF
const { createEpisodeMap } = require('./scoreboard-episodes');
const { assemblePicks } = require('./leadtime-routes');
const LT2 = require('./leadtime2');

const CACHE_PATH = 'apex/leadtime2.json';
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

// Recurring-episode selection: the same ticker/section/tier can produce a NEW
// episode once the per-strategy cooldown has elapsed since it was last seen
// (lib/scoreboard-episodes — the exact engine the Scoreboard uses), fixing v1's
// first-occurrence-forever undercount of recurring setups.
function episodePicks(picks) {
  const map = createEpisodeMap({});
  for (const p of picks.slice().sort(byDate)) {
    map.add(`${p.section}:${p.tier}:${p.ticker}`, p);
  }
  return map.values();
}

async function fetchHist(tickers) {
  const hist = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip a bad feed */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));
  return hist;
}

async function runLeadTime2(req, res) {
  if (!hasStore()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, configured: false, algorithms: [], note: 'No ledger store configured yet.' });
  }
  const barrierVersion = LT2.BARRIERS[req.query.barrier] ? req.query.barrier : LT2.DEFAULT_BARRIER;
  const raw = await assemblePicks();                                     // v1's ledger fold (all sections)
  const picks = episodePicks(raw);
  if (!picks.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, configured: true, algorithms: [], coverage: { episodes: 0, evaluated: 0 }, note: 'No resolvable episodes yet.' });
  }

  const tickers = [...new Set(picks.map(p => p.ticker))];
  const sectorEtfs = [...new Set(tickers.map(t => benchFor(SECTOR_OF[t])).filter(Boolean))];
  const hist = await fetchHist([...tickers, 'SPY', ...sectorEtfs]);
  const bench = hist.get('SPY') || null;

  const episodes = picks
    .map(p => ({ pick: { ...p, key: req.query.bytier === '1' ? `${p.section}:${p.tier}` : p.section }, candles: hist.get(p.ticker) }))
    .filter(e => e.candles);

  // Per-ticker sector residual: each episode resolves against its own sector ETF
  // when candles exist; unknown sector falls back to a LABELED market-only read
  // inside leadtime2 (residualized flag + benchKind — never silently pretended).
  const results = [];
  const byKey = new Map();
  for (const e of episodes) {
    const etf = benchFor(SECTOR_OF[e.pick.ticker]);
    const sectorCandles = etf ? hist.get(etf) || null : null;
    const r = LT2.episodeLeadTime(e.pick, e.candles, { benchCandles: bench, sectorCandles, cfg: { barrierVersion } });
    if (r.skipped) continue;
    results.push({ ...r, key: e.pick.key, band: e.pick.band ?? e.pick.decile ?? null, rejected: !!e.pick.rejected });
  }
  for (const r of results) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const cfg = { ...LT2.CONFIG, barrierVersion };
  const algorithms = [...byKey.entries()].map(([key, group]) => ({
    key, episodes: group.length,
    horizons: Object.fromEntries(cfg.HORIZONS.map(H => [H, LT2.aggregateHorizon(group, H)])),
  })).sort((a, b) => (a.key < b.key ? -1 : 1));

  const payload = {
    ok: true, configured: true, generatedAt: new Date().toISOString(),
    version: LT2.LEADTIME2_VERSION,
    barrierVersion,
    availableBarriers: Object.keys(LT2.BARRIERS),
    horizons: cfg.HORIZONS,
    algorithms,
    coverage: { ledgerRows: raw.length, episodes: picks.length, evaluated: results.length },
    note: 'Lead-time v2: vol-normalized barriers (Coil baseline), sector/market-residual outcomes, censor-aware windows, executable fills, cost-net R, recurring episodes after contract cooldown. v1 (op=leadtime) is preserved for comparison. Measurement only — no alpha claim.',
  };
  try { await writeJSON(CACHE_PATH, payload, 0); } catch { /* cache is optional */ }
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json(payload);
}

async function loadLeadTime2() {
  return readJSON(CACHE_PATH, null).catch(() => null);
}

module.exports = { runLeadTime2, loadLeadTime2, episodePicks, CACHE_PATH };
