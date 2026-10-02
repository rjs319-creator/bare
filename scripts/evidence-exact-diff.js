#!/usr/bin/env node
'use strict';
// EVIDENCE EXACT-PRECISION DIFF — how many gate verdicts flip once the gates read the
// full-precision `exact` block instead of the 2dp display fields?
//
// For every persisted evidence-stats summary found in the given documents (any JSON; the
// walker recognises `dateNet`-shaped records), prints the BEFORE verdict (pre-v2 gate
// semantics: interval class from the rounded ci95, p from avgExact/seExact or the rounded
// avg/se) next to the AFTER verdict (exact block, recomputed from the stored series where
// possible), and counts the flips. Read-only: nothing is written anywhere.
//
//   node scripts/evidence-exact-diff.js --file path.json [--file ...]
//   node scripts/evidence-exact-diff.js --dir research/data
//   node scripts/evidence-exact-diff.js --url 'https://<host>/api/tracker?op=maturity'
//   add --verbose to list every flipped record, --all to list every record.

const fs = require('node:fs');
const path = require('node:path');
const ES = require('../lib/evidence-stats');
const MIG = require('../lib/evidence-exact-migrate');
const S3 = require('../lib/research/stats-v3');

const ALPHA = 0.05;
const isNum = Number.isFinite;

function parseArgs(argv) {
  const out = { files: [], dirs: [], urls: [], verbose: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.files.push(argv[++i]);
    else if (a === '--dir') out.dirs.push(argv[++i]);
    else if (a === '--url') out.urls.push(argv[++i]);
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--all') out.all = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function intervalClass(ci) {
  if (!ci || !isNum(ci.lo) || !isNum(ci.hi)) return 'none';
  if (ci.lo > 0) return 'positive';
  if (ci.hi < 0) return 'negative';
  return 'spans-zero';
}

// Pre-v2 semantics, reproduced here on purpose (the live code no longer does this).
function beforeVerdict(s) {
  const avg = isNum(s.avgExact) ? s.avgExact : s.avg;
  const se = isNum(s.seExact) ? s.seExact : s.se;
  const df = isNum(s.effectiveN) && s.effectiveN > 1 ? s.effectiveN - 1 : undefined;
  const p = isNum(avg) && isNum(se) && se > 0 ? S3.pFromT(avg / se, df) : null;
  return { interval: intervalClass(s.ci95), p, source: isNum(s.avgExact) ? 'avgExact/seExact' : 'rounded avg/se' };
}

function afterVerdict(s) {
  const migrated = MIG.migrateSummary(s);
  const ex = ES.exactOf(migrated);
  const { p } = ES.pValueDetail(migrated);
  return { interval: intervalClass(ex && ex.ci95), p, precision: ex ? ex.precision : null, method: migrated.migration ? migrated.migration.method : 'already-exact' };
}

// Collect every summary with a label describing where it sits in the document.
function collectSummaries(doc) {
  const found = [];
  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, trail.concat(labelOf(x, i)))); return; }
    const isSummary = (node.exact && isNum(node.avg) && node.ci95) || MIG.isLegacySummary(node);
    if (isSummary) { found.push({ label: trail.join('/'), summary: node }); return; }
    for (const k of Object.keys(node)) walk(node[k], trail.concat(k));
  };
  walk(doc, []);
  return found;
}
function labelOf(x, i) {
  if (!x || typeof x !== 'object') return String(i);
  if (x.id) return String(x.id);
  if (x.section) return [x.section, x.tier, x.scope].filter(Boolean).join(':');
  return String(i);
}

function diffDoc(doc, source) {
  const rows = collectSummaries(doc).map(({ label, summary }) => {
    const before = beforeVerdict(summary);
    const after = afterVerdict(summary);
    const sigBefore = isNum(before.p) ? before.p <= ALPHA : null;
    const sigAfter = isNum(after.p) ? after.p <= ALPHA : null;
    const quantised = !!(summary.ci95 && (summary.ci95.lo === 0 || summary.ci95.hi === 0));
    return {
      source, label, n: summary.n,
      before, after, sigBefore, sigAfter, quantised,
      intervalFlip: before.interval !== after.interval,
      significanceFlip: sigBefore !== sigAfter,
    };
  });
  return rows;
}

async function loadDocs({ files, dirs, urls }) {
  const docs = [];
  for (const f of files) docs.push({ source: f, doc: JSON.parse(fs.readFileSync(f, 'utf8')) });
  for (const d of dirs) {
    for (const f of fs.readdirSync(d).filter(x => x.endsWith('.json'))) {
      try { docs.push({ source: path.join(d, f), doc: JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) }); }
      catch (e) { process.stderr.write(`skip ${f}: ${e.message}\n`); }
    }
  }
  for (const u of urls) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${u} -> ${r.status}`);
    docs.push({ source: u, doc: await r.json() });
  }
  return docs;
}

const fmtP = (p) => (isNum(p) ? p.toFixed(4) : '—');
function printRow(r) {
  process.stdout.write(
    `  ${r.label.padEnd(60).slice(0, 60)} n=${String(r.n).padStart(3)}  `
    + `${r.before.interval.padEnd(10)} p=${fmtP(r.before.p)}  →  ${r.after.interval.padEnd(10)} p=${fmtP(r.after.p)}  `
    + `[${r.after.precision}/${r.after.method}]${r.quantised ? '  ci bound == 0.00' : ''}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.files.length && !args.dirs.length && !args.urls.length) {
    process.stdout.write('usage: evidence-exact-diff.js (--file f.json | --dir d | --url u)+ [--verbose] [--all]\n');
    process.exit(2);
  }
  const docs = await loadDocs(args);
  const rows = docs.flatMap(({ source, doc }) => diffDoc(doc, source));
  const flips = rows.filter(r => r.intervalFlip || r.significanceFlip);
  const byPrecision = rows.reduce((m, r) => ({ ...m, [r.after.precision]: (m[r.after.precision] || 0) + 1 }), {});
  const byMethod = rows.reduce((m, r) => ({ ...m, [r.after.method]: (m[r.after.method] || 0) + 1 }), {});
  process.stdout.write(`documents: ${docs.length}   summaries: ${rows.length}   with a display bound quantised to 0.00: ${rows.filter(r => r.quantised).length}\n`);
  process.stdout.write(`after-precision: ${JSON.stringify(byPrecision)}   method: ${JSON.stringify(byMethod)}\n`);
  process.stdout.write(`interval-class flips: ${rows.filter(r => r.intervalFlip).length}   significance (p ≤ ${ALPHA}) flips: ${rows.filter(r => r.significanceFlip).length}   any flip: ${flips.length}\n`);
  const listed = args.all ? rows : (args.verbose ? flips : flips.slice(0, 25));
  if (listed.length) {
    process.stdout.write(`${args.all ? 'all records' : 'flipped records'}${!args.all && !args.verbose && flips.length > 25 ? ' (first 25; --verbose for all)' : ''}:\n`);
    listed.forEach(printRow);
  }
}

main().catch((e) => { process.stderr.write(`evidence-exact-diff: ${e.message}\n`); process.exit(1); });
