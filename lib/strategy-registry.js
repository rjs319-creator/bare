// Canonical catalog of every strategy/signal class the app runs — the single source
// of truth that the evidence-maturity grader (lib/maturity.js) joins against the live
// Scoreboard track record. Adding a screener? Add it here so it gets a maturity grade
// and, if it's an unproven overlay, is auto-routed to the Research Lab until it earns
// its way out.
//
// Fields:
//   id        stable key (matches the app tab where possible)
//   label     display name (with the tab's emoji)
//   kind      'signal' (return-generating, graded on forward return) | 'informational'
//             (context/awareness — never graded, never in the lab)
//   section   the Scoreboard `section` this class logs under (join key), or null when
//             it is tracked elsewhere / not yet in the board
//   horizon   intended holding period — intraday | swing | position | portfolio
//             (the executable outcome contract lives in lib/strategy-contracts.js)
//   core      true = a backbone tradeable screener that stays in the main workspaces
//             regardless of grade; false = an overlay that lives in the Research Lab
//             until it reaches Validated
//   maturity  live-trade eligibility, enforced centrally by lib/strategy-gate.js and
//             lib/eligibility.js. REQUIRED and EXPLICIT on every entry (quant-redesign-3):
//             an omitted/unknown maturity now fails CLOSED to 'shadow' — it can never
//             default to production again. Values:
//             'production' (may create/boost live trades) | 'shadow' (runs live in
//             confirmation/shadow mode, MUST NOT originate or boost a live trade) |
//             'experimental' (Research-Lab-only) | 'rejected'. Promotion out of shadow
//             is a deliberate data change gated by strategy-gate PROMOTION_GATE — it
//             can NEVER happen by editing UI wording.
//   scoringVersion  the version the source's normalizer stamps on its signals. Threaded
//             into maturity → governance so a scoring change RESETS earned evidence
//             (the version-reset guard in lib/governance.js was dead code without it).
//   note      optional plain-English context shown when there's no data to grade
//   criteria  optional: what would promote it out of the lab

const STRATEGY_REGISTRY = [
  // ── Core backbone screeners (stay in the main app; grade shown for honesty) ──
  // policyTiers (redesign Phase 5): the FROZEN cohort every displayed statistic for this
  // strategy is computed from. Declared explicitly on every governed strategy so average
  // return, win rate, cost-net utility and the confidence interval can never describe
  // different populations, and so control/research tiers are never pooled into the
  // promoted policy's record. Screener publishes exactly three statuses.
  { id: 'screener',   label: '🔎 Breakout',           kind: 'signal', section: 'screener', horizon: 'swing',    core: true,  maturity: 'production', scoringVersion: 'screener-v2', policyTiers: ['Early'], policyScopes: ['large'], note: 'screener-v2 (2026-08-11): Breakout admission no longer accepts volume-surge alone (c_volume dropped from the admission disjunct — volSurge rank-IC ≈ −0.004 in this project\'s own research) and techScore no longer credits volume-surge or the rising-50-DMA bonus. RVOL remains a descriptor. Version bumped so v1 evidence cannot validate the changed admission; Early/Setup admission logic is unchanged. | Policy cohort narrowed to Early:large 2026-08-09 from the resolved record + a production-parity replay. Live ledger (5d cost-net vs SPY): Early:large +0.62% (n=24/16 dates, 3/4 positive blocks) while Breakout:large −2.66% (n=67) and Setup:large −0.20% (n=89, 1d date CI entirely negative); every small-scope cell ≤−2%. Replay (research/74-early-cohort-replay.js; 2,000 names, 195 sessions 2022-2026, cost-net): Setup −0.38%/5d (HAC t −3.89) and −0.95%/21d (t −2.94, 0/8 positive blocks), Breakout −0.31%/5d (t −2.07); Early−Setup +0.34% (t 2.77, 4/4 blocks) and Early−Breakout +0.27% (t 1.82, 4/4 blocks) — but Early ABSOLUTE ≈0 (t −0.23) over the full window, so this narrowing removes proven-negative control lanes from the promoted claim; it does NOT pre-prove the Early cohort, whose prospective record must clear the promotion gates on its own. Breakout/Setup and small/micro lanes keep logging as excluded controls.', criteria: 'Early:large cohort alone (Breakout/Setup and small/micro scopes are excluded controls): cost-net excess vs SPY at the 5d contract, ≥50 resolved over ≥20 independent dates with the date-level CI clear of zero — then an explicit reviewable registry maturity flip.' },
  // CONTRACT CORRECTION (predictive-redesign, defect #15): detection is 5-minute technicals —
  // a same-session read — so the horizon is now 'intraday' (was 'position', which graded a
  // 5-minute signal on a 1-month contract). The universe redesign (defect #14: price/volume
  // discovery, StockTwits demoted to an annotation) bumps the scoring version; evidence
  // earned under momentum-v1's mismatched contract is NOT inherited, so maturity resets to
  // shadow until the v2 contract earns its own record.
  { id: 'momentum',   label: '🔥 Momentum',           kind: 'signal', section: 'momentum', horizon: 'intraday', core: true,  maturity: 'shadow', scoringVersion: 'momentum-v2', policyTiers: ['StrongBuy', 'StrongSell'], note: 'Intraday technical momentum over a price/volume-discovered universe (momentum-v2). Rebuilt 2026-07: universe = Day Trade discovery anomalies + screener cross-sections (never social trending); horizon corrected position→intraday. Prior momentum-v1 evidence was earned under a mismatched 1m contract and does not transfer — pre-v2 ledger rows reclassify to HIST_* at Scoreboard read time (lib/apex-routes momentumLedgerTier), so this policy cohort is the prospectively-accrued v2 record only. (2026-08-09 fix: policyTiers previously named a tier the ledger never writes, leaving governance permanently blind at excessN 0.)', criteria: 'Cost-net excess vs SPY at the 1d contract on the v2 universe, accrued prospectively, before any maturity upgrade.' },
  // DEMOTED production → shadow (alpha-research pass 3, 2026-08-11). This was the only
  // production entry carrying neither a note nor promotion criteria, and the repo's own
  // confirmatory record contradicts the status: hypothesis `quiet-accumulation-standalone`
  // (lib/research/hypothesis-registry.js) is status **no-edge** — "The Ghost
  // quiet-accumulation composite ranks better than momentum as a standalone selector",
  // tested against a 12-1 momentum / price-core baseline under a pre-declared stopping
  // rule (margin 0.02, ≥3 folds positive), verdict recorded from lib/ghost-backtest.js.
  //
  // The redundancy model additionally measures ghost×screener return correlation ≈0.96.
  // Two production strategies at 0.96 correlation are not two bets; they are one bet
  // sized twice — so the sleeve was also concentrating risk it appeared to diversify.
  //
  // Note the separate defect recorded against the evidence itself: ghost-backtest selects
  // its refinements on the full sample and then reports them as generalizing OOS, and its
  // purge (1 day) is far shorter than the 63-session forward window. So the no-edge
  // verdict is, if anything, the OPTIMISTIC reading. Shadow is not a punishment here —
  // it is what the evidence supports.
  // RETIRED as a duplicate (graduation-league weekly disposition cycle 1, owner
  // decision 2026-08-13). The full case: (a) confirmatory hypothesis
  // `quiet-accumulation-standalone` is no-edge; (b) ghost×screener return
  // correlation ≈0.96 and the measured independence credit fell to 0.248 — it
  // contributes ~a quarter of an independent strategy's evidence; (c) its
  // historical walk-forward evidence is invalidated by the Form 4 look-ahead
  // (graduation-league data-lineage F-1) until re-run; (d) its accumulation read
  // already reaches the board as `evidenceOrigins.volumeAccum` on screener rows.
  // Retirement is non-destructive: the entry, tab and historical ledger remain as
  // the auditable record; the standalone nightly tick stops accruing new evidence;
  // reads render as labeled context only. Un-retiring requires the same evidence
  // its criteria always demanded, via an explicit human registry transition.
  { id: 'ghost',      label: '👻 Ghost Accumulation',  kind: 'signal', section: 'Ghost',    horizon: 'swing',    core: true,  maturity: 'rejected', scoringVersion: 'ghost-v1', policyTiers: ['GHOST', 'STALKING'], note: 'RETIRED (duplicate of the Breakout screener) 2026-08-13 by owner decision, after demotion 2026-08-11. Measured independence credit 0.248 vs screener (corr ≈0.96); standalone hypothesis no-edge; historical insider-pillar evidence invalidated by a filing-date look-ahead. Historical ledger and tab remain as record; no new standalone evidence accrues; MUST NOT originate, boost, or add verdict weight to anything user-facing.', criteria: 'A NEW prospective record on a leakage-clean harness (the current ghost-backtest verdict selects refinements in-sample and purges 1 day against a 63-session horizon, so it cannot support promotion): cost-net excess vs SPY AND vs its sector at the swing contract, ≥50 resolved over ≥20 independent dates with the date-level CI clear of zero, PLUS demonstrated incremental value after redundancy adjustment against the screener (a 0.96-correlated sleeve must prove it adds something the Breakout book does not) — then an explicit reviewable registry maturity flip.' },
  // RECONCILED (non-daytrade redesign 2026-08): the registry said 'production' while the
  // entry's own note said "FORWARD-TRACKED CHALLENGER, not proven alpha" and the ledger
  // grades a daily-close PROXY of the ORB trade (contract fillVerified:false, ledger not
  // even folded into Scoreboard groups). A challenger cannot be production — maturity now
  // matches the evidence. The tab, ledger and frozen rules are untouched (core:true).
  { id: 'gapgo',      label: '🚀 Gap & Go',            kind: 'signal', section: 'GapGo',    horizon: 'intraday', core: true,  maturity: 'shadow', scoringVersion: 'gapgo-v1', policyTiers: ['TAKE'], note: 'UNPROVEN PROSPECTIVE CHALLENGER (2026-08 independent re-test: 51-name hand-picked rig, held-out date-clustered t≈1.5, liquid-25 subset negative held-out). The strongest surviving event setup — surfaced with frozen rules and tracked on its own ledger, which grades a daily-close PROXY of the intraday ORB trade (fills unverified). Registered shadow until the prospective ledger clears the gate on verified intraday execution.', criteria: 'Prospective ledger at the frozen rules: cost-net expectancy > 0, PF > 1, date-clustered lower CI > 0, on VERIFIED intraday ORB fills (real opening-range, trigger-reached, gap-skip honesty) — then an explicit reviewable registry flip.' },
  { id: 'daytrade',   label: '⚡ Day Trade',           kind: 'signal', section: 'daytrade', horizon: 'intraday', core: true,  maturity: 'production', scoringVersion: 'daytrade-v2' },
  // RECONCILED (non-daytrade redesign 2026-08): its own note says compression predicts
  // abnormal moves, NOT trade R, and the event-driven trade backtest was ~break-even with
  // every conviction ranker INVERTED (research/COIL-RADAR.md). An abnormal-expansion
  // watchlist detector is not a production trade originator; Stage-B (cost-net R given a
  // verified fill — the lib/coil-reliability.js lane) must clear promotion first.
  { id: 'coil',       label: '🧬 Coil Radar',          kind: 'signal', section: 'coil',     horizon: 'swing',    core: true,  maturity: 'shadow', scoringVersion: 'coil-v1', policyTiers: ['high'], note: 'ABNORMAL-EXPANSION WATCHLIST DETECTOR (Stage A validated: top-decile coils break ~2× base rate). NOT validated as a trade system: realized trade R ≈ break-even and every conviction ranker tested INVERTED vs realized R. Stage B (trade utility conditional on a verified fill, lib/coil-reliability.js) is the promotion bar.', criteria: 'Stage B: cost-net R given verified conditional fills, ≥50 resolved episodes over ≥20 dates with CI clear of zero across regimes — then an explicit reviewable registry flip.' },
  // DEMOTED production → shadow (alpha-research pass 3, 2026-08-12). The learned Apex /
  // logistic ranking was named for zeroing in the alpha-research brief §2, and the repo
  // record supports it on its own terms:
  //
  //   * NO registered hypothesis. Every other graded strategy has an entry in
  //     lib/research/hypothesis-registry.js stating what it claims and how it would be
  //     falsified. Apex has none — it was production without a written claim.
  //   * NO cost-net record. `section: null`, so it never joined the Scoreboard's
  //     cost-net excess lane; it was "tracked via its own drift/rank-quality panel",
  //     which measures rank stability, not whether the ranking earns money after costs.
  //   * UNCORRECTED SEARCH. lib/recalibrate.js evaluates 5 offsets x 4 pillars = 625
  //     candidate weight sets (OFFSETS x p1..p4) chosen on the full window. The purged
  //     4-fold IC bar it must then clear is genuinely strong, but 625 trials are never
  //     logged to the experiment ledger and never deflated the way lib/promotion-gate
  //     deflates Day-Trade model trials — so the selection is not multiple-testing
  //     controlled.
  //
  // The model, its panel, its tab and its recalibration lane are untouched and keep
  // running as a frozen benchmark. What is withdrawn is live weight: it can no longer
  // originate or boost a trade, and the client no longer publishes share counts or
  // dollar allocations from it.
  { id: 'custom',     label: '🧠 Adaptive Momentum',   kind: 'signal', section: null,       horizon: 'position', core: true,  maturity: 'shadow', scoringVersion: 'apex-v3', note: 'DEMOTED from production 2026-08-12 (brief §2: zero the learned Apex/logistic ranking). Apex ran live with no registered hypothesis, no cost-net Scoreboard record (section:null — the drift/rank-quality panel measures rank stability, not cost-net edge), and a 625-candidate weight search (lib/recalibrate.js) whose trials are neither ledgered nor deflated. Keeps running as a frozen benchmark; weight-0 — MUST NOT originate or boost a live trade, and MUST NOT publish a position size.', criteria: 'Register a falsifiable hypothesis in lib/research/hypothesis-registry.js, give the sleeve a Scoreboard section so it accrues a cost-net excess record, and log the recalibration search to research/experiments/registry.json with the trial count deflated (lib/promotion-gate.deflatedLiftBar is domain-neutral and already does this for the Day-Trade lane). Then: cost-net excess vs SPY AND sector at its contract horizon, >=50 resolved over >=20 independent dates, date-level CI clear of zero, surviving the deflated bar for 625 trials — and an explicit reviewable registry maturity flip.' },
  // Previously an UNREGISTERED ranker whose top-quintile sleeveA drove the 🔥 Prime
  // standout badge on Opportunities/Quick Hit cards — a user-facing conviction signal
  // with no governance identity. Registered shadow 2026-08-11: it keeps computing and
  // logging (a frozen shadow benchmark whose future outcomes stay comparable), but no
  // user-facing badge or rank may consume it until it earns clearance.
  { id: 'conviction', label: '🔥 Conviction Sleeve',   kind: 'overlay', section: null,      horizon: 'swing',    core: false, maturity: 'shadow', scoringVersion: 'conviction-v1', note: 'Regime-gated top-quintile conviction percentile over ghost pillars (lib/conviction.js). FROZEN SHADOW BENCHMARK — computed and logged on every scan, drives nothing user-facing. Unvalidated: no resolved cohort of its own yet.', criteria: 'Own resolved cohort: cost-net excess vs SPY, ≥50 resolved over ≥20 independent dates with date-level CI clear of zero — then an explicit reviewable registry flip before any badge or rank consumes it.' },
  // The one multi-factor swing ranker whose weights were NOT fitted: fixed economic
  // signs, equal weights, ranks not z-scores, expected cost INSIDE the score, and the
  // full rejection denominator retained (lib/transparent-challenger.js). Ships with its
  // own frozen-inverse negative control and identical-date ablation arms.
  { id: 'transparent', label: '🔍 Transparent Challenger', kind: 'signal', section: null,   horizon: 'swing',    core: false, maturity: 'shadow', scoringVersion: 'transparent-v1', note: 'Fixed-sign equal-weight rank composite: +sector-residual momentum 126→21, +tightness20d, −extension/ATR, −idiosyncratic vol 63d, −expected round-trip cost. SHADOW, weight-0, frozen before evaluation; weights may not be optimized during initial prospective testing (a fitted variant is a different strategy/version). Evaluated only via identical-date ablations (research/75) and prospective accrual.', criteria: 'Cost-net date-level CI clear of zero on prospective decisions, positive in ≥3 of 4 chronological blocks, survives doubled costs, beats residualMomentumOnly incrementally on identical dates, FDR-corrected within swing-ranking — then an explicit reviewable registry flip.' },
  // RECONCILED (non-daytrade redesign 2026-08): the contract declares 'catalyst lead (NO
  // published levels — lead, not a trade plan)' + fillPolicy 'lead-only', and the badge
  // lane grades the plan trigger as if always filled. A lead-only system with unverified
  // fills is research, not production; the honest episode lane (swing-evaluate, real
  // no-fill/gap-skip) is the promotion venue.
  { id: 'biotech',    label: '🧬 Biotech Radar',       kind: 'signal', section: 'Biotech',  horizon: 'swing',    core: true,  maturity: 'shadow', scoringVersion: 'biotech-v1', policyTiers: ['Hot'], note: 'LEAD-ONLY RESEARCH SYSTEM: catalyst leads benchmarked vs XBI. Its episode lane (lib/biotech-episodes.js via swing-evaluate) is the only grading path with real no-fill/gap-skip/same-bar honesty — promotion is judged there, never on the close-to-close Scoreboard proxy.', criteria: 'Executable episode record (swing-evaluate lane): ≥50 resolved episodes over ≥20 dates, XBI-residual cost-net excess with CI clear of zero, by catalyst archetype — then an explicit reviewable registry flip.' },
  // DEMOTED production → shadow (alpha-research pass 3, 2026-08-11). Contradicted by the
  // repo's own immutable experiment ledger: `A-downday-exact-contract-2026-08`
  // (research/experiments/registry.json), decision **NOT PROMOTED**.
  //
  // That study is unusually strong evidence BECAUSE it was run at the frozen production
  // contract, not a research proxy: detector `lib/downday.classify` (the production
  // module, bucket=bounce), next-session-open entry, 3-session horizon, matched
  // same-date × same-liquidity-band controls, 254 decision dates across 2022-07-22 →
  // 2026-06-26. Result: lift −0.04%, CI95 [−0.16, +0.08], effectiveN 254,
  // positiveBlocks 0, BH q = 0.52.
  //
  // Cost stress is identical at base / doubled / stressed (−0.04 throughout), which is
  // the tell that this is a genuinely absent signal rather than a real edge eaten by
  // friction — there is nothing for costs to consume. 0 of 4 positive chronological
  // blocks rules out a regime-specific edge as well.
  //
  // The tab, its ledger and the frozen rules are untouched (core:true); the red-tape
  // CONTEXT remains a validated observation. What is withdrawn is the claim that acting
  // on it produces excess return.
  { id: 'downday',    label: '🪁 Down-Day Bounce',     kind: 'signal', section: 'DownDay',  horizon: 'swing',    core: true,  maturity: 'shadow', scoringVersion: 'downday-v1', policyTiers: ['WATCH', 'EMERGING', 'CONFIRMED'], note: 'DEMOTED from production 2026-08-11. The frozen-contract study at the PRODUCTION detector (A-downday-exact-contract-2026-08) returned lift −0.04% vs matched same-date/liquidity controls, CI95 [−0.16, +0.08] over 254 dates, 0/4 positive blocks, BH q 0.52 → NOT PROMOTED; identical at base/doubled/stressed costs, i.e. no signal rather than a cost-eaten one. Red-tape context stays a validated OBSERVATION; the tradeable claim does not. Its SHORT side (overheated fades) remains borrow-gated fail-closed by lib/eligibility.js — no borrow feed means research/watch only. Weight-0: MUST NOT originate or boost a live trade.', criteria: 'A NEW prospective cohort at the frozen 3-session contract must reverse the recorded null: cost-net lift vs matched same-date same-liquidity-band controls with the date-level CI clear of zero, ≥50 resolved over ≥20 independent dates, positive in a majority of chronological blocks, surviving doubled costs — then an explicit reviewable registry maturity flip. Re-running the SAME 2022-2026 window cannot promote it; that sample is consumed.' },
  // Graded on SWING (5d), not intraday, despite sitting under the intraday nav divider:
  // the engine measures acceleration over 3–10 SESSION windows on end-of-day data and
  // the tab's own guidance calls it an early-momentum watchlist you hold with a stop.
  // Ignition's section carries THREE experiments: the today-funnel policy (IGNITION,
  // with WATCH as its falsifiable control), independent broad shadow discovery
  // (BROAD_*), and historical backfill (HIST_*, read-time reclassified). Only the
  // frozen funnel policy tier is promotion evidence; the others keep separate records.
  // DEMOTED to shadow (graduation-league 2026-08-12, findings RT-09/F3/F-13, three
  // independent audit passes): the entry held `production` while its own criteria
  // were future-tense — no fill-verified record, no stored evidence, no promotion
  // artifact — and the PROMOTION_CEILING makes the grade it would need unreachable.
  // A production status with unmet criteria was one governance artifact away from
  // auto-arming. Re-promotion is a human-reviewed registry transition once the
  // criteria below are actually met, never a code edit.
  { id: 'ignition',   label: '🔥 Momentum Ignition',   kind: 'signal', section: 'Ignition', horizon: 'swing',    core: true,  maturity: 'shadow', scoringVersion: 'ignition-v1', policyTiers: ['IGNITION'], criteria: 'Funnel IGNITION-tier cohort alone (WATCH is the control, BROAD_*/HIST_* are separate research lanes): cost-net date-level CI clear of zero at ≥50 episodes / ≥20 dates on a fill-verified pipeline, and incremental lift over the WATCH control — then a reviewable promotion artifact.' },
  // Core Momentum book (op=core → fromCoreMomentum). REGISTERED for the first time in
  // quant-redesign-3: it was reaching the live board UNREGISTERED (the fail-closed
  // unknown-id rule already called it 'shadow' — nothing consulted it). Registered
  // honestly as shadow: a 12-1 momentum book with no strategy-specific validation on a
  // survivorship-safe, turnover-aware basis. Its portfolio-horizon rows remain visible;
  // under fail-closed enforcement they are display/watch, not trade-eligible.
  { id: 'coremo',     label: '🏛️ Core Momentum',      kind: 'signal', section: 'CoreMomentum', horizon: 'portfolio', core: false, maturity: 'shadow', scoringVersion: 'coremo-v1', note: 'Quarterly 12-1 momentum book. Momentum evidence in this app differs by universe/horizon and has not been validated survivorship-safe with turnover costs for THIS book — shadow until it clears strategy-gate PROMOTION_GATE.', criteria: 'Survivorship-aware, turnover/cost-net excess over SPY at the 3m contract with CI excluding zero.' },

  // Standalone Emerging Leader (swing defect #1). The emergingLeaderSignal detector
  // (lib/screener.js) admits fresh-RS-leadership names into the screener buffer even
  // when they carry NO classic base-pattern status — but the decision normalizer
  // required `status`, so every standalone Emerging Leader was silently discarded
  // before the board, supervisor, ledger, research capture and OMEGA funnel.
  // Registered SHADOW: rows now survive into the Swing Research lane with their own
  // identity (captured, retained, graded prospectively) but MUST NOT originate or
  // boost an actionable production pick. The lib/emerging.js admission study is a
  // display-buffer backtest, NOT production-alpha validation — promotion requires
  // this entry's own prospective record to clear strategy-gate PROMOTION_GATE, and
  // only a registry maturity flip (never a UI flag) can enable it.
  { id: 'emergingleader', label: '🌱 Emerging Leader', kind: 'signal', section: 'EmergingLeader', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'emergingleader-v1', note: 'Standalone fresh-RS-leadership detector (no base-pattern status). Shadow research lane: captured/graded prospectively per universe scope; weight-0 on the live board. A name that ALSO carries a production Setup/Breakout status is represented by the screener signal (deduplicated — the emerging read is carried as metadata, never double-counted).', criteria: 'Scoped prospective Scoreboard record (EmergingLeader:{scope}) must clear strategy-gate PROMOTION_GATE: ≥50 resolved episodes over ≥20 independent dates, cost-net excess vs SPY with CI clear of zero, regime-robust — then an explicit reviewable registry maturity flip.' },

  // ── Previously-UNREGISTERED user-visible screeners (non-daytrade redesign 2026-08) ──
  // These three ran user-visible Candidates tabs with their own ledgers/books but no
  // registry entry — no maturity grade, no honesty banner, no governance route. Each is
  // registered SHADOW with an executable contract (lib/strategy-contracts.js) that
  // honestly records fillVerified:false: their books grade signal-day close-to-close
  // proxies of the displayed trade plans (defect recorded in
  // docs/non-daytrade-screener-redesign-2026-08.md).
  { id: 'trendrider', label: '🏇 Trend Rider', kind: 'signal', section: null, horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'trendrider-v1', note: 'Trend-following momentum rank with per-ticker posteriors. Own ledger/book (op=trend/trendtick/trendbook) grades a 21-session close-to-close hold with no published stop/target — a proxy, not an executable episode. Weight-0: never wired to the Today board. Per-ticker learning from tiny samples is diagnostic, not self-improving, until prospective incremental lift is shown.', criteria: 'Executable-episode record beating plain 12-1 momentum, sector-relative momentum and volatility-scaled momentum on identical dates, cost-net, ≥50 episodes / ≥20 dates — then an explicit reviewable registry flip.' },
  { id: 'aligned', label: '🤝 Dual Confirmed', kind: 'signal', section: null, horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'aligned-v1', note: 'Both-horizon alignment picks (long-term trend AND short-term action bullish). Own ledger/book (op=aligned/alignedlog/alignedbook) grades 21-session close-to-close; the displayed entry/stop/target are NOT graded (defect recorded). Two correlated trend horizons are NOT independent confirmation — incremental value over each component alone is unproven. Weight-0.', criteria: 'Versioned episodes with cooldown (no first-appearance-forever), next-open or verified conditional fills with costs, incremental value vs the long-term component alone, short-term alone, best-component rank and random matched controls — then an explicit reviewable registry flip.' },
  { id: 'confluence', label: '🎯 Confluence', kind: 'signal', section: null, horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'confluence-v1', note: 'Five classic technical strategies voting, correlation-discounted into independent evidence families (4 of 5 are ONE trend family). Own ledger/book (op=confluence/confluencetick/confluencebook) grades 21-session close-to-close; the displayed pullback entry / 2R target plan is NOT graded (defect recorded). Live weights frozen equal; the learned-weights path is the separate confluence-marginal shadow learner. Weight-0.', criteria: 'A Confluence label requires ≥2 INDEPENDENT evidence families (not 4 correlated trend votes); promotion requires the family-discounted rank to beat raw vote count and the best single family on identical dates, cost-net, on executable episodes — then an explicit reviewable registry flip.' },

  // ── Overlays / experimental detectors (Research Lab until Validated) ──
  // quant-redesign-3: these were implicitly production (omitted maturity defaulted
  // open). Each is now EXPLICITLY shadow — matching this header's own intent and the
  // repo's recorded evidence (fade = avoid-filter only; gap-down needs executable short
  // + borrow validation; CERN/AI overlays have no incremental-value proof). Promotion
  // is a data change through strategy-gate PROMOTION_GATE, never a wording edit.
  { id: 'chartpattern', label: '📐 Pattern Radar', kind: 'signal', section: 'Pattern', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'pattern-decision-v2', note: 'Family-specific structural chart setups (pattern-v2): frozen episode levels, fill-aware grading, evidence-gated actions. Weight-0 shadow — a family becomes actionable ONLY when its own leakage-safe walk-forward record (op=patternresearch evidence artifact) passes the proven gate; until then every trigger is research-only. Its evidence banner shows ONLY its own resolved record (previously mis-mapped to Coil).', criteria: 'Per family×direction×timeframe: cost-net lift vs matched non-pattern controls with CI clear of the control rate, calibration beating baseline, FDR-controlled across families, stable across years — on the untouched final walk-forward period.' },
  { id: 'fade',       label: '🔥 Overheated (Fade)',   kind: 'signal', section: 'Fade',       horizon: 'swing',    core: false, maturity: 'shadow', scoringVersion: 'fade-v1', policyTiers: ['SHORT'], note: 'Validated ONLY as an AVOID filter on loud bullish social names (the measured edge is entirely short-side, and there is no borrow feed) — never a live short book. Policy cohort narrowed to the strict SHORT tier 2026-08-09 from the resolved record: SHORT_LIGHT had no positive cell at any horizon (n≈230–320/horizon) and was CI-negative at 1d/20d/1m — it keeps logging as an excluded control lane but is no longer part of the promoted claim or the actionable list.' },
  { id: 'gapdown',    label: '🐻 Gap-Down Continuation', kind: 'signal', section: 'GapDown',   horizon: 'intraday', core: false, maturity: 'shadow', scoringVersion: 'gapdown-v1', note: 'Shorts are fail-closed WATCH-ONLY (lib/gapdown.js assessShortExecution) until an observed borrow/locate feed exists and intraday OR-low execution validates.' },
  { id: 'events',     label: '⚡ CERN Forced-Flow',     kind: 'signal', section: 'CERN',       horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'cern-v1', criteria: 'Per event-type decay curve must beat SPY over ≥20 resolved.' },
  { id: 'readthrough',label: '🔗 Read-Through',         kind: 'signal', section: 'ReadThrough',horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'ReadThrough-v1', criteria: 'Fresh (not-yet-moved) must beat Moved + sector.' },
  { id: 'anomaly',    label: '🕵️ Stealth',            kind: 'signal', section: 'Anomaly',    horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'Anomaly-v1' },
  { id: 'secondwave', label: '🌊 Second Wave',          kind: 'signal', section: 'SecondWave', horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'SecondWave-v1' },
  { id: 'crossasset', label: '🌐 Cross-Asset',          kind: 'signal', section: 'CrossAsset', horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'CrossAsset-v1' },
  { id: 'toneshift',  label: '🎚️ Tone Shift',          kind: 'signal', section: 'ToneShift',  horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'ToneShift-v1' },
  { id: 'tone',       label: '🎙 Earnings-Call Tone',   kind: 'signal', section: 'Tone',       horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'tone-v1' },
  { id: 'attention',  label: '📈 Attention (Sticky/Fast)', kind: 'signal', section: 'Attention', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'attention-v1' },
  { id: 'thesis',     label: '🧾 Evidence Thesis Change',  kind: 'signal', section: 'Evidence',  horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'evidence-v1', note: 'News→events→cluster→consensus thesis-change engine. Logs STRONG/MODERATE/WEAK thesis changes to the Scoreboard (weakening theses logged short so the resolver inverts them). Was emitted as an unregistered section — no maturity grade, no Evidence-tab row, no honesty banner — the exact hole registry coverage exists to close.', criteria: 'STRONG thesis changes must move in the flagged direction vs SPY/sector over ≥20 resolved.' },
  { id: 'xalerts',    label: '🐦 Trade Alerts',         kind: 'signal', section: null,         horizon: 'swing',    core: false, maturity: 'shadow', scoringVersion: 'alerts-v2', note: 'Social trade alerts are LEADS, not facts. Source-aware swing-research layer: captures provenance, measures per-account prospective records, confirms/contradicts an INDEPENDENT price setup, flags crowding/coordination, grades realistic next-open episodes. Weight-0 — MUST NOT originate or boost a live trade until it clears strategy-gate PROMOTION_GATE on leakage-resistant, prospective, cost-aware, incremental evidence over the price/setup baseline.', criteria: 'Account-skill layer must add statistically + economically meaningful value beyond the independent price/setup baseline on purged, independently-dated, cost-aware prospective episodes.' },
  { id: 'challenger-decision', label: '🧪 Challenger Decision', kind: 'signal', section: 'Challenger', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'challenger-decision-v1', note: 'Shadow-only four-outcome challenger (challenger-decision-v1) — paper/weight-0 until it passes strict OOS + live-forward validation.' },
  { id: 'orbit', label: '🛰️ ORBIT', kind: 'signal', section: 'Orbit', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'orbit-decision-v1', note: 'Shadow-only orthogonal-residual Bayesian drift screener (orbit-decision-v1) — calibrated P(rise) over 5/21/63 sessions; paper/weight-0 until strict nested-OOS + live-forward validation. Universe survivorship-biased → production-grade blocked.' },
  { id: 'orbit-ml', label: '🛰️ ORBIT-ML', kind: 'signal', section: 'OrbitMl', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'orbit-ml-model-v1', note: 'Shadow EVOLVE specialist `idiosyncraticPersistence` — date-grouped cross-sectional residual-drift ranker (orbit-ml-model-v1). No SOURCE_SPECIALIST mapping = cannot reach live rank; earns influence only after positive incremental (redundancy-adjusted) OOS + prospective validation.' },
  { id: 'gridlock', label: '⚡ GRIDLOCK', kind: 'signal', section: 'Gridlock', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'gridlock-v1', note: 'Shadow physical-constraint & marginal-beneficiary engine (gridlock-v1, GRIDLOCK_MODE default shadow). Maps PHYSICAL/CONTRACTUAL events (data-center load, PPAs, retirements, turbine orders) to a regional constraint-pressure model (PJM first) and a hand-curated VERIFIED exposure graph; deterministic causal classification (most pairs are TOO_INDIRECT by design), decomposed opportunity score with explicit penalties, timing delegated entirely to OMEGA-SWING (no momentum features of its own — the physical evidence family must stay independent). NO probability output (nothing calibrated). Weight-0: MUST NOT originate, boost or suppress a live trade; prospective ledger + Scoreboard decide everything.', criteria: 'Promotion requires ≥150 matured prospective candidates across ≥75 distinct dates, multiple independent events and companies, more than one regime period, cost-net excess over SPY, sector ETF, same-sector random and simple-momentum baselines, stability across time splits, no single-outlier dependence, evidence the effect is not sector momentum, and out-of-fold calibration BEFORE any probability is shown — then an explicit reviewable registry maturity flip.' },
  { id: 'omega', label: '💠 OMEGA-Swing', kind: 'signal', section: 'OMEGA', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'omega-swing-v2', note: 'Shadow 5–10 day momentum-continuation ranker (omega-swing-v2). Re-ranks the op=today candidate funnel; interpretable formula is the shipped ranker, a trained challenger overrides it ONLY after beating the baseline out-of-sample. Executable next-open/conditional fills (omega-exec-v1), separate research vs prospective ledgers, capped sizing. Probabilities are a transparent baseline (uncalibrated) — shown as evidence bands, not percentages. Weight-0: MUST NOT originate or boost a live trade until it clears strategy-gate PROMOTION_GATE on purged, prospective, cost-aware, incremental evidence over simple momentum + the source rank.', criteria: 'Purged walk-forward must beat simple 10d momentum AND the source-strategy rank on cost-net residual return, with monotone tier payoff and prospective-live evidence consistent with research.' },
  { id: 'atlasx', label: '🛰 ATLAS-X', kind: 'signal', section: 'AtlasX', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'atlasx-v1', note: 'Shadow swing challenger (atlasx-v1) — Adaptive Transition, Liquidity, Allocation & Survival. Answers four SEPARATE questions (genuine state transition? which specialist strategy? enter-now vs wait vs abstain? is the entered thesis intact/weakening/invalid/complete?), never one opaque confidence score. Point-in-time residualization → deterministic state-transition detection → regime-conditioned specialist experts (compression / catalyst-drift / first-pullback / breakout / red-tape reversal / event dislocation) → interpretable distributional residual-return ranking → competing-risk survival (target-before-stop/stop/timeout, dynamic landmarking) → independent failure PROSECUTOR (non-binding) → enter-now-vs-wait optimal-stopping → cost/liquidity/portfolio constraints → conformal-style abstention → executable next-open plan → durable swing episodes (reuses the Swing Episode Supervisor engine under its own atlasx/ namespace) → prospective outcome logging. Survival & prosecutor outputs are EXPERIMENTAL SCORES, not probabilities, until out-of-fold calibration passes. Advanced learned models (LambdaRank / Bayesian online change-point / trained conformal) are research interfaces in data-accrual mode; the shipped ranker is the interpretable additive baseline. Weight-0: MUST NOT originate, boost or suppress a live trade, and cannot modify production ranks, until it clears strategy-gate PROMOTION_GATE.', criteria: 'Purged, embargoed, survivorship-safe walk-forward must beat simple momentum AND the best existing swing baseline AND the source rank on cost-net residual return, with monotone utility buckets, multiple positive chronological blocks, no single-regime dependence, calibration pass before any probability is shown, ≥50 prospective independently-dated episodes, and live-funnel parity — then an explicit, reviewable governance flip of maturity.' },

  { id: 'premove', label: '📡 Pre-Move Inventory', kind: 'signal', section: 'PreMove', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'premove-stage-a-v1', note: 'Shadow pre-move transition inventory (ATLAS-X v2 evolution, PREMOVE_V2_MODE default shadow). Separates (1) primed-for-a-move — Stage A competing-risk transition rank over the two-pass specialist universe, (2) a valid executable trigger — objective acceptance/turnover/gap rules (premove-trigger-v1), and (3) remaining expectancy after entry — Stage B conditional barrier model + inspectable expected-net-utility waterfall. States PRIMED/ARMED/TRIGGERED/ACCEPTED/WEAKENING/INVALIDATED/EXPIRED/COMPLETED derive from the Swing Episode Supervisor lifecycle (no silent disappearance). NO probabilities without a valid, current, version-matched calibration artifact — rank percentile + evidence band only. Weight-0: cannot originate, boost or re-rank any live pick; enforce mode fails closed without a promotion artifact.', criteria: 'Stage-A challenger must beat the mandatory baselines (residual momentum, Coil score, Ghost score, current ATLAS-X) on identical purged/embargoed date-grouped folds, cost-net, across chronological blocks and cap bands, survive 2× cost stress, pass calibration before any %, accrue a non-trivial prospective sample with live-funnel parity, and clear an explicit reviewable promotion artifact.' },

  { id: 'rlt', label: '🧭 Relative Leadership Transition', kind: 'signal', section: 'Rlt', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'rlt-v1', note: 'Shadow leadership-transition system (rlt-v1, RLT_MODE default shadow). Finds stocks BEGINNING to outperform the market, their sector AND their sector peers (sector×liquidity-band peer groups with labeled fallbacks; fitted shrunk-beta market+sector residualization reused from atlasx-residual) — the discovery feature is CHANGE in peer rank, not an already-high rank. Distinguishes emerging-leader vs technically-primed vs executable-trigger vs acceptance vs remaining-expectancy: states DISCOVERED/EMERGING_LEADER/PRIMED/ARMED from the cross-section, TRIGGERED/ACCEPTED/WEAKENING/INVALIDATED/EXPIRED/COMPLETED derived from the Swing Episode Supervisor lifecycle (own rlt/* namespace — published candidates never silently vanish). Relative strength alone is NEVER presented as a buy signal. Also feeds ATLAS-X as the relativeLeadershipTransition expert (correlation-discounted vs firstPullback/breakout/compression — leadership+momentum+trend are not independent confirmations). NO probabilities without a valid, current, version-matched calibration artifact — transition rank + evidence band only; enforce mode fails closed without one. Weight-0: MUST NOT originate, boost or suppress a live trade.', criteria: 'Purged, embargoed, date-grouped walk-forward must beat random, raw momentum, SPY-relative strength, sector-relative level, within-sector percentile level, rank acceleration alone, Coil, Ghost and current ATLAS-X on cost-net residual return with date-clustered CI clear of zero, survive cost/delay stress, pass OOF calibration before any %, show incremental value after redundancy adjustment, and accrue prospective live-funnel-parity evidence — then an explicit reviewable registry maturity flip.' },

  { id: 'peerlab', label: '🕸 Peer Propagation', kind: 'signal', section: 'PeerProp', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'peerprop-v1', note: 'Shadow peer-propagation engine (peerprop-v1). Models each stock inside PIT peer networks (sector×band groups reusing rlt-universe + a statistical directed leader→follower graph estimated ONLY from past market/sector-residual returns, Fisher-z shrunk, antisymmetric-component gated) and flags names whose PEERS have moved while their OWN normalized reaction has not (unreflectedPeerStrength). Distinct mechanism from RLT (which ranks a name\'s own peer-rank CHANGE; this propagates information ACROSS names — the two must not be conflated, see the RLT no-edge verdicts). Customer-supplier / analyst-coverage / 13F networks are feature-flagged DISABLED (no PIT data), never simulated. Scores are heuristic ranks; probabilities stay null until OOF calibration on matured outcomes. Weight-0: MUST NOT originate, boost or suppress a live trade.', criteria: 'Purged, embargoed, date-grouped walk-forward (op=peerpropwf) must beat control-random AND residual momentum AND its own falsifications (reversed leader edges and random peer groups must be materially weaker) on cost-net sector-residual return, plus ≥20 resolved prospective PeerProp Scoreboard picks moving in the flagged direction, plus OOF calibration before any % — then an explicit reviewable registry maturity flip.' },
  { id: 'underreaction', label: '📰 News Underreaction', kind: 'signal', section: 'Underreaction', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'underreaction-v1', note: 'Prospective-only news-underreaction engine (underreaction-v1). Compares each structured evidence event\'s semantic economic impact (bounded LLM-extracted direction/materiality/novelty, mechanical source primacy) against the market/sector-adjusted price reaction since the ORIGINAL publish timestamp → underreactionGap → FRESH_POSITIVE/FRESH_NEGATIVE/FULLY_PRICED/POSSIBLE_OVERREACTION/STALE_REPEATED states. NO historical backfill exists or is permitted (present-day LLM reads on old dates are not validation); events without publish timestamps report INSUFFICIENT_DATA. The LLM never emits a probability — states become features for a model trained only after prospective outcomes mature. Weight-0.', criteria: 'Requires ≥20 resolved prospective FRESH_* picks whose sector-relative outcomes beat SPY/sector baselines, stability across event types, and OOF calibration before any % — no retrospective claim can substitute.' },
  // Registered by the graduation-league census (finding F2): EVOLVE ran nightly with a
  // user-visible Markets tab (TRADE/WATCH/PROBE/ABSTAIN labels + calibrated
  // probabilities) but had NO registry identity — the exact orphan hole this registry
  // exists to close. Registered as the meta-ensemble it is; the DSR gate and abstention
  // layer are its own machinery, the registry stamp is what makes op=maturity and the
  // evidence badge cover it.
  { id: 'evolve', label: '🧬 EVOLVE', kind: 'signal', section: null, horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'evolve-v1', note: 'Meta-ensemble over the app\'s engines as specialists (triple-barrier labels, calibrated ensemble, TRADE/WATCH/PROBE/ABSTAIN). Weight-0 shadow: its labels are research output and MUST NOT originate, boost or suppress a live trade. Its own walk-forward gate (uniqueness-weighted DSR, overlap correction default-on since PR #332) currently passes 0 cells — the page must keep saying so.', criteria: 'A cell family passing the deflated-Sharpe gate on uniqueness-weighted effective N across regimes, cost-net, with the trial ledger intact — then an explicit human-reviewed registry transition.' },
  { id: 'govdemand', label: '🏛️ GovDemand', kind: 'signal', section: null, horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'govdemand-v1', note: 'USAspending shadow vertical (award events → expectation model → materiality). Nightly scheduled but previously UNREGISTERED (census F2). Weight-0 shadow, API-only; distinct evidence family (government demand), which is exactly why its ledger must accrue under governance rather than outside it.', criteria: 'Standard shadow ladder: prospective cost-net ledger on independent event dates with baselines and negative controls, then explicit registry review.' },
  { id: 'cfl', label: '🔭 Counterfactual Lab', kind: 'informational', section: null, horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'cfl-v1', note: 'Counterfactual Opportunity & Forecastability Lab (cfl-v1). MEASUREMENT infrastructure, not a screener: reconstructs market-wide missed winners at 5/21/63-session horizons via the production-parity replay engine, attributes every miss and dud to a deterministic pipeline stage (universe/data/generation/ranking/late/veto/alert/display/execution vs genuinely-unforecastable), and reports evidence-based forecastability dispositions with true abstention. Weight-0 and structurally output-free: it emits diagnostics only and MUST NOT originate, boost or suppress any live pick. Retrospective sweeps carry survivorshipSafe:false (as-of-today candles, no delisted names) and are RESEARCH evidence only; prospective decision snapshots (captured at warm decision time) are the clean lane.', criteria: 'Any model or gate DERIVED from CFL findings (e.g. a forecastability gate) must be registered separately, pass the alpha-prosecutor battery (lib/cfl/prosecutor + lib/orbit-controls), and clear the standard promotion ladder on prospective data — CFL itself never promotes.' },
  { id: 'psrl', label: '🪜 Persistent Trends', kind: 'signal', section: null, horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'persistent-staircase-relative-leadership-v1', note: 'Persistent Staircase Relative Leadership (psrl-v1). Longer-horizon continuity + relative-leadership layer over the shared residual engine (atlasx-residual): multi-horizon absolute trend, raw SPY/sector RS lines kept separate from beta-adjusted residual leadership, return-path continuity (information discreteness, efficiency, concentration, robust Theil–Sen fit), jump-then-plateau classification, leadership quadrants, and a persistent trend-episode ledger with hysteresis arrows. ONE price/trend evidence domain — must never be counted as an independent confirmation next to momentum/OMEGA/RLT (same underlying paths). Weight-0 shadow challenger to OMEGA; probabilities are BASELINE_UNCALIBRATED and shown only as evidence bands. RLT context: rank-level/rank-accel/residual-momentum rankers measured at zero on this universe — PSRL’s registered claim is the untested continuity/persistence axis only.', criteria: 'Promotion requires the preregistered contract (research/PREREGISTRATION-PSRL-2026-08.md): PIT lineage, untouched positive walk-forward with ESS ≥ 30 and BH correction in swing-ranking, cost survival via exec-engine-v1, calibration where probabilities are used, continuity value beyond plain momentum AND residual value beyond raw RS, plus explicit registry approval. Survivorship-reduced results cannot promote.' },
  { id: 'volforecast', label: '🔊 Volume Forecast', kind: 'informational', section: null, horizon: 'intraday', core: false, maturity: 'shadow', scoringVersion: 'volfc-v1', note: 'Next-session dollar-volume / relative-volume / abnormal-session forecast from volume+calendar features only (volfc-v1). Execution and capacity context — liquidity tiers, slippage bands, scan priority. NEVER directional: this repo measured raw volume-surge at rank-IC ≈ −0.004 and weights it zero; the module structurally cannot see returns.' },
  { id: 'expgap', label: '🌡 Expectation Gap', kind: 'signal', section: 'ExpGap', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'expgap-v1', note: 'Reduce-only regime challenger (expgap-v1). Compares OBJECTIVE conditions (credit stress, realized-vol percentile, sector breadth) against what the market is PRICING (VIX percentile, drawdown from highs) plus the variance risk premium (VIX − realized). The flagged state is COMPLACENCY — objective deterioration the tape has not priced. States RISK_REDUCE/NEUTRAL/INSUFFICIENT_DATA only: a RISK_ADD state does not exist, recommendedMaxExposure is capped at 1, and transition probability stays null until prospective outcomes support out-of-fold calibration. Ledger records exist ONLY for RISK_REDUCE days (SPY short-framed, so the Scoreboard grades the call). Weight-0: annotation, never a live gate.', criteria: 'SPY forward returns after RISK_REDUCE days must be materially worse than unconditional over ≥20 resolved reduce-day episodes across more than one stress episode, with the falsifiable short-framed Scoreboard record — then a reviewable flip to a real (still reduce-only) gate.' },

  // Confluence marginal-attribution learner (defect #6). The live per-strategy EWMA
  // credited the full realized excess to every bullish voter (4/5 strategies are one
  // correlated trend family), so learned confluence weights are FROZEN at equal and
  // this shadow learner is the only sanctioned path back: family-level, date-level,
  // purged walk-forward marginal attribution (lib/confluence-marginal.js) that must
  // beat equal-weight, raw-vote-count and placebo baselines on identical paired
  // dates, cost-net, with sufficient effective sample — then a registry flip here.
  { id: 'confluence-marginal', label: '🎛 Confluence Marginal Weights', kind: 'signal', section: null, horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'confluence-marginal-v1', note: 'Shadow marginal-attribution learner for the 5-strategy confluence screener. While shadow, live confluence weights stay frozen at equal (1.0) and the per-strategy EWMA is a diagnostic only.', criteria: 'Purged chronological walk-forward: marginal family weights must beat equal-weight, raw vote count and placebo on identical paired test dates, cost-net, with ≥40 distinct decision dates — then an explicit reviewable registry maturity flip.' },

  // Learned-posterior rank influence (non-daytrade backlog 2026-08). The per-ticker
  // fade-engine posterior is graded close-to-close with no fills or costs, yet its
  // expAlpha carried a PROMOTE-direction weight in live ranks (Confluence +8/1% boost,
  // Down-Day short sort priority) — and the Confluence tick ledgers the top slice of
  // that boosted sort, so the unvalidated learner was selecting its own training data.
  // While this entry is shadow, posterior influence is AVOID-ONLY (drifted names may
  // sink or drop — the one registry-validated use of the fade learner); the boost term
  // is weight-0 at every apply site.
  { id: 'posterior-rank', label: '🧠 Learned-Posterior Rank Influence', kind: 'signal', section: null, horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'posterior-rank-v1', note: 'Cross-screener rank influence of the per-ticker fade-engine posterior (Trend Rider / Confluence / Down-Day shorts). While shadow, the posterior may only SUBTRACT (drifted veto/sink) — never boost or reorder a live rank; learnedExcess/confidence stay visible as annotation. The Day Trade consumer is frozen and outside this gate.', criteria: 'On identical dates the boosted rank must beat the same rank WITHOUT the posterior term (and a random-tiebreak placebo) on cost-net date-level excess, purged chronological walk-forward, ≥40 distinct decision dates, CI excluding zero — then an explicit reviewable registry flip PLUS a version-matched PASS artifact supplied at the apply site.' },

  // ── Options overlays (SHADOW — free delayed Yahoo chains can't establish trade-level
  //    direction, so these run in confirmation/shadow mode and MUST NOT originate or
  //    boost a live trade until they clear strategy-gate PROMOTION_GATE) ──
  { id: 'optionsflow', label: '🛠️ Unusual Options Activity', kind: 'signal', section: 'OptionsFlow', horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'optionsflow-v1', note: 'Delayed-chain unusual-activity read (volume vs open interest + estimated premium). Cannot establish opening/closing/bought/sold from free data — a CONFIRMATION overlay, not a standalone signal. Weight-0 in live picks until prospective incremental value beyond the price/momentum/sector/regime model is shown.', criteria: 'Base+options must beat base-alone on independent, cost-aware, prospective episodes.' },
  { id: 'putsell', label: '💵 Cash-Secured Puts', kind: 'signal', section: null, horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'putsell-v1', note: 'Income/entry overlay — cash-secured put candidates on quality-uptrend pullbacks. Never emitted as a live directional pick; shadow until prospective payoff tracking validates it.' },
  { id: 'optionsflow-v2', label: '📡 Options Activity Radar v2', kind: 'signal', section: null, horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'optionsflow-v2', note: 'v2 Options Intelligence Engine — ticker-relative anomaly DISCOVERY is live/visible; its PREDICTIVE value (anomaly weights, direction reads, trade-gate thresholds) is shadow until op=optionsresolve2 shows prospective incremental value beyond the identical price-only setup cohort. Discovery visibility is not gated by maturity; live-pick influence is.', criteria: 'Price+options cohort must beat the same-session price-only control cohort on independent, cost-aware, prospective episodes with a CI excluding zero.' },

  // ── Ticker-lookup horizon reads (alpha-research pass 3, registered 2026-08-12) ──────
  // The single-ticker lookup was the largest ungoverned surface in the app: /api/chart →
  // lib/signal.analyze publishes an ACTION (STRONG_BUY / BUY / SELL / STRONG_SELL) plus a
  // concrete entry / stop / target triple, per horizon, straight to the user — while
  // appearing in NO registry and NO contract. lib/eligibility, lib/strategy-gate and
  // lib/maturity therefore never saw it, so the four central control points the signal
  // inventory claims "no strategy may bypass" were bypassed by the most-used surface.
  //
  // Registered as THREE ids rather than one because the reads are genuinely separate
  // systems on separate clocks with separate asserted weights — collapsing them into a
  // single grade would repeat the horizon-blending the brief §8 forbids:
  //   lookup-intraday  lib/signal.buildLiveSignal   — 5-min technicals, EMA/VWAP/MACD/RSI
  //   lookup-swing     lib/swingread.js             — {trend .45, rs .35, participation .20}
  //   lookup-longterm  lib/longterm.js              — 7-factor ~1y trend composite
  //
  // ALL WEIGHTS ARE ASSERTED, NOT FITTED. None of the three has a resolved cost-net record
  // of its own; the dual-read ledger (lib/dualread-backfill.js) is the grading venue that
  // must accrue one. Shadow / weight-0 accordingly: the reads stay visible as research,
  // but they may not present a trade imperative.
  { id: 'lookup-intraday', label: '🔎 Lookup · Intraday Read', kind: 'signal', section: null, horizon: 'intraday', core: false, maturity: 'shadow', scoringVersion: 'signal-v1', note: 'Single-ticker intraday technical read (lib/signal.buildLiveSignal): stacked-EMA ±3, VWAP ±2, MACD ±2, RSI ±2, volume ±1 — hand-asserted weights, never fitted, no resolved record. Levels are 1.5×/2.5× ATR risk references, NOT a validated trade plan. Weight-0: MUST NOT present a buy/sell imperative.', criteria: 'A prospective dual-read ledger record at the 1d contract: cost-net excess vs SPY with the date-level CI clear of zero over ≥50 resolved / ≥20 independent dates, and incremental value over a naive trend baseline — then an explicit reviewable registry flip.' },
  { id: 'lookup-swing', label: '🔎 Lookup · Swing Read', kind: 'signal', section: null, horizon: 'swing', core: false, maturity: 'shadow', scoringVersion: 'swing-v1', note: 'Single-ticker swing read (lib/swingread.js), weights {trend 0.45, rs 0.35, participation 0.20} — asserted, not fitted. Its `stack` and `slope50` factors carry a hardcoded POSITIVE sign for rising-50-DMA, which this repo has not validated as directional. Weight-0.', criteria: 'Prospective cost-net excess vs SPY AND sector at the 5d contract, date-level CI clear of zero, ≥50 resolved / ≥20 independent dates, plus evidence the composite beats its own best single factor — then a reviewable registry flip.' },
  { id: 'lookup-longterm', label: '🔎 Lookup · Long-Term Read', kind: 'signal', section: null, horizon: 'position', core: false, maturity: 'shadow', scoringVersion: 'longterm-v1', note: 'Single-ticker ~1y trend read (lib/longterm.js), weights {trend200 .20, cross .20, trend50 .10, rs3m .20, rs6m .10, slope50 .10, high52 .10} — asserted, not fitted. Blends 63-session and 126-session horizons into one composite (a horizon mix the brief §8 flags). Weight-0.', criteria: 'Prospective cost-net excess vs SPY at the 1m contract with the date-level CI clear of zero over ≥50 resolved / ≥20 independent dates, and separation of the 63d/126d bands into their own graded records — then a reviewable registry flip.' },

  // ── Informational surfaces (context, never graded, never sized, never in the lab) ──
  { id: 'sectors',    label: '📊 Sectors',    kind: 'informational', section: null, horizon: 'position', maturity: 'shadow', note: 'Sector performance heatmap — context, not a buy signal.' },
  { id: 'rotation',   label: '🔄 Rotation',   kind: 'informational', section: null, horizon: 'position', maturity: 'shadow', note: 'Where money is rotating week over week — context.' },
  { id: 'news',       label: '📰 News',       kind: 'informational', section: null, horizon: 'intraday', maturity: 'shadow', note: 'Summarized market-moving headlines — context.' },
  { id: 'pulse',      label: '📡 Market Pulse',kind: 'informational', section: null, horizon: 'swing',   maturity: 'shadow', note: 'Social/finance attention — awareness, not advice.' },
  { id: 'gameplan',   label: '🗞️ Game Plan',  kind: 'informational', section: null, horizon: 'intraday', maturity: 'shadow', note: 'Plain-English daily market game plan.' },
  { id: 'forecast',   label: '🔮 Forecast',   kind: 'informational', section: null, horizon: 'position', maturity: 'shadow', note: 'Falsifiable macro predictions, auto-graded on their own page.' },
];

// ── DECLARED PROMOTION CEILING (alpha-research pass 3) ───────────────────────────────
//
// No non-Day-Trade strategy in this registry can currently reach `validated`, and the
// reason is a MISSING DATA PIPELINE, not a series of individually disappointing records.
// Recorded here so the ceiling is a stated, reviewable fact rather than something a
// reader has to infer from every strategy sitting at `promising` forever.
//
// THE BLOCKER. lib/maturity.gradeTrack requires `fillVerified`, which
// lib/strategy-contracts.fillVerifiedFor derives ONLY from
// `summary.fillVerification[id]` — produced by lib/episode-ledger.deriveFillVerified
// over a strategy's own canonical episodes. No non-Day-Trade module emits a canonical
// episode carrying a `fillBasis`; only the Day-Trade lane (lib/intraday-outcomes.js)
// does. So the derivation has nothing to read and correctly fails closed.
//
// WHY IT STAYS CLOSED. `VERIFIED_FILL_BASES` admits 'next-open', and the entry-v2.2
// migration moved ~23 Scoreboard sections to next-open grading, so a literal reading
// would grant fill verification to most of the registry. That reading is rejected: a
// next-open fill reconstructed from DAILY bars is an approximation of an executable
// entry, not a verification of one — as the Scoreboard's own entryModel string says
// ("the fill time within a bar is a daily-bar approximation, NOT an intraday-verified
// fill"). Promotion unlocks governance clearance and therefore deployed capital, so the
// weaker basis is not accepted for it. Lead-only sleeves remain PROXY-labelled.
//
// WHAT WOULD LIFT IT. Per strategy: a canonical episode stream (lib/episode-ledger
// makeEpisode) whose resolved episodes carry an intraday-verified fill basis — the lane
// op=gapgoverify already implements for the Day-Trade side — reduced into
// `scoreboard/summary.json` as `fillVerification[id]`. At that point deriveFillVerified
// starts returning true on its own evidence and this declaration should be removed.
//
// This is a CEILING, not a waiver: every other gate (cost-net basis, sector control,
// episode count, independent dates, date-level CI, effective sample, block stability,
// ungradeable share, FDR across the registry) still applies underneath it.
const PROMOTION_CEILING = Object.freeze({
  version: 'promotion-ceiling-v1',
  scope: 'non-daytrade',
  blocked: true,
  maxGrade: 'promising',
  blocker: 'no-intraday-verified-fill-pipeline',
  summary: 'No non-Day-Trade strategy can reach `validated`: fill verification is derived from canonical '
    + 'episodes and no non-Day-Trade module emits one. A daily-bar next-open reconstruction is deliberately '
    + 'NOT accepted as executable-fill verification for promotion.',
  unblockRequires: [
    'a canonical episode stream per strategy (lib/episode-ledger.makeEpisode)',
    'resolved episodes on an intraday-verified fill basis (cf. op=gapgoverify)',
    'reduced into scoreboard/summary.json as fillVerification[<strategyId>]',
  ],
  declaredAt: '2026-08-11',
});

module.exports = { STRATEGY_REGISTRY, PROMOTION_CEILING };
