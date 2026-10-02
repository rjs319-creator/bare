'use strict';
// YAHOO CHART → research price cache (yahoo-history-v1).
//
// The research kit (research/lib/experiment-kit.js) reads research/data/cache/<T>.json
// in the FMP shape: { price: [ {date, open, high, low, close, volume}, … ] } stored
// NEWEST-FIRST. This materializes that shape from Yahoo's public chart endpoint when no
// FMP key is available locally, so the attention study can run on a local price panel.
//
// Honesty limits stamped on every file: Yahoo's raw OHLC is SPLIT-adjusted (not
// dividend-adjusted) — same basis as FMP historical-price-eod/full — but it is a
// SURVIVOR universe (Yahoo drops delisted names); nothing built on it can promote.

const fs = require('node:fs');
const path = require('node:path');
const { fetchJSON, makeLimiter } = require('./http-polite');

const YAHOO_HISTORY_VERSION = 'yahoo-history-v1';
const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const DEFAULT_RANGE = '10y';
const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

const toEtDate = (unixSeconds) => ET_DATE.format(new Date(unixSeconds * 1000));
const finite = (v) => (Number.isFinite(v) ? v : null);

// Pure: Yahoo chart JSON → ascending candles. Rows with no close are dropped (Yahoo pads
// holidays/half-days with nulls). Exported for tests.
function parseChart(json) {
  const r = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
  if (!r || !Array.isArray(r.timestamp)) return [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const close = finite(q.close && q.close[i]);
    if (close == null || close <= 0) continue;
    out.push({
      date: toEtDate(r.timestamp[i]),
      open: finite(q.open && q.open[i]) ?? close,
      high: finite(q.high && q.high[i]) ?? close,
      low: finite(q.low && q.low[i]) ?? close,
      close,
      volume: finite(q.volume && q.volume[i]) ?? 0,
    });
  }
  return out;
}

// Kit file shape (newest-first), with provenance.
function toCacheDoc(symbol, candlesAscending) {
  return {
    symbol,
    source: YAHOO_HISTORY_VERSION,
    priceBasis: 'yahoo raw OHLC — split-adjusted, not dividend-adjusted; survivor universe',
    fetchedAt: new Date().toISOString(),
    price: candlesAscending.slice().reverse(),
  };
}

async function fetchChart(symbol, { range = DEFAULT_RANGE, fetchImpl } = {}) {
  const url = `${CHART_BASE}${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=div%2Csplit`;
  const r = await fetchJSON(url, { fetchImpl });
  if (!r.ok) return { symbol, ok: false, status: r.status, candles: [] };
  return { symbol, ok: true, status: r.status, candles: parseChart(r.json) };
}

// Materialize many symbols into cacheDir. Skips files that already exist unless
// `refresh`. Returns counts; never throws on a single symbol's failure.
async function materialize(symbols, cacheDir, { range = DEFAULT_RANGE, refresh = false, concurrency = 3, minSpacingMs = 250, onProgress = null, fetchImpl } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const limit = makeLimiter({ concurrency, minSpacingMs });
  const counts = { requested: symbols.length, written: 0, skipped: 0, empty: 0, failed: 0 };
  const failures = [];
  await Promise.all(symbols.map((sym) => limit(async () => {
    const file = path.join(cacheDir, `${sym}.json`);
    if (!refresh && fs.existsSync(file)) { counts.skipped++; return; }
    let r;
    try { r = await fetchChart(sym, { range, fetchImpl }); }
    catch (e) { r = { ok: false, status: String((e && e.message) || e), candles: [] }; }
    if (!r.ok) { counts.failed++; failures.push({ symbol: sym, status: r.status }); return; }
    if (!r.candles.length) { counts.empty++; return; }
    fs.writeFileSync(file, JSON.stringify(toCacheDoc(sym, r.candles)));
    counts.written++;
    if (onProgress) onProgress({ ...counts });
  })));
  return { ...counts, failures };
}

module.exports = { YAHOO_HISTORY_VERSION, parseChart, toCacheDoc, fetchChart, materialize };
