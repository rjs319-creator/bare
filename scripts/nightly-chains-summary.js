#!/usr/bin/env node
'use strict';
// Fold the per-chain result files of one nightly-chains run into ONE record and POST it to
// op=chainsummary (lib/chain-summary-routes.js), so the app knows what happened without
// anyone opening the Actions UI. Runs as the workflow's `summary` job (`if: always()`), after
// actions/download-artifact has merged every `chain-<name>` artifact into OUT_DIR.
//
//   node scripts/nightly-chains-summary.js
//   env: APP_URL, CRON_SECRET (absent → warning, exit 0), OUT_DIR (.nightly),
//        ONLY (comma list when the run was filtered by workflow_dispatch),
//        GITHUB_RUN_ID / GITHUB_SERVER_URL / GITHUB_REPOSITORY (run link), GITHUB_STEP_SUMMARY
//
// A root chain with NO result file is recorded as `no-report` and FAILED: its job was
// cancelled, hit timeout-minutes before writing, or never started — the loss modes a
// per-job e-mail cannot distinguish from "nobody ran it", which is exactly what the
// dead-man record is for. The summary job itself fails only when the POST fails.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT_CHAINS } = require('../lib/warm-chains');

const DEFAULT_APP_URL = 'https://market-news-app-chi.vercel.app';
const DEFAULT_OUT_DIR = '.nightly';
const POST_TIMEOUT_MS = 60000;

// Summary dates are ET SESSION dates (lib/chain-summary.js): the retry schedules run as
// late as 01:00 UTC, which is still the same evening in New York.
const { etDate } = require('../lib/chain-summary');
const parseOnly = (only) => String(only || '').split(',').map((s) => s.trim()).filter(Boolean);

function readResults(outDir) {
  if (!fs.existsSync(outDir)) return [];
  return fs.readdirSync(outDir).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try { return [JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'))]; } catch { return []; }
  }).filter((r) => r && typeof r.chain === 'string');
}

const NO_REPORT = { ok: false, status: 'no-report', attempts: 0, failed: [], skipped: [], error: 'no result file — job cancelled, timed out before reporting, or never started' };

// Pure: results + the expected root list → the op=chainsummary body.
function buildSummaryPayload(results, { expected = ROOT_CHAINS, only = [], runId = null, runUrl = null, now = Date.now() } = {}) {
  const wanted = only.length ? expected.filter((c) => only.includes(c)) : expected;
  const byChain = Object.fromEntries((results || []).map((r) => [r.chain, r]));
  const chains = Object.fromEntries(wanted.map((c) => {
    const r = byChain[c];
    if (!r) return [c, NO_REPORT];
    return [c, { ok: r.ok === true, status: r.status || (r.ok ? 'ok' : 'failed'), httpStatus: r.httpStatus ?? null, attempts: r.attempts ?? null,
      complete: typeof r.complete === 'boolean' ? r.complete : null, failed: r.failed || [], skipped: r.skipped || [], elapsedMs: r.elapsedMs ?? null, error: r.error || null }];
  }));
  const starts = Object.values(byChain).map((r) => Date.parse(r.startedAt)).filter(Number.isFinite);
  const ends = Object.values(byChain).map((r) => Date.parse(r.finishedAt)).filter(Number.isFinite);
  const startedMs = starts.length ? Math.min(...starts) : now;
  return {
    date: etDate(startedMs),
    source: only.length ? 'manual' : 'github-matrix',
    // A filtered run reports the chains it ran and nothing about the night: op=health treats
    // only a full run (partial:false) as covering the date. `covered` names what ran.
    partial: only.length > 0,
    covered: wanted,
    runId: runId == null ? null : String(runId),
    runUrl,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(ends.length ? Math.max(...ends, now) : now).toISOString(),
    chains,
  };
}

function stepSummaryMarkdown(payload) {
  const rows = Object.entries(payload.chains).map(([name, c]) =>
    `| ${c.ok ? '✅' : '❌'} ${name} | ${c.status} | ${c.httpStatus ?? '—'} | ${c.attempts ?? '—'} | ${c.elapsedMs != null ? Math.round(c.elapsedMs / 1000) + 's' : '—'} | ${(c.failed || []).join(', ') || (c.error || '')} | ${(c.skipped || []).join(', ')} |`);
  const failed = Object.entries(payload.chains).filter(([, c]) => !c.ok).map(([n]) => n);
  return [
    `## Nightly chains ${payload.date} (${payload.source}${payload.partial ? ', partial' : ''})`,
    failed.length ? `**${failed.length} failed:** ${failed.join(', ')}` : '**All chains ok.**',
    '',
    '| chain | status | http | attempts | elapsed | failed steps / error | budget-skipped |',
    '|---|---|---|---|---|---|---|',
    ...rows, '',
  ].join('\n');
}

async function postSummary(payload, { appUrl = DEFAULT_APP_URL, secret, fetchImpl = globalThis.fetch, timeoutMs = POST_TIMEOUT_MS } = {}) {
  try {
    const r = await fetchImpl(`${appUrl.replace(/\/$/, '')}/api/tracker?op=chainsummary`, {
      method: 'POST', body: JSON.stringify(payload),
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await r.text().catch(() => '');
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON error page */ }
    return { httpStatus: r.status, body, raw: r.ok ? null : raw.slice(0, 300), error: null };
  } catch (e) { return { httpStatus: null, body: null, raw: null, error: String((e && e.message) || e).slice(0, 200) }; }
}

async function main(env = process.env) {
  const outDir = env.OUT_DIR || DEFAULT_OUT_DIR;
  const runId = env.GITHUB_RUN_ID || null;
  const runUrl = runId && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${runId}` : null;
  const payload = buildSummaryPayload(readResults(outDir), { only: parseOnly(env.ONLY), runId, runUrl });
  const md = stepSummaryMarkdown(payload);
  process.stdout.write(md + '\n');
  if (env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n'); } catch { /* cosmetic */ } }
  const secret = env.CRON_SECRET || '';
  if (!secret) { process.stdout.write('::warning::CRON_SECRET repo secret not set — chain summary not posted.\n'); return 0; }
  const r = await postSummary(payload, { appUrl: env.APP_URL || DEFAULT_APP_URL, secret });
  process.stdout.write(JSON.stringify({ httpStatus: r.httpStatus, body: r.body, error: r.error }) + '\n');
  if (r.httpStatus !== 200 || !r.body || r.body.ok !== true) {
    process.stdout.write(`::error title=chain summary not recorded::op=chainsummary ${r.httpStatus == null ? r.error : `HTTP ${r.httpStatus}`} ${r.raw || (r.body && r.body.error) || ''}\n`);
    return 1;
  }
  if (r.body.written === false) process.stdout.write(`::warning::op=chainsummary accepted but did not persist: ${r.body.note || ''}\n`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`::error::${String((e && e.message) || e)}\n`); process.exit(1); });
}

module.exports = { readResults, buildSummaryPayload, stepSummaryMarkdown, postSummary, parseOnly, main, NO_REPORT, DEFAULT_OUT_DIR };
