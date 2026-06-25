'use strict';
// Minimal, dependency-free FMP Starter client for the offline research rig.
// ONLY the `stable/` endpoint family — v3/ is legacy-dead on Starter (403).
// Key is read from process.env (load via: node --env-file=research/.env ...).

const BASE = 'https://financialmodelingprep.com/stable';

function key() {
  const k = process.env.FMP_API_KEY || '';
  if (!k) throw new Error('FMP_API_KEY missing — run with: node --env-file=research/.env <script>');
  return k;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// GET a stable/ endpoint. Returns parsed JSON, or throws with the status + body
// snippet so a 403/402 (tier/legacy) surfaces loudly instead of silently faking.
async function get(path, params = {}, { retries = 2, throttleMs = 250 } = {}) {
  const qs = new URLSearchParams({ ...params, apikey: key() }).toString();
  const url = `${BASE}/${path}?${qs}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { await sleep(1000 * (attempt + 1)); continue; } // rate limit → back off
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}: ${text.slice(0, 160)}`);
      if (throttleMs) await sleep(throttleMs);
      return JSON.parse(text);
    } catch (e) { lastErr = e; if (attempt < retries) await sleep(300 * (attempt + 1)); }
  }
  throw lastErr;
}

// ── Verified endpoints (probed on prod 2026-06-24) ────────────────────────────

// Delisted-company enumeration — paginated, 100/page. Includes ETFs + foreign;
// caller filters to US common stock.
async function delistedPage(page = 0) {
  return get('delisted-companies', { page });
}

// Daily OHLCV, newest-first. RETAINS delisted names up to their last trading day.
async function priceHistory(symbol) {
  const b = await get('historical-price-eod/full', { symbol });
  return Array.isArray(b) ? b : (b && Array.isArray(b.historical) ? b.historical : []);
}

// Quarterly income statements, newest-first, ~15yr deep, retained for delisted
// names. Carries weightedAverageShsOut (PIT shares for the cap band) + fundamentals.
async function incomeQuarterly(symbol, limit = 60) {
  return get('income-statement', { symbol, period: 'quarter', limit });
}

module.exports = { get, delistedPage, priceHistory, incomeQuarterly, sleep, BASE };
