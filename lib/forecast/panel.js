'use strict';
// PIT PANEL LOADER (forecast-panel-v1)
//
// Assembles the (session × name) panel the whole system runs on: the trading-session axis, the
// per-name candle series, the market benchmark, the sector proxy series, and the sector map.
//
// THIS MODULE IS PURE: it takes already-loaded series and does no filesystem, network or clock
// work at all, so tests build synthetic panels with nothing mocked. The loader that reads the
// research price cache lives on the RESEARCH side (research/lib/forecast-panel.js) — the
// repository's isolation invariant (test/research-isolation.test.js) keeps research artifacts out
// of live code, and this system honours it rather than carving itself an exception.
//
// SECTOR BASIS — declared, not hidden. lib/universe.js SECTOR_OF is the CURRENT vendor
// classification. The repo has no point-in-time sector history, so `sectorBasisPointInTime` is
// FALSE everywhere and every sector-conditioned result must disclose it.

const { SECTOR_OF } = require('../universe');

const PANEL_VERSION = 'forecast-panel-v1';

// The app's own sector → SPDR proxy mapping, matching lib/cern-run.js / lib/evolve-backfill.js.
const SECTOR_ETF = Object.freeze({
  'Technology': 'XLK',
  'Information Technology': 'XLK',
  'Communication Services': 'XLC',
  'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP',
  'Health Care': 'XLV',
  'Healthcare': 'XLV',
  'Financials': 'XLF',
  'Financial Services': 'XLF',
  'Industrials': 'XLI',
  'Energy': 'XLE',
  'Utilities': 'XLU',
  'Real Estate': 'XLRE',
  'Materials': 'XLB',
});

const BENCHMARK = 'SPY';

const indexOf = (candles) => new Map(candles.map((b, i) => [b.date, i]));

/**
 * Build a panel from already-loaded series.
 *   dataset       Map(ticker -> { candles, idx? })   candles ascending by date
 *   benchCandles  the market benchmark series (SPY)
 *   sectorCandles Map(etf -> candles)
 *   sectorOf      optional Map/object ticker -> sector name (defaults to lib/universe SECTOR_OF)
 * The session axis is the benchmark's own observed bar dates — the same convention the
 * repository's session-calendar module uses, so purge/embargo arithmetic is in real sessions.
 */
function makePanel({ dataset, benchCandles, sectorCandles = new Map(), sectorOf = SECTOR_OF, securityIds = null, source = null } = {}) {
  if (!dataset || typeof dataset.get !== 'function') throw new Error('makePanel: dataset must be a Map');
  if (!Array.isArray(benchCandles) || benchCandles.length < 2) throw new Error('makePanel: benchCandles required (>= 2 bars)');

  const normalized = new Map();
  for (const [ticker, v] of dataset) {
    const candles = Array.isArray(v) ? v : v.candles;
    if (!Array.isArray(candles) || !candles.length) continue;
    normalized.set(ticker, { candles, idx: (v && v.idx) || indexOf(candles) });
  }

  const sessions = benchCandles.map((b) => b.date);
  const sessionIndex = new Map(sessions.map((d, i) => [d, i]));
  const bench = { candles: benchCandles, idx: indexOf(benchCandles) };

  const sectors = new Map();
  for (const [etf, candles] of sectorCandles) {
    if (Array.isArray(candles) && candles.length) sectors.set(etf, { candles, idx: indexOf(candles) });
  }

  const sectorLookup = sectorOf instanceof Map ? (t) => sectorOf.get(t) || null : (t) => (sectorOf && sectorOf[t]) || null;
  const idLookup = securityIds instanceof Map ? (t) => securityIds.get(t) || t : (t) => t;

  return Object.freeze({
    schema: 'ForecastPanel', version: PANEL_VERSION,
    dataset: normalized,
    sessions: Object.freeze(sessions),
    sessionIndex,
    bench,
    benchmark: BENCHMARK,
    sectorSeries: sectors,
    sectorOf: sectorLookup,
    sectorEtfOf: (ticker) => SECTOR_ETF[sectorLookup(ticker)] || null,
    securityIdOf: idLookup,
    sectorBasisPointInTime: false,
    source,
    size: normalized.size,
  });
}

module.exports = { PANEL_VERSION, SECTOR_ETF, BENCHMARK, makePanel, indexOf };
