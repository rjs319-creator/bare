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
        runConfluence, runConfluenceTick, runConfluenceBook, runConfluenceOpt, runConfluenceMarginal,
        runCoil, runCoilTick, runCoilBook,
        runGapGo, runGapGoTick, runGapGoBook,
        runDownDay, runDownDayTick, runDownDayBook,
        runGapDown, runGapDownTick, runGapDownBook,
        runTiming, runTimingLog, runTimingBook, runTimingTune } = require('../lib/screener-routes');
const { runAlertsIngest, runAlerts, runAlertsGrade, runAlertsAssess } = require('../lib/alerts-routes');
const { runArchive, runBaseline, runIvRvSample, runInsiderIngest, runInsider, runFundBuild, runFundamentals,
        runCernTickOp, runCern, runCernFsProbe, runCernLockProbe, runIntraCapture, runIntraday } = require('../lib/capture-routes');
const { runTrack, runScoreboard, runApexLog, runGhostLog, runEdgeLog, runEdgeBook, runVReversal, runVReversalTest,
        runDrift, runRecalibrate, runResearchOp, runExitsOp, runEmergingOp, runLongShortOp, runPeadOp, runBackfillOp, runModel, runNarrative, runMoverStudyOp, runCernDecay, runRankQuality, runCongressOp, runRevisionsOp } = require('../lib/apex-routes');
const { runHealth } = require('../lib/health');
const { runLeaderboard, runLeaderboardTick } = require('../lib/leaderboard');
const { runCoreBuild, runCore, runCoreLog, runCoreDrift, runCorePerf } = require('../lib/stablecore-routes');
const { runGamePlan } = require('../lib/gameplan-routes');
const { runToneTick, runTone } = require('../lib/tone-routes');
const { runAttention, runAttentionTick } = require('../lib/attention-routes');
const { runOptionsFlow, runOptionsPerf, runOptionsAssess, runOptionsEpisodes } = require('../lib/optionsflow-routes');
const { runPulse, runPulseRefine, runPulseGrade, runPulseEpisodes } = require('../lib/pulse-routes');
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
  'fadetick', 'gapdowntick', 'gapgotick', 'gapgoverify', 'ghostlog', 'intracapture', 'leaderboardtick',
  'narrative', 'optionsassess', 'optionsscan2', 'optionsresolve2', 'patternlog', 'patterngrade', 'patternresearch', 'predicttick', 'timinglog', 'timingtune', 'tonetick',
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
  // ORBIT-ML shadow ledger WRITES (log ranked cross-section / resolve forward labels).
  'orbitmltick', 'orbitmlresolve',
  // Market Pulse SHADOW grader — forward-grades matured first-seen episodes (heavy dated
  // candle fetches + grader-owned outcome ledger write). Cron/manual only.
  'pulsegrade',
  // Market Pulse v2 privileged WRITER ticks: deterministic market-state snapshot,
  // LLM narrative collection/refinement, and the per-horizon outcome grader. An
  // anonymous page load must never reach these (LLM spend + ledger mutation).
  'pulse2statetick', 'pulse2collect', 'pulse2refine', 'pulse2grade',
  // ATLAS-X shadow ledger WRITES (build+persist episodes/ledger/predictions; grade terminals).
  'atlasxlog', 'atlasxresolve',
  // Pre-move inventory shadow cross-section capture (immutable daily WRITE) +
  // ghostobs outcome grading (grader-owned resolved-doc WRITE).
  'premovelog', 'premoveresolve',
  // RLT shadow ledger WRITES (scan + persist episodes/cross-section/alerts; grade terminals).
  'rltlog', 'rltresolve',
  // Swing-search shadow ledger WRITES (log the daily swing cross-section PIT / grade forward outcomes).
  'swingsearchlog', 'swingsearchgrade',
  // Evidence Consensus & Thesis Change engine — the daily snapshot build makes LLM extraction
  // calls per active-attention name + writes the evidence ledger. Cron/manual-with-bearer only.
  'evidencetick',
  // GOV-DEMAND shadow vertical WRITES (USAspending collect + PIT prediction log / forward
  // outcome resolution). Cron/manual-with-bearer only.
  'govdemandtick', 'govdemandresolve',
  // Alpha-archive collection streams (unrecoverable-data Blob WRITES: earnings-calendar
  // snapshots+diffs, analyst-event feeds, per-name dealer-gamma shards, analyst-estimate
  // vintages). Cron/manual only.
  'calarchive', 'revarchive', 'gexarchive', 'estarchive', 'sec8karchive', 'insarchive',
  // FMP subscription capability auditor — spends ~25 FMP probe calls + writes the
  // capability doc. Cron/manual-with-bearer only.
  'fmpaudit',
  // CFL reconstruction jobs: full-cohort replays + Blob day-doc/summary WRITES
  // (cfltick nightly, cflbackfill caller-cursor sweeps). Cron/manual only.
  'cfltick', 'cflbackfill',
  // VRP live paper put-write ledger WRITE (entry + resolution). Cron/manual only.
  'vrptick',
  // Ephemeral edge factory WRITE (grammar rescan + paper-pick log + resolutions). Cron/manual only.
  'ephemeraltick',
  // GRIDLOCK shadow vertical WRITES (PJM/EIA/NWS collect + event ledger + PIT candidate
  // log / forward outcome resolution). Cron/manual-with-bearer only.
  'gridlocktick', 'gridlockresolve',
  // Day Trade scan runner (external-scheduler entry point — writes discovery state, dataset
  // buckets and runner health) + dataset grading (per-ticker bar fetch fan-out + grade WRITE).
  'daytradescan', 'datasetgrade',
  // Day Trade BOARD TICK — the ONE authorized lifecycle mutator (Stage-2 validation,
  // lifecycle advance, alert emission, persistence, capture). The public op=daytrade is a
  // READ-ONLY projection; only this authenticated tick may advance state or emit alerts.
  'daytradeboardtick',
  // Model governance WRITES: train candidate artifacts, promote (shadow), register a
  // shadow challenger, promote live, rollback. Authenticated + actor-stamped — a learned
  // model can never be promoted anonymously or automatically.
  'modeltrain', 'modelpromote', 'modelchallenger', 'modelpromotelive', 'modelrollback',
  // Peer Propagation + News Underreaction shadow ledger WRITES (persist latest board /
  // append immutable daily picks). Cron/manual-with-bearer only.
  'peerproplog', 'underreactionlog',
  // Expectation-Gap regime challenger WRITE (persist latest + RISK_REDUCE-day ledger).
  'expgaplog',
  // LOW-FLOAT / INTRADAY-CONTINUATION stack WRITES. The public op=lowfloat and
  // op=intradaycontinuation are READ-ONLY projections; only these authenticated ticks may
  // persist discovery state, write the research snapshots, mint point-in-time entry events,
  // emit alerts, resolve outcomes, move a template's promotion state, or store the audit.
  'lowfloattick', 'intradaytick', 'intradayresolve', 'intradaypromote', 'largemoveraudittick',
  // 🖥 TECHNOLOGY COMMAND CENTER WRITES. op=techcommand / op=techcommandticker /
  // op=techcommandhealth are READ-ONLY projections; only these authenticated ops may
  // build+persist the snapshot, advance the candidate lifecycle, emit alerts, append the
  // immutable evaluation record, or resolve matured outcomes.
  'techcommandtick', 'techcommandresolve',
  // 🪜 PSRL WRITES. op=psrl / op=psrldetail / op=psrlhealth are READ-ONLY projections;
  // only this authenticated nightly tick may scan, score and persist the snapshot +
  // trend-episode ledger (shadow, weight-0).
  'psrltick',
]);
// Expensive ops the BROWSER can trigger (Custom/Backtest/Baselines panel buttons) — we
// can't 401 them without breaking those buttons, so rate-limit anonymous callers
// instead (trusted cron is exempt). Best-effort per-instance throttle; see lib/ratelimit.js.
const EXPENSIVE_OPS = new Set([
  'recalibrate', 'fadeseed', 'exits', 'longshort', 'pead', 'congress', 'revisions', 'backfill', 'moverstudy', 'cerndecay', 'rankquality', 'research', 'evolveomegawf', 'omegawf', 'omegafunnel', 'redundancy', 'leadtime', 'leadtime2', 'failuremodel', 'complab', 'challengereval', 'router', 'routercf', 'orbitwalkforward', 'orbitmlwalkforward', 'orbitcontrols', 'atlasxwalkforward', 'rltwalkforward', 'evidencediag', 'datasetsurvival',
  'peerprop', 'peerpropwf', 'underreaction', 'targetcompare', 'expgap', 'psrlresearch',
  // discover: the Day Trade page fires it every 60s (CDN-coalesced at 45s), but unthrottled
  // anonymous callers could drive a ~2,500-name provider fan-out + Blob writes at will.
  'discover',
  // The low-float / continuation reads run the whole staged pipeline (bulk quotes over the
  // full eligible universe + a bounded 5-minute chart fan-out). They are CDN-cached at ~45s
  // so normal page traffic coalesces, but an anonymous caller bypassing the cache with a
  // cache-buster could otherwise drive the provider fan-out at will.
  'lowfloat', 'intradaycontinuation', 'largemoveraudit',
  // ignitionreplay/ignitionleadtime: read-only, but each call lists + fetches a whole day of
  // per-scan Blob snapshots (up to ~200 documents) — cheap for the CDN window, expensive for
  // a cache-busting anonymous loop. op=ignitionlive reads ONE latest snapshot and stays
  // unthrottled like the other cached projections.
  'ignitionreplay', 'ignitionleadtime',
  // techcommand: normally serves a persisted snapshot, but when none is fresh it runs a
  // BOUNDED live rebuild (cached public ops + benchmark candles). CDN-cached at ~45s so
  // page traffic coalesces; the throttle stops a cache-busting caller from driving the
  // rebuild at will.
  'techcommand', 'techcommandticker',
]);
const EXPENSIVE_LIMIT = { limit: 6, windowMs: 60000 }; // ≤6 heavy recomputes/min per IP
// Ops both the cron AND the browser call: leave the cached read public, but strip
// the expensive force/refresh rebuild levers for untrusted callers.
const SHARED_FORCE_OPS = new Set([
  'aligned', 'anomalytick', 'biotechtick', 'biotechgrade', 'calibration', 'coredrift', 'crossassettick',
  'optionsflow', 'optionsepisodes', 'pulse', 'pulserefine', 'putsell', 'readthroughtick', 'secondwavetick',
  'toneshifttick', 'atlasx',
  // redundancy: the cached model is public (the UI panel reads it), but a force=1 rebuild
  // refetches candles for every ticker in the ledger history — trusted callers (the cron)
  // only. Rate-limiting alone wasn't enough: 6/min per IP of a 200+ ticker rebuild is still
  // a cheap way to burn the function budget.
  'redundancy',
  // router: cached read public (the shadow health panel reads it); force=1 runs buildRows
  // (candle refetch per ledger ticker) — trusted only. The route also self-gates force.
  'router',
  // routercf: same shape — anonymous reads serve the cached counterfactual report.
  'routercf',
]);
// Ingest endpoints: POST-only + their own token/secret gate inside the route.
const INGEST_OPS = new Set(['insideringest', 'alertsingest']);

// Every log line emitted while handling this request carries the op that caused it,
// so a `no daily data` warning names its own caller instead of having to be inferred.
const { withLogContext } = require('../lib/log');

module.exports = async function handler(req, res) {
  return withLogContext({ op: String(req.query.op || 'scoreboard'), route: '/api/tracker' }, () => handleRequest(req, res));
};

async function handleRequest(req, res) {
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
  if (req.query.op === 'lifecycle') return require('../lib/lifecycle-routes').runLifecycle(req, res);
  if (req.query.op === 'lifecyclegrade') return require('../lib/lifecycle-routes').runLifecycleGrade(req, res);
  if (req.query.op === 'discover') return require('../lib/intraday-discovery').runDiscover(req, res);
  if (req.query.op === 'daytradealerts') return require('../lib/daytrade-alerts').runDaytradeAlerts(req, res);
  if (req.query.op === 'survival') return require('../lib/survival-eval').runSurvival(req, res);
  if (req.query.op === 'daytradescan') return require('../lib/daytrade-scan-runner').runScanRunner(req, res);
  if (req.query.op === 'daytradescanhealth') return require('../lib/daytrade-scan-runner').runScanHealth(req, res);
  // Authenticated board tick (the ONE lifecycle mutator) + model-governance ops.
  if (req.query.op === 'daytradeboardtick') return require('../lib/screener-routes').runDaytradeBoardTick(req, res);
  if (['modeltrain', 'modelpromote', 'modelchallenger', 'modelpromotelive', 'modelrollback', 'modelstatus'].includes(req.query.op)) {
    return require('../lib/model-ops').runModelOps(req, res);
  }
  // Web Push (feature-flagged: no-ops unless VAPID env + web-push dependency are present).
  // Subscribe/unsubscribe are browser POSTs carrying only the PushSubscription JSON; status
  // exposes configuration + counts, never endpoints (they are capability URLs).
  if (req.query.op === 'pushsubscribe' || req.query.op === 'pushunsubscribe' || req.query.op === 'pushstatus') {
    return require('../lib/push-routes').runPushOp(req, res);
  }
  if (req.query.op === 'daytradecapture') return require('../lib/runner-capture').runDaytradeCapture(req, res);
  if (req.query.op === 'datasetgrade') {
    // With an explicit date: grade that single day. Without one: BACKLOG mode — grade the
    // oldest incomplete captured dates first (today included), retrying prior days until
    // each hits remaining=0, terminal unavailability, or the bar-retention deadline.
    const limit = parseInt(req.query.limit || '40', 10) || 40;
    const out = req.query.date
      ? await require('../lib/intraday-dataset').gradeDatasetDay(req.query.date, { limit })
      : await require('../lib/intraday-backlog').gradeDatasetBacklog({ limit });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(out);
  }
  if (req.query.op === 'datasetsurvival') return require('../lib/intraday-training').runDatasetSurvival(req, res);
  if (req.query.op === 'swingsearchlog') return require('../lib/swing-search-ledger').runSwingSearchLog(req, res);
  if (req.query.op === 'swingsearchgrade') return require('../lib/swing-search-ledger').runSwingSearchGrade(req, res);
  if (req.query.op === 'swingsearchstatus') return require('../lib/swing-search-ledger').runSwingSearchStatus(req, res);
  if (req.query.op === 'swingmonitor') return require('../lib/swing-supervisor-routes').runSwingMonitor(req, res);
  if (req.query.op === 'swinggrade') return require('../lib/swing-supervisor-routes').runSwingGrade(req, res);
  // ── LOW-FLOAT IGNITION / INTRADAY CONTINUATION (lib/lowfloat-routes.js) ──────
  // Public reads are read-only projections; the *tick / resolve / promote ops are in
  // PRIVILEGED_OPS above and are the only writers in this stack.
  if (req.query.op === 'lowfloat') return require('../lib/lowfloat-routes').runLowFloat(req, res);
  if (req.query.op === 'lowfloattick') return require('../lib/lowfloat-routes').runLowFloatTick(req, res);
  if (req.query.op === 'lowfloatbook') return require('../lib/lowfloat-routes').runLowFloatBook(req, res);
  if (req.query.op === 'intradaycontinuation') return require('../lib/lowfloat-routes').runIntradayContinuation(req, res);
  if (req.query.op === 'intradaytick') return require('../lib/lowfloat-routes').runLowFloatTick(req, res);
  if (req.query.op === 'intradaybook') return require('../lib/lowfloat-routes').runLowFloatBook(req, res);
  if (req.query.op === 'intradayresolve') return require('../lib/lowfloat-routes').runIntradayResolve(req, res);
  if (req.query.op === 'intradayvalidation') return require('../lib/lowfloat-routes').runIntradayValidation(req, res);
  if (req.query.op === 'intradaypromote') return require('../lib/lowfloat-routes').runIntradayPromote(req, res);
  if (req.query.op === 'largemoveraudit') return require('../lib/lowfloat-routes').runLargeMoverAudit(req, res);
  if (req.query.op === 'largemoveraudittick') return require('../lib/lowfloat-routes').runLargeMoverAuditTick(req, res);
  if (req.query.op === 'largemoverbook') return require('../lib/lowfloat-routes').runLargeMoverBook(req, res);
  if (req.query.op === 'positionsize') return require('../lib/lowfloat-routes').runPositionSize(req, res);
  // ── IGNITION LIVE (lib/ignition-live-routes.js) ──────────────────────────────
  // Spec-shaped synthesis over the low-float pipeline. ALL THREE ops are read-only
  // projections of snapshots the privileged op=lowfloattick persisted — there is no separate
  // ignition writer op, so nothing here belongs in PRIVILEGED_OPS.
  if (req.query.op === 'ignitionlive') return require('../lib/ignition-live-routes').runIgnitionLive(req, res);
  if (req.query.op === 'ignitionreplay') return require('../lib/ignition-live-routes').runIgnitionReplay(req, res);
  if (req.query.op === 'ignitionleadtime') return require('../lib/ignition-live-routes').runIgnitionLeadtime(req, res);
  // Read-only provider health check: does the configured plan actually return share float?
  // The whole low-float lane is worth exactly what this answers.
  if (req.query.op === 'floatprobe') return require('../lib/lowfloat-routes').runFloatProbe(req, res);
  // Which bulk-quote provider answers, and does it carry volume? Decides three of the seven
  // discovery lanes.
  if (req.query.op === 'quoteprobe') return require('../lib/lowfloat-routes').runQuoteProbe(req, res);

  // ── 🖥 TECHNOLOGY COMMAND CENTER (lib/tech-command-routes.js) ────────────────
  // Public reads are read-only projections over a persisted snapshot (with a bounded
  // live fallback); the *tick / *resolve ops are in PRIVILEGED_OPS above and are the
  // only writers in this stack. The frozen Day Trade engine is consumed, never modified.
  if (req.query.op === 'techcommand') return require('../lib/tech-command-routes').runTechCommand(req, res);
  if (req.query.op === 'techcommandticker') return require('../lib/tech-command-routes').runTechCommandTicker(req, res);
  if (req.query.op === 'techcommandhealth') return require('../lib/tech-command-routes').runTechCommandHealth(req, res);
  if (req.query.op === 'techcommandtick') return require('../lib/tech-command-routes').runTechCommandTick(req, res);
  if (req.query.op === 'techcommandresolve') return require('../lib/tech-command-routes').runTechCommandResolve(req, res);

  if (req.query.op === 'daytradetick') return runDaytradeTick(req, res);
  if (req.query.op === 'daytradebook') return runDaytradeBook(req, res);
  if (req.query.op === 'daytradeopt') return runDaytradeOpt(req, res);
  if (req.query.op === 'coil') return runCoil(req, res);
  if (req.query.op === 'coiltick') return runCoilTick(req, res);
  if (req.query.op === 'coilbook') return runCoilBook(req, res);
  if (req.query.op === 'gapgo') return runGapGo(req, res);
  if (req.query.op === 'gapgotick') return runGapGoTick(req, res);
  if (req.query.op === 'gapgoverify') return require('../lib/gapgo-verify').runGapGoVerify(req, res);
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
  if (req.query.op === 'confluencemarginal') return runConfluenceMarginal(req, res);
  if (req.query.op === 'pulse') return runPulse(req, res);
  if (req.query.op === 'pulserefine') return runPulseRefine(req, res);
  if (req.query.op === 'pulsegrade') return runPulseGrade(req, res);
  if (req.query.op === 'pulseepisodes') return runPulseEpisodes(req, res);
  // Market Pulse v2 — public read-only reads + privileged writer ticks.
  if (req.query.op === 'pulse2') return require('../lib/pulse2-routes').runPulse2(req, res);
  if (req.query.op === 'pulse2health') return require('../lib/pulse2-routes').runPulse2Health(req, res);
  if (req.query.op === 'pulse2evidence') return require('../lib/pulse2-routes').runPulse2Evidence(req, res);
  if (req.query.op === 'pulse2statetick') return require('../lib/pulse2-ticks').runPulse2StateTick(req, res);
  if (req.query.op === 'pulse2collect') return require('../lib/pulse2-ticks').runPulse2Collect(req, res);
  if (req.query.op === 'pulse2refine') return require('../lib/pulse2-ticks').runPulse2Refine(req, res);
  if (req.query.op === 'pulse2grade') return require('../lib/pulse2-ticks').runPulse2Grade(req, res);
  if (req.query.op === 'leadtime') return require('../lib/leadtime-routes').runLeadTime(req, res);
  if (req.query.op === 'leadtime2') return require('../lib/leadtime2-routes').runLeadTime2(req, res);
  if (req.query.op === 'failuremodel') return require('../lib/failure-model-routes').runFailureModel(req, res);
  if (req.query.op === 'complab') return require('../lib/component-lab-routes').runComponentLabRoute(req, res);
  if (req.query.op === 'readthrough') return require('../lib/readthrough-routes').runReadThrough(req, res);
  if (req.query.op === 'readthroughtick') return require('../lib/readthrough-routes').runReadThroughTick(req, res);
  if (req.query.op === 'anomaly') return require('../lib/anomaly-routes').runAnomaly(req, res);
  if (req.query.op === 'anomalytick') return require('../lib/anomaly-routes').runAnomalyTick(req, res);
  if (req.query.op === 'biotech') return require('../lib/biotech-routes').runBiotech(req, res);
  if (req.query.op === 'biotechtick') return require('../lib/biotech-routes').runBiotechTick(req, res);
  if (req.query.op === 'biotechgrade') return require('../lib/biotech-routes').runBiotechGrade(req, res);
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
  if (req.query.op === 'optionsepisodes') return runOptionsEpisodes(req, res);
  if (req.query.op === 'optionsassess') return runOptionsAssess(req, res);
  // Options Intelligence Engine v2 (lib/optionsflow-v2-routes.js)
  if (req.query.op === 'optionsscan2') return require('../lib/optionsflow-v2-routes').runOptionsScanV2(req, res);
  if (req.query.op === 'optionsresolve2') return require('../lib/optionsflow-v2-routes').runOptionsResolveV2(req, res);
  if (req.query.op === 'optionsradar') return require('../lib/optionsflow-v2-routes').runOptionsRadar(req, res);
  if (req.query.op === 'optionsevidence2') return require('../lib/optionsflow-v2-routes').runOptionsEvidenceV2(req, res);
  if (req.query.op === 'optionshealth2') return require('../lib/optionsflow-v2-routes').runOptionsHealthV2(req, res);
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
  if (req.query.op === 'calarchive') return require('../lib/alpha-archive-routes').runCalArchive(req, res);
  if (req.query.op === 'revarchive') return require('../lib/alpha-archive-routes').runRevArchive(req, res);
  if (req.query.op === 'gexarchive') return require('../lib/alpha-archive-routes').runGexArchive(req, res);
  if (req.query.op === 'archivehealth') return require('../lib/alpha-archive-routes').runArchiveHealth(req, res);
  if (req.query.op === 'estarchive') return require('../lib/est-archive').runEstArchive(req, res);
  if (req.query.op === 'sec8karchive') return require('../lib/filing-archives').runSec8kArchive(req, res);
  if (req.query.op === 'insarchive') return require('../lib/filing-archives').runInsiderArchive(req, res);
  if (req.query.op === 'fmpaudit') return require('../lib/fmp-audit').runFmpAudit(req, res);
  // CFL — Counterfactual Opportunity & Forecastability Lab (shadow, weight-0).
  if (req.query.op === 'cfl') return require('../lib/cfl-routes').runCflSummary(req, res);
  if (req.query.op === 'cflmissed') return require('../lib/cfl-routes').runCflMissed(req, res);
  if (req.query.op === 'cflduds') return require('../lib/cfl-routes').runCflDuds(req, res);
  if (req.query.op === 'cfltrace') return require('../lib/cfl-routes').runCflTrace(req, res);
  if (req.query.op === 'cflforecast') return require('../lib/cfl-routes').runCflForecast(req, res);
  if (req.query.op === 'cfltick') return require('../lib/cfl-routes').runCflTick(req, res);
  if (req.query.op === 'cflbackfill') return require('../lib/cfl-routes').runCflBackfill(req, res);
  // PSRL — Persistent Staircase Relative Leadership (shadow, weight-0).
  if (req.query.op === 'psrl') return require('../lib/psrl-routes').runPsrlBoard(req, res);
  if (req.query.op === 'psrldetail') return require('../lib/psrl-routes').runPsrlDetail(req, res);
  if (req.query.op === 'psrlhealth') return require('../lib/psrl-routes').runPsrlHealth(req, res);
  if (req.query.op === 'psrltick') return require('../lib/psrl-routes').runPsrlTick(req, res);
  if (req.query.op === 'psrlresearch') return require('../lib/psrl-routes').runPsrlResearch(req, res);
  if (req.query.op === 'alphabook') return require('../lib/alphabook-routes').runAlphaBook(req, res);
  if (req.query.op === 'vrptick') return require('../lib/vrp-routes').runVrpTick(req, res);
  if (req.query.op === 'vrpbook') return require('../lib/vrp-routes').runVrpBook(req, res);
  if (req.query.op === 'ephemeraltick') return require('../lib/ephemeral-routes').runEphemeralTick(req, res);
  if (req.query.op === 'ephemeral') return require('../lib/ephemeral-routes').runEphemeral(req, res);
  if (req.query.op === 'intracapture') return runIntraCapture(req, res);
  if (req.query.op === 'intraday') return runIntraday(req, res);
  if (req.query.op === 'baseline') return runBaseline(req, res);
  if (req.query.op === 'ivrvsample') return runIvRvSample(req, res);
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
  if (req.query.op === 'adaptivepolicy') return require('../lib/maturity-routes').runAdaptivePolicy(req, res);
  if (req.query.op === 'router') return require('../lib/algo-router-routes').runRouter(req, res);
  if (req.query.op === 'routercf') return require('../lib/algo-router-routes').runRouterCounterfactual(req, res);
  if (req.query.op === 'baselines') return require('../lib/baselines-routes').runBaselines(req, res);
  if (req.query.op === 'recalibrate') return runRecalibrate(req, res);
  if (req.query.op === 'backfill') return runBackfillOp(req, res);
  if (req.query.op === 'research') return runResearchOp(req, res);
  if (req.query.op === 'moverstudy') return runMoverStudyOp(req, res);
  if (req.query.op === 'exits') return runExitsOp(req, res);
  if (req.query.op === 'emerging') return runEmergingOp(req, res);
  if (req.query.op === 'longshort') return runLongShortOp(req, res);
  if (req.query.op === 'pead') return runPeadOp(req, res);
  if (req.query.op === 'congress') return runCongressOp(req, res);
  if (req.query.op === 'govdemand') return require('../lib/govdemand-routes').runGovDemand(req, res);
  if (req.query.op === 'govdemandtick') return require('../lib/govdemand-routes').runGovDemandTick(req, res);
  if (req.query.op === 'govdemandresolve') return require('../lib/govdemand-routes').runGovDemandResolve(req, res);

  // ⚡ GRIDLOCK — physical-constraint shadow vertical (weight-0, never changes a live ranking).
  // gridlock/gridlockscenario are public reads (cached snapshot / pure arithmetic);
  // gridlocktick/gridlockresolve are cron-only writers.
  if (req.query.op === 'gridlock') return require('../lib/gridlock-routes').runGridlock(req, res);
  if (req.query.op === 'gridlockscenario') return require('../lib/gridlock-routes').runGridlockScenario(req, res);
  if (req.query.op === 'gridlocktick') return require('../lib/gridlock-routes').runGridlockTick(req, res);
  if (req.query.op === 'gridlockresolve') return require('../lib/gridlock-routes').runGridlockResolve(req, res);
  if (req.query.op === 'revisions') return runRevisionsOp(req, res);
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
  if (req.query.op === 'hypotheses') return require('../lib/hypothesis-routes').runHypotheses(req, res);
  if (req.query.op === 'datahealth') return require('../lib/data-health-routes').runDataHealth(req, res);
  if (req.query.op === 'pitdata') return require('../lib/pitdata-routes').runPitData(req, res);
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
  // EVIDENCE CONSENSUS & THESIS CHANGE engine — news→events→clusters→consensus→thesis.
  if (req.query.op === 'evidencetick') return require('../lib/evidence-routes').runEvidenceTick(req, res);
  if (req.query.op === 'evidence') return require('../lib/evidence-routes').runEvidence(req, res);
  if (req.query.op === 'evidencestock') return require('../lib/evidence-routes').runEvidenceStock(req, res);
  if (req.query.op === 'evidencediag') return require('../lib/evidence-routes').runEvidenceDiag(req, res);
  // NOVEL SIGNAL LAB — shadow-only research surface (never touches prod recs; kill-switch NSL_DISABLED).
  if (req.query.op === 'nsl') return require('../lib/nsl-routes').runNsl(req, res);
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
  if (req.query.op === 'omegafunnel') return require('../lib/omega-swing-routes').runOmegaFunnel(req, res);
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
  // 🛰️ ORBIT-ML (shadow EVOLVE specialist `idiosyncraticPersistence`). Read/health public;
  // tick/resolve are cron-only WRITES; walkforward is a heavy backfill+train+eval recompute.
  if (req.query.op === 'orbitml') return require('../lib/orbit-ml-routes').runOrbitMl(req, res);
  if (req.query.op === 'orbitmltick') return require('../lib/orbit-ml-routes').runOrbitMlTick(req, res);
  if (req.query.op === 'orbitmlresolve') return require('../lib/orbit-ml-routes').runOrbitMlResolve(req, res);
  if (req.query.op === 'orbitmlwalkforward') return require('../lib/orbit-ml-routes').runOrbitMlWalkForward(req, res);
  if (req.query.op === 'orbitmlhealth') return require('../lib/orbit-ml-routes').runOrbitMlHealth(req, res);
  if (req.query.op === 'orbitcontrols') return require('../lib/orbit-ml-routes').runOrbitControls(req, res);

  // ATLAS-X — shadow swing challenger (weight-0). Read board + cron-only writers.
  if (req.query.op === 'premove') return require('../lib/premove-routes').runPremove(req, res);
  if (req.query.op === 'premovelog') return require('../lib/premove-routes').runPremoveLog(req, res);
  if (req.query.op === 'premoveresolve') return require('../lib/premove-routes').runPremoveObsResolve(req, res);
  if (req.query.op === 'atlasx') return require('../lib/atlasx-routes').runAtlasX(req, res);
  if (req.query.op === 'atlasxlog') return require('../lib/atlasx-routes').runAtlasXLog(req, res);
  if (req.query.op === 'atlasxresolve') return require('../lib/atlasx-routes').runAtlasXResolve(req, res);
  if (req.query.op === 'atlasxwalkforward') return require('../lib/atlasx-routes').runAtlasXWalkForward(req, res);
  // RLT — shadow Relative Leadership Transition (weight-0). Read board + cron-only writers.
  if (req.query.op === 'rlt') return require('../lib/rlt-routes').runRlt(req, res);
  if (req.query.op === 'rltlog') return require('../lib/rlt-routes').runRltLog(req, res);
  if (req.query.op === 'rltresolve') return require('../lib/rlt-routes').runRltResolve(req, res);
  if (req.query.op === 'rltwalkforward') return require('../lib/rlt-routes').runRltWalkForward(req, res);
  // Peer Propagation — SHADOW (weight-0). Read board + cron-only ledger writer +
  // walk-forward with built-in falsifications (reversed edges / random peers).
  if (req.query.op === 'peerprop') return require('../lib/peerprop-routes').runPeerProp(req, res);
  if (req.query.op === 'peerproplog') return require('../lib/peerprop-routes').runPeerPropLog(req, res);
  if (req.query.op === 'peerpropwf') return require('../lib/peerprop-routes').runPeerPropWalkforward(req, res);
  // News Underreaction — SHADOW, prospective-only (no backfill op exists on purpose).
  if (req.query.op === 'underreaction') return require('../lib/underreaction-routes').runUnderreaction(req, res);
  if (req.query.op === 'underreactionlog') return require('../lib/underreaction-routes').runUnderreactionLog(req, res);
  // Volume/capacity forecast for one ticker — cheap bounded read (execution context, not alpha).
  if (req.query.op === 'volforecast') return require('../lib/volforecast-routes').runVolForecast(req, res);
  // Target comparison — which LEARNING TARGET transfers best on real graded outcomes
  // (one fixed economic metric, identical purged folds; cached=1 serves the report).
  if (req.query.op === 'targetcompare') return require('../lib/target-compare-routes').runTargetCompare(req, res);
  // Expectation-Gap regime challenger — reduce-only shadow read + cron-only ledger writer.
  if (req.query.op === 'expgap') return require('../lib/expgap-routes').runExpGap(req, res);
  if (req.query.op === 'expgaplog') return require('../lib/expgap-routes').runExpGapLog(req, res);
  if (req.query.op === 'promotionreadiness') return require('../lib/orbit-ml-routes').runPromotionReadiness(req, res);
  if (req.query.op === 'researchgrade') return require('../lib/research-grade-routes').runResearchGrade(req, res);

  // Chart Pattern Intelligence — SHADOW (weight-0, never changes a live ranking).
  // patternsearch/patterns are public cached reads; patternlog/patterngrade are cron-only writers.
  if (req.query.op === 'patternsearch') return require('../lib/pattern-routes').runPatternSearch(req, res);
  if (req.query.op === 'patterns') return require('../lib/pattern-routes').runPatterns(req, res);
  if (req.query.op === 'patternlog') return require('../lib/pattern-routes').runPatternLog(req, res);
  if (req.query.op === 'patterngrade') return require('../lib/pattern-routes').runPatternGrade(req, res);
  if (req.query.op === 'patternresearch') return require('../lib/pattern-routes').runPatternResearch(req, res);
  return runScoreboard(req, res);
};
