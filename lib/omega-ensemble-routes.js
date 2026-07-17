'use strict';
// OMEGA ENSEMBLE route (op=ensemble) — folded into api/tracker.js (no new Serverless
// Function; api/ sits at 11 of the 12 Hobby cap and the last slot is not worth a page).
//
// READ-ONLY and derivative BY DESIGN. It self-fetches the two engines that already did
// the work and hands their payloads to the pure view-model in lib/omega-ensemble.js:
//
//   op=today        → the ranked, redundancy-discounted, cost-charged, portfolio-aware board
//   op=evolvehealth → the calibration / deflated-Sharpe validation status
//
// It writes nothing, scores nothing, and caches its own result. If op=today is down the
// view degrades to an explicit "engine unavailable" rather than rendering a stale board.

const { internalHeaders } = require('./auth');
const { buildEnsembleView, VIEW_VERSION } = require('./omega-ensemble');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';

// op=today is a full multi-screener merge and runs ~12.4s COLD. The 12s default used
// elsewhere sits right on that ceiling — which is exactly the bug PR #105 fixed in
// evolve-routes (every deploy flushes the CDN, so the first hit after a deploy is cold
// and a 12s timeout turns a working board into a "degraded" one). The tracker function
// has a 60s budget; give it room.
const TODAY_TIMEOUT = 30000;
const HEALTH_TIMEOUT = 12000;

async function pull(path, timeout) {
  try {
    const r = await fetch('https://' + HOST + path, {
      headers: internalHeaders(), signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return { ok: false, status: r.status, data: null };
    return { ok: true, data: await r.json() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), data: null };
  }
}

async function runEnsemble(req, res) {
  try {
    // Health is best-effort: a missing validation block degrades to "unavailable" in the
    // view, it must never take the page down.
    const [today, health] = await Promise.all([
      pull('/api/tracker?op=today', TODAY_TIMEOUT),
      pull('/api/tracker?op=evolvehealth', HEALTH_TIMEOUT),
    ]);

    const view = buildEnsembleView({
      today: today.ok ? today.data : null,
      health: health.ok ? health.data : null,
    });

    // Mirrors op=today's cache posture — this is a pure projection of it, so it must not
    // be fresher or staler than its own source.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json({
      ok: view.ok,
      version: VIEW_VERSION,
      generatedAt: new Date().toISOString(),
      sources: {
        today: { ok: today.ok, status: today.status || null, error: today.error || null },
        evolvehealth: { ok: health.ok, status: health.status || null, error: health.error || null },
      },
      ...view,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}

module.exports = { runEnsemble };
