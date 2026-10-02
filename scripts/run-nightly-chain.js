#!/usr/bin/env node
'use strict';
// Run ONE warm root chain from GitHub Actions (.github/workflows/nightly-chains.yml).
//
//   node scripts/run-nightly-chain.js <chain>
//   env: APP_URL (default prod), CRON_SECRET (bearer; absent → graceful skip), OUT_DIR (.nightly),
//        ALREADY_OK (comma list from the preflight job: chains an earlier run of the SAME night
//        already completed — the runner exits 0 with status `already-ok` without a request)
//
// Hits the existing single-chain endpoint op=warmchain&name=<chain> — the same call
// api/warm.js made in-process — and writes a compact result JSON the summary job folds
// into op=chainsummary. Exit code is the dead-man: non-zero = the job goes red = GitHub
// e-mails the workflow owner. Grading mirrors api/warm.js: a warmchain returns HTTP 200
// even when its STEPS failed, so the verdict is read from the body, never the status.
//
// RETRY POLICY — two attempts, but only when the first failed FAST (transport error or an
// edge 429/502/503 inside FAST_FAIL_MS). A slow failure means the chain ran: its steps
// are idempotent per day but not free, and a 504 at the function wall already means the
// work happened. Re-running would double-execute, not recover.
//
// Pure where it matters: `attemptOnce` / `gradeAttempt` / `runChain` take an injected
// fetch + clock so test/nightly-chains-runner.test.js drives every branch offline.

const fs = require('node:fs');
const path = require('node:path');
const { CHAINS } = require('../lib/warm-chains');

const DEFAULT_APP_URL = 'https://market-news-app-chi.vercel.app';
const DEFAULT_OUT_DIR = '.nightly';
const MAX_ATTEMPTS = 2;
// Under the job's timeout-minutes: 6 even on the worst path (fast fail + sleep + full wall).
const REQUEST_TIMEOUT_MS = 290000;   // tracker maxDuration is 300s (vercel.json)
const FAST_FAIL_MS = 30000;
const RETRY_DELAY_MS = 15000;
const RETRY_STATUSES = new Set([429, 502, 503]);
const MAX_ERROR_TEXT = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String((e && e.message) || e).slice(0, MAX_ERROR_TEXT);

function chainUrl(appUrl, chain) {
  return `${appUrl.replace(/\/$/, '')}/api/tracker?op=warmchain&name=${encodeURIComponent(chain)}`;
}

// One HTTP attempt. Never throws — a transport error is a result with `error`.
async function attemptOnce(chain, { appUrl, secret, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS, now = Date.now }) {
  const t0 = now();
  try {
    const r = await fetchImpl(chainUrl(appUrl, chain), {
      headers: { authorization: `Bearer ${secret}`, 'x-warm': '1', accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await r.text().catch(() => '');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* a killed chain may not return JSON */ }
    return { httpStatus: r.status, body, raw: r.ok ? null : raw.slice(0, 300), error: null, ms: now() - t0 };
  } catch (e) {
    return { httpStatus: null, body: null, raw: null, error: errText(e), ms: now() - t0 };
  }
}

// Status vocabulary (also what op=chainsummary stores): ok | failed | http:<code> | no-response.
function gradeAttempt(a) {
  if (!a || a.error || a.httpStatus == null) return { ok: false, status: 'no-response', complete: null, failed: [], skipped: [], failDetail: [], error: (a && a.error) || 'no response' };
  const b = a.body && typeof a.body === 'object' ? a.body : null;
  if (a.httpStatus !== 200) {
    const reason = (b && (b.error || b.reason)) || (a.raw ? a.raw.replace(/\s+/g, ' ').trim() : '') || `HTTP ${a.httpStatus}`;
    return { ok: false, status: `http:${a.httpStatus}`, complete: false, failed: [], skipped: [], failDetail: [], error: String(reason).slice(0, MAX_ERROR_TEXT) };
  }
  const failed = b && Array.isArray(b.failed) ? b.failed : [];
  const skipped = b && Array.isArray(b.skipped) ? b.skipped : [];
  const failDetail = b && Array.isArray(b.failDetail) ? b.failDetail.slice(0, 12) : [];
  const firstDetail = failDetail[0];
  return {
    ok: failed.length === 0,
    status: failed.length ? 'failed' : 'ok',
    complete: b ? b.complete !== false : null,
    failed, skipped, failDetail,
    error: failed.length ? `${failed[0]} ${firstDetail && firstDetail.status ? firstDetail.status : ''} ${firstDetail && firstDetail.error ? firstDetail.error : ''}`.trim().slice(0, MAX_ERROR_TEXT) : null,
  };
}

function shouldRetry(a) {
  if (!a || a.ms >= FAST_FAIL_MS) return false;
  if (a.error) return true;
  return RETRY_STATUSES.has(a.httpStatus);
}

async function runChain(chain, { appUrl = DEFAULT_APP_URL, secret, fetchImpl = globalThis.fetch, now = Date.now, retryDelayMs = RETRY_DELAY_MS, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!CHAINS[chain]) throw new Error(`unknown chain "${chain}" — not in lib/warm-chains.js CHAINS`);
  const startedAt = new Date(now()).toISOString();
  let attempt = null;
  let attempts = 0;
  for (; attempts < MAX_ATTEMPTS; ) {
    attempt = await attemptOnce(chain, { appUrl, secret, fetchImpl, timeoutMs, now });
    attempts += 1;
    if (!shouldRetry(attempt) || attempts >= MAX_ATTEMPTS) break;
    if (retryDelayMs) await sleep(retryDelayMs);
  }
  const grade = gradeAttempt(attempt);
  return {
    chain, ...grade, httpStatus: attempt.httpStatus, attempts,
    elapsedMs: attempt.body && Number.isFinite(attempt.body.elapsedMs) ? attempt.body.elapsedMs : attempt.ms,
    startedAt, finishedAt: new Date(now()).toISOString(),
  };
}

// GitHub workflow-command annotations so the run page names the step that failed.
function annotations(r) {
  const out = [];
  if (r.status === 'skipped:no-secret') out.push(`::warning::CRON_SECRET repo secret not set — skipping chain ${r.chain}. Add it (repo Settings → Secrets and variables → Actions) with the same value as the Vercel Production CRON_SECRET.`);
  else if (!r.ok) out.push(`::error title=chain ${r.chain} ${r.status}::${r.error || 'failed'}${r.failed && r.failed.length ? ` — failed steps: ${r.failed.join(', ')}` : ''} (attempts ${r.attempts})`);
  if (r.skipped && r.skipped.length) out.push(`::warning title=chain ${r.chain} budget-skipped::${r.skipped.join(', ')}`);
  return out;
}

function writeResult(outDir, r) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${r.chain}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 2));
  return file;
}

const parseList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// A chain the preflight found already ok for this ET session (an earlier schedule, a manual
// dispatch, or a retry schedule got to it): report it as such so the summary still covers
// every root, and do not re-run the work — the ops are idempotent per day but not free.
function alreadyOkResult(chain, now = Date.now) {
  const at = new Date(now()).toISOString();
  return { chain, ok: true, status: 'already-ok', attempts: 0, httpStatus: null, complete: true, failed: [], skipped: [], elapsedMs: 0, startedAt: at, finishedAt: at, error: null };
}

async function main(argv = process.argv, env = process.env) {
  const chain = String(argv[2] || '').trim();
  if (!chain) { process.stderr.write('usage: run-nightly-chain.js <chain>\n'); return 2; }
  const outDir = env.OUT_DIR || DEFAULT_OUT_DIR;
  if (parseList(env.ALREADY_OK).includes(chain)) {
    const r = alreadyOkResult(chain);
    writeResult(outDir, r);
    process.stdout.write(`::notice title=chain ${chain} already-ok::completed by an earlier run of this night — not re-run\n`);
    return 0;
  }
  const secret = env.CRON_SECRET || '';
  if (!secret) {
    const r = { chain, ok: true, status: 'skipped:no-secret', attempts: 0, failed: [], skipped: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    writeResult(outDir, r);
    annotations(r).forEach((l) => process.stdout.write(l + '\n'));
    return 0;
  }
  const r = await runChain(chain, { appUrl: env.APP_URL || DEFAULT_APP_URL, secret });
  const file = writeResult(outDir, r);
  process.stdout.write(JSON.stringify({ ...r, failDetail: undefined }) + '\n');
  annotations(r).forEach((l) => process.stdout.write(l + '\n'));
  process.stdout.write(`result → ${file}\n`);
  return r.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`::error::${errText(e)}\n`); process.exit(1); });
}

module.exports = { attemptOnce, gradeAttempt, shouldRetry, runChain, annotations, writeResult, chainUrl, alreadyOkResult, main,
  MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, FAST_FAIL_MS, RETRY_DELAY_MS, RETRY_STATUSES, DEFAULT_OUT_DIR };
