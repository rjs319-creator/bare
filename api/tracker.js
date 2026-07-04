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
        runTiming, runTimingLog, runTimingBook, runTimingTune } = require('../lib/screener-routes');
const { runAlertsIngest, runAlerts, runAlertsGrade } = require('../lib/alerts-routes');
const { runArchive, runBaseline, runInsiderIngest, runInsider, runFundBuild, runFundamentals,
        runCernTickOp, runCern, runCernFsProbe, runCernLockProbe } = require('../lib/capture-routes');
const { runTrack, runScoreboard, runApexLog, runGhostLog, runEdgeLog, runEdgeBook, runVReversal, runVReversalTest,
        runDrift, runRecalibrate, runResearchOp, runExitsOp, runEmergingOp, runLongShortOp, runPeadOp, runBackfillOp, runModel, runNarrative, runMoverStudyOp, runCernDecay } = require('../lib/apex-routes');
const { runHealth } = require('../lib/health');
const { runLeaderboard, runLeaderboardTick } = require('../lib/leaderboard');
const { runCoreBuild, runCore, runCoreLog, runCoreDrift, runCorePerf } = require('../lib/stablecore-routes');
const { runGamePlan } = require('../lib/gameplan-routes');
const { runToneTick, runTone } = require('../lib/tone-routes');
const { runAttention, runAttentionTick } = require('../lib/attention-routes');
const { runOptionsFlow, runOptionsPerf } = require('../lib/optionsflow-routes');
const { runPulse } = require('../lib/pulse-routes');

module.exports = async function handler(req, res) {
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
  if (req.query.op === 'timing') return runTiming(req, res);
  if (req.query.op === 'timinglog') return runTimingLog(req, res);
  if (req.query.op === 'timingbook') return runTimingBook(req, res);
  if (req.query.op === 'timingtune') return runTimingTune(req, res);
  if (req.query.op === 'confluence') return runConfluence(req, res);
  if (req.query.op === 'confluencetick') return runConfluenceTick(req, res);
  if (req.query.op === 'confluencebook') return runConfluenceBook(req, res);
  if (req.query.op === 'confluenceopt') return runConfluenceOpt(req, res);
  if (req.query.op === 'pulse') return runPulse(req, res);
  if (req.query.op === 'readthrough') return require('../lib/readthrough-routes').runReadThrough(req, res);
  if (req.query.op === 'readthroughtick') return require('../lib/readthrough-routes').runReadThroughTick(req, res);
  if (req.query.op === 'predict') return runPredict(req, res);
  if (req.query.op === 'predicttick') return runPredictTick(req, res);
  if (req.query.op === 'crowd') return runCrowd(req, res);
  if (req.query.op === 'crowdtick') return runCrowdTick(req, res);
  if (req.query.op === 'gameplan') return runGamePlan(req, res);
  if (req.query.op === 'optionsflow') return runOptionsFlow(req, res);
  if (req.query.op === 'optionsperf') return runOptionsPerf(req, res);
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
  if (req.query.op === 'model') return runModel(req, res);
  if (req.query.op === 'narrative') return runNarrative(req, res);
  if (req.query.op === 'health') return runHealth(req, res);
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
  return runScoreboard(req, res);
};
