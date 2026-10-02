'use strict';
// DIRECT TRIGGER for the nightly-chains workflow — a workflow_dispatch POST from api/warm.js.
//
// With WARM_CHAINS_INPROCESS=0 the Vercel cron (reliable, 22:00 UTC) only warms caches and
// the chains depend on GitHub's `schedule:` trigger, which GitHub explicitly does not
// guarantee and which, for this repo, has lagged by hours (2026-10-02). The retry
// schedules + preflight in .github/workflows/nightly-chains.yml make late runs harmless;
// THIS makes the first run prompt: the cron that just rebuilt the caches asks GitHub to
// start the matrix now. The preflight keeps a dispatched run and a late scheduled run from
// doing the work twice.
//
// DORMANT WITHOUT A SECRET: no GITHUB_DISPATCH_TOKEN → { attempted:false, status:'no-token' }.
// The token is a fine-grained PAT scoped to this one repo with Actions: Read and write
// (docs/nightly-chains-matrix.md "Direct trigger"). Never throws: the cron's own work and
// its health record must not depend on GitHub's API being up.

const REPO = 'rjs319-creator/bare';
const WORKFLOW = 'nightly-chains.yml';
const DEFAULT_REF = 'main';
// GitHub's dispatch endpoint answers in well under a second (it only queues the run). 10 s
// bounds a stalled connection inside warm's 300 s wall without stretching the cron.
const DISPATCH_TIMEOUT_MS = 10000;
const MAX_ERROR_TEXT = 200;
// A successful workflow_dispatch is 204 No Content — nothing else counts.
const DISPATCHED_STATUS = 204;

const dispatchUrl = (repo = REPO, workflow = WORKFLOW) => `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;

async function dispatchNightlyChains({ token = process.env.GITHUB_DISPATCH_TOKEN, fetchImpl = globalThis.fetch, ref = DEFAULT_REF, repo = REPO, workflow = WORKFLOW, timeoutMs = DISPATCH_TIMEOUT_MS, now = Date.now } = {}) {
  if (!token) return { attempted: false, status: 'no-token', ok: false };
  const t0 = now();
  try {
    const r = await fetchImpl(dispatchUrl(repo, workflow), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'market-news-app-warm',
      },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ok = r.status === DISPATCHED_STATUS;
    if (ok) return { attempted: true, status: r.status, ok: true, ms: now() - t0 };
    const raw = await r.text().catch(() => '');
    let message = raw;
    try { message = JSON.parse(raw).message || raw; } catch { /* GitHub errors are JSON {message}; keep the raw text otherwise */ }
    return { attempted: true, status: r.status, ok: false, ms: now() - t0, error: String(message || `HTTP ${r.status}`).replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_TEXT) };
  } catch (e) {
    return { attempted: true, status: null, ok: false, ms: now() - t0, error: String((e && e.message) || e).slice(0, MAX_ERROR_TEXT) };
  }
}

module.exports = { dispatchNightlyChains, dispatchUrl, REPO, WORKFLOW, DEFAULT_REF, DISPATCH_TIMEOUT_MS, DISPATCHED_STATUS };
