'use strict';
// Step 64 — 8-K REASON CLASSIFICATION over the Form-25 CIK spine.
//   node --env-file=research/.env research/64-form25-reasons.js [--limit=N]
//
// For every CIK in secmaster-hist, pull its EDGAR submissions (cached,
// 170ms-paced — the same fetcher/cache the v3 secmaster used) and classify
// the delisting reason with the EXISTING evidence logic
// (research/lib/edgar.js): an 8-K item 1.03 in the window around the Form 25
// ⇒ bankruptcy-like; item 2.01 near it ⇒ acquisition/merger completion;
// otherwise the reason stays honestly null (fwd-outcome-v3 then fails closed
// on unknown, exactly as designed).
//
// Output: research/data/form25-reasons.json (cik → {reasonCategory, reason,
// evidence}); research/63-secmaster-hist.js merges it on its next build.
// Resumable: submissions are cached per CIK, so reruns only fetch what's new.

const fs = require('fs');
const path = require('path');
const edgar = require('./lib/edgar');

const DATA = path.join(__dirname, 'data');
const HIST_PATH = path.join(DATA, 'secmaster-hist.json');
const EDGAR_CACHE = path.join(DATA, 'secmaster-v3-cache');
const OUT = path.join(DATA, 'form25-reasons.json');

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};

async function main() {
  const hist = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'));
  const prior = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')).reasons || {}; } catch { return {}; } })();
  const ciks = Object.keys(hist.records).filter((c) => !prior[c]);
  const limit = arg('limit', Infinity);
  console.log(`classifying reasons for ${Math.min(ciks.length, limit)} of ${Object.keys(hist.records).length} CIKs (${Object.keys(prior).length} already done; submissions cache-paced at 170ms)`);

  const fetcher = edgar.makeEdgarFetcher(EDGAR_CACHE);
  const reasons = { ...prior };
  const stats = { looked: 0, notFound: 0, classified: 0, anchorless: 0, errors: 0 };
  let done = 0;
  for (const cik of ciks) {
    if (done >= limit) break;
    done++;
    try {
      const doc = await fetcher.submissionsFor(cik);
      stats.looked++;
      if (doc.notFound) { stats.notFound++; reasons[cik] = { reasonCategory: null, note: 'cik-not-found' }; continue; }
      const ev = edgar.extractDelistingEvidence(doc.submissions);
      const derived = edgar.deriveDelisting(ev, doc.retrievedAt);
      if (derived && derived.reasonCategory) {
        stats.classified++;
        reasons[cik] = { reasonCategory: derived.reasonCategory, reason: derived.reason || null, evidence: derived.evidence || null };
      } else {
        stats.anchorless++;
        reasons[cik] = { reasonCategory: null, note: derived ? 'no-8k-classification' : 'no-form25-in-recent-window' };
      }
    } catch (e) {
      stats.errors++;
      reasons[cik] = { reasonCategory: null, note: `error:${String(e.message).slice(0, 60)}` };
    }
    if (done % 500 === 0) {
      fs.writeFileSync(OUT, JSON.stringify({ schema: 'Form25Reasons', generatedAt: new Date().toISOString(), stats, reasons }));
      console.log(`  ${done}/${Math.min(ciks.length, limit)} (classified ${stats.classified}, unclassified ${stats.anchorless + stats.notFound}, errors ${stats.errors})`);
    }
  }
  const byCategory = {};
  for (const r of Object.values(reasons)) if (r.reasonCategory) byCategory[r.reasonCategory] = (byCategory[r.reasonCategory] || 0) + 1;
  fs.writeFileSync(OUT, JSON.stringify({ schema: 'Form25Reasons', generatedAt: new Date().toISOString(), stats, byCategory, reasons }));
  console.log(`done: ${Object.keys(reasons).length} CIKs recorded; classified by category: ${JSON.stringify(byCategory)}`);
  console.log(`stats: ${JSON.stringify(stats)}`);
  console.log(`→ ${path.relative(process.cwd(), OUT)}; rebuild the master with: node --env-file=research/.env research/63-secmaster-hist.js`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
