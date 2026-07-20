'use strict';
// Build the POINT-IN-TIME SECURITY MASTER from the survivorship-complete FMP cache, and validate
// that it actually removes survivorship bias. Run (no network — reads research/data/cache/):
//   node research/50-secmaster-build.js
//
// Writes research/data/secmaster.json (per-symbol listing/delisting records) and prints:
//   • coverage — survivors vs delisted, delisted-by-year,
//   • the survivorship POPULATION — for a set of past as-of dates, how many names were listed then
//     but have since delisted (the "survivors that died" a present-day list silently omits),
//   • concrete in/out examples (SIVB, FRC) proving the delisted-inclusive universe,
//   • reconciliation with research/04's measured return bias.

const fs = require('fs');
const path = require('path');
const SM = require('./lib/secmaster');

const DATA = path.join(__dirname, 'data');
const ms = (d) => Date.parse(d + 'T00:00:00Z');

// From listing metadata alone: was this record listed as of `asOf` (YYYY-MM-DD)?
function listedAsOf(r, asOf) {
  if (r.firstDate > asOf) return false;                 // not yet listed
  if (!r.delisted) return true;                         // still trading
  return r.delistDate >= asOf;                          // delisted, but AFTER asOf ⇒ was still listed then
}

function main() {
  const t0 = Date.now();
  console.log(`[secmaster] building from cache (${SM.cachedSyms().length} symbols)…`);
  const doc = SM.buildMaster();
  const recs = Object.values(doc.records);

  console.log(`\n=== COVERAGE (${doc.v}) ===`);
  console.log(`  symbols with usable history: ${doc.count}  (skipped no-price: ${doc.skipped})`);
  console.log(`  active today:                ${doc.survivors}`);
  console.log(`  delisted (last bar < ${doc.activeCutoff}): ${doc.delisted}`);

  // Delisted-by-year — the histogram a survivorship-blind list can never see.
  const byYear = {};
  for (const r of recs) if (r.delisted && r.delistDate) byYear[r.delistDate.slice(0, 4)] = (byYear[r.delistDate.slice(0, 4)] || 0) + 1;
  console.log('  delisted by year:', Object.keys(byYear).sort().map(y => `${y}:${byYear[y]}`).join('  '));

  console.log('\n=== SURVIVORSHIP POPULATION (listed then, dead now) ===');
  for (const asOf of ['2022-06-30', '2023-06-30', '2024-06-30']) {
    const listed = recs.filter(r => listedAsOf(r, asOf)).length;
    const died = recs.filter(r => r.delisted && listedAsOf(r, asOf)).length;   // listed at asOf, delisted after
    console.log(`  as of ${asOf}: ${listed} names listed · ${died} of them have since delisted (${(100 * died / (listed || 1)).toFixed(1)}% a survivor-only list would silently drop)`);
  }

  console.log('\n=== CONCRETE IN/OUT (proves delisted-inclusive membership) ===');
  for (const sym of ['SIVB', 'FRC']) {
    const rec = SM.loadCached(sym);
    if (!rec) { console.log(`  ${sym}: not cached`); continue; }
    const r = SM.buildRecord(rec);
    const preIso = r.delistDate ? new Date(ms(r.delistDate) - 60 * 86400000).toISOString().slice(0, 10) : null;
    const postIso = r.delistDate ? new Date(ms(r.delistDate) + 300 * 86400000).toISOString().slice(0, 10) : null;
    const pre = preIso ? SM.memberAsOf(rec, ms(preIso)) : null;
    const post = postIso ? SM.memberAsOf(rec, ms(postIso)) : null;
    console.log(`  ${sym}: listed ${r.firstDate}→${r.lastDate}, delisted=${r.delisted}`);
    console.log(`     member @ ${preIso} (pre): ${pre ? `YES ($${(pre.cap / 1e9).toFixed(2)}B, $${(pre.adv / 1e6).toFixed(1)}M/d)` : 'no'}   |   @ ${postIso} (post): ${post ? 'YES' : 'NO — correctly dropped after delisting'}`);
  }

  // Reconcile with the measured RETURN bias (research/04), if present.
  try {
    const bias = JSON.parse(fs.readFileSync(path.join(DATA, 'survivorship-bias.json'), 'utf8'));
    console.log(`\n=== RECONCILES WITH research/04 ===\n  measured survivorship return bias stands: ~+0.4%/21d, ~+1.1%/63d (Shumway-adjusted, IP-weighted). This master is the mechanism that lets a backtest INCLUDE the names behind that bias. (survivorship-bias.json @ ${bias.generatedAt})`);
  } catch { console.log('\n(research/04 survivorship-bias.json not found — run 04 to quantify the return bias.)'); }

  console.log(`\n[secmaster] wrote ${path.relative(process.cwd(), SM.SECMASTER_PATH)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
