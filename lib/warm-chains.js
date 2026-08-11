'use strict';
// WARM CHAINS — ordered cron work that runs in ITS OWN invocation.
//
// THE BUG THIS FIXES (found in the Vercel logs, 2026-07-17):
//
//   [warm] track ok 12731ms · narrative 103ms · apexlog 6847ms · ghostlog 10165ms
//   [warm] archive skipped:budget 51800ms elapsed
//   [warm] done {"elapsedMs":55001, skipped:[archive,intracapture,cern,edgelog,...]}
//
// api/warm.js awaited ~22s of cache warming plus ~30s of ledger stages, so by the time
// it reached its fire-and-forget section it had ~3s of a 55s drain ceiling left. Every
// ORDERED chain there was written as `firstKick.then(() => next()).then(() => next())`
// — and a `.then()` only fires while WARM'S OWN event loop is alive. Warm returned at
// 55.0s, ~3s after dispatching the first link. So:
//
//   • the 2nd+ link of every chain never fired (redundancy rebuild, the op=today
//     re-prime, evolvescore→evolveresolve, ignitionlog, omegalog, alignedlog,
//     universecompile, pulserefine, the OMEGA-Ensemble prime);
//   • the 7 awaited tail stages (archive, intracapture, cern, edgelog, alertsgrade,
//     alertsassess, fadetick) were budget-skipped EVERY run;
//   • the 3 decoupled tick chains were created past the 50s mark and drained for ~3s.
//
// None of it errored. Health reported ok:true / healthy:true, because a budget skip was
// classed as "deferred, self-heals next run" — a premise that is false when it is
// skipped every single run. This is why so much of this app has needed manual triggering.
//
// THE FIX — put the ordering INSIDE the callee, not in the caller.
//
// Every step here is an HTTP call to another Vercel function, which gets its OWN 60s
// budget and runs to completion INDEPENDENTLY of whoever dispatched it. So a chain
// executed inside an `op=warmchain` invocation survives warm's death: warm only has to
// get the request out of the door. Warm still awaits for REPORTING, but its report being
// truncated no longer means the work was lost.
//
// A chain hands off to the next with `@name`, which DISPATCHES a fresh warmchain
// invocation rather than inlining those steps — so each link gets a full budget instead
// of eating its parent's remainder. A parent that dies mid-handoff does not stop the
// child: it is already its own invocation.
//
// Pure + injectable (`call` + `now`): the runner never touches the network or the wall
// clock itself, so the ordering and the budget are unit-testable — which matters here
// precisely because the cron cannot be triggered by hand (it is 401 without CRON_SECRET
// and fires once a day).

// Soft budget for one chain invocation. Under the function wall with headroom, so a
// long chain records honest skips instead of being killed mid-step (a hard kill is a 504
// and writes no report at all).
//
// RAISED 48s → 240s alongside the tracker/warm maxDuration raise to 300s (vercel.json).
// The 2026-08-06 cron proved the 48s/60s pairing chronically too tight for the work as
// designed: `ledger` finished its own steps at 52.5s and budget-skipped `@decision` (so
// the day's decision snapshot was never written — 2 of the last 7 weekdays lost), and
// FOUR roots (pattern, pulse, swingsearch, ticks3) hit the 60s wall mid-step and died as
// 504s with no report at all — which is why the Pattern Radar scan cursor had not
// persisted since 08-04. 240s lets every chain run the steps it was designed to run;
// the 60s of headroom under the wall absorbs one slow awaited step started near the
// deadline, so the invocation still finishes (and persists its report) instead of 504ing.
const CHAIN_DEADLINE_MS = 240000;

// ORDER MATTERS inside a chain; chains themselves are independent of each other.
const CHAINS = {
  // The day's ledger writes. `track` must land before the redundancy rebuild reads the
  // ledger, and `narrative` before `apexlog` stamps signals with the current tag — hence
  // one ordered chain, handing off to the decision layer once the picks are written.
  // `op=runmanifest` runs LAST in this invocation (before handing off to @decision):
  // by then track/apexlog/ghostlog have written today's ledger files, so the manifest
  // pins their real content hashes + the deploy SHA into the immutable `runs` chain.
  ledger: ['op=track', 'op=narrative', 'op=apexlog', 'op=ghostlog', 'op=runmanifest', '@decision'],

  // The decision layer, deliberately SPLIT across two invocations.
  //
  // today&log=1 writes tomorrow's lane diff, then the redundancy model is rebuilt. Both
  // are slow (~11s) and `op=redundancy&force=1` is the one op here whose cost is genuinely
  // unknown — it refetches candles for every ticker in the ledger history (214 and
  // growing). Putting the re-prime and the ensemble behind it in the SAME invocation made
  // the chain ~47s against a 48s deadline, so one slow rebuild would budget-skip
  // op=ensemble — reintroducing exactly the starvation this file exists to remove.
  // Handing off buys the re-prime a fresh budget instead of gambling on the remainder.
  decision: ['op=today&log=1', 'op=redundancy&force=1', '@reprime'],

  // The re-prime MUST follow the rebuild: op=today's CDN copy still carries the previous
  // model's credits until it is refetched, and op=ensemble is a projection of op=today, so
  // it primes last or it caches a board scored on the old model.
  // op=challengerlog logs the shadow board AFTER today+ensemble are fresh (self-fetches the
  // warm cached endpoints). op=challengerresolve is candle-heavy so it rides ticks3 instead.
  // No longer hands to @evolve — see the `evolve` root below for why it was detached.
  reprime: ['op=today', 'op=ensemble', 'op=challengerlog', 'op=orbitlog', 'op=orbitmltick'],

  // EVOLVE: log predictions, resolve matured ones (applies the uniqueness weighting + DSR
  // survivors to the live perf ledger), then prime the tab.
  //
  // OWN ROOT as of 2026-07-20 — it was `ledger → @decision → @reprime → @evolve`, four
  // warmchain hops deep, and every step here returned Vercel **HTTP 508
  // (INFINITE_LOOP_DETECTED)** in ~4–12ms on EVERY cron run from 2026-07-18 (a 4-run
  // silent fail streak; found via the `stepFailDetail` added in the prior fix).
  //
  // EMPIRICAL basis for the fix (not a theory): `op=evolve` returns 200 in ~0.14s when
  // called SHALLOW, and 508 in 4ms when called at that depth. Each evolve step also
  // self-fetches `op=today`, which itself fans out to a batch of sub-endpoint self-fetches
  // — so nested deep, the lineage `evolve → today → {screener,gapgo,…}` is what trips the
  // platform's self-invocation guard. Promoting evolve to a root caps that whole subtree
  // near the top (`warm → evolve → today → …`), the known-good shallow condition.
  //
  // HONEST LIMIT: `op=ignition` ALSO self-fetches op=today and runs DEEPER (under
  // @postdecision) yet succeeds, so simple "depth" or "self-fetch" theories don't fully
  // explain the trip point — the exact Vercel heuristic is uncharacterized. The fix is
  // justified by the direct shallow-works/deep-fails observation, not by a full model, and
  // is confirmed by the next cron run turning this chain green.
  //
  // TRADE-OFF: as a root it races the decision spine, so it may read op=today scored on the
  // previous cron's redundancy model (one tick stale) instead of today's re-primed board.
  // For a shadow/experimental ledger that is negligible — and strictly better than the
  // 508-dead status quo, where it logged nothing at all.
  evolve: ['op=evolvescore&log=1', 'op=evolveresolve', 'op=evolve', '@postdecision'],

  // Everything else that only needs op=today to be fresh. One chain rather than three
  // roots so they cannot race the decision layer.
  postdecision: ['op=ignitionlog', 'op=ignition', 'op=omegalog', 'op=omega'],

  // The capture/tail stages that were budget-skipped on EVERY run — including op=archive,
  // which is step 1 of the backtest roadmap and has therefore not been capturing.
  // op=lifecyclegrade: grades the day's Day-Trade lifecycle transition snapshots (accrued by
  // live op=daytrade traffic) with post-decision bars — the previously-unwired grading leg.
  capture: ['op=archive', 'op=intracapture', 'op=lifecyclegrade', 'op=cerntick', 'op=edgelog', 'op=alertsgrade', 'op=alertsassess', 'op=fadetick'],

  // Screener + event resolve/learn/log ticks (order-independent within the chain).
  ticks1: ['op=trendtick', 'op=daytradetick', 'op=confluencetick', 'op=coiltick', 'op=gapgotick', 'op=gapgoverify', 'op=downdaytick', 'op=gapdowntick'],
  // Ordered pairs: timinglog→tune, dualreadlog→tune, then brief after predict+crowd.
  ticks2: ['op=timinglog', 'op=timingtune', 'op=dualreadlog', 'op=dualreadtune', 'op=predicttick', 'op=crowdtick', 'op=brieftick'],
  // Leaderboard (heavy), then core build→log→drift (ordered), then the cheap ones.
  ticks3: ['op=leaderboardtick&src=confluence', 'op=corebuild', 'op=corelog', 'op=coredrift', 'op=attentiontick', 'op=tonetick&limit=6', 'op=challengerresolve', 'op=orbitresolve', 'op=orbitmlresolve'],

  aligned: ['op=aligned', 'op=alignedlog'],
  // Security master refresh rides the once-daily heavy-build lane. Slow-changing, so a
  // budget-skip on a busy day self-heals next run (it re-reads all sources from scratch).
  // EXPANDED-UNIVERSE REFRESH THROUGHPUT (2026-08-05). The chain was already scheduled and
  // completing nightly — it was simply under-provisioned: 2 x 150 = 300 names/night against
  // a multi-thousand-name candidate list means a given name is re-fetched roughly every
  // three weeks. The coil vintage gate made the consequence visible: the `expanded` cohort
  // sat five sessions behind the cap-band caches and was excluded from every ranking.
  //
  // Scans now run in NESTED chains (`@name`), each of which gets its OWN invocation and
  // therefore its own 60s wall — the parent awaits them, so the compile still runs strictly
  // after the night's scans. Four nested chains x 2 scans x the 200-name cap = 1,600
  // names/night, a ~5x increase, without pushing any single invocation toward its limit.
  //
  // Each scan carries `cursor=1`, so they advance the SAME shared cursor
  // (universe/scan-cursor.json) in sequence and wrap — no ticker is fetched twice per night
  // and no range is skipped.
  // `op=universebuild` runs FIRST: it is the cheap free-directory ingest (NASDAQ Trader
  // symbol files + mechanical filter, no price fetches) that refreshes
  // universe/candidates.json — the list every scan below draws from. It was never wired
  // to any cron, so the candidate list silently aged (29 days as of 2026-08-07, against
  // the 10-day staleness bound lib/data-health.js itself enforces — op=datahealth had
  // been reporting `universe: stale` on every run). Nightly is safe: the build is
  // idempotent, seconds-cheap, and a directory-fetch failure leaves the previous
  // candidates doc in place (the op returns ok:false without writing).
  universe: ['op=universebuild', '@universescan1', '@universescan2', '@universescan3', '@universescan4', 'op=universecompile', 'op=secmasterbuild'],
  universescan1: ['op=universescan&cursor=1&limit=200', 'op=universescan&cursor=1&limit=200'],
  universescan2: ['op=universescan&cursor=1&limit=200', 'op=universescan&cursor=1&limit=200'],
  universescan3: ['op=universescan&cursor=1&limit=200', 'op=universescan&cursor=1&limit=200'],
  universescan4: ['op=universescan&cursor=1&limit=200', 'op=universescan&cursor=1&limit=200'],
  // Gather → refine (+enrich +episode fold) → SHADOW forward-grade of matured episodes.
  // Ordered: refine writes the episode ledger that pulsegrade then reads. pulsegrade is
  // cheap on a cold ledger (no matured episodes yet) and self-bounds its forward fetches.
  pulse: ['op=pulse&force=1', 'op=pulserefine&force=1', 'op=pulsegrade'],
  // Market Pulse v2: deterministic market-state snapshot → LLM collection (claim-level
  // provenance + event fold) → Fable editorial pass → per-horizon outcome appends.
  // Ordered: collect writes the event ledger pulse2grade reads. Intraday cadence comes
  // from .github/workflows/pulse2-tick.yml; this nightly root is the guaranteed floor.
  pulse2: ['op=pulse2statetick', 'op=pulse2collect', 'op=pulse2refine', 'op=pulse2grade'],

  // Shadow Algorithm-Effectiveness Monitor + Router. force=1 runs buildRows (candle refetch
  // for every ledger ticker — as heavy as op=redundancy&force=1), so it gets its OWN root
  // invocation rather than joining the already-tight `decision` chain (~47s/48s). It reads
  // the PERSISTED apex/redundancy.json + scoreboard/summary.json, so a one-tick-stale model
  // is fine (both are slow-moving artifacts); the per-date series it needs is built fresh
  // here. Persists router/latest.json (weights + cooldowns) so the public read serves cache.
  // routercf AFTER router so the day's weights are in history before evaluation.
  router: ['op=router&force=1', 'op=routercf&force=1'],

  // MATURITY → GOVERNANCE refresh (quant-redesign-3 H16). governance/latest.json was
  // previously written ONLY when a human opened the Maturity tab — yet it is a live
  // capital control (allocation clearance, now fail-closed) and the eligibility gate's
  // freshness input. Own root, mirroring `router`: it reads the persisted
  // scoreboard/summary.json (written earlier by the ledger chain's op=track path), so a
  // one-tick-stale summary is fine and nothing sits behind it to be budget-starved.
  maturity: ['op=maturity'],

  // Research-contract grading. Reads stored decision snapshots and writes outcome
  // batches once horizons elapse.
  //
  // OWN ROOT, for the same reason as `router`: it refetches daily candles for up to 3
  // decision days x 120 tickers, so its cost is both high and unknown-in-advance —
  // exactly the profile that budget-starves whatever sits behind it in a shared chain.
  //
  // It deliberately does NOT ride the `decision` chain behind `op=today&log=1`, even
  // though that step writes the snapshot it will eventually read. Grading only ever
  // touches days whose horizon has ALREADY elapsed (today is excluded by construction),
  // so there is no ordering dependency to honour — coupling them would buy nothing and
  // would put a slow candle sweep in front of the re-prime.
  researchgrade: ['op=researchgrade'],

  // Swing Episode Supervisor. OWN ROOT: it refetches daily candles for the union of every
  // non-terminal published swing episode + today's swing candidates (up to ~200 tickers), so
  // its cost is high and unknown-in-advance — the profile that budget-starves anything behind
  // it. It self-fetches the already-warmed op=today for current candidates; a one-tick-stale
  // op=today just means a brand-new name waits one tick (self-healing). Ordered so the monitor
  // writes the episode ledger that swinggrade then reads. Both steps are idempotent per session
  // (age is derived from bar dates, transitions append only on a real state change), so a
  // budget-skip or a double-dispatch cannot double-age or double-log. Wired into ROOT_CHAINS
  // from day one — the earlier lifecycle ops were left unwired and never aged; this must not.
  swing: ['op=swingmonitor&log=1', 'op=swinggrade'],

  // ATLAS-X shadow swing challenger. OWN ROOT for the same reason as `swing`: op=atlasxlog
  // builds the union universe (op=today swing candidates ∪ non-terminal ATLAS-X episodes ∪
  // near-miss) and prices it — cache-first, but with a bounded live-candle fallback — so its
  // cost is high and unknown-in-advance, the profile that budget-starves anything behind it.
  // It self-fetches the already-warmed op=today; a one-tick-stale op=today just delays a
  // brand-new name by one tick (self-healing), so racing the decision spine as a root is fine
  // — and mirrors `swing`, whose identical shallow lineage (root → op=today → sub-endpoints)
  // runs green, avoiding the deep-chain HTTP 508 that forced `evolve` to its own root.
  // Ordered: atlasxlog writes the episode ledger + predictions that atlasxresolve then grades.
  // Both are idempotent per session (episode age is bar-derived, transitions append only on a
  // real state change, resolved is deduped by predictionId), so a budget-skip or a
  // double-dispatch cannot double-age or double-log. SHADOW/weight-0: none of this can move a
  // live trade — it only accrues the prospective episodes + calibration evidence ATLAS-X needs.
  // op=premovelog appends the IMMUTABLE pre-move daily cross-section (write-once
  // per date) AFTER the episode ledger it reads from has been written.
  atlasx: ['op=atlasxlog', 'op=atlasxresolve', 'op=premovelog', 'op=premoveresolve'],

  // RLT — shadow Relative Leadership Transition. OWN ROOT (shallow lineage +
  // independent budget): op=rltlog runs the full cross-sectional scan and
  // persists the immutable daily artifacts BEFORE op=atlasxlog's next pass
  // reads rlt/latest.json for the expert injection; op=rltresolve appends
  // graded terminal episodes. SHADOW/weight-0: none of this can move a live trade.
  rlt: ['op=rltlog', 'op=rltresolve'],

  // Peer Propagation + News Underreaction shadow ledgers. Own root (heavy graph
  // estimation over the full candle pool must not budget-starve anything behind
  // it). underreactionlog reads the LATEST evidence snapshot — it does not fetch
  // news itself, so the 22:00 UTC burst rate-limit that exiled evidencetick to
  // GitHub Actions does not apply here.
  peerprop: ['op=peerproplog', 'op=underreactionlog'],

  // Expectation-Gap regime challenger — ~15 bounded ETF/index fetches, its own
  // root so a slow benchmark day can't starve the peerprop ledger (or vice versa).
  expgap: ['op=expgaplog'],

  // PIT-DATA-V2 shadow identity collector. OWN ROOT: each step is bounded (≤5
  // delisted-companies pages or one list pull) and resumable via its cursor, so a
  // budget-skip self-heals; once the cursor reaches 'done' the step is a cheap no-op
  // that keeps the store fresh. Shadow-only — no live consumer reads pitdata/*.
  // v2 collect stays for compatibility; the v3 DAILY append-only collector and
  // its immutable daily health artifact run after it. All shadow — no live
  // consumer reads pitdata/*. Three v3collect steps: the first completes the
  // daily run; the extras advance the longitudinal profile-enrichment sweep
  // (enrich-only runs) at ~250 symbols each.
  pitdata: ['op=pitdata&view=collect', 'op=pitdata&view=v3collect', 'op=pitdata&view=v3collect', 'op=pitdata&view=v3collect', 'op=pitdata&view=v3health'],

  // Shadow alt-signal drift probes (congressional net-flow, analyst-revision
  // momentum). OWN ROOT: each op sweeps FMP + daily candles for up to 150 names,
  // so cost is high and unknown-in-advance — the profile that budget-starves
  // anything behind it in a shared chain. Ordered DELIBERATELY (congress → then
  // revisions): the two ops together fire ~450 FMP calls, and running them
  // sequentially — congress fully drains before revisions starts — avoids the
  // burst that transient-429s a back-to-back second op. Both are weight-0 /
  // diagnostic (they only refresh apex/congress.json + apex/revisions.json for
  // the Custom Model panel; nothing here can move a live pick), and the signals
  // move slowly (congress disclosures lag 30-45d, analyst consensus is monthly),
  // so a budget-skip on a busy day self-heals on the next run.
  altprobes: ['op=congress', 'op=revisions'],

  // GOV-DEMAND shadow vertical (AI-Alpha-OS slice 1). OWN ROOT rather than a tail on
  // `altprobes`: the tick does a USAspending roster-batch scan (~12 POSTs) plus bounded
  // Finnhub/price fetches, and the resolve refetches 1y candles per pending prediction —
  // cost unknown-in-advance, exactly the profile that budget-starves a shared chain.
  // Ordered tick → resolve so a day's new predictions and matured outcomes land in the
  // same run. Everything is shadow/weight-0; a budget-skip self-heals next run (the
  // collector's 45-day lookback window overlaps far more than one missed day).
  govdemand: ['op=govdemandtick', 'op=govdemandresolve'],

  // ⚡ GRIDLOCK shadow vertical (physical constraint & marginal beneficiary). OWN ROOT
  // for the govdemand reason: the tick fans out to PJM/EIA/NWS adapters plus bounded
  // candle + OMEGA-timing fetches (cost unknown-in-advance), and the resolve refetches
  // 1y candles per pending candidate. Ordered tick → resolve so a day's candidates and
  // matured outcomes land in the same run. Everything is shadow/weight-0; a budget-skip
  // self-heals next run (the event ledger is cumulative, nothing is date-gated).
  gridlock: ['op=gridlocktick', 'op=gridlockresolve'],

  // Swing-search forward ledger (the per-ticker swing read's falsifiability layer).
  // OWN ROOT for the same reason as `swing`/`atlasx`/`router`: op=swingsearchlog fetches
  // ~2y of daily candles for a fixed ~150-name SP500 panel (+SPY) every run, so its cost
  // is high and unknown-in-advance — the profile that budget-starves anything behind it in
  // a shared chain. The route self-bounds (45s wall budget + bounded concurrency), and the
  // panel is FIXED, so a budget-skipped partial sweep self-heals next run (same names).
  // A shallow root (root → self-contained op) avoids the deep-chain HTTP 508 that forced
  // `evolve` to its own root. Ordered: swingsearchlog writes the day-shard that
  // swingsearchgrade later reads; grade only ever touches days whose horizon has already
  // elapsed (today is excluded by construction), and is cheap on a cold ledger. SHADOW /
  // weight-0 — this only accrues a consistent daily cross-section (cohort 'universe'), kept
  // separate from user-searched names, so the swing model can eventually be walk-forward
  // validated. Nothing here can move a live pick.
  swingsearch: ['op=swingsearchlog', 'op=swingsearchgrade'],
  // Evidence Consensus & Thesis Change (op=evidencetick) is deliberately NOT a chain:
  // inside the 22:00 UTC burst — all roots dispatched concurrently, altprobes alone
  // draining ~450 sequential FMP calls — its 14 news fetches were rate-limited to zero
  // every single day (14/14 "noNews", empty snapshot, empty Thesis Changes tab).
  // It runs 30 min after the burst from .github/workflows/evidence-tick.yml instead.
  // Chart Pattern Intelligence — SHADOW. patternlog scans a bounded pool and writes the
  // immutable first-detection record + radar snapshot; patterngrade resolves matured matches
  // from post-detection bars only. Its OWN root (each op self-fetches candles per name, so
  // it must not budget-starve a shared chain). Ordered: log writes what grade reads.
  pattern: ['op=patternlog', 'op=patterngrade'],
  // Pattern Radar PIT evidence build (2026-08-09): op=patternresearch mode=auto is
  // self-cursoring — ONE step per night that loops ~25-name slices in-process (150s
  // budget ≈ 100+ names) and writes its cursor doc once at the end; the completed sweep
  // triggers the evaluate that writes pattern/evidence.json (the artifact every family
  // gate + calibrated probability depends on, which had never been built), then idles
  // until the quarterly rebuild window. A single step, NOT a multi-step cursor handoff:
  // Blob overwrite read-back lags 10–30s, so back-to-back steps would re-read a stale
  // cursor and redo (or resurrect) work. OWN ROOT (unknown-cost candle sweeps must not
  // budget-starve patternlog/patterngrade in the `pattern` chain).
  patternresearch: ['op=patternresearch&mode=auto'],
  // CFL — Counterfactual Opportunity & Forecastability Lab (shadow, weight-0).
  // One nightly tick: reconstructs the latest MATURED checkpoint per horizon from
  // the candle cache + a full production-parity replay, grades the picks ledger
  // for duds, and refreshes the funnel summary. OWN ROOT: it replays the whole
  // scope cohort several times (unknown cost — must not budget-starve a shared
  // chain). Single step — no Blob cursor handoff between invocations. Reads the
  // candle cache the warm screener rebuilds in the same burst; if it observes
  // yesterday's cache the idempotent day-key just fills in on the next run.
  cfl: ['op=cfltick'],

  // PSRL — Persistent Staircase Relative Leadership (shadow, weight-0).
  // One nightly tick: scans the cached universe + live benchmarks, scores
  // continuity/leadership, and advances the trend-episode ledger. OWN ROOT
  // (unknown cost — must not budget-starve a shared chain) and a single
  // in-process step — the ledger read-modify-write must never straddle
  // invocations (Blob overwrite read-back lags 10-30s).
  psrl: ['op=psrltick'],

  // ALPHA-ARCHIVE streams (archive-first collection — lib/alpha-archive.js).
  // These capture data that cannot be reconstructed later, so a lost day is lost
  // forever: they get their own roots rather than a slot at the tail of `capture`
  // (which has a documented history of budget-starving its last steps).
  //
  // alphacal: ~3 FMP calendar calls then ~8 FMP feed-page calls — ordered
  // sequentially in ONE chain (the altprobes burst-429 lesson: never let two FMP
  // sweeps race each other from the same cron burst; each op also retries once).
  // op=revarchive is NOT here: two live crons proved the 22:00 burst 429s FMP
  // for minutes — longer than any in-process retry can outlast — so it runs
  // from .github/workflows/evidence-tick.yml at 22:30 UTC instead (the same
  // exile that fixed evidencetick). calarchive stays: its 3 calendar calls
  // squeeze through with the 4-try backoff (proven two nights running).
  alphacal: ['op=calarchive'],
  // gex slices: ~235 Yahoo option-chain names each (2 fetches/name, concurrency 6,
  // self-bounded ~38s) — one slice per invocation so each gets a full budget,
  // handed off @-style exactly like the decision spine (same known-good depth;
  // a deeper handoff chain risks the evolve-508 loop-detect).
  gexa: ['op=gexarchive&slice=0&of=3', '@gexb'],
  gexb: ['op=gexarchive&slice=1&of=3', '@gexc'],
  gexc: ['op=gexarchive&slice=2&of=3'],

  // VRP live paper put-write (lib/vrp-routes.js): resolve matured entries, then
  // enter on the frozen 5-session grid at REAL end-of-day quotes. Light (one
  // SPY history + one chain fetch) but its entry marks are unrecoverable — own
  // root so the capture chain's documented tail-starvation can never cost an
  // entry date.
  vrp: ['op=vrptick'],

  // Ephemeral edge factory (lib/ephemeral.js): daily grammar rescan over the
  // candle caches + paper-pick log + fast-horizon resolutions. Own root; reads
  // the caches the screener chain builds, so a one-tick-stale cache is fine.
  ephemeral: ['op=ephemeraltick'],

  // Options Intelligence Engine v2 (lib/optionsflow-v2-routes.js): dynamic-universe
  // chain scan (~90 names × up to 5 expiry fetches, self-time-boxed 150s) → event
  // resolution/grading. Unknown-cost dynamic universe ⇒ its OWN root per the rule
  // above; the scan is idempotent per decision session so a retry cannot double-write.
  optionsv2: ['op=optionsscan2', 'op=optionsresolve2'],
};

// Only these are dispatched by warm. The rest are reached via `@` from their parent — a
// chain that is BOTH a root and nested would run twice; one that is neither never runs.
// Both mistakes are asserted against in test/warm-chains.test.js.
const ROOT_CHAINS = ['ledger', 'capture', 'ticks1', 'ticks2', 'ticks3', 'aligned', 'universe', 'pulse', 'router', 'maturity', 'researchgrade', 'evolve', 'swing', 'atlasx', 'rlt', 'altprobes', 'govdemand', 'gridlock', 'swingsearch', 'pattern', 'patternresearch', 'cfl', 'psrl', 'peerprop', 'expgap', 'pitdata', 'alphacal', 'gexa', 'vrp', 'ephemeral', 'optionsv2', 'pulse2'];

const pathFor = (step) => (step.startsWith('@')
  ? `/api/tracker?op=warmchain&name=${step.slice(1)}`
  : `/api/tracker?${step}`);

// Run one named chain. `call(path) -> {ok, status}` and `now()` are injected so this is
// testable without a network or a wall clock.
async function runChain(name, { call, now = Date.now, deadlineMs = CHAIN_DEADLINE_MS } = {}) {
  const steps = CHAINS[name];
  if (!steps) return { ok: false, name, error: `unknown chain "${name}"`, steps: [], skipped: [], complete: false };

  const started = now();
  const done = [];
  const skipped = [];

  for (const step of steps) {
    const elapsed = now() - started;
    if (elapsed > deadlineMs) {
      // Do not START new work past the budget — record it instead. The next run picks it
      // up (each tick re-resolves everything still open), and the skip is NAMED so chronic
      // starvation is visible rather than reported as a healthy deferral.
      done.push({ op: step, status: 'skipped:budget', elapsedMs: elapsed });
      skipped.push(step);
      continue;
    }
    const t0 = now();
    try {
      const r = await call(pathFor(step));
      const ms = now() - t0;
      if (step.startsWith('@')) {
        // A nested chain runs in its own invocation, but this parent AWAITED it, so its
        // body IS here — propagate the child's real outcome (its steps' failures/skips)
        // rather than rubber-stamping "dispatched". A warmchain returns HTTP 200 even when
        // its steps failed, so trusting the status alone would bury the decision/evolve
        // pipeline's failures one level down — the exact blind spot being closed.
        const b = r && r.body;
        if (b && typeof b === 'object') {
          // Attribute failures/skips to the NAMED child steps, not to the @step itself, so
          // the report says "decision/op=redundancy" once — not that plus a bare "@decision".
          const childFails = (b.failed || []).map(f => `${step.slice(1)}/${f}`);
          const childSkips = (b.skipped || []).map(s => `${step.slice(1)}/${s}`);
          // Carry the child's per-step DETAIL up too, not just the names. Without the
          // status code a nested failure is undiagnosable from op=health: you learn that
          // `evolve/op=evolvescore` failed but not whether it was a 401, a 504, or a
          // throw — three different bugs with three different fixes.
          const childDetail = (b.failDetail || []).map(d => ({ ...d, op: `${step.slice(1)}/${d.op}` }));
          childSkips.forEach(s => skipped.push(s));
          done.push({ op: step, status: 'ok', ms, childFails, childSkips, childDetail });
        } else {
          // No body ⇒ the child was killed/timed out before responding. Unknown, not a
          // failure — honest, and warm's own report will show the root as truncated.
          done.push({ op: step, status: 'dispatched', ms });
        }
      } else {
        done.push({ op: step, status: r && r.ok === false ? `http:${(r && r.status) || '?'}` : 'ok', ms });
      }
    } catch (e) {
      // One bad feed must never cost the rest of the chain.
      done.push({ op: step, status: 'error', error: String((e && e.message) || e).slice(0, 160) });
    }
  }

  const OK = new Set(['ok', 'dispatched', 'skipped:budget']);
  const failed = done.filter(s => !OK.has(s.status));
  const nestedFailNames = done.flatMap(s => s.childFails || []);
  // `failed` transitively includes a nested chain's own failed steps (name-prefixed), so a
  // redundancy-rebuild failure deep under `ledger` reaches warm, not just the child's log.
  const allFailed = [...failed.map(s => s.op), ...nestedFailNames];
  // Same list as `failed`, but WITH the status/error that explains it. Kept as a
  // separate field so every existing consumer of `failed` (op=health, warm's report,
  // the tests) is untouched.
  const failDetail = [
    ...failed.map(s => ({ op: s.op, status: s.status, ms: s.ms, error: s.error || null })),
    ...done.flatMap(s => s.childDetail || []),
  ];
  return {
    ok: allFailed.length === 0 && skipped.length === 0,
    name,
    steps: done,
    skipped,
    complete: skipped.length === 0,
    failed: allFailed,
    failDetail,
    elapsedMs: now() - started,
  };
}

module.exports = { CHAINS, ROOT_CHAINS, CHAIN_DEADLINE_MS, pathFor, runChain };
