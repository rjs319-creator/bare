// Cron-invoked cache warmer — hits the heavy endpoints so their edge caches are
// fresh (combined with stale-while-revalidate, the app stays instant for users).
const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const { requireTrusted, internalHeaders } = require('../lib/auth');
const WC = require('../lib/warm-chains');

const PATHS = [
  '/api/backtest?scope=large&months=6',
  '/api/backtest?scope=small&months=6',
  '/api/backtest?scope=micro&months=6',
  '/api/screener?scope=large&lookback=1M',
  '/api/screener?scope=small',
  '/api/screener?scope=micro',
  '/api/screener?scope=biotech',   // build candles/biotech.json for the 🧬 Biotech Radar

  '/api/sectors',
  '/api/tracker?op=optionsflow&refresh=1',  // build + log the day's options flow (~1.5s) for the track record
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A warmOne whose DISPATCH is deferred — used to keep the fire-and-forget kicks out of
// the t=0 burst (they each become a heavy invocation of their own). The kick still
// happens while warm is draining the chain reports, long before warm returns.
const delayedWarmOne = (path, delayMs) => (async () => {
  if (delayMs) await sleep(delayMs);
  return warmOne(path);
})().catch(() => null);

async function warmOne(p) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://' + HOST + p, { headers: internalHeaders() });
    return { p, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { p, error: String(e && e.message || e), ms: Date.now() - t0 };
  }
}

// A warmchain dispatch, WITH its response body. A chain returns HTTP 200 even when its
// steps failed or budget-skipped (the ok/failed/skipped truth is in the body, not the
// status) — so reading only r.status here would re-create the exact "200 == healthy" blind
// spot the chain refactor was built to remove, one layer up. This parses the body so a
// chain's real outcome reaches op=health instead of only the [warmchain] log lines.
async function warmChainOne(name) {
  const t0 = Date.now();
  try {
    const r = await fetch(`https://${HOST}/api/tracker?op=warmchain&name=${name}`, { headers: internalHeaders() });
    let body = null;
    try { body = await r.json(); } catch { /* a truncated/killed chain may not return JSON */ }
    return { name, httpStatus: r.status, body, ms: Date.now() - t0 };
  } catch (e) {
    return { name, error: String((e && e.message) || e), ms: Date.now() - t0 };
  }
}


module.exports = async function handler(req, res) {
  // Gate the cron entrypoint: Vercel auto-sends the CRON_SECRET bearer on scheduled
  // runs; when the secret is unset this fails open (deploy-safe). See lib/auth.js.
  if (!requireTrusted(req, res)) return;

  const START = Date.now();
  const queue = [...PATHS], out = [];
  async function worker() { while (queue.length) out.push(await warmOne(queue.shift())); }
  await Promise.all([worker(), worker(), worker()]); // 3 at a time

  // Warm the heavier non-default screener lookbacks (3M/6M) in the BACKGROUND,
  // concurrently with the sequential logging below. These are separate function
  // invocations that populate the CDN cache on their own, so switching the
  // Screener's 1M/3M/6M selector isn't a ~23s cold scan. We don't block the cron's
  // critical path on them — they're awaited at the very end (by then already done,
  // since the logging tail runs longer than a single scan).
  const EXTRA = ['/api/screener?scope=large&lookback=3M', '/api/screener?scope=large&lookback=6M'];
  const extraWarm = Promise.all(EXTRA.map(warmOne)).catch(() => []);

  // ── ORDERED WORK RUNS IN ITS OWN INVOCATIONS (see lib/warm-chains.js) ──────
  //
  // These stages used to be awaited HERE, sequentially. The Vercel logs showed what that
  // cost: track 12.7s + narrative 0.1s + apexlog 6.8s + ghostlog 10.2s on top of ~22s of
  // cache warming meant elapsed was already 51.8s by the `archive` stage — so archive,
  // intracapture, cern, edgelog, alertsgrade, alertsassess and fadetick recorded
  // `skipped:budget` on EVERY run, and everything below (the tick chains and every
  // ordered kick) was created with ~3s left of the 55s drain ceiling.
  //
  // Now warm DISPATCHES each root chain and the chain runs its steps inside its own
  // tracker invocation, with its own 60s budget, independent of warm's lifetime. Warm
  // still awaits them in the bounded drain below, but only to REPORT: a truncated report
  // no longer means the work was lost, because the chain is not running in this process.
  // STAGGERED dispatch (see lib/warm-chains.js dispatchDelayMs): a simultaneous 30+ chain
  // burst shared Fluid instances and got /api/tracker OOM-killed on every cron run
  // 2026-08-07 → 2026-08-11, taking down whichever unrelated invocations were in flight.
  // Waves flatten the peak; every chain is still dispatched well inside the drain below.
  const chainKicks = WC.ROOT_CHAINS.map((name, i) => ({
    name,
    p: (async () => {
      const delay = WC.dispatchDelayMs(i);
      if (delay) await sleep(delay);
      return warmChainOne(name);
    })().catch(e => ({ name, error: String((e && e.message) || e) })),
  }));

  // NOTE: the per-screener resolve/learn/log ticks (trend, daytrade, confluence, coil,
  // gap-go, down-day, gap-down, timing, dual-read, predict, crowd, brief, leaderboard,
  // core, attention, tone) are NO LONGER awaited here — running them sequentially blew
  // warm's 60s wall so the tail was deferred every run. They're now dispatched as
  // fire-and-forget CHAINS below (see tickChains), off warm's critical path.

  // ── 5 AI-reasoning screeners (Read-Through / Stealth / Second Wave / Cross-Asset / Tone
  // Shift) — each tick is SELF-CONTAINED (detect + AI + forward-log + cache) in its own 60s
  // invocation. FIRE-AND-FORGET: we kick them and do NOT await (awaiting the slow AI calls
  // is what blew warm's own 60s wall → 504). The kicks dispatch during warm's long tail
  // below; each tick then runs + logs independently of warm's lifetime. `.catch` only to
  // avoid unhandled rejections.
  // Deferred to the third dispatch wave: 6 more simultaneous heavy invocations at t=0
  // were part of the OOM burst the staggering exists to remove.
  const AI_TICKS_DELAY_MS = 2 * WC.DISPATCH_WAVE_GAP_MS;
  const aiTicks = [
    '/api/tracker?op=readthroughtick', '/api/tracker?op=anomalytick', '/api/tracker?op=secondwavetick',
    '/api/tracker?op=crossassettick', '/api/tracker?op=toneshifttick', '/api/tracker?op=biotechtick',
  ].map(p => delayedWarmOne(p, AI_TICKS_DELAY_MS));

  // 🧠 Options-flow Fable analysis — reads today's flow snapshot (built by op=optionsflow
  // in PATHS above) and writes per-ticker trade plans + a desk read + stamps the ledger
  // for the A/B. Fire-and-forget: it's a ~30-50s Fable call in its own 60s budget, so it
  // must NOT be awaited on warm's critical path.
  const SINGLE_KICKS_DELAY_MS = 3 * WC.DISPATCH_WAVE_GAP_MS;
  const optionsAssessKick = delayedWarmOne('/api/tracker?op=optionsassess', SINGLE_KICKS_DELAY_MS);

  // ── SINGLE-DISPATCH KICKS ──────────────────────────────────────────────────
  // These were never broken by the .then()-chain bug: one dispatch each, no ordering, so
  // the request going out is the whole job. They stay here rather than becoming chains.
  // All deferred to the last dispatch wave (same OOM-burst reasoning as the chains);
  // op=optionsassess / op=optionsepisodes additionally get their op=optionsflow input
  // built by PATHS long before the delay elapses.
  //
  // 💰 Options Moves — put-selling setups (full-market scan + IV/earnings).
  const putsellKick = delayedWarmOne('/api/tracker?op=putsell', SINGLE_KICKS_DELAY_MS);
  // 📏 Options episode grading — next-open, SPY-relative, cost-aware grading of the
  // immutable decision episodes (folded by op=optionsflow above). Heavy (candle fetches
  // per resolvable episode) → its own 60s budget, off warm's critical path.
  const optionsEpisodesKick = delayedWarmOne('/api/tracker?op=optionsepisodes&refresh=1', SINGLE_KICKS_DELAY_MS);
  // Predict-tab feedback loop — recompute each class's Wilson-bounded track-record grade
  // so cards auto-feature/demote as picks resolve. Heavy (fetches history), own budget.
  const calibKick = delayedWarmOne('/api/tracker?op=calibration&force=1', SINGLE_KICKS_DELAY_MS);
  // 🧪 Baseline factor scan — refresh the point-in-time cross-section (rank-IC + top-
  // quintile excess for momentum / 52-week / rel-volume) that the Baselines tab reads via
  // op=baselines. The bearer (internalHeaders) exempts it from the op=research rate limit.
  const researchKick = delayedWarmOne('/api/tracker?op=research&scope=large', SINGLE_KICKS_DELAY_MS);
  // 🧬 Biotech episode grading — next-open, XBI-relative, multi-horizon (3/5/10/21) grading of
  // the biotech research ledger, stratified by archetype. Heavy (candle fetch per ledger
  // ticker) → its own 60s budget, off warm's critical path. Shadow measurement only.
  const biotechGradeKick = delayedWarmOne('/api/tracker?op=biotechgrade', SINGLE_KICKS_DELAY_MS);

  // The tick chains are now warmchain roots (ticks1/ticks2/ticks3 in lib/warm-chains.js).
  // They were previously built HERE as `.then()` chains and drained for whatever was left
  // of a 55s ceiling — which, past the 51.8s of awaited stages, was ~3s for all 20 ticks.

  const warmedExtra = await extraWarm;   // already resolved — ran during the tail above

  // Await the dispatched chains only to REPORT. Each is running in its own tracker
  // invocation with its own budget, so this deadline decides how much we get to SAY
  // about them, not how much of them runs. That is the whole point of the fix: warm's
  // death used to kill the work; now it only truncates the report.
  //
  // RAISED 55s → 280s with warm's maxDuration raise to 300s (vercel.json): at the old
  // ceiling, 10 of 27 roots were still running when warm reported, so their outcomes
  // (including the 2026-08-06 `ledger` @decision budget-skip and four wall-killed
  // chains) never reached op=health — it showed green while the day's decision snapshot
  // was silently lost. The chains' own deadline is 240s, so 280s hears ~every report.
  const DRAIN_CEIL_MS = 280000;
  const chainReports = {};
  await Promise.race([
    Promise.all(chainKicks.map(async (k) => {
      const r = await k.p;
      if (r && r.error) { chainReports[k.name] = { dispatched: true, reportError: r.error }; return; }
      // A warmchain ALWAYS returns HTTP 200 (unknown-name→400, throw→500), so the status
      // alone hides a chain whose STEPS failed or budget-skipped — the ok/failed/skipped
      // truth is in the body. Surface it, so op=health grades the real outcome instead of
      // rubber-stamping every 200. This is the same "200 == healthy" trap, one layer up.
      const b = r && r.body;
      // A chain-level NON-200 with a JSON body is the warmchain handler's own catch
      // ({ok:false, error}) — that body has no `complete` field, so the old
      // `complete: b.complete !== false` recorded the crashed chain as complete:true and
      // DROPPED the error text. Grade non-200 as failed and surface the error.
      const chainOk = !r || r.httpStatus == null || r.httpStatus === 200;
      chainReports[k.name] = b && typeof b === 'object'
        ? { dispatched: true, httpStatus: r.httpStatus, complete: chainOk ? b.complete !== false : false,
            ...(chainOk ? {} : { chainError: String(b.error || `chain HTTP ${r.httpStatus}`).slice(0, 200) }),
            stepFails: Array.isArray(b.failed) ? b.failed : [], skipped: Array.isArray(b.skipped) ? b.skipped : [],
            // The status/error behind each failed step. Names alone cannot distinguish a
            // 401 from a 504 from a throw, which left the evolve sub-chain's 3-run fail
            // streak undiagnosable from op=health.
            stepFailDetail: Array.isArray(b.failDetail) ? b.failDetail.slice(0, 12) : [] }
        : { dispatched: true, httpStatus: (r && r.httpStatus) || null, complete: null };
    })),
    new Promise(r => setTimeout(r, Math.max(0, DRAIN_CEIL_MS - (Date.now() - START)))),
  ]);
  // A chain we didn't hear back from is STILL RUNNING — not failed, and not skipped. The
  // honest word is "running", not the old "deferred, self-heals next run" (which it wasn't).
  for (const k of chainKicks) if (!chainReports[k.name]) chainReports[k.name] = { dispatched: true, status: 'running-past-warm' };

  // The 6 AI screener ticks are kicked fire-and-forget — a single dispatch each, which is
  // all they need (no ordering), so unlike the old .then() chains they were never broken.
  void aiTicks;
  void calibKick;         // single dispatch: recomputes in its own invocation
  void researchKick;      // single dispatch: refresh the baseline factor cross-section
  void optionsAssessKick; // single dispatch: Fable options-flow analysis in its own budget
  void putsellKick;       // single dispatch: put-selling setups scan
  void optionsEpisodesKick; // single dispatch: episode grading in its own budget
  void biotechGradeKick;  // single dispatch: biotech episode grading in its own budget

  const chainsDispatched = chainKicks.length;
  const result = {
    ok: true, host: HOST, warmed: out, warmedExtra,
    // Ordered work now lives in lib/warm-chains.js. Each root reports dispatched + its
    // own per-step outcome in its OWN logs ([warmchain] <name>); a chain still running
    // when warm returns is normal and no longer means the work was lost.
    chains: chainReports, chainsDispatched, chainRoots: WC.ROOT_CHAINS,
    aiTicksKicked: 6, calibKicked: true, researchKicked: true,
    elapsedMs: Date.now() - START, at: new Date().toISOString(),
  };

  // Structured run summary — survives in Vercel logs even if the health write fails.
  // Per-STEP outcomes now live in each chain's own [warmchain] <name> log line; warm only
  // knows what it dispatched and what reported back before its ceiling.
  console.info('[warm] done', JSON.stringify({ elapsedMs: result.elapsedMs, chainsDispatched, chains: chainReports }));

  // Observability: persist a compact health record so failed ticks / stale data are visible (op=health).
  try { const { summarizeRun, writeHealthRun } = require('../lib/health'); await writeHealthRun(summarizeRun(result)); }
  catch (e) { result.healthLogError = String(e && e.message || e); }

  res.setHeader('Cache-Control', 'no-store');
  return res.json(result);
};
