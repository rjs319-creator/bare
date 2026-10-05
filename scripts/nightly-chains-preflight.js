#!/usr/bin/env node
'use strict';
// PREFLIGHT for .github/workflows/nightly-chains.yml — makes the run IDEMPOTENT per night.
//
//   node scripts/nightly-chains-preflight.js
//   env: APP_URL (default prod), ONLY (workflow_dispatch filter), FORCE ('true' re-runs
//        regardless), GITHUB_RUN_ID (cache-buster), GITHUB_OUTPUT (where outputs go)
//
// WHY: GitHub delays this repo's scheduled workflows by minutes to HOURS (2026-10-02: the
// 13:30 evidence-tick fired at 18:38; the 22:05 nightly never fired by 22:53). The fix is
// to schedule the workflow several times a night (22:05, 22:40, 23:20, 01:00 UTC) and let
// each run ask op=health — public, no bearer — what the night already has:
//   • a FULL summary for the TARGET SESSION that is ok   → `skip=true`: every chain job and
//     the summary are skipped by `if:`, so a late duplicate schedule costs one tiny job;
//   • a partial or red record for the session             → `already_ok=<csv>`: the chains
//     that are already ok exit 0 with status `already-ok` inside the runner, only the rest
//     run, and the summary job still folds ALL roots so the night ends up covered;
//   • nothing for the session (or the probe failed)        → run everything.
// A manual `only=` dispatch or `force=true` always runs what was asked.
//
// THE NIGHT IS THE TARGET SESSION — the last COMPLETED NYSE session at run start
// (lib/chain-summary.js targetSession → lib/market-session.js), NOT the ET calendar date.
// On Fri 2026-10-02 GitHub ran the 01:00 UTC retry at 06:14 UTC = 02:14 ET, before the
// session; keyed by ET date that pre-market run became "Friday's" full record and the real
// post-close runs skipped everything as already-ok. Now 02:14 ET Friday targets Thursday
// (already ok → skip), 20:28 ET Friday targets Friday, 02:41 ET Saturday targets Friday.
// The session is published as a third output (`session=`) so the chain jobs and the summary
// stamp the SAME night the preflight decided on (TARGET_SESSION), whatever the clock says
// by the time they run.
//
// Fail-OPEN: any error here means "run" — the preflight is an optimisation, never a gate
// that can silently cancel the night. It never exits non-zero.

const fs = require('node:fs');
const { ROOT_CHAINS } = require('../lib/warm-chains');
const CS = require('../lib/chain-summary');

const DEFAULT_APP_URL = 'https://market-news-app-chi.vercel.app';
// op=health answers in ~1-3 s (an SPY history fetch + a few Blob reads); 30 s leaves room
// for a cold start without holding the night hostage to a slow probe.
const PROBE_TIMEOUT_MS = 30000;
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

const parseList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const isTruthy = (v) => TRUTHY.has(String(v == null ? '' : v).trim().toLowerCase());

// Pure: what the night already has → what this run should do.
// The health block is matched on its `session`; a block from a deploy that predates the
// field carries only `date`, which was its session (CS.sessionOf).
function decidePreflight({ health = null, targetSession, only = [], force = false, roots = ROOT_CHAINS } = {}) {
  if (force) return { skip: false, alreadyOk: [], reason: 'force=true — running everything requested' };
  if (only.length) return { skip: false, alreadyOk: [], reason: `only=${only.join(',')} — a filtered dispatch always runs what was asked` };
  const ch = health && typeof health === 'object' ? health.chains : null;
  if (!ch || typeof ch !== 'object' || CS.sessionOf(ch) !== targetSession) return { skip: false, alreadyOk: [], reason: `no record for ${targetSession} yet — running everything` };
  if (ch.full === true && ch.ok === true) return { skip: true, alreadyOk: roots.slice(), reason: `${targetSession} already has a full, clean run (${ch.source || 'posted'}${ch.runUrl ? ` ${ch.runUrl}` : ''}) — skipping` };
  const failed = new Set(Array.isArray(ch.failed) ? ch.failed : []);
  const alreadyOk = roots.filter((c) => Array.isArray(ch.covered) && ch.covered.includes(c) && !failed.has(c));
  return { skip: false, alreadyOk, reason: `${targetSession} has a ${ch.full ? 'full' : 'partial'} record with ${alreadyOk.length}/${roots.length} chains ok — running the rest` };
}

// One public GET of op=health. The run id busts the 5-minute CDN cache so a stale
// "not yet" cannot cause a duplicate run (a stale "ok" is impossible: ok never un-happens).
async function probeHealth({ appUrl = DEFAULT_APP_URL, runId = null, fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const url = `${appUrl.replace(/\/$/, '')}/api/tracker?op=health${runId ? `&preflight=${encodeURIComponent(runId)}` : ''}`;
  try {
    const r = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status !== 200) return { health: null, error: `HTTP ${r.status}` };
    const body = await r.json().catch(() => null);
    return body && typeof body === 'object' ? { health: body, error: null } : { health: null, error: 'non-JSON body' };
  } catch (e) {
    return { health: null, error: String((e && e.message) || e).slice(0, 200) };
  }
}

const outputLines = (d, targetSession) => [`skip=${d.skip ? 'true' : 'false'}`, `already_ok=${d.alreadyOk.join(',')}`, `session=${targetSession || ''}`];

async function main(env = process.env, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const startMs = now();
  const targetSession = CS.targetSession(startMs);
  const only = parseList(env.ONLY);
  const force = isTruthy(env.FORCE);
  const { health, error } = (only.length || force) ? { health: null, error: null } : await probeHealth({ appUrl: env.APP_URL || DEFAULT_APP_URL, runId: env.GITHUB_RUN_ID || null, fetchImpl });
  const decision = decidePreflight({ health, targetSession, only, force });
  if (error) process.stdout.write(`::warning::op=health probe failed (${error}) — running everything\n`);
  process.stdout.write(`::notice title=nightly preflight session ${targetSession} (run date ${CS.etDate(startMs)} ET)::${decision.reason}\n`);
  const lines = outputLines(decision, targetSession);
  process.stdout.write(lines.join('\n') + '\n');
  if (env.GITHUB_OUTPUT) { try { fs.appendFileSync(env.GITHUB_OUTPUT, lines.join('\n') + '\n'); } catch (e) { process.stdout.write(`::warning::could not write GITHUB_OUTPUT: ${e.message}\n`); } }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { process.stdout.write(`::warning::preflight crashed (${String((e && e.message) || e)}) — running everything\nskip=false\nalready_ok=\nsession=\n`); process.exit(0); });
}

module.exports = { decidePreflight, probeHealth, outputLines, main, PROBE_TIMEOUT_MS, DEFAULT_APP_URL };
