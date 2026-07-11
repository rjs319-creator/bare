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

  // Trend Rider: resolve matured picks → learn per-stock trend quality → log
  // today's light + basket. Self-heals if a slow day skips it.
  const trendtick = await stage('trendtick', '/api/tracker?op=trendtick');

  // Day-Trade momentum/rel-vol screener: resolve matured picks → learn per-stock →
  // log today's picks. Reads the candle caches the screener warm just built.
  const daytradetick = await stage('daytradetick', '/api/tracker?op=daytradetick');

  // Confluence screener: resolve matured picks → learn (per-stock + per-strategy) → log.
  const confluencetick = await stage('confluencetick', '/api/tracker?op=confluencetick');

  // 🧬 Coil Radar — log today's top pre-explosion coil picks for the self-validating ledger.
  const coiltick = await stage('coiltick', '/api/tracker?op=coiltick');

  // ⚡ Gap-and-Go — resolve matured unscheduled gap-up picks + log today's for the ledger.
  const gapgotick = await stage('gapgotick', '/api/tracker?op=gapgotick');

  // 🪁 Down-Day Mode — resolve matured oversold-bounce longs + log today's IF the tape is red.
  const downdaytick = await stage('downdaytick', '/api/tracker?op=downdaytick');

  // 🐻 Gap-Down Continuation — resolve matured gap-down shorts + log today's for the ledger.
  const gapdowntick = await stage('gapdowntick', '/api/tracker?op=gapdowntick');

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

  // 🟢 Timing light — log today's picks' grades (accountability) then run the adaptive
  //    weight tuner (self-improvement; dormant until the ledger matures).
  const timinglog = await stage('timinglog', '/api/tracker?op=timinglog');
  const timingtune = await stage('timingtune', '/api/tracker?op=timingtune');

  // ⏱📈 Dual-horizon read — log today's trending universe tagged by short×long
  //    quadrant, so the pullback-buy vs bear-bounce read is falsifiable.
  const dualreadlog = await stage('dualreadlog', '/api/tracker?op=dualreadlog');
  const dualreadtune = await stage('dualreadtune', '/api/tracker?op=dualreadtune');

  // 🔮 Forecast — resolve matured predictions + (weekly) generate a fresh batch.
  const predicttick = await stage('predicttick', '/api/tracker?op=predicttick');

  // 🎲 Crowd — snapshot prediction-market 24h volume (builds the unusual-activity baseline).
  const crowdtick = await stage('crowdtick', '/api/tracker?op=crowdtick');

  // 🏆 Algo Leaderboard — snapshot the heavy confluence-strategy backtest into the cache.
  const leaderboardtick = await stage('leaderboardtick', '/api/tracker?op=leaderboardtick&src=confluence');

  // 🧭 Brief — log today's stance + resolve matured ones (runs after crowd/predict/tape are warm).
  const brieftick = await stage('brieftick', '/api/tracker?op=brieftick');

  // Core Momentum sleeve: refresh the feature cache (resumable, ~5 daily runs to fully seed),
  // log the book on quarterly rebalance (self-gated), and resolve outcomes for live drift.
  const corebuild = await stage('corebuild', '/api/tracker?op=corebuild');
  const corelog = await stage('corelog', '/api/tracker?op=corelog');
  const coredrift = await stage('coredrift', '/api/tracker?op=coredrift');
  // Fast-vs-sticky attention — cheap (no API): classify the day's archived mentions and
  // log Sticky/Fast names for the Scoreboard. Runs after op=archive wrote today's file.
  const attentiontick = await stage('attentiontick', '/api/tracker?op=attentiontick');
  // Earnings-call tone — LAST on purpose: it makes bounded Claude calls, so if it's
  // slow it never blocks the critical logging ops above. Small per-run limit caps time.
  const tonetick = await stage('tonetick', '/api/tracker?op=tonetick&limit=6');

  const warmedExtra = await extraWarm;   // already resolved — ran during the tail above

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

  const result = { ok: true, host: HOST, warmed: out, warmedExtra, track, narrative, apexlog, ghostlog, archive, intracapture, cern, edgelog, alertsgrade, alertsassess, fadetick, trendtick, daytradetick, confluencetick, coiltick, gapgotick, downdaytick, gapdowntick, timinglog, timingtune, dualreadlog, dualreadtune, predicttick, crowdtick, brieftick, leaderboardtick, corebuild, corelog, coredrift, attentiontick, tonetick, aiTicksKicked: 6, calibKicked: true, stageStatus, elapsedMs: Date.now() - START, at: new Date().toISOString() };

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
