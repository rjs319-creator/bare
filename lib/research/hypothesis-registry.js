'use strict';
// HYPOTHESIS REGISTRY + NEGATIVE-RESULTS GRAVEYARD (hypothesis-registry-v1)
//
// One committed, code-reviewed record of every research hypothesis the app has tested
// or is testing: what was claimed, what metric decides it, what the stopping rule is,
// and what happened. Three problems this solves:
//
//   1. FAILED IDEAS GET REINTRODUCED. The graveyard (status 'no-edge') makes every
//      rejected hypothesis findable BEFORE someone re-runs it as if new.
//   2. TRIALS GO UNCOUNTED. familyTrials()/totalTrials() give the multiple-testing
//      denominator; benjaminiHochberg() is the standard FDR correction that was
//      documented as required (docs/validation-protocol.md) but never implemented.
//   3. EXPLORATORY RESULTS MASQUERADE AS CONFIRMATORY. Every entry declares its mode;
//      only a 'confirmatory' pass can support status 'confirmed'.
//
// The registry lives in code (not Blob) DELIBERATELY: preregistration should be a
// reviewed, versioned diff, and a hypothesis edited after its outcome was seen shows
// up in git history. Entries are grandfathered honestly: work done before this file
// existed carries stoppingRule 'retrospective — not preregistered (grandfathered)'.
//
// Statuses: open | confirmed | provisional | no-edge | invalid-data | retired
// Pure module: no network, no clock, no store.

const REGISTRY_VERSION = 'hypothesis-registry-v1';

const STATUSES = Object.freeze(['open', 'confirmed', 'provisional', 'no-edge', 'invalid-data', 'retired']);
const MODES = Object.freeze(['exploratory', 'confirmatory']);

const GRANDFATHERED = 'retrospective — not preregistered (grandfathered)';

// NOTE: statuses below summarize the cited evidence artifact — change one only with a
// newer artifact, and record the old row's supersession in the note (never delete).
const HYPOTHESES = Object.freeze([
  {
    id: 'momentum-12-1-swing', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: '12-1 momentum ranks the app universe for 21/63-session forward excess return.',
    mechanism: 'cross-sectional continuation (Jegadeesh-Titman)',
    primaryMetric: 'per-date rank IC, survivorship-free', baseline: 'random control',
    universe: 'small/mid band incl. 2,573 delisted (PIT master)', costs: 'cost-net tiers',
    expectedDirection: 'positive IC', stoppingRule: GRANDFATHERED,
    evidence: 'research/MOMENTUM-SURVIVORSHIP-FREE-2026-07.md',
    note: 'rank-IC ≈ 0 on BOTH survivor and survivorship-free universes; retained as the transparent BENCHMARK yardstick, never a live edge claim.',
  },
  {
    id: 'omega-swing-selection', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'OMEGA utility-ranked continuation beats the momentum baseline on 5/10d residual return.',
    mechanism: 'multi-expert continuation ensemble', primaryMetric: 'survivorship-free rank IC vs baseline',
    baseline: '12-1 momentum', universe: 'PIT master incl. delisted', costs: 'cost-net',
    expectedDirection: 'positive incremental IC', stoppingRule: GRANDFATHERED,
    evidence: 'research/OMEGA-SURVIVORSHIP-FREE-2026-07.md + lib/omega-research-verdict.json',
    note: 'rank-IC −0.027 vs baseline +0.029; verdict no-edge, promotable=false.',
  },
  {
    id: 'unscheduled-gap-orb', familyId: 'intraday-gap', mode: 'confirmatory', status: 'provisional',
    hypothesis: 'Unscheduled ≥5% gap-ups on liquid names continue after a 30-min ORB break (2.5 ATR stop, 2R target, ≤3 sessions).',
    mechanism: 'underreaction to unscheduled catalysts', primaryMetric: 'OOS cost-net expectancy/trade + DSR',
    baseline: 'no-trade', universe: '51-name intraday rig 2022-2025H1 (survivorship-free)', costs: '5bps slip/fill + 2bps comm/leg',
    expectedDirection: 'positive expectancy', stoppingRule: 'pre-registered split 2023-10-23; variants declared in script header',
    evidence: 'research/intraday/data/unscheduled_gap.json (gap5_PRIMARY) + research/intraday/FINDINGS.md + independent re-test 2026-08-02 (ALPHA-STRATEGY-TEST-REPORT)',
    note: 'Independent re-test 2026-08-02: 450 fills, +1.888%/trade net, PF 1.47, held-out +1.888% (PF 1.50), positive 4/4 years, DSR 0.992, PBO 0.457, survives 20bps slip + tail trim. NOT promotable: hand-selected 51-name universe, held-out date-clustered HAC t=1.53 (<2), liquid 25-name subset NEGATIVE held-out (−0.218%), no post-freeze live sample. FORWARD-TRACKED CHALLENGER with frozen params; re-evaluate only on a fresh prospective ledger sample with zero parameter changes (cost-net expectancy>0, PF>1, date-clustered lower CI>0).',
  },
  {
    id: 'gap-metalabel', familyId: 'intraday-gap', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'A purged walk-forward meta-label filter improves the gap-ORB book over ranking by gap size.',
    mechanism: 'precision filter on entry-time features', primaryMetric: 'OOS expectancy vs gap-size ranking',
    baseline: 'gap-size rank', universe: '750 gap-ORB trades 2022-2025H1', costs: 'as rig',
    expectedDirection: 'higher expectancy, lower lumpiness', stoppingRule: GRANDFATHERED,
    evidence: 'research/intraday/FINDINGS.md (exp 11) + research/GAP-METALABEL-2026-07.md',
    note: 'meta rank-IC 0.007; no ranker clears bootstrap significance; filtering CONCENTRATES tail risk.',
  },
  {
    id: 'orb-gate-vs-prior-high', familyId: 'intraday-gap', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Waiting for the opening-range break beats the live prior-day-high trigger on realized R.',
    mechanism: 'gap-fade avoidance', primaryMetric: 'meanR AND PF AND MAE vs live rule',
    baseline: 'live triggerScore rule', universe: '374 intra5 events', costs: 'as rig',
    expectedDirection: 'B beats A_trig on all three', stoppingRule: 'pre-registered in script header before outcomes',
    evidence: 'research/ORB-GATE-VALIDATION-2026-07.md',
    note: 'NO-SHIP: halves MAE/stop-outs but sacrifices net R and PF on this runner-heavy window.',
  },
  {
    id: 'pead-sue', familyId: 'event-drift', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Analyst-SUE post-earnings drift predicts 21/63d SPY-excess return.',
    mechanism: 'post-earnings underreaction', primaryMetric: 'signed IC + decile spread, multi-year multi-regime',
    baseline: 'zero drift', universe: 'large+small+micro 2021-2026 paired-estimate history', costs: 'excess-vs-SPY',
    expectedDirection: 'positive drift', stoppingRule: GRANDFATHERED,
    evidence: 'research/data/sue.json (panel-v2 rerun) + sue-v3.json (fwd-outcome-v3 rerun) + apex/pead.json (surprise mode) + research/data/evidence/pead-sue/',
    note: 'clean-panel rerun: pooled IC 0.006, t 1.76 < 2, adding SUE to the composite REDUCES IC (delta −0.009). Large-cap shows mild REVERSAL. 2026-08-02 fwd-outcome-v3 rerun (authoritative delistings only): IC 0.0041, t 1.49, delta −0.0112 — the negative is label-robust.',
  },
  {
    id: 'congress-flow', familyId: 'alt-signals', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Net congressional buying (as-of DISCLOSURE date) predicts forward excess return.',
    mechanism: 'informed-trader imitation', primaryMetric: 'signed drift t-stat by quintile',
    baseline: 'zero', universe: 'large-cap 150, 2021-2026', costs: 'excess-vs-SPY',
    expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'apex/congress.json (op=congress)', note: 'signed t 1.24 over 4,067 events — not confirmed.',
  },
  {
    id: 'analyst-revisions', familyId: 'alt-signals', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Analyst consensus-revision momentum predicts forward excess return.',
    mechanism: 'sluggish price response to revisions', primaryMetric: 'signed drift t-stat by quintile',
    baseline: 'zero', universe: 'large-cap 150, 2021-2026', costs: 'excess-vs-SPY',
    expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'apex/revisions.json (op=revisions)', note: 'signed t 0.6 over 2,574 events — not confirmed.',
  },
  {
    id: 'quiet-accumulation-standalone', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'The Ghost quiet-accumulation composite ranks better than momentum as a standalone selector.',
    mechanism: 'institutional accumulation footprint', primaryMetric: 'walk-forward composite rank-IC, all blocks positive',
    baseline: '12-1 momentum / price core', universe: 'full S&P + small-cap scans', costs: 'gross (study-era)',
    expectedDirection: 'positive incremental IC', stoppingRule: 'pre-declared ship criterion (margin 0.02, ≥3 folds positive)',
    evidence: 'lib/ghost-backtest.js verdict + redundancy model (ghost×screener return corr ≈0.96)',
    note: 'edge is ~all momentum/RM; failed all-blocks-positive; broad-IC information without top-pick lift → SUPPORTING EVIDENCE / shadow tie-break candidate only, weight 0 as standalone.',
  },
  {
    id: 'rlt-leadership-transition', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Sector×band peer-rank leadership transitions predict 5/10/21d residual return.',
    mechanism: 'leadership rotation', primaryMetric: 'cost-net residual IC, both cap bands',
    baseline: 'simple baselines + momentum', universe: 'top-150 sample walk-forward', costs: 'cost-net',
    expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'PR #215 walk-forward record (rlt-lab payloads)', note: 'first real-data walk-forward rejected on both bands.',
  },
  {
    id: 'orbit-residual-drift', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'ORBIT residual-drift screener ranks forward residual returns.',
    mechanism: 'residual drift persistence', primaryMetric: 'OOS rank IC', baseline: 'random + momentum',
    universe: 'app universe', costs: 'cost-aware', expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'docs/orbit-validation.md + orbit lab payloads', note: 'honest ~0 OOS (grade C); never deployed.',
  },
  {
    id: 'orbit-ml-ranknet', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'A RankNet learner beats the transparent baselines on the same folds.',
    mechanism: 'nonlinear feature interactions', primaryMetric: 'OOS rank IC vs baselines',
    baseline: 'ridge + momentum', universe: 'app universe', costs: 'cost-aware',
    expectedDirection: 'positive incremental IC', stoppingRule: GRANDFATHERED,
    evidence: 'docs/orbit-ml-validation.md', note: 'rank-IC ~0; more complexity ≠ improvement.',
  },
  {
    id: 'nonlinear-ml-panel', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'GBM over the clean panel-v2 features earns live promotion over Ridge and momentum.',
    mechanism: 'nonlinear interactions', primaryMetric: 'walk-forward Deflated Sharpe ≥ 0.95 + incremental IC',
    baseline: 'ridge + 12-1 momentum', universe: 'panel-v2 (fwd-outcome-v2 labels)', costs: 'cost-net',
    expectedDirection: 'positive', stoppingRule: 'DSR ≥ 0.95 bar declared before rerun',
    evidence: 'commit a862e83 (28-mlrank rerun on panel-v2) + research/data/evidence/nonlinear-ml-panel/ (panel-v3 rerun)',
    note: 'GBM>Ridge IC delta significant but WF DSR 0.51 < 0.95 → research-only, no live ML. 2026-08-02 panel-v3 rerun (honest labels): delta shrinks +0.0198→+0.0118 (t 4.92→2.63, PBO 18%→43%) — much of the v2 significance was the 3,297 fabricated delisting haircuts; WF DSR 0.50 still fails the pre-declared 0.95 bar. Independent 2026-08-02 re-test agrees: BH q 0.400/0.311 (21/63s), IC delta vs momentum not significant (p 0.444/0.425), top-decile BELOW momentum by 0.55/2.38pp, sector-peer features add nothing.',
  },
  {
    id: 'momentum-volume-composite', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Adding volume-surge information to 12-1 momentum improves 21/63-session rank IC.',
    mechanism: 'volume confirms informed continuation', primaryMetric: 'IC delta vs raw momentum + top-decile excess, BH-corrected',
    baseline: '12-1 momentum', universe: 'refreshed monthly panel (mature rows)', costs: 'cost-net, sector-relative',
    expectedDirection: 'positive incremental IC', stoppingRule: 'fixed predeclared tournament, no variant search',
    evidence: 'independent test 2026-08-02 (ALPHA-STRATEGY-TEST-REPORT §1)',
    note: 'IC delta −0.0004 at 63 sessions; top-decile delta +0.08%/decision-month — immaterial. No factor in the tournament survived BH (momentum itself q=0.311).',
  },
  {
    id: 'sector-residual-momentum-v2', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Sector-residualized momentum ranks better than raw momentum.',
    mechanism: 'strip sector beta to isolate idiosyncratic continuation', primaryMetric: 'IC vs raw momentum at 21/63 sessions',
    baseline: 'raw 12-1 momentum', universe: 'refreshed monthly panel (mature rows)', costs: 'cost-net',
    expectedDirection: 'higher IC', stoppingRule: 'fixed predeclared tournament, no variant search',
    evidence: 'independent test 2026-08-02 (ALPHA-STRATEGY-TEST-REPORT §1)',
    note: 'REDUCED IC relative to raw momentum at both horizons. Consistent with the earlier residual-momentum graveyard entry — now confirmed on the refreshed panel. Caveat: panel sector labels are current-vendor classifications (panel-v3 header sectorBasis), so sector conditioning is itself approximate.',
  },
  {
    id: 'alphagen-compact-formulas', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Compact formulaic combinations (momentum×volume, peer/stock interactions, sector-relative momentum) add lift over momentum.',
    mechanism: 'AlphaGen-style compact factor composition', primaryMetric: 'incremental IC vs momentum in the same frozen tournament, BH-corrected',
    baseline: '12-1 momentum', universe: 'refreshed monthly panel (mature rows)', costs: 'cost-net',
    expectedDirection: 'positive incremental IC', stoppingRule: 'ONLY the predeclared compact families; open-ended symbolic search is PROHIBITED on panel-v2 labels and deferred until panel-v3 (fwd-outcome-v3) exists — unconstrained search now would multiply false-discovery risk against defective labels',
    evidence: 'independent test 2026-08-02 (ALPHA-STRATEGY-TEST-REPORT §3)',
    note: 'No compact family delivered significant incremental lift. The open-ended generator remains UNRUN by design; any future run must preregister here first and use panel-v3 labels through harness-v3.',
  },
  {
    id: 'peer-underreaction-formula', familyId: 'graph-signals', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'A fixed peer-underreaction formula (laggard vs sector-peer moves) predicts forward excess return.',
    mechanism: 'delayed diffusion of peer information', primaryMetric: 'signed IC in the frozen tournament',
    baseline: 'zero + momentum', universe: 'refreshed monthly panel (mature rows)', costs: 'cost-net',
    expectedDirection: 'positive', stoppingRule: 'fixed predeclared formula, no tuning',
    evidence: 'independent test 2026-08-02 (ALPHA-STRATEGY-TEST-REPORT §1)',
    note: 'WRONG-SIGNED. Consistent with the peer-propagation live walk-forward no-edge. Family is two-for-two dead.',
  },
  {
    id: 'peer-propagation', familyId: 'graph-signals', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Sector-peer graph propagation of moves predicts laggard catch-up.',
    mechanism: 'intra-sector information diffusion', primaryMetric: 'prospective walk-forward incremental lift',
    baseline: 'momentum + sector', universe: 'app universe', costs: 'cost-net',
    expectedDirection: 'positive', stoppingRule: 'falsification harness declared at build time',
    evidence: 'peerprop live walk-forward (PRs #226/#229 record)',
    note: 'live WF shows no incremental lift on a small window; stays shadow (test/peerprop-isolation.test.js enforces).',
  },
  {
    id: 'nsl-novel-engines', familyId: 'novel-signal-lab', mode: 'exploratory', status: 'retired',
    hypothesis: 'Nine novel engines (residual momentum, sector twins, forensics, insider-incremental, …) add edge over momentum.',
    mechanism: 'various', primaryMetric: 'incremental IC vs momentum on shared harness',
    baseline: '12-1 momentum', universe: 'app universe', costs: 'cost-aware',
    expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'research/NSL-INCREMENTAL-SERIES-SUMMARY-2026-07.md (PRs #158-#162)',
    note: 'ALL experiments no-edge; arc closed — the family is retired, engines remain shadow diagnostics.',
  },
  {
    id: 'momentum-longer-horizons', familyId: 'swing-ranking', mode: 'confirmatory', status: 'open',
    hypothesis: '12-1 momentum (m121, frozen) positively ranks 63-session and 126-session forward total return on fully observed monthly cohorts.',
    mechanism: 'cross-sectional continuation persisting beyond the 21-session window (Jegadeesh-Titman at quarterly/semiannual horizons)',
    primaryMetric: 'mean per-date rank IC over ELIGIBLE cohorts only (cohort-eligibility ledger), Newey-West HAC t, BH-corrected within swing-ranking; requires ESS ≥ 30, beats random control, survives BOTH extreme-sensitivity views, execution-engine cost-net > 0 under base/doubled/stressed',
    baseline: 'random control + the 21-session momentum benchmark',
    universe: 'panel-v3 universe rule (cap band, ADV floor, US common, identity-resolved), survivorship status as measured — promotion requires proven-safe',
    costs: 'exec-engine-v1 top-decile long, next-session-open entry, base/doubled/stressed all positive',
    expectedDirection: 'positive IC at both horizons',
    stoppingRule: 'PREREGISTERED 2026-08-03 (research/PREREGISTRATION-MOMENTUM-HORIZONS-2026-08.md, sealed BEFORE any confirmatory data existed): evaluation ONLY on sealed unseen data — Era A = 2010-2021 panel once a proven-safe historical listing universe exists (single one-shot evaluation), Era B = prospective cohorts after 2026-02-28 (63s) / 2025-11-30 (126s) evaluated once ESS ≥ 30 is first reached; NO tuning, NO subgroup search, NO added horizons, NO early verdicts (research/58-momentum-horizons-confirmatory.js refuses to reveal interim ICs); any deviation is a NEW hypothesis',
    evidence: 'research/data/momentum-horizons-diagnostic.json (EXPLORATORY: 63s IC 0.0316 t 5.48 ESS 24; 126s IC 0.0451 t 7.09 ESS 18 — the motivating in-sample read, 2022-2026 panel, NEVER reusable as confirmation)',
    note: 'The exploratory 2022-2026 window is spent and excluded from any confirmatory verdict. Honest arithmetic: prospective-only accrual to ESS ≥ 30 takes years at these horizons — the practical confirmatory path is the historical era, which is BLOCKED on an authoritative monthly listing universe (research/data/history-expansion.BLOCKED.json). Even a pass yields PASS-PROVISIONAL only: promotion still needs proven-safe survivorship, prospective agreement, human review and registry approval.',
  },

  // WIKI-mirror historical era (2026-08-04). NOT an amendment to
  // momentum-longer-horizons — its own prohibitions say any deviation is a NEW
  // hypothesis, and this deviates in era (2014-01..2017-12 ⊂ neither sealed
  // era), universe (WIKI curated mirror, ADV-floor band — no shares data), and
  // survivorship class (reduced BY CONSTRUCTION: pre-2014 deaths absent at
  // source, ~1/3 of era real deaths never in WIKI). The 2010-2021 Era-A holdout
  // REMAINS SEALED and untouched. This entry widens the swing-ranking BH
  // denominator — the preregistered cost of asking again on cheaper data.
  {
    id: 'momentum-wiki-2014-2018', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: '12-1 momentum (m121, frozen definition identical to research/15-panel-features-v3.js) positively ranks 63-session and 126-session forward total return on fully observed monthly cohorts of the WIKI-mirror universe, decision dates 2014-01..2017-12.',
    mechanism: 'cross-sectional continuation persisting beyond the 21-session window (Jegadeesh-Titman at quarterly/semiannual horizons), tested on an out-of-era liquid-name historical sample',
    primaryMetric: 'mean per-date rank IC over ELIGIBLE cohorts only (cohort-eligibility ledger), Newey-West HAC t, BH-corrected within swing-ranking at familyTrials-at-evaluation; requires ESS ≥ 30, beats shuffled control on identical rows, dominant-date fraction < 0.5, survives BOTH extreme-sensitivity views, exec-engine-v1 cost-net > 0 under base/doubled/stressed',
    baseline: 'shuffled random control on identical rows',
    universe: 'WIKI-mirror observed PIT membership (bars present at decision date), ADV20 ≥ $3M floor ONLY (no cap band — WIKI carries no shares outstanding; preregistered replacement), curated-list US common, ticker-reuse collisions excluded by the adapter zombie rule',
    costs: 'exec-engine-v1 top-decile long, next-session-open entry on WIKI raw-basis bars, base/doubled/stressed all positive',
    expectedDirection: 'positive IC at both horizons',
    stoppingRule: 'PREREGISTERED 2026-08-04 (research/PREREGISTRATION-MOMENTUM-WIKI-2026-08.md, sealed BEFORE any outcome was computed from the WIKI panel): ONE evaluation ever via research/66-wiki-confirmatory.js, only after the wiki-era panel passes the unchanged audit; NO tuning, NO subgroup/sector/band selection, NO added horizons, NO era extension (pre-2014 is survivorship-biased at source, post-2018-03 does not exist); VERDICT CEILING pass-provisional(survivorship-reduced) — this hypothesis can NEVER, under any result, promote a live strategy or claim survivorship-safe evidence; any deviation is a NEW hypothesis',
    evidence: 'EVALUATED 2026-08-04 (one shot, holdout opened): research/data/wiki-era/evidence-momentum-wiki-2014-2018.json (record 7d56387ef59ceb72…, panel 9e4038f0209ea045…, confirmatory-reproducible at a592dc8, audit PASS, 91,206 name-months / 2,984 names / 839 dead names). VERDICT NOT-CONFIRMED: 63s meanIC 0.007 HAC-t 0.26 ESS 20 q=1 (stressed-cost net NEGATIVE); 126s meanIC 0.006 HAC-t 0.19 ESS 8 q=1. Only direction-sign and shuffled-control gates passed; every significance, sample and robustness gate failed. Full record: research/WIKI-MOMENTUM-RESULT-2026-08.md. Registration-time basis (superseded, kept per registry rule): research/data/wiki/coverage-report.json mirror QC + Form-25 join.',
    note: 'Purpose was closure on the last open lead at zero data cost — ACHIEVED: the free-data branch of the Era-A question is CLOSED with a preregistered null. m121 momentum showed no rankable edge in the liquid WIKI universe 2014-2018, consistent with every other survivorship-aware test in this program and the post-2010 literature. The momentum-historical-2010-2021 holdout stays sealed; buying authoritative data for the true Era A is now a pure user preference with a weakened prior, not a research necessity.',
  },
  {
    id: 'expectation-gap-regime', familyId: 'regime', mode: 'confirmatory', status: 'open',
    hypothesis: 'Objective-vs-priced expectation gaps identify RISK_REDUCE windows that beat static exposure.',
    mechanism: 'variance-risk-premium + breadth divergence', primaryMetric: 'graded SPY-short episodes on the Scoreboard',
    baseline: 'static exposure 1.0', universe: 'index-level', costs: 'cost-net',
    expectedDirection: 'RISK_REDUCE days underperform', stoppingRule: '≥20 resolved RISK_REDUCE episodes before any promotion decision',
    evidence: 'lib/expectation-gap.js + expgap/<date>.json ledger (PR #230)',
    note: 'reduce-only by construction (no RISK_ADD state exists); accruing prospectively.',
  },
  {
    id: 'target-comparison', familyId: 'label-design', mode: 'confirmatory', status: 'open',
    hypothesis: 'Alternative training targets rank the SAME economic metric better than the current label.',
    mechanism: 'label design', primaryMetric: 'cost-adjusted sector-residual rank-IC on identical purged folds',
    baseline: 'current label + shuffled-label control', universe: 'research/horizon-outcomes vectors',
    costs: 'cost-adjusted', expectedDirection: 'a variant beats champion AND the control loses',
    stoppingRule: 'fail-closed <8 dates/<150 rows; shuffled control winning ⇒ verdict NOISE',
    evidence: 'lib/research/target-compare.js (PRs #230-#233)',
    note: 'INSUFFICIENT_DATA until labels mature (~2026-08-09 for bars=5); the control is built in.',
  },
  {
    id: 'downday-v-reversal', familyId: 'mean-reversion', mode: 'confirmatory', status: 'provisional',
    hypothesis: 'On broad red-tape days, V-reversal candidates mean-revert over the following sessions.',
    mechanism: 'liquidity-driven overshoot', primaryMetric: 'forward excess vs SPY of graded picks',
    baseline: 'no-trade', universe: 'app universe on qualifying down days', costs: 'cost-aware',
    expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'research/DOWNDAY-MODE-2026-07.md',
    note: 'validated in study; prospective ledger still thin — provisional until the live record matures.',
  },
  {
    id: 'coil-compression', familyId: 'volatility-structure', mode: 'confirmatory', status: 'provisional',
    hypothesis: 'Volatility compression concentrates ABNORMAL (vol-normalized) upside breaks.',
    mechanism: 'coiled-spring volatility clustering', primaryMetric: 'decile lift of abnormal-break rate',
    baseline: 'universe base rate', universe: 'present-day universe ~2y (SURVIVORSHIP-UNSAFE)', costs: 'n/a (event rate)',
    expectedDirection: 'top decile > base', stoppingRule: GRANDFATHERED,
    evidence: 'research/COIL-RADAR.md + lib/coil.js frozen table',
    note: 'decile lift ~1.9× is real in-study but the table is a frozen present-universe artifact with no per-decile n — display relabeled to "empirical decile base rate", never a calibrated probability.',
  },

  // ── ALPHA-ARCHIVE streams (registered 2026-08-05, PREREGISTRATION-ARCHIVE-STREAMS-2026-08.md) ──
  // Three ARCHIVE-FIRST hypotheses: the confirmatory dataset for each does not
  // exist yet — it accrues prospectively from the daily collectors that ship in
  // the same diff (op=calarchive / op=revarchive / op=gexarchive). Nothing is
  // spent at registration: no outcome has been computed, no window peeked. Each
  // is sealed as a prospective holdout below and carries an earliest-test
  // condition in its stopping rule; evaluating early, or re-cutting the design
  // after data accrues, is a NEW hypothesis.
  {
    id: 'earnings-date-revision', familyId: 'event-drift', mode: 'confirmatory', status: 'open',
    hypothesis: 'Firms that move a scheduled earnings date EARLIER outperform (SPY-excess) between the reschedule observation and ~21 sessions past the announcement; firms that DELAY underperform (Johnson & So, "Time Will Tell", JFQA 2018).',
    mechanism: 'managers schedule good news eagerly; delays reflect audit friction, negotiation, or dread — the reschedule leaks announcement-content information before the announcement',
    primaryMetric: 'signed SPY-excess drift (advanced=long, delayed=short) at 21/63 sessions from the revision observation date via the drift-eval harness; long-short t ≥ 2 AND signed-overall t ≥ 2, ≥2 positive regimes, BH-corrected within event-drift at familyTrials-at-evaluation',
    baseline: 'sign-shuffled control on identical revision events',
    universe: 'all US-listed symbols in the calarchive revision ledger with resolvable Yahoo daily bars; revisions with |deltaDays| in [2, 45] (1-day jitter excluded as vendor noise, >45d as fiscal-calendar changes)',
    costs: 'cost-net at the small tier on the long leg; the short leg is reported gross AND net (borrow unmodeled — stated limitation)',
    expectedDirection: 'advanced dates → positive excess; delayed dates → negative excess',
    stoppingRule: 'PREREGISTERED 2026-08-05 (research/PREREGISTRATION-ARCHIVE-STREAMS-2026-08.md, sealed BEFORE the first revision ledger day existed): ONE evaluation, no earlier than 2027-02-01 AND only once the ledger holds ≥400 revision events with |deltaDays| in [2,45] spanning ≥2 distinct earnings seasons; NO interim drift reads of the ledger before that condition; NO delta-day threshold tuning, NO subgroup search beyond the preregistered advanced/delayed split; any deviation is a NEW hypothesis',
    evidence: 'collector shipped 2026-08-05: op=calarchive daily snapshot+diff (lib/alpha-archive.js diffCalendarSnapshots, calarchive/rev/<date>.json ledger). No outcome data exists at registration.',
    note: 'ARCHIVE-FIRST: scheduled-date revision history cannot be bought retroactively (vendors overwrite lastUpdated in place) — the ledger this test needs starts accruing the day the collector ships, which is the entire reason to preregister now. FMP calendar quality is the known risk: estimated-date churn can fake revisions; the [2,45]-day band and confirmed-season requirement are the preregistered guards.',
  },
  {
    id: 'gex-vol-damping', familyId: 'volatility-structure', mode: 'confirmatory', status: 'open',
    hypothesis: 'Single-name dealer-gamma proxy (netGex from archived option-chain OI, customer-flow sign convention) NEGATIVELY ranks forward realized-vs-implied volatility: high positive netGex names realize LESS vol than their snapshot ATM IV implies; negative-netGex names realize more.',
    mechanism: 'dealers hedging long-gamma books sell rallies and buy dips (damping); short-gamma books hedge with the move (amplification) — Barbon-Buraschi, Baltussen et al.; single-name mid-cap positioning is not arbitraged the way index GEX is',
    primaryMetric: 'daily cross-sectional Spearman between netGex/dollar-OI and forward 5-session realized vol ÷ snapshot atmIV, mean over days with Newey-West HAC t; requires HAC t significant negative, ESS ≥ 30 days, survives excluding expiry weeks, BH-corrected within volatility-structure at familyTrials-at-evaluation',
    baseline: 'shuffled netGex control on identical name-days; atmIV-only ranking as the informational benchmark (the test is INCREMENTAL to IV)',
    universe: 'gexarchive names with ≥500 total OI and ≥4 contracts used at snapshot (thin chains excluded by preregistered floor, not by tuning)',
    costs: 'n/a at this stage (vol forecast, not a trade) — any RETURN-signal use is a separate future hypothesis with its own cost gates',
    expectedDirection: 'negative rank correlation (high dealer gamma → vol damped below implied)',
    stoppingRule: 'PREREGISTERED 2026-08-05 (research/PREREGISTRATION-ARCHIVE-STREAMS-2026-08.md, sealed BEFORE the first snapshot existed): ONE evaluation, no earlier than the ledger holding ≥60 trading-day snapshots with ≥300 qualifying names/day median; the vol-forecast test MUST pass before any return-interaction hypothesis may even be registered on this data; NO sign-convention flips post hoc (the convention is frozen in lib/alpha-archive.js), NO normalization search; any deviation is a NEW hypothesis',
    evidence: 'collector shipped 2026-08-05: op=gexarchive daily sliced snapshots (lib/alpha-archive.js bsGamma/expiryGex/nameGexRecord, gexarchive/<date>-s<n>.json). No outcome data exists at registration.',
    note: 'ARCHIVE-FIRST: OI snapshots exist only on the day. The dealer sign convention (net = calls − puts) is an ASSUMPTION recorded with the data; it being wrong for some names is a way this test FAILS, not a post-hoc re-cut. Known confound: netGex correlates with size and IV level — hence the ÷atmIV target and the atmIV informational benchmark, frozen here.',
  },
  {
    id: 'revision-cascade-velocity', familyId: 'alt-signals', mode: 'confirmatory', status: 'open',
    hypothesis: 'Analyst grade changes that are NOT followed by a second firm within 5 sessions (slow/no cascade) are followed by continued SPY-excess drift in the grade direction; fast-cascade events are already priced by the follower wave.',
    mechanism: 'herding sequencing (Welch): the first mover carries information; the follower cascade is the market’s absorption mechanism — where it does not arrive, absorption is incomplete and price adjusts slowly',
    primaryMetric: 'signed SPY-excess drift at 21/63 sessions from the initiating event via the drift-eval harness, slow-cascade vs fast-cascade cohorts; slow-cohort signed t ≥ 2 AND slow-minus-fast spread t ≥ 2, ≥2 positive regimes, BH-corrected within alt-signals at familyTrials-at-evaluation',
    baseline: 'sign-shuffled control on identical events; the fast-cascade cohort is the internal benchmark',
    universe: 'revarchive initiating events (upgrade/downgrade actions only, maintains excluded) on symbols with resolvable Yahoo daily bars; an event is INITIATING when no other firm graded the same symbol in the prior 10 sessions',
    costs: 'cost-net at the small tier on the long leg; short leg gross AND net (borrow unmodeled — stated limitation)',
    expectedDirection: 'slow-cascade events drift in the grade direction; fast-cascade events do not',
    stoppingRule: 'PREREGISTERED 2026-08-05 (research/PREREGISTRATION-ARCHIVE-STREAMS-2026-08.md, sealed BEFORE the first feed pull existed): ONE evaluation, no earlier than 2027-02-01 AND only once the ledger holds ≥500 initiating events with the full 5-session cascade window observed; the 5-session cascade window and 10-session initiation lookback are FROZEN here; NO window tuning, NO analyst-identity weighting (that would be a NEW hypothesis); any deviation is a NEW hypothesis',
    evidence: 'collector shipped 2026-08-05: op=revarchive daily grade/price-target event pulls with second-resolution publish timestamps (revarchive/<date>.json). No outcome data exists at registration.',
    note: 'ARCHIVE-FIRST: the FMP event feeds truncate — only a daily archive preserves the full cascade record with arrival timestamps. Known risk: feed coverage skews large-cap where analyst effects are weakest; the initiating-event definition deliberately does not condition on cap so the evaluation reports where the events actually live.',
  },

  // ── Panel conditioning features (registered 2026-08-05) — EXPLORATORY ──
  // Both run ONE exploratory pass on the existing 2022-2026 panel-v3 window (which
  // is already exploratory-spent territory for ranking hypotheses). Registered
  // BEFORE the pass so the trial is counted even if the answer is null; any
  // confirmatory claim requires a NEW preregistration on unseen data.
  {
    id: 'overnight-share-conditioning', familyId: 'swing-ranking', mode: 'exploratory', status: 'no-edge',
    hypothesis: 'The overnight share of trailing 63-session returns (close→open component vs total) carries cross-sectional information about 21-session forward total return INCREMENTAL to m121: high overnight-share names (retail/attention-driven clientele) underperform.',
    mechanism: 'overnight vs intraday returns are generated by different investor populations (Lou-Polk-Skouras); a return built disproportionately overnight reflects attention-driven demand that reverts',
    primaryMetric: 'panel-v3 rank IC of the overnight-share feature at 21s on eligible cohorts, harness-v3 gates (HAC t, ESS ≥ 30, shuffled control, both extreme-sensitivity views), paired against the m121 benchmark',
    baseline: 'random control + momentum-12-1 benchmark (harness defaults)',
    universe: 'panel-v3 universe rule, survivorship as measured',
    costs: 'exec-engine-v1 next-session-open, base/doubled/stressed reported',
    expectedDirection: 'negative IC for high overnight share (or materially negative interaction with m121)',
    stoppingRule: 'ONE exploratory pass on panel-v3 2022-2026 (research/67-overnight-share.js), feature definitions frozen in research/15-panel-features-v3.js before the run; the window is spent on completion regardless of result; any confirmatory claim requires a NEW preregistered hypothesis on unseen cohorts',
    evidence: 'EVALUATED 2026-08-05 (the one registered pass, window now SPENT): research/data/evidence/overnight-share-conditioning/ record 547ef66c6cd9bcbf on panel-v3.3:3e3aa9b23193c601 (74,789 label-ready events, 47 eligible cohorts). VERDICT NOT-CONFIRMED: onShare63 meanIC −0.0015 HAC-t −0.32 ESS 32; tugOfWar63 meanIC 0.0166 HAC-t 1.30 ESS 26 (fails min-ESS and FDR; the shuffled control itself ran t 1.34 this window). Both sensitivity views agree.',
    note: 'Overnight returns need OPEN prices: vendor opens are split-adjusted but NOT dividend-reinvested — the feature build corrects ex-div bars via divAmt (locked by test/overnight-features.test.js), so the null is not a dividend artifact. The clientele-decomposition idea carries no cross-sectional signal in this universe/window; features stay in the panel as measured covariates, nothing consumes them.',
  },
  {
    id: 'announcement-congestion', familyId: 'event-drift', mode: 'exploratory', status: 'no-edge',
    hypothesis: 'Post-earnings-announcement drift is stronger for events on CONGESTED reporting days (many same-day announcers compete for attention → initial underreaction) and weaker on quiet days.',
    mechanism: 'limited investor attention (Hirshleifer-Lim-Teoh "Driven to Distraction"): same-day announcement volume rations attention, so congested-day news is incorporated slowly',
    primaryMetric: 'SUE long-short drift at 21/63 sessions split by same-day announcer-count tercile (count from the full FMP calendar, not the sample); congested-tercile minus quiet-tercile spread with t-stat, within-scope (large/small) so congestion is not a size proxy',
    baseline: 'the quiet-day tercile (internal); sign-shuffled control',
    universe: 'FMP paired-estimate SUE events 2021-2026 (the runSurprisePEAD event set), congestion counted over ALL US announcers that calendar day',
    costs: 'reported gross (exploratory conditioning study, not a trade candidate yet)',
    expectedDirection: 'drift concentrated in the congested tercile',
    stoppingRule: 'ONE exploratory pass (research/68-announcement-congestion.js) with terciles and horizons frozen here; NOTE the base PEAD signal was already NOT-CONFIRMED unconditionally on this window — this pass asks only whether congestion MODULATES it; the window is spent on completion; any confirmatory claim requires a NEW preregistration on future events',
    evidence: 'EVALUATED 2026-08-05 (the one registered pass, window now SPENT): research/data/evidence/announcement-congestion/ record 2bfd95c8e9bd0895 (2,526 SUE events, congestion denominator = 3,438-symbol research earnings cache — recorded amendment: the FMP calendar endpoint tier-blocks historical from-dates, substituted BEFORE any outcome was computed; see research/68-announcement-congestion.js header). VERDICT NOT-CONFIRMED on the frozen 63s primary: spread positive in both scopes (large +0.52%, small +5.10%) but t only 0.20/1.43. Large scope thin (26/150 names with cached estimates).',
    note: 'SECONDARY OBSERVATION, not a result: at the NON-primary 21s horizon, small-cap congested-minus-quiet spread +4.46% t 2.55 with a monotone quiet<mid<congested LS pattern (quiet −1.19%, congested +3.27% t 3.48). Post-hoc horizon selection is exactly what the frozen primary exists to forbid — any follow-up is a NEW preregistered hypothesis on FUTURE events, which the calarchive stream will supply prospectively (its daily snapshots yield forward congestion counts).',
  },

  // ── Insider cluster × drawdown (registered 2026-08-05) — EXPLORATORY ──
  // Deliberately a KNOWN effect (limits-to-arbitrage pocket), asked as an EVENT
  // question rather than the composite-weight question the 2026-06 pilots
  // answered (small-cap IN pillar: real +0.067 IC standalone but redundant with
  // momentum). Registered before the EDGAR pull for this universe/window ran.
  {
    id: 'insider-cluster-drawdown', familyId: 'alt-signals', mode: 'exploratory', status: 'no-edge',
    hypothesis: 'Clustered open-market insider BUYING (≥2 distinct insiders within 14 calendar days, ≥$50k combined) in small/micro caps trading ≥30% below their trailing-252-session high is followed by positive SPY-excess drift over the next 21-63 sessions.',
    mechanism: 'multiple insiders independently committing capital after a drawdown is a costly, information-bearing signal; the small-cap segment is where limits-to-arbitrage let it persist (documented cluster-purchase literature), and where this program already measured real standalone insider IC',
    primaryMetric: 'mean SPY-excess drift of cluster+drawdown events at 63 sessions with t ≥ 2 AND positive 21-session mean; internal comparisons (not gates): single-buyer events and cluster-without-drawdown; placebo control: the same events shifted −126 sessions must not show comparable drift',
    baseline: 'placebo (−126-session shifted entries) + single-buyer and no-drawdown internal comparison cohorts',
    universe: 'SMALL_CAPS ∪ MICRO_CAPS names with research price caches (~184); EDGAR Form 4 code-P open-market purchases, filings from 2021-01-01; event date = the LATEST FILING date of the cluster (decision-time: the cluster is only knowable once its last member files — transaction dates would leak)',
    costs: 'reported gross AND cost-net at the small tier (exploratory event study; no live consumer)',
    expectedDirection: 'positive excess drift for cluster+drawdown; larger than both internal comparison cohorts',
    stoppingRule: 'ONE exploratory pass (research/69-insider-cluster.js) with ALL parameters frozen here before the EDGAR pull: 14-day cluster window, ≥2 distinct owners, ≥$50k combined value, drawdown = close ≤ 0.70 × trailing-252-bar max close, per-name event cooldown 21 sessions, horizons 21/63 only; the 2021-2026 window is spent on completion; any confirmatory claim requires a NEW preregistration on future filings',
    evidence: 'EVALUATED 2026-08-05 (the one registered pass, window now SPENT): research/data/evidence/insider-cluster-drawdown/ record 2b610a1f68ddbd7e (242/242 symbols pulled, 221 with Form-4 data, 63 primary events ≥ the 40 fail-closed floor). VERDICT NOT-CONFIRMED: 63s mean excess +10.28% but t only 1.23 (hitRate 46% — a few large winners carry the mean), and the 21s mean is NEGATIVE (−1.25%); both frozen gates fail. Comparisons behaved directionally as hypothesized: placebo −2.88%, cluster-without-drawdown −7.03%, single-buyer+drawdown +4.91% t 1.62.',
    note: 'PIT discipline held: event timing uses FILING dates (the congress-trades lesson). Honest read: the cohort ordering matches the mechanism (cluster+drawdown > single-buyer > placebo > no-drawdown at 63s) but the distribution is far too skewed and thin for a claim — a 63-event lottery-ticket profile, not a tradable edge. Any follow-up is a NEW preregistered hypothesis on FUTURE filings (EDGAR supplies them prospectively); no interim re-cuts of this window.',
  },

  // ── Gap-continuation × congestion (registered 2026-08-05) — EXPLORATORY ──
  // Asks whether the announcement-congestion mechanism (attention rationing →
  // underreaction) upgrades the program's ONE deflation-surviving live edge
  // family (gap-continuation ORB). Uses the COMMITTED 19,326-event
  // survivorship-corrected gap set (research/data/gap-events.json, frozen by
  // research/36-gap-events.js in July) — no event re-generation, no re-cuts.
  {
    id: 'gapgo-congestion-interaction', familyId: 'intraday-gap', mode: 'exploratory', status: 'no-edge',
    hypothesis: 'Gap-and-Go ORB continuation (realized R per the frozen exp08 trade) is STRONGER on congested announcement days (many same-day announcers rationing attention) than on quiet days.',
    mechanism: 'limited-attention underreaction: a gap that fires while the market is digesting hundreds of other announcements is less fully priced at the open, leaving more continuation for the ORB trade to capture',
    primaryMetric: 'congested-tercile minus quiet-tercile mean realized R with pooled-SE t ≥ 2 AND positive, AND spread sign consistent in ≥2 of 3 macro regimes (the reg field frozen into the event set)',
    baseline: 'the quiet tercile (internal); terciles computed over the event set’s same-day announcer counts',
    universe: 'the committed research/data/gap-events.json set (19,326 triggered ORB events, 2021-2026, survivorship-corrected incl. delisted names); congestion = same-day announcer count across the 3,438-symbol research earnings cache (the amended denominator recorded on announcement-congestion)',
    costs: 'R is already the frozen trade’s risk-multiple (entry/stop/target fixed by exp08) — cost sensitivity reported as the spread net of the shipped cost model’s per-trade drag',
    expectedDirection: 'positive congested-minus-quiet R spread',
    stoppingRule: 'ONE exploratory pass (research/70-gapgo-congestion.js) on the committed event set, terciles and the regime-consistency requirement frozen here; NO gap-size/ADV/tier subgrouping beyond the preregistered primary; the 2021-2026 event set is spent for this question on completion; a positive result changes NOTHING live directly — it would only justify a SHADOW congestion feature in the gapgo scorer, itself gated by governance',
    evidence: 'EVALUATED 2026-08-05 (the one registered pass, event set now SPENT for this question): research/data/evidence/gapgo-congestion-interaction/ record 765ec41f52f2ee7a (19,326 events). VERDICT NOT-CONFIRMED for the registered direction — the spread is significantly NEGATIVE: quiet +0.0631 R (t 10.0) vs congested +0.0297 R (t 5.5), spread −0.0334 R t −4.01, positive in only 1/3 regimes.',
    note: 'The registered attention-rationing direction was WRONG; the reversed sign (gaps continue better on QUIET days — an attention-magnet story) is significant overall but NON-MONOTONE (mid tercile −0.008 R, worse than both extremes) and concentrated in risk-on — the signature of a seasonal/regime confound, not a clean effect. Recorded as a confounded reversed-sign lead ONLY; any follow-up (e.g. gap-cause × congestion separation, or a quiet-day boost feature) is a NEW hypothesis and would need prospective data. Nothing wired live.',
  },

  // ── Congestion 21s prospective (registered 2026-08-05) — CONFIRMATORY ──
  // The preregistered follow-up to announcement-congestion's SECONDARY 21s
  // small-cap observation (spread +4.46% t 2.55, monotone terciles — recorded
  // as a lead, never a result). Tested ONLY on events that had not occurred at
  // registration; sealed as holdout `congestion21-prospective`.
  {
    id: 'congestion-21s-prospective', familyId: 'event-drift', mode: 'confirmatory', status: 'open',
    hypothesis: 'On FUTURE earnings events (announced after 2026-08-05), small/micro-cap SUE long-short drift at 21 sessions is stronger on congested announcement days than quiet days (congested-minus-quiet spread positive).',
    mechanism: 'limited investor attention rations processing on crowded reporting days; the effect concentrates where coverage is thinnest (small caps) and at the horizon where the 2021-2026 exploratory lead appeared (21 sessions)',
    primaryMetric: 'congested-minus-quiet tercile spread of SUE top-vs-bottom-quintile LS at 21 sessions, pooled-SE t ≥ 2 AND positive in BOTH small and micro scopes, BH-corrected within event-drift at familyTrials-at-evaluation',
    baseline: 'quiet tercile (internal) + sign-shuffled control on identical events',
    universe: 'small/micro-cap names with research price caches; SUE per the frozen lib/pead.js construction (PIT trailing σ ≤12 prior surprises excluding the event, ≥4 prior, winsor ±8); congestion = same-day announcer count over the full research earnings cache universe, within-scope terciles',
    costs: 'reported gross AND cost-net at the small tier on the long leg; short leg gross and net (borrow unmodeled — stated limitation)',
    expectedDirection: 'positive congested-minus-quiet spread at 21 sessions in both scopes',
    stoppingRule: 'PREREGISTERED 2026-08-05 (research/PREREGISTRATION-CONGESTION-21S-2026-08.md, sealed BEFORE any qualifying event existed): ONE evaluation, no earlier than 2027-08-01 AND only once ≥800 qualifying post-2026-08-05 events spanning ≥3 distinct earnings seasons exist; the 21-session horizon, tercile split, and scope definitions are FROZEN (the 63s failure and the 21s lead are both recorded — evaluating any other horizon is prohibited); NO interim spread reads; any deviation is a NEW hypothesis',
    evidence: 'motivating lead (spent, never reusable): announcement-congestion record 2bfd95c8e9bd0895 — 21s small-cap spread +4.46% t 2.55 on 2021-2026 events, a NON-primary observation on an already-failed primary',
    note: 'This is the program’s template case for lead → prospective preregistration: the horizon was chosen by the 2021-2026 data, so ONLY future events can confirm it. Accrual arithmetic: the exploratory window produced ~430 small-scope events/year from 150 names; with micro added, ≥800 events plausibly accrue by mid-2027. The calarchive stream independently snapshots forward calendars, giving a second PIT congestion source to cross-check the cache-derived counts at evaluation time.',
  },

  // ── Composite book (registered 2026-08-05) — CONFIRMATORY, prospective ──
  // The PORTFOLIO-LEVEL reframe: every per-signal gate demands each hypothesis
  // clear t ≥ 2 alone, but real books are combinations of individually-weak,
  // mutually-uncorrelated sleeves whose POOLED record clears significance
  // honestly — and pooled events reach a testable sample months sooner than
  // any sleeve alone. Evaluated ONLY on events logged after registration.
  {
    id: 'composite-book-v1', familyId: 'regime', mode: 'confirmatory', status: 'open',
    hypothesis: 'The equal-weight composite of the program’s surviving event-conditional sleeves — CERN forced-flow decisions (non-logOnly types, incl. SMID) and Down-Day red-tape V-reversal bounces — produces positive market-neutral alpha at the PORTFOLIO level on prospectively logged events.',
    mechanism: 'diversification across weak, structurally uncorrelated limits-to-arbitrage streams: forced passive flows and liquidity-overshoot reversion fire on different days for different reasons, so the pooled book earns their combined premium at lower variance than any component',
    primaryMetric: 'on events logged AFTER 2026-08-05 only: pooled beat-rate Wilson 90% lower bound > 0.50 AND pooled mean-alpha t ≥ 2 (event level) AND each sleeve’s individual mean alpha positive; cross-sleeve daily-mean-alpha correlation reported (the diversification premise wants ~0)',
    baseline: 'SPY market-neutral per event (long: excess vs SPY; short: symmetric short-benchmark read); no-trade as the capital baseline',
    universe: 'op=alphabook composition, FROZEN in lib/alphabook-routes.js: CERN engine ledger+archive first-appearance events excluding logOnly types, graded at each type’s own horizon; DOWNDAY tick-resolved 3-session bounce picks. Sleeve set changes (e.g. adding gapgo-TAKE) are a NEW book version with a NEW registration.',
    costs: 'cost-net at the small AND micro capital tiers via exec-engine scenarios at evaluation time (micro tier = the capacity-asymmetry read: these sleeves live where institutions cannot deploy)',
    expectedDirection: 'positive pooled alpha; both sleeves positive; near-zero cross-sleeve correlation',
    stoppingRule: 'PREREGISTERED 2026-08-05 (research/PREREGISTRATION-COMPOSITE-BOOK-2026-08.md): ONE evaluation, no earlier than 2027-02-01 AND only once ≥120 pooled post-2026-08-05 resolved events exist; sleeve set and weights (equal) FROZEN; the op=alphabook `prospective` block is the ONLY evidence lane (pre-registration rows are motivating context, never confirmation); NO sleeve re-selection, NO weight fitting, NO horizon changes; any deviation is a NEW book version and hypothesis',
    evidence: 'registered before any prospective row existed. FIRST RETROSPECTIVE READ 2026-08-05 (motivating context ONLY, never confirmation): CERN 3/3 resolved beat, meanAlpha +19.23% t 2.2 (n tiny); DOWNDAY 60 resolved, beat 40%, meanAlpha −0.08% t −0.14 (the study-validated sleeve is FLAT live); pooled 63 resolved, beat 42.9%, meanAlpha +0.84% t 1.01 — no retrospective edge, and the equal-event pooling lets the high-frequency flat sleeve swamp the low-frequency positive one. The prospective lane opened empty, as designed; SMID coverage (~10× CERN events) shifts the future mix toward the positive sleeve under the SAME frozen weighting.',
    note: 'The retrospective rows were logged LIVE (PIT by construction) but predate this registration, so they can motivate, never confirm. Accrual arithmetic: CERN SMID coverage (~10× events) plus red-day-gated DOWNDAY picks make ≥120 pooled events by early 2027 plausible; if accrual falls short the evaluation simply waits — the condition is sample-based, not date-based.',
  },

  // ── VRP overlay (registered 2026-08-05) — EXPLORATORY ──
  // The risk-transfer reframe: stop forecasting, get PAID for bearing crash
  // risk. Synthetic study only (no historical option prices on hand).
  {
    id: 'vrp-overlay-synthetic', familyId: 'volatility-structure', mode: 'exploratory', status: 'no-edge',
    hypothesis: 'A regime-gated systematic SPY put-write (sell 30d ATM cash-secured puts, hold to expiry) earns the variance risk premium with a better risk-adjusted profile than SPY buy-and-hold over 2021-2026, and the gates (macro risk-off skip; implied>realized entry condition) materially improve it.',
    mechanism: 'the variance risk premium — option buyers systematically overpay for crash insurance, so the seller earns a persistent premium as compensation for bearing left-tail risk (CBOE PUT/BXM evidence class); regime/IV-RV gates avoid selling insurance exactly when it is underpriced',
    primaryMetric: 'monthly P&L series over ~60 months: annualized Sharpe and max drawdown of ungated vs macro-gated vs IV>RV-gated variants against SPY buy-and-hold; frozen lead criterion: a gated variant beats SPY’s Sharpe AND its worst month is > −25% of collateral',
    baseline: 'SPY buy-and-hold over the identical window; the ungated put-write as the internal comparison',
    universe: 'index level only (SPY + ^VIX daily bars, 5y); premiums SYNTHESIZED via Black-Scholes with σ = VIX at entry (no smile — understates real put premium, a conservative bias recorded with the result)',
    costs: 'reported gross with a fixed $1/contract + 1-tick slippage haircut scenario (index options are the cheapest venue retail touches)',
    expectedDirection: 'gated variants improve Sharpe over ungated; at least one gated variant beats SPY buy-and-hold risk-adjusted',
    stoppingRule: 'ONE exploratory pass (research/71-vrp-overlay.js) with entry grid (21-session), tenor (30d), moneyness (ATM), rate (4%), and both gates FROZEN here before the run; no strike/tenor search; the 2021-2026 window is spent on completion; this is a RISK-PREMIUM characterization, not an alpha claim — any live overlay is a separate governance question and any confirmatory claim needs real option marks (the gexarchive IV stream as it matures)',
    evidence: 'EVALUATED 2026-08-05 (the one registered pass, window now SPENT): research/data/evidence/vrp-overlay-synthetic/ record 550fdefbf8a45dd6 (58 periods 2021-09..2026-07). VERDICT NOT-CONFIRMED as registered — the GATES are refuted: macro-gated Sharpe 0.47 and IV>RV-gated 0.70, both WORSE than ungated, neither beating SPY buy-and-hold (0.80). The hypothesized mechanism (gate the premium sale by regime) works BACKWARDS: skipping risk-off skips exactly the richest premium periods.',
    note: 'SECONDARY OBSERVATION, not a result: the UNGATED put-write beat SPY risk-adjusted on this window (Sharpe 1.03 vs 0.80, maxDD −13.1% vs −20.3%, worst month −7.2%, 74% positive) with LOWER total return (49.6% vs 66.3%) — consistent with the CBOE PUT/BXM literature class. Caveats that keep this a lead only: one 5y window with no 2020-class crash (the left tail IS the premium’s price), synthetic no-smile pricing, no gap-risk realism. Any follow-up needs real option marks — the gexarchive IV stream as it matures — and would be a NEW hypothesis about the UNGATED harvest, not a gate.',
  },
]);

// ── Multiple-testing correction ────────────────────────────────────────────────
// Benjamini-Hochberg step-up FDR: items = [{id, p}] → [{id, p, q, rank}] with the
// standard monotone adjusted q-values. Null/invalid p-values are excluded from the
// correction (returned with q:null) — a missing p must not shrink the denominator.
function benjaminiHochberg(items) {
  const rows = (items || []).map((it) => ({ id: it.id, p: Number.isFinite(it.p) && it.p >= 0 && it.p <= 1 ? it.p : null }));
  const valid = rows.filter((r) => r.p != null).sort((a, b) => a.p - b.p);
  const n = valid.length;
  let runningMin = 1;
  const qById = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const raw = (valid[i].p * n) / (i + 1);
    runningMin = Math.min(runningMin, raw);
    qById.set(valid[i].id, Math.min(1, runningMin));
  }
  return rows.map((r, idx) => ({
    ...r,
    q: r.p == null ? null : qById.get(r.id),
    rank: r.p == null ? null : valid.findIndex((v) => v.id === r.id) + 1,
    index: idx,
  }));
}

// ── Trial accounting ───────────────────────────────────────────────────────────
function familyTrials(familyId) {
  return HYPOTHESES.filter((h) => h.familyId === familyId).length;
}
function totalTrials() { return HYPOTHESES.length; }

function byStatus(status) { return HYPOTHESES.filter((h) => h.status === status); }
function graveyard() { return HYPOTHESES.filter((h) => h.status === 'no-edge' || h.status === 'retired'); }
function find(id) { return HYPOTHESES.find((h) => h.id === id) || null; }

// ── Sealed-holdout ledger ──────────────────────────────────────────────────────
// Rule: an opened holdout can NEVER be called untouched again. Opening is a
// recorded, irreversible event (openedAt set via a reviewed diff). The three
// momentum-longer-horizons eras below were sealed BEFORE any of their outcomes
// existed or were inspected (the 2026-03+ / 2025-12+ cohorts were pending and
// ineligible at sealing; the 2010-2021 era has no panel at all yet).
const HOLDOUTS = Object.freeze([
  {
    id: 'momentum-63s-prospective',
    description: 'momentum-longer-horizons Era B, 63 sessions: decision cohorts AFTER 2026-02-28, evaluated only when fully observed per the cohort ledger; single verdict when ESS ≥ 30 first holds',
    sealedAt: '2026-08-03', openedAt: null, openedBy: null,
  },
  {
    id: 'momentum-126s-prospective',
    description: 'momentum-longer-horizons Era B, 126 sessions: decision cohorts AFTER 2025-11-30, same rules',
    sealedAt: '2026-08-03', openedAt: null, openedBy: null,
  },
  {
    id: 'momentum-historical-2010-2021',
    description: 'momentum-longer-horizons Era A: 2010-01..2021-12 panel, buildable ONLY on a proven-safe historical listing universe (currently BLOCKED — research/data/history-expansion.BLOCKED.json); ONE evaluation ever',
    sealedAt: '2026-08-03', openedAt: null, openedBy: null,
  },
  {
    id: 'momentum-wiki-2014-2018-era',
    description: 'momentum-wiki-2014-2018: WIKI-mirror panel, decision cohorts 2014-01..2017-12, labels observed through the 2018-03-27 freeze; ONE evaluation ever (research/66-wiki-confirmatory.js), only after the wiki-era audit passes; survivorship-reduced BY CONSTRUCTION — verdict ceiling pass-provisional, never promotion evidence',
    sealedAt: '2026-08-04',
    openedAt: '2026-08-04',
    openedBy: 'research/66-wiki-confirmatory.js one-shot (panel 9e4038f0209ea045…, evidence record 7d56387ef59ceb72…, verdict not-confirmed) — an opened holdout is never untouched again',
  },
  // ALPHA-ARCHIVE prospective ledgers (sealed 2026-08-05, BEFORE the first
  // collected day existed — the strongest sealing possible: the entire dataset
  // is future data). Reading any of these ledgers to compute an outcome before
  // the paired hypothesis's earliest-test condition holds OPENS the holdout.
  {
    id: 'calrev-prospective',
    description: 'earnings-date-revision: the calarchive/rev/* revision ledger accruing from 2026-08-05; ONE evaluation, no earlier than 2027-02-01 and ≥400 qualifying revisions spanning ≥2 earnings seasons',
    sealedAt: '2026-08-05', openedAt: null, openedBy: null,
  },
  {
    id: 'gex-prospective',
    description: 'gex-vol-damping: the gexarchive/* snapshot ledger accruing from 2026-08-05; ONE evaluation once ≥60 trading-day snapshots with ≥300 qualifying names/day median exist',
    sealedAt: '2026-08-05', openedAt: null, openedBy: null,
  },
  {
    id: 'revcascade-prospective',
    description: 'revision-cascade-velocity: the revarchive/* event ledger accruing from 2026-08-05; ONE evaluation, no earlier than 2027-02-01 and ≥500 initiating events with observed cascade windows',
    sealedAt: '2026-08-05', openedAt: null, openedBy: null,
  },
  {
    id: 'congestion21-prospective',
    description: 'congestion-21s-prospective: earnings events announced AFTER 2026-08-05 in the small/micro cached universe; ONE evaluation, no earlier than 2027-08-01 and ≥800 qualifying events across ≥3 earnings seasons; sealed before any qualifying event existed',
    sealedAt: '2026-08-05', openedAt: null, openedBy: null,
  },
  {
    id: 'composite-book-prospective',
    description: 'composite-book-v1: the op=alphabook `prospective` lane (events logged after 2026-08-05); ONE evaluation, no earlier than 2027-02-01 and ≥120 pooled resolved events; the retrospective portfolio block is motivating context and may be read freely — only the prospective lane is sealed',
    sealedAt: '2026-08-05', openedAt: null, openedBy: null,
  },
]);
function untouchedHoldouts() { return HOLDOUTS.filter((h) => !h.openedAt); }

// ── Validation ─────────────────────────────────────────────────────────────────
function validateHypothesis(h) {
  const errors = [];
  if (!h || typeof h !== 'object') return { valid: false, errors: ['not an object'] };
  for (const k of ['id', 'familyId', 'hypothesis', 'mechanism', 'primaryMetric', 'baseline', 'universe', 'expectedDirection', 'stoppingRule', 'evidence']) {
    if (typeof h[k] !== 'string' || !h[k].length) errors.push(`${k} is required`);
  }
  if (!MODES.includes(h.mode)) errors.push(`mode must be one of ${MODES.join('|')}`);
  if (!STATUSES.includes(h.status)) errors.push(`status must be one of ${STATUSES.join('|')}`);
  // Only a confirmatory test can confirm.
  if (h.status === 'confirmed' && h.mode !== 'confirmatory') errors.push('status confirmed requires mode confirmatory');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  REGISTRY_VERSION, STATUSES, MODES, HYPOTHESES, HOLDOUTS,
  benjaminiHochberg, familyTrials, totalTrials, byStatus, graveyard, find,
  untouchedHoldouts, validateHypothesis,
};
