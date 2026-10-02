#!/usr/bin/env node
'use strict';
// FILING RED FLAGS — EDGAR daily-index backfill (resumable, rate-limited, 403-vs-404 aware).
//
//   node --env-file-if-exists=.env.local scripts/redflags-backfill.js --from 2026-08-20 --to 2026-10-01
//   node scripts/redflags-backfill.js --from … --to … --out research/data/redflags   # local shards, no Blob
//   … --progress <file>   resume file (default research/data/redflags-backfill-progress.json)
//   … --dry               walk the index and classify, write nothing
//
// Walks every calendar date in [from, to] through lib/filing-redflags-routes tickCore with the
// production feed (SEC User-Agent, ≤10 req/s) — one date = one union shard, exactly the rows
// the nightly tick would have logged had it run that night (entry at the next open after the
// filing date; the ledger row's `date` is the index date it was READ from). Weekends and
// holidays answer 403 AccessDenied (missing index) and are recorded as such; any other 403 is
// the rate-limit block page and STOPS the run so the resume file can pick it up later.
//
// Resumable: the progress file records each finished date with its counts; a rerun skips them.
// The shards themselves are CAS unions, so a crash mid-date is safe to re-run.
//
// NOTE the state machine: first-in-252 depends on the per-ticker rolling state, so the walk
// MUST run in chronological order and MUST NOT skip dates (the progress file enforces both).
// The research/data symlink is never committed (see memory: research/data never git add).

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 86_400_000;
const DEFAULT_PROGRESS = path.join(__dirname, '..', 'research', 'data', 'redflags-backfill-progress.json');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv) {
  const out = { from: null, to: null, out: null, progress: DEFAULT_PROGRESS, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--progress') out.progress = argv[++i];
    else if (a === '--dry') out.dry = true;
  }
  if (!DATE_RE.test(out.from || '') || !DATE_RE.test(out.to || '')) throw new Error('--from and --to (YYYY-MM-DD) are required');
  if (out.from > out.to) throw new Error('--from must be ≤ --to');
  return out;
}

function datesBetween(from, to) {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// Pure: progress doc + planned dates → the dates still to run (chronological, contiguous).
function planDates(progress, dates) {
  const done = new Set(Object.keys((progress && progress.dates) || {}));
  return dates.filter((d) => !done.has(d));
}

function readProgress(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { version: 'redflags-backfill-v1', dates: {} }; }
}

function withDate(progress, date, record) {
  return { ...progress, dates: { ...(progress.dates || {}), [date]: record }, updatedAt: new Date().toISOString() };
}

// A local-directory store with the same surface as lib/filing-redflags-store (for --out runs
// without Blob credentials; shards land as JSON files the research kit can read).
function fileStore(dir) {
  const RFS = require('../lib/filing-redflags-store');
  const RF = require('../lib/filing-redflags');
  fs.mkdirSync(dir, { recursive: true });
  const file = (k) => path.join(dir, k.replace(/^redflags\/v1\//, ''));
  const read = (k) => { try { return JSON.parse(fs.readFileSync(file(k), 'utf8')); } catch { return null; } };
  const write = (k, doc) => fs.writeFileSync(file(k), JSON.stringify(doc));
  return {
    readAllRedflagDays: async ({ since = null, limit = null } = {}) => {
      const days = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => read(`redflags/v1/${f}`)).filter(Boolean)
        .filter((d) => !since || d.date >= since).sort((a, b) => (a.date < b.date ? -1 : 1));
      return limit ? days.slice(-limit) : days;
    },
    readState: async () => read(RFS.STATE_KEY) || RF.emptyState(),
    readCurrent: async () => read(RFS.CURRENT_KEY),
    writeDayUnion: async (date, patch) => write(RFS.dayKey(date), RFS.mergeDay(read(RFS.dayKey(date)), { ...patch, date, savedAt: new Date().toISOString() })),
    writeStateUnion: async (next) => write(RFS.STATE_KEY, RFS.mergeState(read(RFS.STATE_KEY), next)),
    writeCurrent: async (snap) => write(RFS.CURRENT_KEY, snap),
  };
}

// A store that records nothing (--dry).
const nullStore = (RF) => ({
  readAllRedflagDays: async () => [], readState: async () => RF.emptyState(), readCurrent: async () => null,
  writeDayUnion: async () => {}, writeStateUnion: async () => {}, writeCurrent: async () => {},
});

// Classify a 403 block (stop) vs anything else (record + continue). Pure.
function isBlockedError(e) { return /403 \(not a missing-key response/.test(String((e && e.message) || e)); }

// Walk the dates. `runDate(date)` is tickCore bound to the chosen store; injected for tests.
async function backfillRange({ dates, progress, runDate, saveProgress, log = () => {} }) {
  let prog = progress;
  const totals = { byFlag: {}, rows: 0, excluded: 0, missingIndex: 0, partial: 0, errors: 0, dates: 0 };
  for (const date of dates) {
    let record;
    try {
      const r = await runDate(date);
      const missing = r.stats && Array.isArray(r.stats.indexDates) ? r.stats.indexDates.every((x) => x.missing) : false;
      record = { ok: true, rows: r.counts.rows, excluded: r.counts.excluded, byFlag: r.counts.byFlag, partial: r.partial, missingIndex: missing, ms: r.stats.ms };
      totals.rows += r.counts.rows; totals.excluded += r.counts.excluded; totals.dates++;
      if (r.partial) totals.partial++;
      for (const [f, n] of Object.entries(r.counts.byFlag || {})) totals.byFlag[f] = (totals.byFlag[f] || 0) + n;
    } catch (e) {
      if (isBlockedError(e)) { log(`${date}: BLOCKED by EDGAR (403 rate-limit page) — stopping; rerun later to resume`); return { progress: prog, totals, stopped: date }; }
      record = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
      totals.errors++;
    }
    prog = withDate(prog, date, record);
    await saveProgress(prog);
    log(`${date}: ${record.ok ? `${record.rows} rows ${JSON.stringify(record.byFlag)}${record.partial ? ' PARTIAL' : ''}` : `ERROR ${record.error}`}`);
  }
  return { progress: prog, totals, stopped: null };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const RF = require('../lib/filing-redflags');
  const ROUTES = require('../lib/filing-redflags-routes');
  const STORE = require('../lib/store');
  const store = args.dry ? nullStore(RF) : args.out ? fileStore(args.out) : (STORE.hasStore() ? require('../lib/filing-redflags-store') : null);
  if (!store) throw new Error('no BLOB_READ_WRITE_TOKEN — pass --out <dir> for local shards or --dry');
  const progress = readProgress(args.progress);
  const dates = planDates(progress, datesBetween(args.from, args.to));
  process.stdout.write(`redflags backfill ${args.from}..${args.to}: ${dates.length} date(s) to run${args.dry ? ' (dry)' : ''}\n`);
  const saveProgress = args.dry ? async () => {} : async (p) => { fs.mkdirSync(path.dirname(args.progress), { recursive: true }); fs.writeFileSync(args.progress, JSON.stringify(p, null, 2)); };
  // The ledger row's `date` is the index date (the day the app would have known); each date
  // reads that day + the day before exactly like the nightly tick, so the union dedupes.
  const runDate = (date) => ROUTES.tickCore({ date, store });
  const r = await backfillRange({ dates, progress, runDate, saveProgress, log: (m) => process.stdout.write(m + '\n') });
  process.stdout.write(`done: ${r.totals.dates} dates, ${r.totals.rows} rows (${r.totals.excluded} excluded), by flag ${JSON.stringify(r.totals.byFlag)}, partial ${r.totals.partial}, errors ${r.totals.errors}${r.stopped ? `, STOPPED at ${r.stopped}` : ''}\n`);
  return r.stopped || r.totals.errors ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`redflags backfill failed: ${String((e && e.message) || e)}\n`); process.exit(1); });
}

module.exports = { parseArgs, datesBetween, planDates, withDate, backfillRange, isBlockedError, fileStore, DEFAULT_PROGRESS };
