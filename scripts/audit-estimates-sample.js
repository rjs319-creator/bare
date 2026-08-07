#!/usr/bin/env node
'use strict';
// PIT sample auditor CLI — LOCAL-ONLY. Reads a user-supplied analyst-estimates
// sample from the git-ignored research/private-data/ directory (CSV or JSON;
// Parquet must be converted first — no parquet dependency is worth adding for
// a one-off audit), runs lib/research/estimates-audit, and writes the
// machine-readable report next to it. Licensed row VALUES never reach stdout —
// only counts, coverage, column names and the classification.
//
// USAGE:  npm run audit:estimates            (auto-finds estimates-sample.*)
//         node scripts/audit-estimates-sample.js path/to/sample.csv

const fs = require('fs');
const path = require('path');
const { auditEstimatesSample, parseCsv } = require(path.join(__dirname, '..', 'lib', 'research', 'estimates-audit'));

const PRIVATE_DIR = path.join(__dirname, '..', 'research', 'private-data');
const REPORT_PATH = path.join(PRIVATE_DIR, 'estimates-audit.json');

function findSample(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  if (!fs.existsSync(PRIVATE_DIR)) return null;
  const hit = fs.readdirSync(PRIVATE_DIR).find(f => /^estimates-sample\.(csv|json|ndjson|parquet)$/i.test(f));
  return hit ? path.join(PRIVATE_DIR, hit) : null;
}

function loadRows(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.parquet') {
    throw new Error('Parquet is not supported without adding a dependency — convert to CSV or JSON first (e.g. via duckdb: COPY (SELECT * FROM read_parquet(...)) TO sample.csv).');
  }
  const text = fs.readFileSync(file, 'utf8');
  if (ext === '.csv') return parseCsv(text);
  if (ext === '.ndjson') return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
  if (parsed && Array.isArray(parsed.data)) return parsed.data;
  throw new Error('JSON sample must be an array of row objects (or {rows:[...]}).');
}

function main() {
  const file = findSample(process.argv[2]);
  if (!file) {
    console.log(`No sample found. Place your vendor export at ${path.relative(process.cwd(), PRIVATE_DIR)}/estimates-sample.csv|json (directory is git-ignored) and rerun.`);
    process.exitCode = 2;
    return;
  }
  let rows;
  try {
    rows = loadRows(file);
  } catch (e) {
    console.error(`Could not parse sample (${path.basename(file)}): ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const report = auditEstimatesSample(rows, { now: new Date().toISOString() });
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  const safeSummary = {
    sample: path.basename(file),
    rowCount: report.rowCount,
    tickerCount: report.tickerCount,
    dateCoverage: report.dateCoverage,
    multiObsGroups: report.multiObsGroups,
    valuesChange: report.valuesChange,
    classification: report.classification,
    reasons: report.reasons,
    report: path.relative(process.cwd(), REPORT_PATH),
  };
  console.log(JSON.stringify(safeSummary, null, 2));
}

main();
