#!/usr/bin/env node
'use strict';
// VENDOR fja05680/sp500 (MIT) — historical S&P 500 constituents since 1996 → PIT membership.
//
//   node scripts/vendor-sp500-constituents.js                 # fetch via `gh api` (raw contents)
//   node scripts/vendor-sp500-constituents.js --from <csv>    # offline: an already-downloaded daily CSV
//
// Writes, under research/data-derived/ (committed):
//   sp500-constituents.csv        ticker,start,end — lossless interval compression of the daily file
//   sp500-constituents.meta.json  upstream repo/path/commit, raw sha256, row counts, generatedAt
//   LICENSE-fja05680-sp500        the upstream MIT license, kept verbatim
// Consumers: research/lib/sp500-pit.js membersAt(date) → research/lib/secmaster.js universeAt
// `membership` option → research/04 and research/05 `--sp500-pit`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const SP = require('../research/lib/sp500-pit');

const REPO = 'fja05680/sp500';
const UPSTREAM_CSV = 'S&P 500 Historical Components & Changes (Updated).csv';
const OUT_CSV = SP.VENDORED_CSV;
const OUT_META = path.join(SP.DERIVED_DIR, 'sp500-constituents.meta.json');
const OUT_LICENSE = path.join(SP.DERIVED_DIR, 'LICENSE-fja05680-sp500');
const GH_TIMEOUT_MS = 60_000;

const argValue = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function ghRaw(filePath) {
  const url = `repos/${REPO}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
  return execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.raw', url], { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
}

function upstreamCommit() {
  try {
    const out = execFileSync('gh', ['api', `repos/${REPO}/commits?per_page=1`, '--jq', '.[0].sha + " " + .[0].commit.committer.date'], { encoding: 'utf8', timeout: GH_TIMEOUT_MS }).trim();
    const [sha, date] = out.split(' ');
    return { sha: sha || null, date: date || null };
  } catch { return { sha: null, date: null }; }
}

function main() {
  const from = argValue('from');
  const rawCsv = from ? fs.readFileSync(from, 'utf8') : ghRaw(UPSTREAM_CSV);
  const license = from && fs.existsSync(path.join(path.dirname(from), 'LICENSE')) ? fs.readFileSync(path.join(path.dirname(from), 'LICENSE'), 'utf8') : ghRaw('LICENSE');
  if (!/MIT License/.test(license)) throw new Error('upstream LICENSE is not the expected MIT text — stop and inspect before vendoring');

  const snapshots = SP.parseDailyCsv(rawCsv);
  const intervals = SP.compressToIntervals(snapshots);
  // Round-trip guard: the interval form must answer every snapshot date exactly like the source.
  const membership = SP.createMembership(intervals);
  for (const snap of snapshots) {
    const got = [...membership.membersAt(snap.date)].sort();
    if (got.length !== snap.tickers.length || got.some((t, i) => t !== snap.tickers[i])) throw new Error(`lossless check failed on ${snap.date}`);
  }

  fs.mkdirSync(SP.DERIVED_DIR, { recursive: true });
  fs.writeFileSync(OUT_CSV, SP.intervalsToCsv(intervals));
  fs.writeFileSync(OUT_LICENSE, license);
  const commit = from ? { sha: null, date: null } : upstreamCommit();
  const meta = {
    version: SP.SP500_PIT_VERSION, generatedAt: new Date().toISOString(),
    upstream: { repo: REPO, file: UPSTREAM_CSV, license: 'MIT', commit: commit.sha, commitDate: commit.date, source: from ? `file:${path.basename(from)}` : 'gh api (raw contents)' },
    rawSha256: sha256(rawCsv), rawBytes: rawCsv.length,
    snapshots: snapshots.length, firstDate: snapshots[0].date, lastDate: snapshots[snapshots.length - 1].date,
    intervals: intervals.length, distinctTickers: membership.tickers.length, currentMembers: membership.currentMembers().size,
    semantics: 'end is EXCLUSIVE (first snapshot date without the ticker); empty end = still a member; membersAt(date) is null before firstDate',
  };
  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 1) + '\n');
  process.stdout.write(`${meta.snapshots} snapshots ${meta.firstDate}→${meta.lastDate} → ${meta.intervals} intervals, ${meta.distinctTickers} tickers, ${meta.currentMembers} current\n`);
  process.stdout.write(`saved → ${path.relative(path.join(__dirname, '..'), OUT_CSV)} (+ meta, LICENSE)\n`);
}

try { main(); }
catch (e) { process.stderr.write(`vendor-sp500-constituents failed: ${String((e && e.message) || e)}\n`); process.exit(1); }
