'use strict';
// op=chainsummary — PRIVILEGED (CRON_SECRET bearer), POST-only.
//
// Written once per night by the summary job of .github/workflows/nightly-chains.yml
// (scripts/nightly-chains-summary.js) with the per-chain outcome of the matrix. One
// INDEPENDENT key per date (chains/<date>.json) — never a shared read-modify-write doc,
// the Blob lost-update race this codebase has met before. Idempotent: the same run posted
// twice writes the same doc; a newer run for the same date replaces it (latest wins, and
// the runId says which run it was).
//
// Written with writeChecked: Blob overwrites read back stale for 10-60s, so `verified`
// is diagnostic (`written` is the success bit) — exactly the pulse2-store contract.

const CS = require('./chain-summary');
const { requireTrusted, requireMethod } = require('./auth');
const STORE = require('./store');

const READBACK_RETRY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Honest two-part write status (see lib/pulse2-store.js writeChecked). Store-injectable.
async function writeChecked(store, key, doc, predicate, retryMs = READBACK_RETRY_MS) {
  try { await store.writeJSON(key, doc, 0); } catch (e) { return { written: false, verified: false, error: String((e && e.message) || e).slice(0, 200) }; }
  for (const delay of [0, retryMs]) {
    if (delay) await sleep(delay);
    try {
      const back = await store.readJSON(key, null);
      if (back && predicate(back)) return { written: true, verified: true };
    } catch { /* verification only — the write already succeeded */ }
  }
  return { written: true, verified: false };
}

function parseBody(req) {
  let body = req && req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  return body && typeof body === 'object' ? body : null;
}

async function runChainSummary(req, res, { store = STORE, now = Date.now, readbackRetryMs = READBACK_RETRY_MS } = {}) {
  if (!requireTrusted(req, res)) return;
  if (!requireMethod(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  const { value, error } = CS.normalizeChainSummary(parseBody(req), { now: now() });
  if (error) return res.status(400).json({ ok: false, error });
  if (!store.hasStore()) {
    // A config gap, not a chain failure: the workflow's summary job must not go red
    // (and e-mail) for a missing Blob token — op=health already reports that.
    return res.status(200).json({ ok: true, written: false, verified: false, date: value.date, chainsOk: value.ok, failed: value.failed, note: 'Blob storage not configured — summary not persisted' });
  }
  const receivedAt = new Date(now()).toISOString();
  const doc = { ...value, receivedAt };
  const key = CS.summaryPath(value.date);
  const wr = await writeChecked(store, key, doc, (b) => b.runId === doc.runId && b.receivedAt === receivedAt, readbackRetryMs);
  const status = wr.written ? 200 : 500;
  return res.status(status).json({ ok: wr.written, ...wr, date: value.date, path: key, chainsOk: value.ok, failed: value.failed, chainCount: value.chainCount });
}

// Newest summary inside the lookback window, or null. Each probe is one Blob list+get;
// op=health is CDN-cached for 5 minutes so the cost is negligible.
async function readLatestChainSummary({ store = STORE, now = Date.now } = {}) {
  if (!store.hasStore()) return null;
  for (const date of CS.recentSummaryDates(now())) {
    const doc = await store.readJSON(CS.summaryPath(date), null).catch(() => null);
    if (doc && doc.date === date && doc.chains) return doc;
  }
  return null;
}

module.exports = { runChainSummary, readLatestChainSummary, writeChecked };
