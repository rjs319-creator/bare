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
// RETRY POLICY — two attempts. The second is taken when EITHER:
//   • the first failed FAST (transport error or an edge 429/502/503 inside FAST_FAIL_MS) —
//     the chain never ran; or
//   • the first was a PLATFORM CRASH, at any elapsed time: a Vercel FUNCTION_INVOCATION_FAILED
//     500 / a 502 / a 503 on the chain itself, or one of its steps failing that way. On
//     2026-10-01 (insidercluster) and 2026-10-02 (capture, universe, pulse, pattern, pitdata)
//     one Fluid-compute instance hosting several heavy invocations died (OOM) and took every
//     co-located request with it at the same instant — no code defect, just a shared kill.
//     That retry waits CRASH_RETRY_DELAY_MS so the dead instance is replaced and the siblings
//     that shared it have finished or failed before we go again.
// Otherwise a slow failure is NOT retried: the chain ran, its steps are idempotent per day
// but not free, and a 504 at the function wall already means the work happened. The crash
// case is the one exception because every chain op is idempotent per DATE (each tick keys
// its writes by the session date and re-resolves what is still open), so re-running a
// crashed chain resumes the night rather than duplicating it.
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
// Platform-crash retry: 60-90 s is long enough for the killed Fluid instance to be replaced
// and for the sibling jobs that shared it to land, short enough that two full attempts plus
// this delay (290 + 75 + 290 s) still fit the job's timeout-minutes: 12.
const CRASH_RETRY_DELAY_MS = 75000;
const CRASH_STATUSES = new Set([502, 503]);
const CRASH_MARKER = /FUNCTION_INVOCATION_FAILED/;
const MAX_ERROR_TEXT = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String((e && e.message) || e).slice(0, MAX_ERROR_TEXT);

function chainUrl(appUrl, chain) {
  return `${appUrl.replace(/\/$/, '')}/api/tracker?op=warmchain&name=${encodeURIComponent(chain)}`;
}

// One HTTP attempt. Never throws — a transport error is a result with `error`.
// `endMs` (the instant the response/failure arrived) anchors the step failure times below.
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
    const endMs = now();
    return { httpStatus: r.status, body, raw: r.ok ? null : raw.slice(0, 300), error: null, ms: endMs - t0, endMs };
  } catch (e) {
    const endMs = now();
    return { httpStatus: null, body: null, raw: null, error: errText(e), ms: endMs - t0, endMs };
  }
}

// WHEN did each failed step fail? The chain body has per-step durations (`steps[].ms`) and
// its own total (`elapsedMs`), so anchoring on the instant the response arrived gives each
// step's end to within the response latency — close enough for the 5 s peer-crash window
// the summary uses (scripts/nightly-chains-summary.js). A nested child's failure
// (`decision/op=x`) is stamped with its parent `@decision` step's end.
function stampFailDetail(body, failDetail, endMs) {
  const steps = body && Array.isArray(body.steps) ? body.steps : [];
  const total = body && Number.isFinite(body.elapsedMs) ? body.elapsedMs : null;
  let cum = 0;
  const endByOp = {};
  for (const st of steps) {
    cum += Number.isFinite(st && st.ms) ? st.ms : 0;
    if (st && typeof st.op === 'string') endByOp[st.op] = cum;
  }
  if (total == null || !Number.isFinite(endMs)) return failDetail.map((d) => ({ ...d, at: null }));
  return failDetail.map((d) => {
    const key = typeof d.op === 'string' && d.op.includes('/') ? `@${d.op.split('/')[0]}` : d.op;
    const cumEnd = endByOp[key];
    return { ...d, at: cumEnd == null ? null : new Date(endMs - (total - cumEnd)).toISOString() };
  });
}

// Did a Fluid instance die under this attempt (or under one of the chain's steps)? At the
// chain level a 502/503 can only be the platform (the chain handler itself never sends
// them). At the STEP level a 503 is NOT a kill — the app uses it deliberately (fail-closed
// auth, challengerlog's empty-board refusal) — so only the Vercel marker and a 502 count.
function isPlatformCrash(a, grade) {
  if (!a) return false;
  if (a.httpStatus != null && (CRASH_STATUSES.has(a.httpStatus) || (a.httpStatus === 500 && CRASH_MARKER.test(a.raw || '')))) return true;
  const details = (grade && grade.failDetail) || [];
  return details.some((d) => d && (d.status === 'http:502' || (d.status === 'http:500' && CRASH_MARKER.test(String(d.error || '')))));
}

// The failure instants of one attempt (ISO), for the summary's co-located-crash detector.
function failureInstants(a, grade) {
  if (!grade || grade.ok) return [];
  if (grade.status === 'failed') return (grade.failDetail || []).map((d) => d.at).filter(Boolean);
  return Number.isFinite(a && a.endMs) ? [new Date(a.endMs).toISOString()] : [];
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
  const failDetail = stampFailDetail(b, b && Array.isArray(b.failDetail) ? b.failDetail.slice(0, 12) : [], a.endMs);
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

async function runChain(chain, { appUrl = DEFAULT_APP_URL, secret, fetchImpl = globalThis.fetch, now = Date.now, retryDelayMs = RETRY_DELAY_MS, crashRetryDelayMs = CRASH_RETRY_DELAY_MS, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!CHAINS[chain]) throw new Error(`unknown chain "${chain}" — not in lib/warm-chains.js CHAINS`);
  const startedAt = new Date(now()).toISOString();
  let attempt = null;
  let grade = null;
  let attempts = 0;
  let crashRetry = false;
  const attemptFailures = [];
  for (; attempts < MAX_ATTEMPTS; ) {
    attempt = await attemptOnce(chain, { appUrl, secret, fetchImpl, timeoutMs, now });
    grade = gradeAttempt(attempt);
    attempts += 1;
    attemptFailures.push(...failureInstants(attempt, grade));
    if (grade.ok || attempts >= MAX_ATTEMPTS) break;
    if (shouldRetry(attempt)) { if (retryDelayMs) await sleep(retryDelayMs); continue; }
    if (isPlatformCrash(attempt, grade)) { crashRetry = true; if (crashRetryDelayMs) await sleep(crashRetryDelayMs); continue; }
    break;
  }
  return {
    chain, ...grade, httpStatus: attempt.httpStatus, attempts, crashRetry,
    elapsedMs: attempt.body && Number.isFinite(attempt.body.elapsedMs) ? attempt.body.elapsedMs : attempt.ms,
    // Every failure instant across attempts (ISO) — the summary job clusters these across
    // chains to label a co-located instance crash instead of N separate defects.
    attemptFailures,
    failedAt: grade.ok ? null : (attemptFailures[attemptFailures.length - 1] || null),
    startedAt, finishedAt: new Date(now()).toISOString(),
  };
}

// GitHub workflow-command annotations so the run page names the step that failed.
function annotations(r) {
  const out = [];
  if (r.status === 'skipped:no-secret') out.push(`::warning::CRON_SECRET repo secret not set — skipping chain ${r.chain}. Add it (repo Settings → Secrets and variables → Actions) with the same value as the Vercel Production CRON_SECRET.`);
  else if (!r.ok) out.push(`::error title=chain ${r.chain} ${r.status}::${r.error || 'failed'}${r.failed && r.failed.length ? ` — failed steps: ${r.failed.join(', ')}` : ''} (attempts ${r.attempts}${r.crashRetry ? ', retried after a platform crash' : ''})`);
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

module.exports = { attemptOnce, gradeAttempt, shouldRetry, isPlatformCrash, stampFailDetail, failureInstants, runChain, annotations, writeResult, chainUrl, alreadyOkResult, main,
  MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, FAST_FAIL_MS, RETRY_DELAY_MS, CRASH_RETRY_DELAY_MS, RETRY_STATUSES, CRASH_STATUSES, DEFAULT_OUT_DIR };
