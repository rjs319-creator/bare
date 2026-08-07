'use strict';
// op=warmchain — run one named ordered chain (lib/warm-chains.js) inside THIS invocation's
// own 60s budget.
//
// The whole point: ordering lives here, in the callee, not in api/warm.js. A `.then()`
// chain in warm only advances while warm's event loop is alive, and warm returns at its
// 55s drain ceiling — which is why every 2nd+ link had been silently dying. This
// invocation is independent of whoever dispatched it, so warm only has to get the request
// out of the door.
//
// PRIVILEGED (cron-only): every step is a ledger WRITE or an expensive rebuild
// (op=redundancy&force=1 refetches candles for every ticker in the ledger history), so
// this must never be publicly callable.

const { runChain, CHAINS, CHAIN_DEADLINE_MS } = require('./warm-chains');
const { internalHeaders } = require('./auth');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';

// Durable per-chain report prefix. One INDEPENDENT key per chain (never a shared
// read-modify-write doc — see the apex/insider.json lost-update race): the newest run
// simply overwrites its own key. op=health overlays these onto chains warm's drain did
// not hear back from, so a chain that outlives (or dies after) warm's report window is
// no longer invisible.
const CHAIN_REPORT_PREFIX = 'warm/chains/';
const chainReportPath = (name) => `${CHAIN_REPORT_PREFIX}${name}.json`;

// Compact, health-shaped persistence record (pure — unit-tested without I/O).
function compactChainReport(result, at) {
  return {
    name: result.name,
    at,
    complete: result.complete === true,
    failed: Array.isArray(result.failed) ? result.failed : [],
    skipped: Array.isArray(result.skipped) ? result.skipped : [],
    failDetail: Array.isArray(result.failDetail) ? result.failDetail.slice(0, 12) : [],
    elapsedMs: result.elapsedMs ?? null,
  };
}

// One step = one call to another function (its own 60s). Returns the parsed body too, so
// runChain can propagate a NESTED chain's real outcome (its own steps' failures/skips)
// instead of rubber-stamping the @dispatch — a warmchain returns HTTP 200 even when its
// steps failed, so the truth is only in the body. Never throws: runChain records the
// failure and carries on to the next step.
async function call(path) {
  const r = await fetch('https://' + HOST + path, { headers: internalHeaders() });
  let body = null;
  try { body = await r.json(); } catch { /* a killed/truncated child may not return JSON */ }
  return { ok: r.ok, status: r.status, body };
}

async function runWarmChain(req, res) {
  const name = String((req.query && req.query.name) || '');
  if (!CHAINS[name]) {
    return res.status(400).json({
      ok: false,
      error: `unknown chain "${name}"`,
      known: Object.keys(CHAINS),
    });
  }
  try {
    const result = await runChain(name, { call, deadlineMs: CHAIN_DEADLINE_MS });
    // Per-step lines survive in Vercel logs even if this invocation is later killed —
    // the only way to see a chain's real behaviour, since the cron cannot be hand-triggered.
    console.info('[warmchain]', name, JSON.stringify({
      complete: result.complete, failed: result.failed, skipped: result.skipped, elapsedMs: result.elapsedMs,
    }));
    const at = new Date().toISOString();
    // Persist the report durably (best-effort — a Blob hiccup must not fail the chain).
    // Written with cacheMaxAge 0 so op=health reads the current run, not a CDN-stale one.
    try {
      const store = require('./store');
      if (store.hasStore()) await store.writeJSON(chainReportPath(name), compactChainReport(result, at), 0);
    } catch { /* report persistence is observability, never the work itself */ }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ...result, at });
  } catch (e) {
    console.error('[warmchain]', name, 'error', String((e && e.message) || e));
    return res.status(500).json({ ok: false, name, error: String((e && e.message) || e) });
  }
}

module.exports = { runWarmChain, compactChainReport, chainReportPath, CHAIN_REPORT_PREFIX };
