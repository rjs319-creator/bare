'use strict';
// Phase-0 connectivity + endpoint discovery. Run:
//   node --env-file=research/.env research/01-connectivity.js
//
// Confirms the local key works end-to-end (delisted enumeration + price + shares
// for a survivor AND a delisted name) and DISCOVERS which current in-band symbol
// list endpoint is available on Starter — so the universe builder is only ever
// written against endpoints we've actually seen return 200.

const fmp = require('./lib/fmp');

const ok = s => `\x1b[32m${s}\x1b[0m`;
const bad = s => `\x1b[31m${s}\x1b[0m`;

async function tryGet(label, path, params) {
  try {
    const b = await fmp.get(path, params);
    const n = Array.isArray(b) ? b.length : (b && typeof b === 'object' ? Object.keys(b).length : 0);
    const sample = Array.isArray(b) && b[0] ? Object.keys(b[0]).slice(0, 8).join(',') : '';
    console.log(`  ${ok('OK ')} ${label.padEnd(34)} n=${String(n).padStart(5)}  fields: ${sample}`);
    return b;
  } catch (e) {
    console.log(`  ${bad('FAIL')} ${label.padEnd(34)} ${String(e.message).slice(0, 90)}`);
    return null;
  }
}

(async () => {
  console.log('\n=== 1. Verified core (must all pass) ===');
  const del = await tryGet('delisted-companies (page 0)', 'delisted-companies', { page: 0 });
  for (const sym of ['AAPL', 'SIVB']) {
    try {
      const px = await fmp.priceHistory(sym);
      const inc = await fmp.incomeQuarterly(sym, 8);
      const shares = inc && inc[0] ? inc[0].weightedAverageShsOut : null;
      console.log(`  ${ok('OK ')} ${sym.padEnd(34)} ${px.length} bars (${px.at(-1)?.date}..${px[0]?.date}), shares=${shares}`);
    } catch (e) { console.log(`  ${bad('FAIL')} ${sym.padEnd(34)} ${String(e.message).slice(0, 90)}`); }
  }

  console.log('\n=== 2. Current in-band list — DISCOVERY (need exactly one winner) ===');
  // The cap band the mandate wants: $300M–$10B, US common stock, ETFs/funds out.
  await tryGet('company-screener (cap-banded)', 'company-screener', {
    marketCapMoreThan: 300000000, marketCapLowerThan: 10000000000,
    isEtf: false, isFund: false, country: 'US', limit: 50,
  });
  await tryGet('stock-list', 'stock-list', {});
  await tryGet('available-exchange-symbols (NASDAQ)', 'available-exchange-symbols', { exchange: 'NASDAQ' });

  console.log('\n=== summary ===');
  console.log(`  delisted enumeration: ${del ? ok('available') : bad('BLOCKED')}`);
  console.log('  → pick the current-list winner above for the universe builder (step 02).\n');
})();
