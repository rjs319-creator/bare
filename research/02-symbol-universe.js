'use strict';
// Phase-0 step 02 — build the US-common SYMBOL SUPERSET (survivor side, clean)
// and cache the full survivorship-complete symbol list for the bias study (04).
//   node --env-file=research/.env research/02-symbol-universe.js
//
// FINDINGS that shaped this (FMP Starter, 2026-06-24):
//  • company-screener: clean US-common, cap-banded, ETFs/funds excluded → the
//    SURVIVOR superset. Wide band (150M–15B) so names that drift across the
//    300M–10B mandate edge are still captured for point-in-time membership (03).
//  • delisted-companies: page=0 ONLY on Starter (402) → cannot enumerate history.
//  • stock-list: 38k symbols, IS survivorship-complete (contains SIVB/FRC/etc.)
//    but unlabeled (no exchange/cap). Cached here; the bias study (04) samples it
//    for delisted in-band names rather than pulling all ~20k candidate histories.

const fs = require('fs');
const path = require('path');
const fmp = require('./lib/fmp');

const DATA_DIR = path.join(__dirname, 'data');
const COMMON = /^[A-Z]{1,5}(-[A-Z])?$/; // US-common shape; drops dotted/foreign/derivatives

(async () => {
  console.log('Building survivor superset + caching the full symbol list…\n');

  // 1) Survivor superset — current US common across a WIDE cap band.
  const scr = await fmp.get('company-screener', {
    marketCapMoreThan: 150_000_000, marketCapLowerThan: 15_000_000_000,
    isEtf: false, isFund: false, country: 'US', limit: 10000,
  });
  const symbols = {};
  for (const r of scr || []) {
    const sym = (r.symbol || '').toUpperCase();
    if (!COMMON.test(sym)) continue;
    symbols[sym] = { source: 'current', name: r.companyName || null,
      exchange: r.exchangeShortName || r.exchange || null,
      sector: r.sector || null, currentMarketCap: r.marketCap ?? null };
  }

  // 2) Cache the full survivorship-complete symbol list (for the 04 bias sample).
  const list = await fmp.get('stock-list', {});
  const allCommon = [...new Set(list.map(r => (r.symbol || '').toUpperCase()).filter(s => COMMON.test(s)))];

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'symbols.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), band: '150M-15B', counts: { survivors: Object.keys(symbols).length }, symbols }, null, 0));
  fs.writeFileSync(path.join(DATA_DIR, 'all-symbols.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), total: list.length, common: allCommon }, null, 0));

  console.log('=== universe ===');
  console.log(`  survivor superset (US common, 150M–15B): ${Object.keys(symbols).length}`);
  console.log(`  full symbol list cached (survivorship-complete): ${allCommon.length} US-common / ${list.length} total`);
  console.log(`  saved → research/data/symbols.json  +  research/data/all-symbols.json`);
})();
