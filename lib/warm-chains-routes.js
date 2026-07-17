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

// One step = one call to another function (its own 60s). Never throws: runChain records
// the failure and carries on to the next step.
async function call(path) {
  const r = await fetch('https://' + HOST + path, { headers: internalHeaders() });
  return { ok: r.ok, status: r.status };
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
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ...result, at: new Date().toISOString() });
  } catch (e) {
    console.error('[warmchain]', name, 'error', String((e && e.message) || e));
    return res.status(500).json({ ok: false, name, error: String((e && e.message) || e) });
  }
}

module.exports = { runWarmChain };
