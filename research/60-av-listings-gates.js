'use strict';
// Step 60 — validation gates for the Alpha Vantage listing-universe snapshots.
//   node research/60-av-listings-gates.js
//
// Decides whether the AV feed may EVER be cited by the survivorship contract.
// Runs on whatever partitions exist (gates without enough data report
// insufficient-data — the verdict stays ACCRUING, never a free pass), writes
// research/data/av-listings-gates.json, and prints the verdict:
//   ACCRUING | FAILED | CANDIDATE_AUTHORITATIVE
// Even CANDIDATE_AUTHORITATIVE changes nothing by itself — adopting the source
// in lib/research/survivorship.js is a separate, reviewed code change.

const fs = require('fs');
const path = require('path');
const AV = require('./lib/av-listings');

const DATA = path.join(__dirname, 'data');
const DIR = path.join(DATA, 'av-listings');
const OUT = path.join(DATA, 'av-listings-gates.json');
const MASTER_PATH = path.join(DATA, 'secmaster-v3.json');

// The independently verified rename chains from identity-v3 (panel-v3 era).
const RENAME_CHECKS = [
  { old: 'CDAY', new: 'DAY' }, { old: 'SGMS', new: 'LNW' }, { old: 'RLGY', new: 'HOUS' },
  { old: 'SCHN', new: 'RDUS' }, { old: 'AMSWA', new: 'LGTY' }, { old: 'CINR', new: 'SIRE' },
];

const loadPartition = (key) => {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(DIR, `${key}.json`), 'utf8'));
    return AV.partitionValid(doc) ? doc : null;
  } catch { return null; }
};

function knownDelistingsFromMaster() {
  let master; try { master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf8')); } catch { return []; }
  const out = [];
  for (const [sym, rec] of Object.entries(master.records || {})) {
    const d = rec && rec.delisting;
    if (d && d.date) out.push({ symbol: sym, date: d.date });
  }
  return out;
}

function main() {
  if (!fs.existsSync(DIR)) {
    console.log('no snapshots collected yet — run research/59-av-listings-fetch.js first (needs ALPHAVANTAGE_API_KEY).');
    process.exitCode = 0;
    return;
  }
  const latestActive = loadPartition('latest-active');
  const latestDelisted = loadPartition('latest-delisted');

  // Monthly active snapshots → membership counts + consistency sample.
  const countsByYm = {};
  const monthlySnapshots = [];
  for (const f of fs.readdirSync(DIR)) {
    const m = f.match(/^active-(\d{4}-\d{2})\.json$/);
    if (!m) continue;
    const doc = loadPartition(`active-${m[1]}`);
    if (!doc) continue;
    countsByYm[m[1]] = doc.records.filter(AV.isCommonStock).length;
    if (monthlySnapshots.length < 24) monthlySnapshots.push(doc);   // bounded sample for the consistency scan
  }

  const gates = [
    AV.gateDelistingReconciliation(latestDelisted && latestDelisted.records, knownDelistingsFromMaster()),
    AV.gateMembershipSanity(countsByYm),
    AV.gateInternalConsistency(monthlySnapshots, latestDelisted && latestDelisted.records),
    AV.gateRenameSpotChecks(latestActive && latestActive.records, latestDelisted && latestDelisted.records, RENAME_CHECKS),
  ];
  const verdict = AV.gatesVerdict(gates);

  const report = {
    schema: 'AvListingsGatesReport', version: AV.AV_LISTINGS_VERSION,
    generatedAt: new Date().toISOString(),
    snapshotsOnDisk: { latestActive: !!latestActive, latestDelisted: !!latestDelisted, monthlyActive: Object.keys(countsByYm).length },
    gates, ...verdict,
    adoptionNote: 'CANDIDATE_AUTHORITATIVE does not change survivorship status by itself; citing this source in lib/research/survivorship.js is a reviewed code change, and proven-safe additionally requires the measured coverage gates.',
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`verdict: ${verdict.verdict} — ${verdict.reason}`);
  for (const g of gates) console.log(`  ${g.gate}: ${g.status}`);
  console.log(`report → ${path.relative(process.cwd(), OUT)}`);
}

main();
