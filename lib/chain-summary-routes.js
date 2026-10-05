'use strict';
// op=chainsummary — PRIVILEGED (CRON_SECRET bearer), POST-only.
//
// Written once per run by the summary job of .github/workflows/nightly-chains.yml
// (scripts/nightly-chains-summary.js) with the per-chain outcome of the matrix. One
// INDEPENDENT key per TARGET SESSION (chains/<session>.json — the last completed NYSE
// session at run start, never the ET calendar date; see lib/chain-summary.js). Several runs CAN post for the
// same night — a morning `only=` dispatch, the scheduled run, a retry schedule, a manual
// re-run of one red chain — so the write is a compare-and-swap MERGE (lib/store-cas.js
// updateJSON) under the pure rule in lib/chain-summary.js mergeChainSummary: a full run
// replaces the night (earlier posts kept as provenance), a partial run folds its chain
// statuses in. Never a plain readJSON→writeJSON: Blob read-back lags 10-60s and a
// concurrent writer would be erased.

const CS = require('./chain-summary');
const { requireTrusted, requireMethod } = require('./auth');
const STORE = require('./store');

function parseBody(req) {
  let body = req && req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  return body && typeof body === 'object' ? body : null;
}

// CAS-merge the normalised record into the night's doc. Never throws: a conflict that
// outlives the retries (or any store error) is reported as written:false with the reason.
async function mergeIntoNight(store, key, doc) {
  let merged = false;
  try {
    const r = await store.updateJSON(key, (current) => {
      merged = !!current;
      return CS.mergeChainSummary(current, doc);
    }, { initial: null });
    return { written: r.written !== false, merged, attempts: r.attempts ?? null, error: null };
  } catch (e) {
    return { written: false, merged: false, attempts: null, error: String((e && e.message) || e).slice(0, 200) };
  }
}

async function runChainSummary(req, res, { store = STORE, now = Date.now } = {}) {
  if (!requireTrusted(req, res)) return;
  if (!requireMethod(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  const { value, error } = CS.normalizeChainSummary(parseBody(req), { now: now() });
  if (error) return res.status(400).json({ ok: false, error });
  if (!store.hasStore()) {
    // A config gap, not a chain failure: the workflow's summary job must not go red
    // (and e-mail) for a missing Blob token — op=health already reports that.
    return res.status(200).json({ ok: true, written: false, session: value.session, date: value.date, partial: value.partial, chainsOk: value.ok, failed: value.failed, note: 'Blob storage not configured — summary not persisted' });
  }
  const doc = { ...value, receivedAt: new Date(now()).toISOString() };
  const key = CS.summaryPath(value.session);
  const wr = await mergeIntoNight(store, key, doc);
  const status = wr.written ? 200 : 500;
  return res.status(status).json({ ok: wr.written, ...wr, session: value.session, date: value.date, path: key, partial: value.partial, chainsOk: value.ok, failed: value.failed, chainCount: value.chainCount });
}

// Every summary inside the lookback window, newest first (one Blob get per recent ET
// calendar date — every session is one). op=health is CDN-cached for 5 minutes so the cost
// is negligible. A doc whose session (legacy: date) does not match its key is ignored
// rather than trusted.
async function readChainSummaries({ store = STORE, now = Date.now } = {}) {
  if (!store.hasStore()) return [];
  const dates = CS.recentSummaryDates(now());
  const docs = await Promise.all(dates.map((date) => store.readJSON(CS.summaryPath(date), null).catch(() => null)));
  return docs.filter((doc, i) => doc && CS.sessionOf(doc) === dates[i] && doc.chains);
}

module.exports = { runChainSummary, readChainSummaries, mergeIntoNight };
