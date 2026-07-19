// Pick-tracking endpoint — two ops behind one function (Hobby plan caps a
// deployment at 12 Serverless Functions, so logging + scoring share a file):
//   GET /api/tracker?op=track[&force=1]    → snapshot today's picks to storage
//   GET /api/tracker  (or ?op=scoreboard)  → realized forward-return scoreboard
//   GET /api/tracker?op=apexlog[&force=1]  → log today's Apex/Loaded signals
//   GET /api/tracker?op=ghostlog[&force=1] → log today's Ghost/Stalking signals
//   GET /api/tracker?op=archive            → snapshot per-ticker mentions + options baselines
//   POST /api/tracker?op=insideringest     → receive EDGAR Form 4 history (external builder)
//   GET /api/tracker?op=insider            → insider-history coverage snapshot
//   GET /api/tracker?op=fundbuild          → resumable point-in-time fundamentals build
//   GET /api/tracker?op=fundamentals       → fundamentals coverage snapshot
//   GET /api/tracker?op=cerntick           → run one CERN daily cycle (warm cron)
//   GET /api/tracker?op=cern               → CERN engine state for the Events tab
//   GET /api/tracker?op=cernlockprobe      → read-only lockup-feed liquidity probe
//   GET /api/tracker?op=drift              → Apex model drift / health (Module 3)
//   GET /api/tracker?op=recalibrate        → re-optimize pillar weights (Module 2)
//   GET /api/tracker?op=model              → active model weights / version (for client)
//   GET /api/tracker?op=narrative[&force=1] → weekly market-narrative tag
// Thin dispatcher. Every op's handler lives in a domain module under lib/*-routes.js
// (the file was split out of a 3,300-line god-file). One Vercel function, many ops
// (Hobby plan caps functions per deployment, so all trackers share this endpoint).
const { runPredict, runPredictTick, runCrowd, runCrowdTick, runBrief, runBriefTick, runTape, runAlertFeed } = require('../lib/predict-routes');
const { runFadeOpt, runFadeSeed, runFadeSignals, runFadeTick, runFadeBook,
        runTrendOpt, runTrend, runTrendTick, runTrendBook,
        runDaytrade, runDaytradeTick, runDaytradeBook, runDaytradeOpt,
        runConfluence, runConfluenceTick, runConfluenceBook, runConfluenceOpt,
        runCoil, runCoilTick, runCoilBook,
        runGapGo, runGapGoTick, runGapGoBook,
        runDownDay, runDownDayTick, runDownDayBook,
        runGapDown, runGapDownTick, runGapDownBook,
        runTiming, runTimingLog, runTimingBook, runTimingTune } = require('../lib/screener-routes');
const { runAlertsIngest, runAlerts, runAlertsGrade, runAlertsAssess } = require('../lib/alerts-routes');
const { runArchive, runBaseline, runInsiderIngest, runInsider, runFundBuild, runFundamentals,
        runCernTickOp, runCern, runCernFsProbe, runCernLockProbe, runIntraCapture, runIntraday } = require('../lib/capture-routes');
const { runTrack, runScoreboard, runApexLog, runGhostLog, runEdgeLog, runEdgeBook, runVReversal, runVReversalTest,
        runDrift, runRecalibrate, runResearchOp, runExitsOp, runEmergingOp, runLongShortOp, runPeadOp, runBackfillOp, runModel, runNarrative, runMoverStudyOp, runCernDecay, runRankQuality } = require('../lib/apex-routes');
const { runHealth } = require('../lib/health');
const { runLeaderboard, runLeaderboardTick } = require('../lib/leaderboard');
const { runCoreBuild, runCore, runCoreLog, runCoreDrift, runCorePerf } = require('../lib/stablecore-routes');
const { runGamePlan } = require('../lib/gameplan-routes');
const { runToneTick, runTone } = require('../lib/tone-routes');
const { runAttention, runAttentionTick } = require('../lib/attention-routes');
const { runOptionsFlow, runOptionsPerf, runOptionsAssess } = require('../lib/optionsflow-routes');
const { runPulse, runPulseRefine } = require('../lib/pulse-routes');
const { runDualRead, runDualReadLog, runDualReadBook, runDualReadTune, runDualReadBackfill, runLtRecs } = require('../lib/dualread-routes');
const { requireTrusted, requireMethod, stripForceParams, isTrusted } = require('../lib/auth');
const { rateLimit, clientKey } = require('../lib/ratelimit');

// Ops the DAILY CRON fans out to and the browser never fetches directly — safe to
// require the CRON_SECRET bearer (enforced only once the secret is configured).
const PRIVILEGED_OPS = new Set([
  // 'warmchain' runs ledger WRITES and expensive rebuilds (op=redundancy&force=1 refetches
  // candles for every ticker in the ledger history) — cron-only, never public.
  'warmchain',
  'alertsassess', 'alertsgrade', 'alignedlog', 'apexlog', 'archive', 'attentiontick',
  'brieftick', 'cerntick', 'coiltick', 'confluencetick', 'corebuild', 'corelog',
  'crowdtick', 'daytradetick', 'downdaytick', 'dualreadlog', 'dualreadtune', 'edgelog',
  'fadetick', 'gapdowntick', 'gapgotick', 'ghostlog', 'intracapture', 'leaderboardtick',
  'narrative', 'optionsassess', 'predicttick', 'timinglog', 'timingtune', 'tonetick',
  // 'track' snapshots the day's Screener+Momentum picks to Blob (a state-changing WRITE).
  // The daily cron dispatches it with the internal bearer (warm-chains-routes.js), so gating
  // it here blocks an anonymous public GET from mutating the ledger without breaking the cron.
  'track', 'trendtick', 'universecompile', 'universescan',
  // EVOLVE writers — cron/manual-with-bearer only (persist predictions / resolve labels /
  // heavy historical backfill of specialist performance).
  'evolvescore', 'evolveresolve', 'evolvebackfill', 'ignitionlog', 'ignitionbackfill',
  'omegalog', 'omegabackfill',
  // Expensive non-browser builders/computes — cron/external/manual only, so gating
  // them behind the CRON_SECRET bearer costs the UI nothing.
  'fundbuild', 'universebuild', 'emerging',
  // Provenance WRITES — commit the immutable run manifest / rebuild the security
  // master. State-changing (append to the run ledger / overwrite the master doc),
  // dispatched by the daily cron with the internal bearer.
  'runmanifest', 'secmasterbuild',
  // Challenger shadow ledger WRITES (log predictions PIT / append forward outcomes).
  'challengerlog', 'challengerresolve',
  // ORBIT shadow ledger WRITES (log PIT predictions / resolve forward labels).
  'orbitlog', 'orbitresolve',
]);
// Expensive ops the BROWSER can trigger (Custom/Backtest/Baselines panel buttons) — we
// can't 401 them without breaking those buttons, so rate-limit anonymous callers
// instead (trusted cron is exempt). Best-effort per-instance throttle; see lib/ratelimit.js.
const EXPENSIVE_OPS = new Set([
  'recalibrate', 'fadeseed', 'exits', 'longshort', 'pead', 'backfill', 'moverstudy', 'cerndecay', 'rankquality', 'research', 'evolveomegawf', 'omegawf', 'redundancy', 'leadtime', 'failuremodel', 'complab', 'challengereval', 'orbitwalkforward',
]);
const EXPENSIVE_LIMIT = { limit: 6, windowMs: 60000 }; // ≤6 heavy recomputes/min per IP
// Ops both the cron AND the browser call: leave the cached read public, but strip
// the expensive force/refresh rebuild levers for untrusted callers.
const SHARED_FORCE_OPS = new Set([
  'aligned', 'anomalytick', 'biotechtick', 'calibration', 'coredrift', 'crossassettick',
  'optionsflow', 'pulse', 'pulserefine', 'putsell', 'readthroughtick', 'secondwavetick',
  'toneshifttick',
  // redundancy: the cached model is public (the UI panel reads it), but a force=1 rebuild
  // refetches candles for every ticker in the ledger history — trusted callers (the cron)
  // only. Rate-limiting alone wasn't enough: 6/min per IP of a 200+ ticker rebuild is still
  // a cheap way to burn the function budget.
  'redundancy',
]);
// Ingest endpoints: POST-only + their own token/secret gate inside the route.
const INGEST_OPS = new Set(['insideringest', 'alertsingest']);

module.exports = async function handler(req, res) {
  // Deploy version — the client compares this against the value it booted with and
  // prompts a refresh when a new deploy lands. Cheap (env read), never cached.
  if (req.query.op === 'version') {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.json({ version: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || 'dev' });
  }

  // ── Authorization gate (see lib/auth.js). Ingest is POST-only; cron-exclusive
  //    ops require the CRON_SECRET bearer; shared ops lose their force/refresh lever
  //    for anonymous callers. All fail-open until CRON_SECRET is configured.
  const op = req.query.op || 'scoreboard';
  if (INGEST_OPS.has(op) && !requireMethod(req, res, ['POST'])) return;
  if (PRIVILEGED_OPS.has(op)) { if (!requireTrusted(req, res)) return; }
  else if (SHARED_FORCE_OPS.has(op)) { stripForceParams(req); }
  // Cost-abuse throttle on browser-triggerable heavy recomputes (cron exempt).
  if (EXPENSIVE_OPS.has(op) && !isTrusted(req)) {
    const rl = rateLimit(`${op}:${clientKey(req)}`, EXPENSIVE_LIMIT);
    if (!rl.ok) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(429).json({ ok: false, error: 'rate limited — too many heavy recomputes; try again shortly.' });
    }
  }

  if (req.query.op === 'dualread') return runDualRead(req, res);
  if (req.query.op === 'dualreadlog') return runDualReadLog(req, res);
  if (req.query.op === 'dualreadbook') return runDualReadBook(req, res);
  if (req.query.op === 'dualreadtune') return runDualReadTune(req, res);
  if (req.query.op === 'dualreadbackfill') return runDualReadBackfill(req, res);
  if (req.query.op === 'ltrecs') return runLtRecs(req, res);
  if (req.query.op === 'putsell') return require('../lib/putsell-routes').runPutSell(req, res);
  if (req.query.op === 'universebuild') return require('../lib/universe-routes').runUniverseBuild(req, res);
  if (req.query.op === 'universescan') return require('../lib/universe-routes').runUniverseScan(req, res);
  if (req.query.op === 'universecompile') return require('../lib/universe-routes').runUniverseCompile(req, res);
  if (req.query.op === 'universecurate') return require('../lib/universe-routes').runUniverseCurate(req, res);
  if (req.query.op === 'aligned') return require('../lib/aligned-routes').runAligned(req, res);
  if (req.query.op === 'alignedlog') return require('../lib/aligned-routes').runAlignedLog(req, res);
  if (req.query.op === 'alignedbook') return require('../lib/aligned-routes').runAlignedBook(req, res);
  if (req.query.op === 'track') return runTrack(req, res);
  if (req.query.op === 'apexlog') return runApexLog(req, res);
  if (req.query.op === 'ghostlog') return runGhostLog(req, res);
  if (req.query.op === 'edgelog') return runEdgeLog(req, res);
  if (req.query.op === 'edgebook') return runEdgeBook(req, res);
  if (req.query.op === 'vreversal') return runVReversal(req, res);
  if (req.query.op === 'vreversaltest') return runVReversalTest(req, res);
  if (req.query.op === 'fadeopt') return runFadeOpt(req, res);
  if (req.query.op === 'fadeseed') return runFadeSeed(req, res);
  if (req.query.op === 'daytrade') return runDaytrade(req, res);
  if (req.query.op === 'daytradetick') return runDaytradeTick(req, res);
  if (req.query.op === 'daytradebook') return runDaytradeBook(req, res);
  if (req.query.op === 'daytradeopt') return runDaytradeOpt(req, res);
  if (req.query.op === 'coil') return runCoil(req, res);
  if (req.query.op === 'coiltick') return runCoilTick(req, res);
  if (req.query.op === 'coilbook') return runCoilBook(req, res);
  if (req.query.op === 'gapgo') return runGapGo(req, res);
  if (req.query.op === 'gapgotick') return runGapGoTick(req, res);
  if (req.query.op === 'gapgobook') return runGapGoBook(req, res);
  if (req.query.op === 'downday') return runDownDay(req, res);
  if (req.query.op === 'downdaytick') return runDownDayTick(req, res);
  if (req.query.op === 'downdaybook') return runDownDayBook(req, res);
  if (req.query.op === 'gapdown') return runGapDown(req, res);
  if (req.query.op === 'gapdowntick') return runGapDownTick(req, res);
  if (req.query.op === 'gapdownbook') return runGapDownBook(req, res);
  if (req.query.op === 'timing') return runTiming(req, res);
  if (req.query.op === 'timinglog') return runTimingLog(req, res);
  if (req.query.op === 'timingbook') return runTimingBook(req, res);
  if (req.query.op === 'timingtune') return runTimingTune(req, res);
  if (req.query.op === 'confluence') return runConfluence(req, res);
  if (req.query.op === 'confluencetick') return runConfluenceTick(req, res);
  if (req.query.op === 'confluencebook') return runConfluenceBook(req, res);
  if (req.query.op === 'confluenceopt') return runConfluenceOpt(req, res);
  if (req.query.op === 'pulse') return runPulse(req, res);
  if (req.query.op === 'pulserefine') return runPulseRefine(req, res);
  if (req.query.op === 'leadtime') return require('../lib/leadtime-routes').runLeadTime(req, res);
  if (req.query.op === 'failuremodel') return require('../lib/failure-model-routes').runFailureModel(req, res);
  if (req.query.op === 'complab') return require('../lib/component-lab-routes').runComponentLabRoute(req, res);
  if (req.query.op === 'readthrough') return require('../lib/readthrough-routes').runReadThrough(req, res);
  if (req.query.op === 'readthroughtick') return require('../lib/readthrough-routes').runReadThroughTick(req, res);
  if (req.query.op === 'anomaly') return require('../lib/anomaly-routes').runAnomaly(req, res);
  if (req.query.op === 'anomalytick') return require('../lib/anomaly-routes').runAnomalyTick(req, res);
  if (req.query.op === 'biotech') return require('../lib/biotech-routes').runBiotech(req, res);
  if (req.query.op === 'biotechtick') return require('../lib/biotech-routes').runBiotechTick(req, res);
  if (req.query.op === 'secondwave') return require('../lib/secondwave-routes').runSecondWave(req, res);
  if (req.query.op === 'secondwavetick') return require('../lib/secondwave-routes').runSecondWaveTick(req, res);
  if (req.query.op === 'crossasset') return require('../lib/crossasset-routes').runCrossAsset(req, res);
  if (req.query.op === 'crossassettick') return require('../lib/crossasset-routes').runCrossAssetTick(req, res);
  if (req.query.op === 'toneshift') return require('../lib/toneshift-routes').runToneShift(req, res);
  if (req.query.op === 'toneshifttick') return require('../lib/toneshift-routes').runToneShiftTick(req, res);
  if (req.query.op === 'calibration') return require('../lib/calibration').runCalibration(req, res);
  if (req.query.op === 'predict') return runPredict(req, res);
  if (req.query.op === 'predicttick') return runPredictTick(req, res);
  if (req.query.op === 'crowd') return runCrowd(req, res);
  if (req.query.op === 'crowdtick') return runCrowdTick(req, res);
  if (req.query.op === 'gameplan') return runGamePlan(req, res);
  if (req.query.op === 'optionsflow') return runOptionsFlow(req, res);
  if (req.query.op === 'optionsperf') return runOptionsPerf(req, res);
  if (req.query.op === 'optionsassess') return runOptionsAssess(req, res);
  if (req.query.op === 'perf') return require('../lib/perf-routes').runPerf(req, res);
  if (req.query.op === 'brief') return runBrief(req, res);
  if (req.query.op === 'brieftick') return runBriefTick(req, res);
  if (req.query.op === 'alertfeed') return runAlertFeed(req, res);
  if (req.query.op === 'tape') return runTape(req, res);
  if (req.query.op === 'fadesignals') return runFadeSignals(req, res);
  if (req.query.op === 'fadetick') return runFadeTick(req, res);
  if (req.query.op === 'fadebook') return runFadeBook(req, res);
  if (req.query.op === 'trendopt') return runTrendOpt(req, res);
  if (req.query.op === 'trend') return runTrend(req, res);
  if (req.query.op === 'trendtick') return runTrendTick(req, res);
  if (req.query.op === 'trendbook') return runTrendBook(req, res);
  if (req.query.op === 'archive') return runArchive(req, res);
  if (req.query.op === 'intracapture') return runIntraCapture(req, res);
  if (req.query.op === 'intraday') return runIntraday(req, res);
  if (req.query.op === 'baseline') return runBaseline(req, res);
  if (req.query.op === 'insideringest') return runInsiderIngest(req, res);
  if (req.query.op === 'insider') return runInsider(req, res);
  if (req.query.op === 'fundbuild') return runFundBuild(req, res);
  if (req.query.op === 'fundamentals') return runFundamentals(req, res);
  if (req.query.op === 'cerntick') return runCernTickOp(req, res);
  if (req.query.op === 'cern') return runCern(req, res);
  if (req.query.op === 'cernfsprobe') return runCernFsProbe(req, res);
  if (req.query.op === 'cernlockprobe') return runCernLockProbe(req, res);
  if (req.query.op === 'drift') return runDrift(req, res);
  if (req.query.op === 'rankquality') return runRankQuality(req, res);
  if (req.query.op === 'redundancy') return require('../lib/redundancy-routes').runRedundancy(req, res);
  if (req.query.op === 'maturity') return require('../lib/maturity-routes').runMaturity(req, res);
  if (req.query.op === 'baselines') return require('../lib/baselines-routes').runBaselines(req, res);
  if (req.query.op === 'recalibrate') return runRecalibrate(req, res);
  if (req.query.op === 'backfill') return runBackfillOp(req, res);
  if (req.query.op === 'research') return runResearchOp(req, res);
  if (req.query.op === 'moverstudy') return runMoverStudyOp(req, res);
  if (req.query.op === 'exits') return runExitsOp(req, res);
  if (req.query.op === 'emerging') return runEmergingOp(req, res);
  if (req.query.op === 'longshort') return runLongShortOp(req, res);
  if (req.query.op === 'pead') return runPeadOp(req, res);
  if (req.query.op === 'alertsingest') return runAlertsIngest(req, res);
  if (req.query.op === 'alerts') return runAlerts(req, res);
  if (req.query.op === 'alertsgrade') return runAlertsGrade(req, res);
  if (req.query.op === 'alertsassess') return runAlertsAssess(req, res);
  if (req.query.op === 'model') return runModel(req, res);
  if (req.query.op === 'narrative') return runNarrative(req, res);
  if (req.query.op === 'health') return runHealth(req, res);
  // Provenance: run manifest + point-in-time security master + immutable-ledger verify.
  if (req.query.op === 'runmanifest') return require('../lib/provenance-routes').runRunManifest(req, res);
  if (req.query.op === 'secmasterbuild') return require('../lib/provenance-routes').runSecMasterBuild(req, res);
  if (req.query.op === 'provenance') return require('../lib/provenance-routes').runProvenance(req, res);
  if (req.query.op === 'leaderboard') return runLeaderboard(req, res);
  if (req.query.op === 'leaderboardtick') return runLeaderboardTick(req, res);
  if (req.query.op === 'corebuild') return runCoreBuild(req, res);
  if (req.query.op === 'core') return runCore(req, res);
  if (req.query.op === 'corelog') return runCoreLog(req, res);
  if (req.query.op === 'coredrift') return runCoreDrift(req, res);
  if (req.query.op === 'coreperf') return runCorePerf(req, res);
  if (req.query.op === 'cerndecay') return runCernDecay(req, res);
  if (req.query.op === 'tonetick') return runToneTick(req, res);
  if (req.query.op === 'tone') return runTone(req, res);
  if (req.query.op === 'attentiontick') return runAttentionTick(req, res);
  if (req.query.op === 'attention') return runAttention(req, res);
  if (req.query.op === 'whynow') return require('../lib/whynow-routes').runWhyNow(req, res);
  if (req.query.op === 'today') return require('../lib/decision-routes').runToday(req, res);
  // EVOLVE — Adaptive Pre-Move Discovery Engine (composition + calibration over the
  // existing engines-as-specialists). Live reads are public + cached; the writers
  // (evolvescore&log, evolveresolve) are cron-only via PRIVILEGED_OPS.
  if (req.query.op === 'evolve') return require('../lib/evolve-routes').runEvolve(req, res);
  if (req.query.op === 'evolvescore') return require('../lib/evolve-routes').runEvolveScore(req, res);
  if (req.query.op === 'evolveresolve') return require('../lib/evolve-routes').runEvolveResolve(req, res);
  if (req.query.op === 'evolvehealth') return require('../lib/evolve-routes').runEvolveHealth(req, res);
  if (req.query.op === 'evolvewalkforward') return require('../lib/evolve-routes').runEvolveWalkforward(req, res);
  if (req.query.op === 'evolveomegawf') return require('../lib/evolve-routes').runEvolveOmegaWalkforward(req, res);
  if (req.query.op === 'evolvebackfill') return require('../lib/evolve-routes').runEvolveBackfillOp(req, res);
  // OMEGA Ensemble page (§9) — a read-only projection of op=today + op=evolvehealth.
  if (req.query.op === 'ensemble') return require('../lib/omega-ensemble-routes').runEnsemble(req, res);
  // Ordered cron work, run in ITS OWN invocation (see lib/warm-chains.js — a .then()
  // chain inside api/warm.js dies when warm returns at its 55s ceiling).
  if (req.query.op === 'warmchain') return require('../lib/warm-chains-routes').runWarmChain(req, res);
  // 🔥 Momentum Ignition — one acceleration-ranked view over the momentum scanners.
  if (req.query.op === 'ignition') return require('../lib/ignition-routes').runIgnition(req, res);
  if (req.query.op === 'ignitionlog') return require('../lib/ignition-routes').runIgnitionLog(req, res);
  if (req.query.op === 'ignitionbackfill') return require('../lib/ignition-routes').runIgnitionBackfillOp(req, res);
  // 💠 OMEGA-SWING — 5–10 day momentum continuation engine (Prime/Qualified/Watch tiers).
  if (req.query.op === 'omega') return require('../lib/omega-swing-routes').runOmega(req, res);
  if (req.query.op === 'omegalog') return require('../lib/omega-swing-routes').runOmegaLog(req, res);
  if (req.query.op === 'omegamodel') return require('../lib/omega-swing-routes').runOmegaModel(req, res);
  if (req.query.op === 'omegawf') return require('../lib/omega-swing-routes').runOmegaWf(req, res);
  if (req.query.op === 'omegabackfill') return require('../lib/omega-swing-routes').runOmegaBackfillOp(req, res);
  // 🧪 Challenger decision system (shadow-only, challenger-decision-v1). Read is public;
  // log/resolve are cron-only WRITES; eval is a heavy recompute.
  if (req.query.op === 'challenger') return require('../lib/challenger-routes').runChallenger(req, res);
  if (req.query.op === 'challengerlog') return require('../lib/challenger-routes').runChallengerLog(req, res);
  if (req.query.op === 'challengerresolve') return require('../lib/challenger-routes').runChallengerResolve(req, res);
  if (req.query.op === 'challengereval') return require('../lib/challenger-routes').runChallengerEval(req, res);
  // 🛰️ ORBIT (shadow-only, orbit-decision-v1). Read/health/router are public; log/resolve
  // are cron-only WRITES; walkforward is a heavy backfill+train+eval recompute.
  if (req.query.op === 'orbit') return require('../lib/orbit-routes').runOrbit(req, res);
  if (req.query.op === 'orbitlog') return require('../lib/orbit-routes').runOrbitLog(req, res);
  if (req.query.op === 'orbitresolve') return require('../lib/orbit-routes').runOrbitResolve(req, res);
  if (req.query.op === 'orbitwalkforward') return require('../lib/orbit-routes').runOrbitWalkForward(req, res);
  if (req.query.op === 'orbithealth') return require('../lib/orbit-routes').runOrbitHealth(req, res);
  if (req.query.op === 'algorithmrouter') return require('../lib/orbit-routes').runAlgorithmRouter(req, res);
  return runScoreboard(req, res);
};
