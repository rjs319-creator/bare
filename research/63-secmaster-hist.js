'use strict';
// Step 63 — build the PARTIAL historical security master (secmaster-hist-v0.1)
// from everything collected so far.
//   node --env-file=research/.env research/63-secmaster-hist.js
//
// Sources (each already validated or provenance-tagged):
//   * research/data/edgar-form25/ — the complete Form-25 enumeration (dates);
//   * research/data/secmaster-v3.json — verified 2021+ era (ticker joins);
//   * EDGAR company_tickers.json — current official CIK→ticker (cached);
//   * research/data/secmaster-v3-cache/edgar/ — cached submissions (tickers);
//   * research/data/av-listings/ — latest active+delisted (names for the join)
//     and however many monthly membership snapshots exist TODAY.
//
// Output: research/data/secmaster-hist.json (+ coverage report), explicitly
// PARTIAL: membership fills as the AV daily job accrues; delisting reasons
// await the 8-K classification pass; nothing here touches survivorship status.

const fs = require('fs');
const path = require('path');
const SH = require('./lib/secmaster-hist');
const AV = require('./lib/av-listings');
const EI = require('./lib/edgar-index');
const edgar = require('./lib/edgar');

const DATA = path.join(__dirname, 'data');
const F25_DIR = path.join(DATA, 'edgar-form25');
const AV_DIR = path.join(DATA, 'av-listings');
const EDGAR_SUBS = path.join(DATA, 'secmaster-v3-cache', 'edgar');
const TICKERS_CACHE = path.join(F25_DIR, 'company_tickers.json');
const OUT = path.join(DATA, 'secmaster-hist.json');
const COV_OUT = path.join(DATA, 'secmaster-hist-coverage.json');

const loadJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

async function companyTickers() {
  const cached = loadJson(TICKERS_CACHE);
  if (cached && cached.payload) return cached.payload;
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'user-agent': edgar.USER_AGENT } });
  if (!res.ok) throw new Error(`company_tickers.json HTTP ${res.status}`);
  const body = await res.json();
  const payload = Object.values(body).map((r) => ({ cik: r.cik_str, ticker: r.ticker }));
  fs.writeFileSync(TICKERS_CACHE, JSON.stringify({ retrievedAt: new Date().toISOString(), payload }));
  return payload;
}

function loadForm25Events() {
  const events = [];
  for (const f of fs.readdirSync(F25_DIR)) {
    if (!/^\d{4}-Q\d\.json$/.test(f)) continue;
    const doc = loadJson(path.join(F25_DIR, f));
    if (doc && EI.partitionValid(doc)) events.push(...doc.events);
  }
  return events;
}

function loadAv() {
  const part = (k) => {
    const doc = loadJson(path.join(AV_DIR, `${k}.json`));
    return doc && AV.partitionValid(doc) ? doc : null;
  };
  const la = part('latest-active'), ld = part('latest-delisted');
  // The name-join pool includes the MONTHLY snapshots: they carry
  // CONTEMPORANEOUS symbol+name pairs — the only source that can name
  // companies delisted a decade before today's mappings existed. The pool
  // grows (and old-era mapping coverage rises) as the daily accrual runs.
  const seen = new Set();
  const avRecords = [];
  const addRecords = (records) => {
    for (const r of records || []) {
      const k = `${r.symbol}|${r.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      avRecords.push(r);
    }
  };
  addRecords(la && la.records);
  addRecords(ld && ld.records);
  const monthlyMembership = {};
  if (fs.existsSync(AV_DIR)) {
    for (const f of fs.readdirSync(AV_DIR)) {
      const m = f.match(/^active-(\d{4}-\d{2})\.json$/);
      if (!m) continue;
      const doc = part(`active-${m[1]}`);
      if (doc) {
        monthlyMembership[m[1]] = new Set(doc.records.filter(AV.isCommonStock).map((r) => r.symbol));
        addRecords(doc.records);
      }
    }
  }
  return { avRecords, monthlyMembership };
}

function loadSubmissionsTickers() {
  const out = [];
  if (!fs.existsSync(EDGAR_SUBS)) return out;
  for (const f of fs.readdirSync(EDGAR_SUBS)) {
    const m = f.match(/^CIK(\d+)\.json$/);
    if (!m) continue;
    const doc = loadJson(path.join(EDGAR_SUBS, f));
    const t = doc && doc.submissions && doc.submissions.tickers;
    if (Array.isArray(t) && t.length) out.push({ cik: m[1], tickers: t });
  }
  return out;
}

async function main() {
  const form25Events = loadForm25Events();
  if (!form25Events.length) { console.error('BLOCKED: no Form-25 partitions — run research/62-edgar-form25-enum.js first'); process.exitCode = 1; return; }
  const master = loadJson(path.join(DATA, 'secmaster-v3.json'));
  const { avRecords, monthlyMembership } = loadAv();
  const ct = await companyTickers();
  const subs = loadSubmissionsTickers();
  console.log(`inputs: ${form25Events.length} Form-25 events, ${ct.length} official ticker rows, ${subs.length} cached submissions with tickers, ${avRecords.length} AV records, ${Object.keys(monthlyMembership).length} membership months`);

  const tickerMap = SH.buildTickerMap({
    secmasterRecords: (master && master.records) || {},
    companyTickers: ct,
    submissionsTickers: subs,
    avRecords,
    form25Events,
  });
  const hist = SH.assembleHistMaster({ form25Events, tickerMap, monthlyMembership });

  // Consistency check vs the verified 2021+ secmaster (should track the 96.1%
  // enumeration validation by construction — recompute, never assume).
  let overlap = { known: 0, sameDateWithin45d: 0 };
  if (master) {
    for (const [sym, rec] of Object.entries(master.records || {})) {
      const d = rec && rec.delisting;
      const cik = rec && rec.issuer && rec.issuer.cik;
      if (!d || !d.date || !cik) continue;
      const h = hist.records[SH.normCik(cik)];
      if (!h) continue;
      overlap.known++;
      if (Math.abs(Date.parse(h.delisting.date) - Date.parse(d.date)) / 86400000 <= 45) overlap.sameDateWithin45d++;
    }
    overlap.agreementFraction = overlap.known ? +(overlap.sameDateWithin45d / overlap.known).toFixed(4) : null;
  }

  // MEMBERSHIP-SOURCE AUDIT (the decisive check, recomputed every build):
  // a name Form 25 proves was listed until year Y must appear in ACTIVE
  // snapshots from the years just before Y. Low presence ⇒ the snapshot
  // source is itself survivorship-biased and CANNOT be the membership leg.
  const snapshotYms = Object.keys(monthlyMembership).sort();
  const namePool = new Set();
  for (const r of avRecords) if (r.assetType === 'Stock') namePool.add(SH.normalizeCompanyName(r.name));
  const membershipSourceAudit = { snapshotWindow: snapshotYms.length ? `${snapshotYms[0]}..${snapshotYms[snapshotYms.length - 1]}` : null, byDelistingYear: {} };
  if (snapshotYms.length) {
    const lastYear = Number(snapshotYms[snapshotYms.length - 1].slice(0, 4));
    for (let y = lastYear + 1; y <= lastYear + 3; y++) {
      const cands = Object.values(hist.records).filter((r) => r.delisting.date.slice(0, 4) === String(y));
      if (!cands.length) continue;
      const present = cands.filter((r) => r.names.some((n) => namePool.has(SH.normalizeCompanyName(n)))).length;
      membershipSourceAudit.byDelistingYear[y] = { form25Ciks: cands.length, namedInSnapshots: present, fraction: +(present / cands.length).toFixed(3) };
    }
  }

  const coverage = {
    schema: 'HistoricalSecmasterCoverage', version: SH.SECMASTER_HIST_VERSION,
    generatedAt: new Date().toISOString(),
    contentHash: hist.contentHash,
    ...hist.coverage,
    ambiguousNameJoins: tickerMap.ambiguities.length,
    membershipStatus: `PARTIAL: ${hist.coverage.membershipMonthsAvailable} monthly snapshots collected (target ~200; AV daily job accruing)`,
    overlapVsSecmasterV3: overlap,
    membershipSourceAudit,
    finding: '2026-08-03 audits: (1) soon-to-die names (Form-25 delistings 2011-2014) appear in AV 2010-2011 active snapshots at only 15-31% — AV old-era snapshots are SURVIVORSHIP-BIASED AT THE SOURCE; (2) Wayback NasdaqTrader symbol directories are too sparse for monthly membership (23+7 snapshots 2009-2016, none in 2010); (3) FMP serves ZERO price bars for 2012-2014 delisted names (BYI/OMX/DOLE probed) — dead-name PRICES for the old era have NO available source in the current stack. CONSEQUENCE: the free path covers delisting events/dates only; a survivorship-free historical PRICE+membership vendor (e.g. Sharadar SEP) is required for any 2010-2015 panel.',
    nextSteps: [
      'Era-A (2010-2021) panel requires a survivorship-free price+membership vendor — Sharadar SEP (research/SHARADAR-INTEGRATION-PLAN-2026-08.md) now solves ALL remaining legs (dead-name prices, membership by observation, permaticker identity) in one purchase; nothing free covers dead-name prices',
      'the free assets stand regardless: Form-25 event record (validated 96.1%) + this CIK spine become the cross-validation harness for ANY purchased feed',
      'delisting reasons: 8-K classification pass over Form-25 CIKs (research/lib/edgar.js, ~90min of throttled fetches)',
      'AV daily accrual continues (recent-era membership + cross-checks only)',
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(hist));
  fs.writeFileSync(COV_OUT, JSON.stringify(coverage, null, 2));
  console.log(`records: ${hist.coverage.form25Ciks} CIKs; ticker-mapped ${hist.coverage.tickerMapped} (${(hist.coverage.tickerMappedFraction * 100).toFixed(1)}%) by ${JSON.stringify(hist.coverage.bySource)}; unmapped ${hist.coverage.unmapped}; ambiguous ${tickerMap.ambiguities.length}`);
  console.log(`membership observed for ${hist.coverage.withMembershipObserved} records over ${hist.coverage.membershipMonthsAvailable} partial months`);
  console.log(`overlap vs secmaster-v3: ${overlap.sameDateWithin45d}/${overlap.known} (${overlap.agreementFraction})`);
  console.log(`→ ${path.relative(process.cwd(), OUT)} (hash ${hist.contentHash.slice(0, 16)}…), coverage → ${path.relative(process.cwd(), COV_OUT)}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
