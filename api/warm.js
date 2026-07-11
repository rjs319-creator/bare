// Cron-invoked cache warmer — hits the heavy endpoints so their edge caches are
// fresh (combined with stale-while-revalidate, the app stays instant for users).
const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const { requireTrusted, internalHeaders } = require('../lib/auth');

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

async function warmOne(p) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://' + HOST + p, { headers: internalHeaders() });
    return { p, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { p, error: String(e && e.message || e), ms: Date.now() - t0 };
  }
}

// Soft budget: stop STARTING new awaited stages once this much of the 60s function
// wall is gone, so late jobs record skipped:'budget' instead of silently vanishing
// when the run 504s. Fire-and-forget kicks run in their own invocations regardless.
const SOFT_BUDGET_MS = 50000;

module.exports = async function handler(req, res) {
  // Gate the cron entrypoint: Vercel auto-sends the CRON_SECRET bearer on scheduled
  // runs; when the secret is unset this fails open (deploy-safe). See lib/auth.js.
  if (!requireTrusted(req, res)) return;

  const START = Date.now();
  const stageStatus = {};   // name -> 'ok' | 'http:<code>' | 'error' | 'skipped:budget'

  // Run one awaited sub-request, budget-aware and observable. Past the soft budget
  // it records a skip and returns immediately so the run finishes and still writes a
  // health record. Per-stage console lines survive even a partial (504'd) run.
  async function stage(name, path) {
    if (Date.now() - START > SOFT_BUDGET_MS) {
      stageStatus[name] = 'skipped:budget';
      console.info('[warm]', name, 'skipped:budget', (Date.now() - START) + 'ms elapsed');
      return { skipped: 'budget' };
    }
    const t0 = Date.now();
    try {
      const r = await fetch('https://' + HOST + path, { headers: internalHeaders() });
      const j = await r.json();
      stageStatus[name] = r.ok ? 'ok' : ('http:' + r.status);
      console.info('[warm]', name, stageStatus[name], (Date.now() - t0) + 'ms');
      return j;
    } catch (e) {
      stageStatus[name] = 'error';
      console.error('[warm]', name, 'error', String(e && e.message || e));
      return { error: String(e && e.message || e) };
    }
  }

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

  // Once caches are fresh, snapshot today's picks for the scoreboard (one cron
  // does both — warm then log — so we stay within Vercel cron limits).
  const track = await stage('track', '/api/tracker?op=track');

  // Refresh this week's market-narrative tag (cheap; no-ops if already set this week),
  // THEN log today's Apex/Loaded signals so they're stamped with the current tag.
  const narrative = await stage('narrative', '/api/tracker?op=narrative');

  const apexlog = await stage('apexlog', '/api/tracker?op=apexlog');

  // Log today's Ghost/Stalking signals to their own ledger (Phase-2 adaptive engine).
  const ghostlog = await stage('ghostlog', '/api/tracker?op=ghostlog');

  // Snapshot today's per-ticker mention counts + options baselines — the
  // unrecoverable data capture (option chains & social mentions can't be
  // reconstructed historically). One Blob write per day.
  const archive = await stage('archive', '/api/tracker?op=archive');

  // Accrue the prior completed session's 5-min bars for the day-trade picks (regime-
  // tagged) so the regime-conditional opening-range-gate hypothesis can be re-validated
  // once neutral/risk-off fader days accumulate. Own tracker call = own 60s budget.
  const intracapture = await stage('intracapture', '/api/tracker?op=intracapture');

  // Run one CERN daily cycle — scan for forced-flow events, advance/resolve the
  // ledger, update the Bayesian posteriors. The counterfactual archive is the moat.
  const cern = await stage('cern', '/api/tracker?op=cerntick');

  // Snapshot the two-sleeve Edge Book (conviction longs + CERN forced-flow) AFTER
  // the CERN tick so Sleeve B reflects the freshest decisions. This is the paper
  // book whose realized beat-SPY rate + cross-sleeve correlation we track.
  const edgelog = await stage('edgelog', '/api/tracker?op=edgelog');

  // Grade any matured trade-alerts on forward excess return (hands-off track record).
  const alertsgrade = await stage('alertsgrade', '/api/tracker?op=alertsgrade');

  // Bounded Fable-5 review over the current top ranked alerts: annotate cards and
  // stamp the pending log entries with Fable's direction for the A/B edge test.
  const alertsassess = await stage('alertsassess', '/api/tracker?op=alertsassess');

  // Self-improving fade engine: resolve matured logged shorts → update per-stock
  // posteriors → log today's setups. Last (candle data is CDN-warm by now); a
  // skipped slow day self-heals next run (it re-resolves all still-open signals).
  const fadetick = await stage('fadetick', '/api/tracker?op=fadetick');

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
  const aiTicks = [
    '/api/tracker?op=readthroughtick', '/api/tracker?op=anomalytick', '/api/tracker?op=secondwavetick',
    '/api/tracker?op=crossassettick', '/api/tracker?op=toneshifttick', '/api/tracker?op=biotechtick',
  ].map(p => warmOne(p).catch(() => null));

  // 🧠 Options-flow Fable analysis — reads today's flow snapshot (built by op=optionsflow
  // in PATHS above) and writes per-ticker trade plans + a desk read + stamps the ledger
  // for the A/B. Fire-and-forget: it's a ~30-50s Fable call in its own 60s budget, so it
  // must NOT be awaited on warm's critical path.
  const optionsAssessKick = warmOne('/api/tracker?op=optionsassess').catch(() => null);

  // 🎯 Dual Confirmed — scan for names that are a buy on BOTH horizons, THEN log
  // today's picks to the ledger (accountability). Fire-and-forget: intraday reads.
  const alignedKick = warmOne('/api/tracker?op=aligned')
    .then(() => warmOne('/api/tracker?op=alignedlog'))
    .catch(() => null);

  // 💰 Options Moves — put-selling setups (full-market price-action scan + IV/earnings).
  const putsellKick = warmOne('/api/tracker?op=putsell').catch(() => null);

  // 🌐 Expanded universe — self-completing: scan 2 cursor-paced batches/day (fills
  // the free full-market candle cache over ~2 weeks, then refreshes continuously),
  // then reassemble the cache from its shards.
  const universeKick = warmOne('/api/tracker?op=universescan&cursor=1&limit=150')
    .then(() => warmOne('/api/tracker?op=universescan&cursor=1&limit=150'))
    .then(() => warmOne('/api/tracker?op=universecompile'))
    .catch(() => null);

  // 📡 Market Pulse — pre-build a refined snapshot so users hit the cache instantly:
  // gather (Haiku search, forced) THEN refine (Fable) in its own chained invocation.
  // Fire-and-forget off warm's critical path — each stage is its own 60s budget.
  const pulseKick = warmOne('/api/tracker?op=pulse&force=1')
    .then(() => warmOne('/api/tracker?op=pulserefine&force=1'))
    .catch(() => null);

  // Predict-tab feedback loop — recompute each class's live track-record grade (Wilson-
  // bounded excess vs sector) so the cards auto-feature/demote classes as picks resolve.
  // Fire-and-forget: it resolves only picks ≥1 week old, so it's independent of today's
  // ticks above, and it's heavy enough (fetches history) to keep off warm's critical path.
  const calibKick = warmOne('/api/tracker?op=calibration&force=1').catch(() => null);

  // ── DECOUPLED TICK CHAINS ──────────────────────────────────────────────────
  // The resolve/learn/log ticks run as fire-and-forget CHAINS (not awaited on the
  // critical path). Each chain runs its ops sequentially in their own invocations
  // (own 60s budget each), so ORDERED ops stay ordered (timinglog→tune, dual-read
  // log→tune, core build→log→drift, brief after predict/crowd). 3 chains = ~3× the
  // throughput of the old sequential tail while bounding concurrent feed load. They
  // progress during the bounded drain below; any tail op not reached self-heals next
  // run (each tick re-resolves all still-open signals). Uses warmOne (not the
  // budget-guarded stage()) so they're not skipped past the 50s soft budget.
  const tickChain = ops => ops.reduce((prev, op) => prev.then(() => warmOne(op).catch(() => null)), Promise.resolve());
  const tickChains = [
    // screener + event ticks (order-independent)
    tickChain(['/api/tracker?op=trendtick', '/api/tracker?op=daytradetick', '/api/tracker?op=confluencetick',
      '/api/tracker?op=coiltick', '/api/tracker?op=gapgotick', '/api/tracker?op=downdaytick', '/api/tracker?op=gapdowntick']),
    // timing + dual-read (ordered pairs) then the predict family (brief after predict+crowd)
    tickChain(['/api/tracker?op=timinglog', '/api/tracker?op=timingtune', '/api/tracker?op=dualreadlog',
      '/api/tracker?op=dualreadtune', '/api/tracker?op=predicttick', '/api/tracker?op=crowdtick', '/api/tracker?op=brieftick']),
    // leaderboard (heavy) then core (ordered build→log→drift) then cheap attention/tone
    tickChain(['/api/tracker?op=leaderboardtick&src=confluence', '/api/tracker?op=corebuild', '/api/tracker?op=corelog',
      '/api/tracker?op=coredrift', '/api/tracker?op=attentiontick', '/api/tracker?op=tonetick&limit=6']),
  ];

  const warmedExtra = await extraWarm;   // already resolved — ran during the tail above

  // Drain the tick chains within the remaining budget, capped well under the 60s hard
  // limit (a hard timeout is a 504). The critical logging above already committed; this
  // is best-effort for the decoupled ticks. Whatever a chain doesn't reach self-heals
  // next run — strictly better than the old behavior where the whole tail was deferred.
  const DRAIN_CEIL_MS = 55000;
  await Promise.race([
    Promise.allSettled(tickChains),
    new Promise(r => setTimeout(r, Math.max(0, DRAIN_CEIL_MS - (Date.now() - START)))),
  ]);

  // The 5 AI screener ticks were kicked fire-and-forget (not awaited) — they self-log to
  // their own ledgers in their own invocations. `aiTicksKicked` just confirms the fetches
  // were dispatched; we do NOT block warm's return on the ~30-50s AI calls (that caused the
  // 504). void-reference so the array isn't dropped before the requests flush.
  void aiTicks;
  void calibKick; // fire-and-forget like the ticks — recomputes on its own invocation
  void pulseKick; // fire-and-forget: gather→refine chain builds the refined Pulse snapshot
  void optionsAssessKick; // fire-and-forget: Fable options-flow analysis in its own budget
  void alignedKick; // fire-and-forget: Dual-Confirmed scan over the warm screener pool
  void putsellKick; // fire-and-forget: put-selling setups scan
  void universeKick; // fire-and-forget: reassemble the expanded candle cache

  // The 20 resolve/learn/log ticks are decoupled (fire-and-forget chains, see above) —
  // no longer awaited stage() results, so they're not per-step keys here. Each self-logs
  // to its own ledger; ledger freshness is the source of truth for them now.
  const ticksDecoupled = 20;
  const result = { ok: true, host: HOST, warmed: out, warmedExtra, track, narrative, apexlog, ghostlog, archive, intracapture, cern, edgelog, alertsgrade, alertsassess, fadetick, ticksDecoupled, aiTicksKicked: 6, calibKicked: true, stageStatus, elapsedMs: Date.now() - START, at: new Date().toISOString() };

  // Structured run summary — survives in Vercel logs even if the health write fails.
  const skipped = Object.keys(stageStatus).filter(k => stageStatus[k] === 'skipped:budget');
  const failed = Object.keys(stageStatus).filter(k => stageStatus[k] === 'error' || String(stageStatus[k]).startsWith('http:'));
  console.info('[warm] done', JSON.stringify({ elapsedMs: result.elapsedMs, stages: Object.keys(stageStatus).length, failed, skipped }));

  // Observability: persist a compact health record so failed ticks / stale data are visible (op=health).
  try { const { summarizeRun, writeHealthRun } = require('../lib/health'); await writeHealthRun(summarizeRun(result)); }
  catch (e) { result.healthLogError = String(e && e.message || e); }

  res.setHeader('Cache-Control', 'no-store');
  return res.json(result);
};
