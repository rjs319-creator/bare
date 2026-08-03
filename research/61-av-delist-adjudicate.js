'use strict';
// Step 61 — EDGAR adjudication of the AV↔secmaster delisting-date
// reconciliation tail.
//   node research/61-av-delist-adjudicate.js
//
// For EVERY matched symbol whose AV delisting date and secmaster date disagree
// beyond the documented ±21d convention window (AV = last trading day,
// secmaster = Form-25 effective date = filing + 10), pull the authoritative
// SEC filings (Form 25 / Form 15, via the existing cached EDGAR fetcher) and
// decide WHO the authoritative record supports:
//   av-consistent | secmaster-consistent | both-consistent |
//   edgar-disagrees-with-both | no-edgar-evidence (fails closed against AV)
// A CONTROL group of within-convention symbols is adjudicated too, to prove
// the method itself behaves (controls should be overwhelmingly consistent).
//
// Output: research/data/av-delist-adjudication.json — consumed by
// research/60-av-listings-gates.js (tail symbols adjudicated av-consistent
// stop counting against AV; everything else still does).

const fs = require('fs');
const path = require('path');
const AV = require('./lib/av-listings');
const edgar = require('./lib/edgar');

const DATA = path.join(__dirname, 'data');
const DIR = path.join(DATA, 'av-listings');
const OUT = path.join(DATA, 'av-delist-adjudication.json');
const MASTER_PATH = path.join(DATA, 'secmaster-v3.json');
const EDGAR_CACHE = path.join(DATA, 'secmaster-v3-cache');
const CONVENTION_DAYS = 21;
const CONTROL_COUNT = 15;

const loadPartition = (key) => {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(DIR, `${key}.json`), 'utf8'));
    return AV.partitionValid(doc) ? doc : null;
  } catch { return null; }
};

async function main() {
  const latestDelisted = loadPartition('latest-delisted');
  if (!latestDelisted) { console.log('BLOCKED: latest-delisted snapshot missing — run research/59-av-listings-fetch.js first.'); process.exitCode = 1; return; }
  const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf8'));

  const avBySym = new Map(latestDelisted.records.filter((r) => r.delistingDate).map((r) => [r.symbol, r.delistingDate]));
  const matched = [];
  for (const [sym, rec] of Object.entries(master.records || {})) {
    const d = rec && rec.delisting;
    if (!d || !d.date || !avBySym.has(sym)) continue;
    const signed = Math.round((Date.parse(d.date) - Date.parse(avBySym.get(sym))) / 86400000);
    matched.push({ symbol: sym, known: d.date, av: avBySym.get(sym), diffDays: signed, cik: rec.issuer && rec.issuer.cik });
  }
  const tail = matched.filter((m) => Math.abs(m.diffDays) > CONVENTION_DAYS).sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  const within = matched.filter((m) => Math.abs(m.diffDays) <= CONVENTION_DAYS).sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  // Deterministic control sample: every k-th within-convention symbol.
  const stride = Math.max(1, Math.floor(within.length / CONTROL_COUNT));
  const controls = within.filter((_, i) => i % stride === 0).slice(0, CONTROL_COUNT);
  console.log(`matched ${matched.length}; tail beyond ±${CONVENTION_DAYS}d: ${tail.length}; adjudicating tail (all) + ${controls.length} controls`);

  const fetcher = edgar.makeEdgarFetcher(EDGAR_CACHE);
  const adjudicate = async (m, group) => {
    if (!m.cik) return { symbol: m.symbol, group, verdict: 'no-cik', avConsistent: false, diffDays: m.diffDays };
    let doc;
    try { doc = await fetcher.submissionsFor(m.cik); }
    catch (e) { return { symbol: m.symbol, group, verdict: `edgar-fetch-failed:${String(e.message).slice(0, 60)}`, avConsistent: false, diffDays: m.diffDays }; }
    if (doc.notFound) return { symbol: m.symbol, group, verdict: 'no-edgar-evidence', avConsistent: false, diffDays: m.diffDays };
    const ev = edgar.extractDelistingEvidence(doc.submissions);
    const res = AV.adjudicateDelistingCase({
      symbol: m.symbol, avDate: m.av, knownDate: m.known,
      form25FilingDate: ev.form25 && ev.form25.filingDate,
      form15FilingDate: ev.form15 && ev.form15.filingDate,
    });
    return { ...res, group, diffDays: m.diffDays };
  };

  const results = [];
  for (const m of tail) results.push(await adjudicate(m, 'tail'));
  for (const m of controls) results.push(await adjudicate(m, 'control'));

  const count = (group, pred) => results.filter((r) => r.group === group && pred(r)).length;
  const tallies = (group) => ({
    total: results.filter((r) => r.group === group).length,
    avConsistent: count(group, (r) => r.avConsistent === true),
    secmasterConsistent: count(group, (r) => r.verdict === 'secmaster-consistent'),
    bothConsistent: count(group, (r) => r.verdict === 'both-consistent'),
    edgarDisagreesWithBoth: count(group, (r) => r.verdict === 'edgar-disagrees-with-both'),
    noEvidence: count(group, (r) => ['no-edgar-evidence', 'no-cik'].includes(r.verdict) || /fetch-failed/.test(r.verdict)),
  });
  const tailTally = tallies('tail');
  const controlTally = tallies('control');
  const controlSane = controlTally.total > 0
    && (controlTally.avConsistent + controlTally.bothConsistent + controlTally.secmasterConsistent) / controlTally.total >= 0.8;

  const artifact = {
    schema: 'AvDelistAdjudication', version: AV.AV_LISTINGS_VERSION,
    generatedAt: new Date().toISOString(),
    conventionDays: CONVENTION_DAYS,
    matched: matched.length, tailCount: tail.length,
    tail: tailTally, control: controlTally,
    controlMethodSane: controlSane,
    // The gate consumes this list: tail symbols where EDGAR sides WITH AV.
    avConsistentSymbols: results.filter((r) => r.group === 'tail' && r.avConsistent === true).map((r) => r.symbol),
    results,
    note: 'no-edgar-evidence and fetch failures count AGAINST AV (fail closed); controls validate the method, not AV',
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(`tail:    ${JSON.stringify(tailTally)}`);
  console.log(`control: ${JSON.stringify(controlTally)} (method sane: ${controlSane})`);
  console.log(`artifact → ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
