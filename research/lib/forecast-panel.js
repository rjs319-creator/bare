'use strict';
// RESEARCH-SIDE PANEL LOADER (forecast-panel-loader-v1)
//
// The ONE place that reads the research price cache for the CFR system. It lives here, on the
// research side, because test/research-isolation.test.js keeps research data artifacts out of
// live application code — and this subsystem honours that invariant instead of exempting itself.
//
// lib/forecast/panel.js stays pure (series in, panel out); this module is the thin filesystem
// wrapper around it, reusing the loaders the repository already has
// (research/lib/experiment-kit.js) rather than introducing a second, drifting data path.

const path = require('node:path');
const fs = require('node:fs');
const { makePanel, indexOf, SECTOR_ETF, BENCHMARK } = require('../../lib/forecast/panel');

const PANEL_LOADER_VERSION = 'forecast-panel-loader-v1';

/**
 * Load the panel from the research cache (research/data/cache/*.json).
 * Optional: `tickers` restricts the load; `kit` is injectable for tests.
 */
function loadPanel(cfg, { kit = null, tickers = null } = {}) {
  const K = kit || require('./experiment-kit');

  const benchCandles = K.loadSeries(path.join(K.CACHE_DIR, `${BENCHMARK}.json`));
  if (!benchCandles) throw new Error(`${BENCHMARK} missing from the research cache (${K.CACHE_DIR}) — the panel needs a benchmark`);

  const sectorCandles = new Map();
  const missingSectorProxies = [];
  for (const etf of new Set(Object.values(SECTOR_ETF))) {
    const c = K.loadSeries(path.join(K.CACHE_DIR, `${etf}.json`));
    if (c) sectorCandles.set(etf, c); else missingSectorProxies.push(etf);
  }

  const u = cfg.universe;
  const files = tickers
    ? tickers.map((t) => `${t}.json`)
    : fs.readdirSync(K.CACHE_DIR).filter((f) => f.endsWith('.json'));

  const dataset = new Map();
  const attrition = { scanned: files.length, unreadable: 0, tooFewBars: 0, tooIlliquid: 0, admitted: 0 };
  for (const f of files) {
    if (dataset.size >= u.maxNames) break;
    const ticker = f.replace(/\.json$/, '');
    if (ticker === BENCHMARK || sectorCandles.has(ticker)) continue;      // proxies are not names
    const candles = K.loadSeries(path.join(K.CACHE_DIR, f));
    if (!candles) { attrition.unreadable++; continue; }
    if (candles.length < u.minHistorySessions) { attrition.tooFewBars++; continue; }
    // A cheap whole-series liquidity pre-filter; the real gate is per-date in universe.js.
    if (K.advOf(candles, u.advLookback) < u.minAvgDollarVolume) { attrition.tooIlliquid++; continue; }
    dataset.set(ticker, { candles, idx: indexOf(candles) });
  }
  attrition.admitted = dataset.size;

  const panel = makePanel({ dataset, benchCandles, sectorCandles, source: K.CACHE_DIR });
  return { panel, attrition, missingSectorProxies };
}

module.exports = { PANEL_LOADER_VERSION, loadPanel, SECTOR_ETF, BENCHMARK };
