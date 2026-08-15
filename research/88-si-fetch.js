'use strict';
// Step 88 — download FINRA CONSOLIDATED SHORT INTEREST (full field set, every semi-monthly
// settlement cycle) for the options-liquid experiment universe, as append-only deterministic
// snapshots for the OMEGA_SI_LEVEL_5D_TOP10 shadow experiment.
//
//   node research/88-si-fetch.js [--from 2021-06-01] [--to 2026-12-31]
//
// One snapshot file per settlement date: research/data/short-interest-full/<date>.json
//   { settlementDate, fetchedAt, source, sourceHash, universe, coverage, rows: [raw FINRA rows] }
//
// APPEND-ONLY: an existing snapshot is NEVER overwritten. If a re-fetch of an existing
// settlement date returns a different sourceHash, the new payload is written alongside as
// <date>.rev<N>.json — the originally observed version stays authoritative for joins,
// which is what makes revisions honest instead of silent history rewrites.
//
// Everything retrospective is revision-risky by construction (FINRA may already have
// revised what we download today; the original print is unrecoverable), so snapshots
// carry revisionRisk:true unless fetched prospectively inside the publication window.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const SI = require('../lib/research/finra-si');
const { LIQUID_OPTIONS } = require('../lib/optionsflow');

const OUT_DIR = path.join(K.DATA_DIR, 'short-interest-full');
const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'GLD', 'SLV', 'TLT', 'SMH']);
const UNIVERSE = LIQUID_OPTIONS.filter((t) => !ETFS.has(t));
const BATCH = 40;               // domainFilters symbol batch size — small, well under any server cap
const RATE_LIMIT_MS = 300;

const args = Object.fromEntries(process.argv.slice(2).map((a, i, x) => (a.startsWith('--') ? [a.slice(2), x[i + 1]] : null)).filter(Boolean));
const FROM = args.from || '2021-06-01';
const TO = args.to || new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enumerateSettlements() {
  // AAPL exists across the whole window → its settlement dates enumerate the schedule.
  const { rows } = await SI.fetchSiPage({
    settlementDate: null, symbols: null, limit: 500,
    // fetchSiPage builds an EQUAL filter from settlementDate; enumeration needs a range
    // instead, so call the endpoint directly here with the same retry client via a shim.
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const shim = {
        limit: 500, fields: ['settlementDate'],
        compareFilters: [{ fieldName: 'symbolCode', fieldValue: 'AAPL', compareType: 'equal' }],
        dateRangeFilters: [{ fieldName: 'settlementDate', startDate: FROM, endDate: TO }],
      };
      void body;
      return fetch(url, { ...init, body: JSON.stringify(shim) });
    },
  });
  return [...new Set(rows.map((r) => r.settlementDate))].filter(Boolean).sort();
}

async function fetchOneSettlement(date) {
  const rows = [];
  const hashes = [];
  for (let i = 0; i < UNIVERSE.length; i += BATCH) {
    const batch = UNIVERSE.slice(i, i + BATCH);
    const res = await SI.fetchSettlementRows({ settlementDate: date, symbols: batch, rateLimitMs: RATE_LIMIT_MS });
    rows.push(...res.rows);
    hashes.push(res.sourceHash);
    await sleep(RATE_LIMIT_MS);
  }
  return { rows, sourceHash: SI.sourceHash(hashes.join('|')) };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const settlements = await enumerateSettlements();
  console.log(`${settlements.length} settlement cycles ${FROM}..${TO}; universe ${UNIVERSE.length} symbols`);
  const report = { fetched: 0, skippedExisting: 0, revisions: 0, failures: [] };
  for (const date of settlements) {
    const file = path.join(OUT_DIR, `${date}.json`);
    const exists = fs.existsSync(file);
    if (exists && !args.recheck) { report.skippedExisting++; continue; }
    try {
      const { rows, sourceHash } = await fetchOneSettlement(date);
      const bySym = new Set(rows.map((r) => SI.normalizeSymbol(r.symbolCode)).filter(Boolean));
      const snapshot = {
        settlementDate: date,
        fetchedAt: new Date().toISOString(),
        source: 'finra:consolidatedShortInterest',
        availabilityMethod: 'conservative_13d_fallback',
        revisionRisk: true,      // retrospective download — the original print may be unrecoverable
        sourceHash,
        universe: UNIVERSE.length,
        coverage: { returned: rows.length, distinctSymbols: bySym.size, missing: UNIVERSE.filter((t) => !bySym.has(t)) },
        rows,
      };
      if (exists) {
        const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (prior.sourceHash === sourceHash) { report.skippedExisting++; continue; }
        let n = 1;
        while (fs.existsSync(path.join(OUT_DIR, `${date}.rev${n}.json`))) n++;
        fs.writeFileSync(path.join(OUT_DIR, `${date}.rev${n}.json`), JSON.stringify(snapshot));
        report.revisions++;
        console.log(`  ${date}: REVISION rev${n} (${rows.length} rows)`);
        continue;
      }
      fs.writeFileSync(file, JSON.stringify(snapshot));
      report.fetched++;
      console.log(`  ${date}: ${rows.length} rows, ${bySym.size}/${UNIVERSE.length} symbols${snapshot.coverage.missing.length ? ` (missing ${snapshot.coverage.missing.join(',')})` : ''}`);
    } catch (e) {
      // Partial failure degrades safely: nothing was written for this date, prior
      // snapshots are untouched, and the gap is REPORTED instead of papered over.
      report.failures.push({ date, error: e.message });
      console.log(`  ${date}: FAILED ${e.message}`);
    }
    await sleep(RATE_LIMIT_MS);
  }
  console.log(JSON.stringify({ settlements: settlements.length, ...report }, null, 2));
  return report;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, UNIVERSE, OUT_DIR };
