'use strict';
// Step 62 — PROTOTYPE: enumerate every Form 25 / 25-NSE delisting notice
// 2010→present from the SEC's quarterly full indexes (free, authoritative).
//   node --env-file=research/.env research/62-edgar-form25-enum.js [--from=2010] [--refresh-current]
//
// WHY: the AV adjudication proved EDGAR Form 25 dates are the ground truth
// (124/125 tail cases) while AV's delisting dates are ~21.6% wrong. If this
// enumeration covers the known 2021+ delistings well, the free stack becomes:
//   AV monthly snapshots → MEMBERSHIP;  EDGAR Form-25 enumeration → DELISTINGS
// and the Sharadar purchase stays optional.
//
//   * quarterly form.idx files cached under research/data/edgar-form25/idx-cache/
//     (resumable; past quarters immutable; current quarter refreshable);
//   * Form 25 events per quarter → content-addressed partitions;
//   * validation: coverage of the secmaster's 636 confirmed delistings (CIK
//     join, ±45d on the effective date);
//   * per-year event counts → research/data/edgar-form25-enumeration.json.
//
// SEC fair-use: proper User-Agent, ≤2 req/s here (well under the 10/s cap).

const fs = require('fs');
const path = require('path');
const EI = require('./lib/edgar-index');
const edgar = require('./lib/edgar');

const DATA = path.join(__dirname, 'data');
const DIR = path.join(DATA, 'edgar-form25');
const IDX_CACHE = path.join(DIR, 'idx-cache');
const OUT = path.join(DATA, 'edgar-form25-enumeration.json');
const MASTER_PATH = path.join(DATA, 'secmaster-v3.json');
const THROTTLE_MS = 600;

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  return process.argv.includes(`--${name}`) ? true : dflt;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchIdx(qk, { refresh = false } = {}) {
  const f = path.join(IDX_CACHE, `${qk}.idx`);
  if (!refresh && fs.existsSync(f) && fs.statSync(f).size > 10000) return fs.readFileSync(f, 'utf8');
  const res = await fetch(EI.quarterUrl(qk), { headers: { 'user-agent': edgar.USER_AGENT } });
  if (!res.ok) throw new Error(`form.idx ${qk}: HTTP ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(IDX_CACHE, { recursive: true });
  fs.writeFileSync(f, text);
  await sleep(THROTTLE_MS);
  return text;
}

function knownDelistingsFromMaster() {
  let master; try { master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf8')); } catch { return []; }
  const out = [];
  for (const [sym, rec] of Object.entries(master.records || {})) {
    const d = rec && rec.delisting;
    if (d && d.date) out.push({ symbol: sym, date: d.date, cik: rec.issuer && rec.issuer.cik });
  }
  return out;
}

async function main() {
  const fromYear = Number(arg('from', 2010));
  const now = new Date();
  const toYear = now.getUTCFullYear();
  const toQuarter = Math.floor(now.getUTCMonth() / 3) + 1;
  const quarters = EI.quartersBetween(fromYear, toYear, toQuarter);
  const currentQk = quarters[quarters.length - 1];
  console.log(`enumerating Form 25 across ${quarters.length} quarters (${quarters[0]} → ${currentQk})`);

  const allEvents = [];
  let fetched = 0, cached = 0, failed = 0;
  for (const qk of quarters) {
    const pf = path.join(DIR, `${qk}.json`);
    let part = null;
    if (fs.existsSync(pf) && qk !== currentQk) {
      try { part = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch { part = null; }
      if (part && !EI.partitionValid(part)) part = null;
    }
    if (!part) {
      let text;
      try { text = await fetchIdx(qk, { refresh: qk === currentQk && arg('refresh-current', false) === true }); fetched++; }
      catch (e) { failed++; console.log(`  ${qk}: ${e.message} — skipped (rerun to retry)`); continue; }
      const parsed = EI.parseFormIdx(text);
      if (parsed.error) { failed++; console.log(`  ${qk}: ${parsed.error}`); continue; }
      const { events, amendments } = EI.extractForm25(parsed.rows);
      part = EI.form25Partition({ quarter: qk, events, amendments, retrievedAt: new Date().toISOString() });
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(pf, JSON.stringify(part));
    } else cached++;
    allEvents.push(...part.events);
  }

  const byYear = {};
  for (const e of allEvents) byYear[e.filingDate.slice(0, 4)] = (byYear[e.filingDate.slice(0, 4)] || 0) + 1;
  const uniqueCiks = new Set(allEvents.map((e) => String(Number(e.cik)))).size;
  const known = knownDelistingsFromMaster();
  const coverage = EI.coverageVsKnownDelistings(allEvents, known);

  const report = {
    schema: 'EdgarForm25Enumeration', version: EI.EDGAR_FORM25_VERSION,
    generatedAt: new Date().toISOString(),
    quarters: quarters.length, fetched, cached, failed,
    totalForm25Events: allEvents.length, uniqueCiks,
    eventsByYear: byYear,
    validationVsSecmaster: coverage,
    identifiedGaps: [
      'CIK→ticker mapping at filing time is unresolved for the pre-secmaster era (join via AV membership snapshots by name/period, or the filing header, is the next build step)',
      'Form 25 covers exchange delistings; issuers drifting to OTC without a Form 25 (rare for exchange-listed common stock) would be missed — measure via membership-disappearance cross-check',
      'delisting REASON still needs the existing 8-K classification pass (research/lib/edgar.js) per CIK',
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`Form 25 events: ${allEvents.length} across ${uniqueCiks} CIKs (${fetched} quarters fetched, ${cached} cached, ${failed} failed)`);
  console.log('by year:', JSON.stringify(byYear));
  console.log(`validation vs secmaster known delistings: ${coverage.covered}/${coverage.knownWithCik} covered (${coverage.coverageFraction}) within ±${coverage.tolDays}d`);
  console.log(`report → ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
