'use strict';
// Step 59 — Alpha Vantage LISTING_STATUS snapshot collector (FREE historical
// listing universe; the free-path alternative to the Sharadar purchase).
//
//   node --env-file=research/.env research/59-av-listings-fetch.js [--budget=22] [--dry]
//
// Requires ALPHAVANTAGE_API_KEY in research/.env (free signup:
// https://www.alphavantage.co/support/#api-key). Without it the run reports
// BLOCKED and exits 0 so the scheduled job simply waits for the key.
//
// Design (see research/lib/av-listings.js for the pure core):
//   * deterministic plan: latest active+delisted first (the complete
//     delisting-date table in 2 requests), then monthly ACTIVE snapshots
//     2010-01→now, then quarterly DELISTED consistency snapshots;
//   * resumable: research/data/av-listings/index.json records completed keys;
//     partitions are content-addressed and NEVER overwritten;
//   * free-tier pacing: default 22 requests/run, 15s throttle; a rate-limit
//     response stops the run gracefully (progress kept);
//   * progress report each run: done/pending counts + ETA at current budget.
//
// The key is never printed. Failures are recorded, never invented around.

const fs = require('fs');
const path = require('path');
const AV = require('./lib/av-listings');

const DATA = path.join(__dirname, 'data');
const DIR = path.join(DATA, 'av-listings');
const INDEX_PATH = path.join(DIR, 'index.json');
const PROGRESS_PATH = path.join(DIR, 'progress.json');
const BASE = 'https://www.alphavantage.co/query';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  return process.argv.includes(`--${name}`) ? true : dflt;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const loadIndex = () => {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch { return { schema: 'AvListingsIndex', version: AV.AV_LISTINGS_VERSION, done: {}, failures: [], lastRun: null }; }
};
const saveIndex = (idx) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2)); };

function writeProgress(idx, pendingCount, planCount, budget, note) {
  const report = {
    schema: 'AvListingsProgress', generatedAt: new Date().toISOString(),
    planned: planCount, completed: Object.keys(idx.done).length, pending: pendingCount,
    estimatedRunsRemaining: budget > 0 ? Math.ceil(pendingCount / budget) : null,
    estimatedDaysRemaining: budget > 0 ? Math.ceil(pendingCount / budget) : null,   // one budgeted run per day
    note: note || null,
  };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(report, null, 2));
  return report;
}

async function fetchSnapshot(key, state, date) {
  const params = new URLSearchParams({ function: 'LISTING_STATUS', state, apikey: process.env.ALPHAVANTAGE_API_KEY });
  if (date) params.set('date', date);
  const res = await fetch(`${BASE}?${params.toString()}`);
  const text = await res.text();
  if (!res.ok) return { kind: 'error', message: `HTTP ${res.status}` };
  return AV.classifyResponse(text);
}

async function main() {
  const budget = Number(arg('budget', AV.DEFAULT_RUN_BUDGET)) || AV.DEFAULT_RUN_BUDGET;
  const dry = arg('dry', false) === true;
  const idx = loadIndex();
  const toYm = new Date().toISOString().slice(0, 7);
  const { plan, pending } = AV.snapshotPlan({ toYm, doneKeys: new Set(Object.keys(idx.done)) });

  if (!process.env.ALPHAVANTAGE_API_KEY) {
    const p = writeProgress(idx, pending.length, plan.length, budget, 'BLOCKED: ALPHAVANTAGE_API_KEY missing from research/.env — free signup at alphavantage.co/support/#api-key; the scheduled job resumes automatically once the key exists');
    console.log(`BLOCKED: no ALPHAVANTAGE_API_KEY. Plan ${p.planned} snapshots, ${p.pending} pending. Add the key to research/.env and this job takes it from there.`);
    return;
  }
  if (dry) {
    const p = writeProgress(idx, pending.length, plan.length, budget, 'dry run');
    console.log(`DRY: plan ${p.planned}, done ${p.completed}, pending ${p.pending}, ~${p.estimatedDaysRemaining} daily runs remaining`);
    return;
  }

  let used = 0, wrote = 0;
  for (const item of pending) {
    if (used >= budget) break;
    used++;
    let out;
    try { out = await fetchSnapshot(item.key, item.state, item.date); }
    catch (e) { out = { kind: 'error', message: String(e.message).slice(0, 160) }; }

    if (out.kind === 'rate-limited') {
      idx.failures.push({ key: item.key, at: new Date().toISOString(), kind: 'rate-limited' });
      console.log(`rate-limited after ${used - 1} successful requests — stopping this run (progress kept).`);
      break;
    }
    if (out.kind !== 'csv') {
      idx.failures.push({ key: item.key, at: new Date().toISOString(), kind: out.kind, message: out.message || null });
      console.log(`  ${item.key}: ${out.kind}${out.message ? ` (${out.message})` : ''} — will retry next run`);
      await sleep(AV.THROTTLE_MS);
      continue;
    }
    const doc = AV.partitionDoc({ key: item.key, state: item.state, asOfDate: item.date, records: out.records, retrievedAt: new Date().toISOString() });
    const file = path.join(DIR, `${item.key}.json`);
    if (fs.existsSync(file)) {
      let existing = null; try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { existing = null; }
      if (AV.partitionValid(existing)) {
        // Never overwrite a valid partition — just record it as done.
        idx.done[item.key] = { file: path.basename(file), rows: existing.rowCount, retrievedAt: existing.retrievedAt };
        continue;
      }
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc));
    idx.done[item.key] = { file: path.basename(file), rows: doc.rowCount, retrievedAt: doc.retrievedAt };
    wrote++;
    console.log(`  ${item.key}: ${doc.rowCount} rows`);
    await sleep(AV.THROTTLE_MS);
  }

  idx.lastRun = new Date().toISOString();
  saveIndex(idx);
  const stillPending = AV.snapshotPlan({ toYm, doneKeys: new Set(Object.keys(idx.done)) }).pending.length;
  const p = writeProgress(idx, stillPending, plan.length, budget, null);
  console.log(`run complete: ${wrote} partitions written (${used} requests). ${p.completed}/${p.planned} done, ${p.pending} pending ≈ ${p.estimatedDaysRemaining} more daily runs.`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
