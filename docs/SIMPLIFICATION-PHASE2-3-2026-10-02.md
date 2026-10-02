# Simplification — Phase 2 (merges + copy) and Phase 3 (backend pruning), 2026-10-02

Executes §6 Phase 2 and the evidence-safe subset of Phase 3 of
`docs/SIMPLIFICATION-PLAN-2026-09-20.md` (Phase 1 shipped in PR #424). Base: `main`
`10670db`. Rule applied throughout (§7 guardrails win): a surface is pruned from the
backend only when **its own evidence is closed / no-edge / Disabled / retired AND it
has no still-accruing preregistered ledger**. Hiding or removing a tab never touches
a nightly step that writes a ledger the Scoreboard still reads.

## 1. What changed

### Phase 2 — merges (lanes), removals, copy

- **Lanes.** A duplicate surface no longer gets a sub-nav pill; it renders as a lane
  pill under the tab that owns the question (`MERGED_INTO` in `public/js/app.js`,
  `laneStripHTML` in `renderHubSubnav`). Its section, loader, verdict banner and
  `#hash` are unchanged. Hosts and lanes:

  | Host | Lanes (Simple) | Expert-only lanes |
  |---|---|---|
  | today | gameplan, brief | — |
  | session | — | quickhit, ensemble (combined shortlist), opportunities |
  | ignitionlive | lowfloat, breakoutradar | — |
  | rotation | sectors | — |
  | news | picks | — |
  | options (Expert tab) | crowd, sharp, putsell | — |
  | scoreboard | evidence (grades), baselines | movermiss, intradayval |

- **Removed from the UI** (DOM section, `app.js` renderer, dedicated module, CSS):
  the 23 tabs §5 marks REMOVE (table in §2). `RETIRED_TO` maps each old id to its
  successor so bookmarks, `localStorage`, Today's source chips and ⌘K history still
  land somewhere.
- **Copy.** `SUB_LABEL` uses the plan's plain names (Combined shortlist, Swing entry
  planner, Forced-selling bounces, …); `SECTION_HELP` is one sentence per tab;
  `HOWTO` is one sentence per field; `TRUST` / `SCREENER_STYLE` lost their retired
  keys. `HOW-TO-USE.md` rewritten for lanes.
- **One honesty stamp per tab.** Simple mode hides `#tape-badge` and `#trust-badge`;
  the verdict banner stays on every tab.
- **Boot hygiene.** The flip-alert watcher (`pollSignals`, up to 12 `/api/chart`
  reads every 2 min for every visitor) now runs only after the user turns the bell or
  the chime on; the toggles moved from the retired Momentum header to Alerts.
- **Phase 2 items done elsewhere / not needed.** `op=maturity` is already a single
  memoised promise in `evidence-badge.js`; `today.js` makes its own bounded optional
  read in the same `Promise.all` as `op=today` — folding it would couple the Today
  render to the badge module for one 60 KB read, so it was left. `op=thesis` is not
  requested by the app (the Thesis tab fetches `op=evidence&view=all`); the 5.1 MB
  figure in the plan came from a direct `curl ?op=thesis` hitting the tracker's
  scoreboard default — see deferred list.

### Phase 3 — backend pruning (evidence-safe subset)

| Module / op | Chain step | Blob | Registry row proving it is dead | Removed |
|---|---|---|---|---|
| `lib/techstrats.js` (donchian / rsi2 / pullback detectors) | none | none | STRATEGY-CENSUS-2026-08-12 "techstrats retire-duplicate (rec)"; no registry or hypothesis row; zero tests | module + the three `KNOWN` patterns in `op=vreversaltest` |
| `lib/leaderboard.js`, `op=leaderboard`, `op=leaderboardtick` | `ticks3[0]` `op=leaderboardtick&src=confluence` | `leaderboard/strats.json` (derived cache) | GRADUATION-LEAGUE-2026-08-12: "Auto-reweighting disabled: the leaderboard no longer feeds any rank"; FINDINGS-LEDGER RT-04; no registry/hypothesis row | module, ops, chain step |
| `lib/catalyst-flow-routes.js`, `op=catalystflow`, `op=catalystflowcoverage`, `op=catalystflowregistry` | none (artifacts published by offline `research/88-92` scripts) | `catalystflow/v1/*` (no writer in the app) | `research/results/catalyst_flow_report.md`: KEEP_RESEARCH_ONLY, 6/7 promotion gates fail, BH q = 0.919; plan §5 "falsified" | routes + ops + routes test; `lib/catalyst-flow/*` kept for the research scripts |
| `lib/si-overlay-routes.js`, `lib/si-overlay/*.json` (2 MB committed bundle), 7 `si*` ops | none — `op=sitick` was never scheduled anywhere | `si/v1/prospective/*` never accrued | `lib/si-overlay/result.json` verdict `NO_INCREMENTAL_ALPHA`; plan §5 "experiment concluded NO_ALPHA" | routes, bundle, ops, route tests; `lib/shortinterest.js`, `lib/research/si-*` kept (shared by screener / omega-ab) |
| Edge Book: `op=edgelog`, `op=edgebook` (`apex-routes` `runEdgeLog`/`runEdgeBook`), `store.js` `edge/` helpers | `capture` step `op=edgelog` | `edge/<date>.json` | unregistered (census F5 "unregistered minor surface"); sleeve A consumes the conviction sleeve the registry forbids showing; no Scoreboard reader, zero tests | ops, functions, store helpers, chain step |
| `op=coreperf` (`stablecore-routes.runCorePerf`) | none of its own | reads `core/*` | plan §5 "performance page for an archived book"; the core book itself (shadow `coremo`) keeps `corebuild/corelog/coredrift` | op + function; book and its steps untouched |
| `op=algorithmrouter` (public demo read) | none | none | census PR-08 "algo-router ≡ algorithm-router (duplicate; keep algo-router-v1)" | op only — `lib/algorithm-router.js` stays, see deferred |

`ROOT_CHAINS` is unchanged (44 roots after rebasing on the day's sibling PRs; two steps
removed inside `capture` and `ticks3`), so `scripts/gen-nightly-matrix.js --check` is current and the
GitHub-matrix workflow semantics are untouched.

## 2. Per-surface disposition

Disposition vocabulary: KEEP (Simple pill) · LANE (merged, Simple) · LANE-X (merged,
Expert-only) · ARCHIVE (Expert pill) · REMOVED-UI (tab gone, backend intact) ·
REMOVED (tab + backend gone).

| surface | disposition | evidence | removed / kept / deferred + reason |
|---|---|---|---|
| today | KEEP | landing page | kept |
| session | KEEP | user-requested graded board | kept |
| gameplan | LANE → today | KEEP-CONTEXT | kept (lane) |
| brief | LANE → today | already fetched by Today | kept (lane) |
| quickhit | LANE-X → session | third shortlist of the same rows | kept (Expert lane) |
| ensemble | LANE-X → session | 0 names; second composition | kept (Expert lane, relabelled "Combined shortlist") |
| opportunities | LANE-X → session | same rows as Today's research lane | kept (Expert lane) |
| start | ARCHIVE | Guide header button covers it | kept |
| daytrade | KEEP | PIT ledger, negative record stays on tab | kept |
| ignitionlive | KEEP | in-session ignition view | kept |
| lowfloat | LANE → ignitionlive | same engine, different filter | kept (lane) |
| breakoutradar | LANE → ignitionlive | fourth view of the intraday pipeline | kept (lane) |
| gapgo | ARCHIVE | hypothesis `unscheduled-gap-orb` open | kept; `gapgotick`/`gapgoverify` accrue |
| gapdown | REMOVED-UI | census retire-duplicate; shorts fail closed | tab gone; `op=gapdowntick` kept (ledger accrues, Scoreboard reads) — engine retirement deferred |
| ignition (EOD) | REMOVED-UI | demoted to shadow 2026-08-12, 0 cards | tab + `public/js/ignition.js` gone; `op=ignitionlog`/`op=ignition` in `postdecision` kept (shadow ledger accrues) |
| swingsup | KEEP | only post-publication follow-up | kept |
| screener | KEEP | prospective cost-net ledger | kept |
| premove | ARCHIVE | weight-0, gate blocked | kept; `premovelog/resolve` in `atlasx` root accrue |
| omega | REMOVED-UI | registry `omega-swing-selection` no-edge; census baseline-only | tab + `public/js/omega-swing.js` gone; `op=omegalog`/`op=omega` kept (shadow ledger accrues; `omegaab` A/B accrues to ~2027-05) |
| atlas | ARCHIVE | weight-0 research, 0 rows | kept (relabelled "Swing entry planner") |
| aligned | REMOVED-UI | composition of lookup reads, always empty | tab gone; `aligned` root (`op=aligned`, `op=alignedlog`) kept — ledger accrues |
| custom | ARCHIVE | zero-weight benchmark since 2026-08-12 | kept |
| ghost | REMOVED-UI | retired 2026-08-13 (`ghostlog` already removed from chains) | tab + renderer gone; `lib/ghost.js` kept — `c.ghost` still ships on screener candidates and the Scoreboard reads the historical ledger as record |
| coil | REMOVED-UI | governance DISABLED; hypothesis `coil-compression` provisional | tab gone; `op=coiltick` kept — §6: disabled ticks keep writing so the disabled evidence stays honest |
| patternradar | ARCHIVE | 20.7 MB payload; lookup embeds pattern search | kept; summarized read deferred |
| downday | REMOVED-UI | robustly negative; registered negative lane 2026-09-19 | tab gone; `op=downdaytick` kept (negative-lane ledger accrues) |
| confluence | REMOVED-UI | always abstains; voters are one family | tab gone; `op=confluencetick` kept (ledger accrues); `leaderboardtick&src=confluence` removed with the leaderboard |
| trendrider | REMOVED-UI | never produces scoreboard rows | tab gone; `op=trendtick` kept (trend-episode shadow ledger accrues) |
| fade | ARCHIVE | validated only as AVOID filter | kept (relabelled "Overheated (avoid)"); AVOID-badge fold deferred |
| biotech | ARCHIVE | distinct data, tiny negative record | kept |
| tech-command | KEEP | owner-requested, forward ledger | kept |
| coremo | ARCHIVE | falsified factor shown as a book | kept |
| momentum | REMOVED-UI | empty and negative; alerts carries flips | tab gone; `api/momentum.js` kept (own function; `probability-language` test pins it) |
| putsell | LANE-X → options | 0 picks; VRP unproven (`vrp-put-write-live` open) | kept (Expert lane); `op=putsell` warm kick kept |
| picks | LANE → news | cheap news discovery | kept (lane, moved to Markets) |
| rotation | KEEP | the one defensible read | kept |
| sectors | LANE → rotation | same data | kept (lane); `/api/sectors` also feeds `op=today` |
| news | KEEP | cheap | kept |
| pulse | KEEP | regime context | kept; v1 fallback deferred |
| thesis | ARCHIVE | n101 at −3.67 %, stale | kept; `op=evidencetick` (GitHub 22:30 UTC) accrues and the Scoreboard reads `Evidence` |
| evolve | REMOVED-UI | empty in every horizon; registry shadow "0 cells pass WF gate" | tab + `evolve.js`/`evolve-evidence.js` gone; `evolve` root kept — it carries the `@postdecision` handoff (test-enforced) and `lib/evolve*.js` is shared by orbit/challenger/atlasx/ephemeral |
| forecast | ARCHIVE | calibration diary, IC ≈ 0.02 | kept |
| crowd / sharp | LANE-X → options | same options/prediction data | kept (Expert lanes); `op=crowdtick` also feeds the push feed |
| alerts | ARCHIVE | push plumbing useful | kept; now hosts the flip-alert bell/chime |
| scoreboard | KEEP | the honesty spine | kept; summarized payload deferred |
| evidence | LANE → scoreboard | grades mount on every tab | kept (lane "Grades") |
| movermiss / intradayval | LANE-X → scoreboard | §7: never removed | kept (Expert lanes) |
| baselines | LANE → scoreboard | F-12 open (baselines asserted, not measured) | kept (lane) |
| leaderboard | REMOVED | superseded by maturity grades; reweighting disabled | tab, module, ops, chain step, derived cache all gone |
| coreperf | REMOVED | performance page for an archived book | tab + `op=coreperf` gone; core book kept |
| events (CERN) | ARCHIVE | one non-negative cell | kept (relabelled "Forced-selling bounces") |
| crossasset | ARCHIVE | "promising" = sector beta | kept |
| xalerts | ARCHIVE | distinct data | kept |
| options | ARCHIVE host | v1 + v2 render in one tab | kept as the one Options page |
| backtest | ARCHIVE | research harness | kept |
| cfl | ARCHIVE | measurement tool | kept |
| psrl | ARCHIVE | open hypotheses | kept |
| gridlock | ARCHIVE | distinct data | kept |
| readthrough | REMOVED-UI | n6 at −16 % | tab gone; `op=readthroughtick` (warm aiTick) kept — Scoreboard reads `ReadThrough`; `lib/readthrough.js` is the sector-ETF resolver for 13 modules |
| anomaly | REMOVED-UI | negative; census consolidate | tab gone; `op=anomalytick` kept — Scoreboard reads `Anomaly` |
| secondwave | REMOVED-UI | governance DISABLED | tab gone; `op=secondwavetick` kept — disabled ticks keep writing |
| toneshift | REMOVED-UI | n4, empty | tab gone; `op=toneshifttick` + `op=tonetick` kept (Scoreboard reads `ToneShift`, `Tone`) |
| edge | REMOVED | unregistered; consumes a forbidden sleeve; no reader | tab, ops, capture step, store helpers gone |
| orbitlab | REMOVED-UI | `orbit-residual-drift` + `orbit-ml-ranknet` no-edge | tab + `orbit-lab.js` gone; `orbitlog/orbitmltick/orbitresolve/orbitmlresolve` kept (shadow ledgers accrue); `orbit-math/-calibration/-controls/-factor-model` are shared infra |
| rltlab | REMOVED-UI | `rlt-leadership-transition` no-edge | tab + `rlt-lab.js` gone; `rlt` root kept — `rlt/latest.json` is read by atlasx, pulse, pulse2; `rlt-residual/-universe` feed peerprop/psrl |
| silab | REMOVED | NO_INCREMENTAL_ALPHA; never scheduled | tab, routes, bundle, ops gone |
| catalyst | REMOVED (serving) | falsified (KEEP_RESEARCH_ONLY) | tab, routes, ops gone; `lib/catalyst-flow/*` kept for `research/88-93` |
| peerlab | REMOVED-UI | `peer-propagation` + `peer-underreaction-formula` no-edge | tab + `peer-lab.js` gone; `peerprop` root kept — Scoreboard reads `PeerProp`/`Underreaction`, OMEGA annotates from `peerprop/latest.json` |

## 3. Deferred until 2026-10-30 (four weeks, human approval)

| Item | Why deferred |
|---|---|
| Retire `gapdown` as an engine (parameterize side in `gapgo`) | `op=gapdowntick` still writes a ledger the Scoreboard reads; the merge is an engine change, not a prune |
| Drop the `evolve` root (`evolvescore/evolveresolve/evolve`) | carries the `@postdecision` handoff (`ignitionlog`, `ignition`, `omegalog`, `omega`) — `test/warm-chains.test.js` pins it; needs re-homing as its own shallow root first (HTTP-508 history) |
| Retire `postdecision` ledgers (`ignition`, `omega` EOD) | shadow ledgers still accruing; `omegaab` A/B verdict ~2027-05 |
| Pulse v1 (`op=pulse`, `pulserefine`, `pulsegrade`, `pulse` root, `pulse-store/-grade/-schema/-episodes`) | dead data (no reader) but live code: `app.js` falls back to v1 when `PULSE2_MODE=off`, the documented rollback lever; `warm-chains.test.js` uses the `pulse` chain as a fixture; `pulse-enrich.js` must stay for pulse2 |
| Options flow v1 (`optionsflow-routes.js`, `api/warm.js` kicks) | `op=today` consumes `op=optionsflow` as its `optionsPositioning` evidence family; `lib/optionsflow.js` is shared by v2, gameplan, capture, omega-ab |
| `lib/algorithm-router.js` (the second router) | `orbit-routes.orbitRouterWeight` still calls `Router.routeWeights`; the public demo op is gone |
| `op=thesis` fall-through | `api/tracker.js` returns the full scoreboard for any unknown op; a 400 on unknown ops is a tracker contract change (health probes and warm kicks must be audited first) |
| Summarized `op=patterns` read (top 50 triggered) and summarized Scoreboard payload | backend payload redesign with its own tests; not a removal |
| Fade → AVOID badge fold | renderer work on live surfaces (Day Trade / Session cards) |
| `lib/anomaly*`, `secondwave*`, `toneshift*`, `readthrough-routes` libs | ledgers still accrue and the Scoreboard reads their sections; pruning means retiring those sections |
| `research/89-si-incremental.js` writes `lib/si-overlay/` | the bundle directory is gone; the script needs a new output path if it is ever rerun |

## 4. §8 measurements (before → after)

| Measure | Before (main 10670db) | After |
|---|---|---|
| Visible tabs in Simple mode | 12 pills | 11 pills + 8 Simple lanes (gameplan, brief, lowfloat, breakoutradar, sectors, picks, evidence, baselines) |
| Sections / tabs in Expert mode | 70 | 47 registered (31 pills + 16 lanes) |
| `<section>` elements in `index.html` | 70 | 47 |
| Top-level destinations | 5 (4 in Simple) | 5 (4 in Simple) |
| Eager JS bytes (`public/js` excl. `vendor/`) | 1,555,037 | 1,310,042 (−15.8 %) |
| `public/js/app.js` lines | 10,652 | 9,105 |
| `public/index.html` bytes | 105,947 | 83,546 |
| `public/css/app.css` bytes | 280,026 | 261,499 (235 selectors/rules pruned) |
| `lib/**/*.js` module count | 742 | 738 (+ 2 MB of committed JSON removed) |
| Nightly ROOT_CHAINS | 42 at 10670db (44 on main after the 2026-10-02 sibling PRs) | unchanged (steps −2: `edgelog`, `leaderboardtick`) |
| Requests before first paint at `#today` | 11 + up to 12 chart polls | 11 (chart polling opt-in behind the bell) |
| Onboarding surfaces | 2 | 2 |

Re-measure after the deferred items with the same probes.

## 5. Verification

- `npm run check` green; full `npm test` 0 failures on the rebased tree (see PR). `CERN_LBL`
  (the CERN event-type label map, incl. the ARK shadow pair) now lives once at module level in
  `app.js` and feeds the Scoreboard's CERN tier labels; its old copy was inside the retired
  Down-Day renderer.
- `drive-app` against a local static server proxying `/api` to production: today,
  daytrade, rotation, scoreboard, events (the five destinations) plus session,
  ignitionlive, news, pulse, sectors, evidence — 0 console errors, 0 render hazards.
  `options` reports a pre-existing `quote undefined/undefined (undefined% of mid)`
  leak in the v2 liquidity line (`app.js` ~1756, unchanged by this PR) when a quote
  object lacks bid/ask — reported, not fixed here.
