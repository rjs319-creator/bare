'use strict';
// Step 54 — corporate-action cache builder for the panel universe.
//   node --env-file=research/.env research/54-corpactions-fetch.js [--limit N]
//
// For every symbols.json member with a price cache, fetches FMP `splits` and
// `dividends` (stable API) and writes research/data/corpactions/<SYM>.json:
//   { sym, splits, dividends, retrievedAt, source }
//
// Resumable: symbols with an existing cache file are skipped. An EMPTY splits
// or dividends array is a legitimate observation ("vendor reports none") and IS
// cached; a request that errors after retries writes NOTHING, so failures are
// visibly missing (fail closed downstream: no provenance → row excluded), and
// the next run retries them.

const fs = require('fs');
const path = require('path');
const fmp = require('./lib/fmp');

const DATA = path.join(__dirname, 'data');
const OUT_DIR = path.join(DATA, 'corpactions');
const CACHE = path.join(DATA, 'cache');

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
  const symbols = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols).sort();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let done = 0, skipped = 0, failed = 0, fetched = 0;
  for (const sym of symbols) {
    if (fetched >= limit) break;
    const outPath = path.join(OUT_DIR, `${sym}.json`);
    if (fs.existsSync(outPath)) { skipped++; continue; }
    if (!fs.existsSync(path.join(CACHE, `${sym}.json`))) { skipped++; continue; }
    try {
      const [splits, dividends] = [
        await fmp.get('splits', { symbol: sym }).catch((e) => { throw new Error(`splits:${e.message}`); }),
        await fmp.get('dividends', { symbol: sym }).catch((e) => { throw new Error(`dividends:${e.message}`); }),
      ];
      if (!Array.isArray(splits) || !Array.isArray(dividends)) throw new Error('non-array response');
      fs.writeFileSync(outPath, JSON.stringify({
        sym, splits, dividends,
        retrievedAt: new Date().toISOString(),
        source: 'fmp-stable:splits+dividends',
      }));
      fetched++;
    } catch (e) {
      failed++;
      if (failed <= 20) console.error(`FAIL ${sym}: ${String(e.message).slice(0, 100)}`);
    }
    if (++done % 200 === 0) console.log(`progress: ${done} visited, ${fetched} fetched, ${skipped} skipped, ${failed} failed`);
  }
  console.log(`corpactions fetch complete: ${fetched} fetched, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();
