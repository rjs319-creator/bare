// Cron-invoked cache warmer — hits the heavy endpoints so their edge caches are
// fresh (combined with stale-while-revalidate, the app stays instant for users).
const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';

const PATHS = [
  '/api/backtest?scope=large&months=6',
  '/api/backtest?scope=small&months=6',
  '/api/backtest?scope=micro&months=6',
  '/api/screener?scope=large&lookback=1M',
  '/api/screener?scope=small',
  '/api/screener?scope=micro',
  '/api/sectors',
  '/api/tracker?op=optionsflow&refresh=1',  // build + log the day's options flow (~1.5s) for the track record
];

async function warmOne(p) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://' + HOST + p, { headers: { 'x-warm': '1' } });
    return { p, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { p, error: String(e && e.message || e), ms: Date.now() - t0 };
  }
}

module.exports = async function handler(req, res) {
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
  let track = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=track', { headers: { 'x-warm': '1' } });
    track = await r.json();
  } catch (e) { track = { error: String(e && e.message || e) }; }

  // Refresh this week's market-narrative tag (cheap; no-ops if already set this week),
  // THEN log today's Apex/Loaded signals so they're stamped with the current tag.
  let narrative = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=narrative', { headers: { 'x-warm': '1' } });
    narrative = await r.json();
  } catch (e) { narrative = { error: String(e && e.message || e) }; }

  let apexlog = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=apexlog', { headers: { 'x-warm': '1' } });
    apexlog = await r.json();
  } catch (e) { apexlog = { error: String(e && e.message || e) }; }

  // Log today's Ghost/Stalking signals to their own ledger (Phase-2 adaptive engine).
  let ghostlog = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=ghostlog', { headers: { 'x-warm': '1' } });
    ghostlog = await r.json();
  } catch (e) { ghostlog = { error: String(e && e.message || e) }; }

  // Snapshot today's per-ticker mention counts + options baselines — the
  // unrecoverable data capture (option chains & social mentions can't be
  // reconstructed historically). One Blob write per day.
  let archive = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=archive', { headers: { 'x-warm': '1' } });
    archive = await r.json();
  } catch (e) { archive = { error: String(e && e.message || e) }; }

  // Accrue the prior completed session's 5-min bars for the day-trade picks (regime-
  // tagged) so the regime-conditional opening-range-gate hypothesis can be re-validated
  // once neutral/risk-off fader days accumulate. Own tracker call = own 60s budget.
  let intracapture = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=intracapture', { headers: { 'x-warm': '1' } });
    intracapture = await r.json();
  } catch (e) { intracapture = { error: String(e && e.message || e) }; }

  // Run one CERN daily cycle — scan for forced-flow events, advance/resolve the
  // ledger, update the Bayesian posteriors. The counterfactual archive is the moat.
  let cern = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=cerntick', { headers: { 'x-warm': '1' } });
    cern = await r.json();
  } catch (e) { cern = { error: String(e && e.message || e) }; }

  // Snapshot the two-sleeve Edge Book (conviction longs + CERN forced-flow) AFTER
  // the CERN tick so Sleeve B reflects the freshest decisions. This is the paper
  // book whose realized beat-SPY rate + cross-sleeve correlation we track.
  let edgelog = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=edgelog', { headers: { 'x-warm': '1' } });
    edgelog = await r.json();
  } catch (e) { edgelog = { error: String(e && e.message || e) }; }

  // Grade any matured trade-alerts on forward excess return (hands-off track record).
  let alertsgrade = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=alertsgrade', { headers: { 'x-warm': '1' } });
    alertsgrade = await r.json();
  } catch (e) { alertsgrade = { error: String(e && e.message || e) }; }

  // Self-improving fade engine: resolve matured logged shorts → update per-stock
  // posteriors → log today's setups. Last (candle data is CDN-warm by now); a
  // skipped slow day self-heals next run (it re-resolves all still-open signals).
  let fadetick = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=fadetick', { headers: { 'x-warm': '1' } });
    fadetick = await r.json();
  } catch (e) { fadetick = { error: String(e && e.message || e) }; }

  // Trend Rider: resolve matured picks → learn per-stock trend quality → log
  // today's light + basket. Self-heals if a slow day skips it.
  let trendtick = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=trendtick', { headers: { 'x-warm': '1' } });
    trendtick = await r.json();
  } catch (e) { trendtick = { error: String(e && e.message || e) }; }

  // Day-Trade momentum/rel-vol screener: resolve matured picks → learn per-stock →
  // log today's picks. Reads the candle caches the screener warm just built.
  let daytradetick = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=daytradetick', { headers: { 'x-warm': '1' } });
    daytradetick = await r.json();
  } catch (e) { daytradetick = { error: String(e && e.message || e) }; }

  // Confluence screener: resolve matured picks → learn (per-stock + per-strategy) → log.
  let confluencetick = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=confluencetick', { headers: { 'x-warm': '1' } });
    confluencetick = await r.json();
  } catch (e) { confluencetick = { error: String(e && e.message || e) }; }

  // 🧬 Coil Radar — log today's top pre-explosion coil picks for the self-validating ledger.
  let coiltick = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=coiltick', { headers: { 'x-warm': '1' } });
    coiltick = await r.json();
  } catch (e) { coiltick = { error: String(e && e.message || e) }; }

  // ⚡ Gap-and-Go — resolve matured unscheduled gap-up picks + log today's for the ledger.
  let gapgotick = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=gapgotick', { headers: { 'x-warm': '1' } });
    gapgotick = await r.json();
  } catch (e) { gapgotick = { error: String(e && e.message || e) }; }

  // ── 5 AI-reasoning screeners (Read-Through / Stealth / Second Wave / Cross-Asset / Tone
  // Shift) — each tick is SELF-CONTAINED (detect + AI + forward-log + cache) in its own 60s
  // invocation. FIRE-AND-FORGET: we kick them and do NOT await (awaiting the slow AI calls
  // is what blew warm's own 60s wall → 504). The kicks dispatch during warm's long tail
  // below; each tick then runs + logs independently of warm's lifetime. `.catch` only to
  // avoid unhandled rejections.
  const aiTicks = [
    '/api/tracker?op=readthroughtick', '/api/tracker?op=anomalytick', '/api/tracker?op=secondwavetick',
    '/api/tracker?op=crossassettick', '/api/tracker?op=toneshifttick',
  ].map(p => warmOne(p).catch(() => null));

  // 🟢 Timing light — log today's picks' grades (accountability) then run the adaptive
  //    weight tuner (self-improvement; dormant until the ledger matures).
  let timinglog = null, timingtune = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=timinglog', { headers: { 'x-warm': '1' } });
    timinglog = await r.json();
  } catch (e) { timinglog = { error: String(e && e.message || e) }; }
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=timingtune', { headers: { 'x-warm': '1' } });
    timingtune = await r.json();
  } catch (e) { timingtune = { error: String(e && e.message || e) }; }

  // 🔮 Forecast — resolve matured predictions + (weekly) generate a fresh batch.
  let predicttick = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=predicttick', { headers: { 'x-warm': '1' } });
    predicttick = await r.json();
  } catch (e) { predicttick = { error: String(e && e.message || e) }; }

  // 🎲 Crowd — snapshot prediction-market 24h volume (builds the unusual-activity baseline).
  let crowdtick = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=crowdtick', { headers: { 'x-warm': '1' } });
    crowdtick = await r.json();
  } catch (e) { crowdtick = { error: String(e && e.message || e) }; }

  // 🏆 Algo Leaderboard — snapshot the heavy confluence-strategy backtest into the cache.
  let leaderboardtick = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=leaderboardtick&src=confluence', { headers: { 'x-warm': '1' } });
    leaderboardtick = await r.json();
  } catch (e) { leaderboardtick = { error: String(e && e.message || e) }; }

  // 🧭 Brief — log today's stance + resolve matured ones (runs after crowd/predict/tape are warm).
  let brieftick = null;
  try {
    const r = await fetch('https://' + HOST + '/api/tracker?op=brieftick', { headers: { 'x-warm': '1' } });
    brieftick = await r.json();
  } catch (e) { brieftick = { error: String(e && e.message || e) }; }

  // Core Momentum sleeve: refresh the feature cache (resumable, ~5 daily runs to fully seed),
  // log the book on quarterly rebalance (self-gated), and resolve outcomes for live drift.
  let corebuild = null;
  try { const r = await fetch('https://' + HOST + '/api/tracker?op=corebuild', { headers: { 'x-warm': '1' } }); corebuild = await r.json(); }
  catch (e) { corebuild = { error: String(e && e.message || e) }; }
  let corelog = null;
  try { const r = await fetch('https://' + HOST + '/api/tracker?op=corelog', { headers: { 'x-warm': '1' } }); corelog = await r.json(); }
  catch (e) { corelog = { error: String(e && e.message || e) }; }
  let coredrift = null;
  try { const r = await fetch('https://' + HOST + '/api/tracker?op=coredrift', { headers: { 'x-warm': '1' } }); coredrift = await r.json(); }
  catch (e) { coredrift = { error: String(e && e.message || e) }; }
  // Fast-vs-sticky attention — cheap (no API): classify the day's archived mentions and
  // log Sticky/Fast names for the Scoreboard. Runs after op=archive wrote today's file.
  let attentiontick = null;
  try { const r = await fetch('https://' + HOST + '/api/tracker?op=attentiontick', { headers: { 'x-warm': '1' } }); attentiontick = await r.json(); }
  catch (e) { attentiontick = { error: String(e && e.message || e) }; }
  // Earnings-call tone — LAST on purpose: it makes bounded Claude calls, so if it's
  // slow it never blocks the critical logging ops above. Small per-run limit caps time.
  let tonetick = null;
  try { const r = await fetch('https://' + HOST + '/api/tracker?op=tonetick&limit=6', { headers: { 'x-warm': '1' } }); tonetick = await r.json(); }
  catch (e) { tonetick = { error: String(e && e.message || e) }; }

  const warmedExtra = await extraWarm;   // already resolved — ran during the tail above

  // The 5 AI screener ticks were kicked fire-and-forget (not awaited) — they self-log to
  // their own ledgers in their own invocations. `aiTicksKicked` just confirms the fetches
  // were dispatched; we do NOT block warm's return on the ~30-50s AI calls (that caused the
  // 504). void-reference so the array isn't dropped before the requests flush.
  void aiTicks;

  const result = { ok: true, host: HOST, warmed: out, warmedExtra, track, narrative, apexlog, ghostlog, archive, intracapture, cern, edgelog, alertsgrade, fadetick, trendtick, daytradetick, confluencetick, coiltick, gapgotick, timinglog, timingtune, predicttick, crowdtick, brieftick, leaderboardtick, corebuild, corelog, coredrift, attentiontick, tonetick, aiTicksKicked: 5, at: new Date().toISOString() };

  // Observability: persist a compact health record so failed ticks / stale data are visible (op=health).
  try { const { summarizeRun, writeHealthRun } = require('../lib/health'); await writeHealthRun(summarizeRun(result)); }
  catch (e) { result.healthLogError = String(e && e.message || e); }

  res.setHeader('Cache-Control', 'no-store');
  return res.json(result);
};
