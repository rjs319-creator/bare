# Simplification Plan (2026-09-20)

Produced by a four-agent audit swarm (tab inventory, UX clutter, information
architecture, implementation constraints) on `main` 88e4be9. This is the one
decision document: what the app is for, what to show, what to hide, what to
remove, and in which order. Anchors are `file:line` at that commit.

## 1. The honest premise

- Production governance (gov-v3, 2026-09-19 22:03Z): **0 production, 59 paper,
  3 disabled** (attention, coil, secondwave). Cleared weight is zero.
- Hypothesis registry: 0 confirmed, 3 provisional, 17 open, 26 no-edge, 1 retired.
- Every "candidates" tab is therefore a research surface wearing a trading label.
- The app's real assets are three: the **regime read** (the one finding the data
  supports), the **graded Session board** (A to F, time frame, live status vs levels),
  and the **evidence pipeline** (ledgers, scoreboard, maturity grades).
- Simplifying means putting those three in front and moving everything else
  behind an Expert switch, without stopping a single ledger.

## 2. Measured overwhelm

| Metric | Value | Where |
|---|---|---|
| Top-level nav groups | 8, duplicated in three navs | `index.html:28-35`, `:51-60`, `:1770-1781` |
| Sections / sub-tabs | **70** (candidates 23, lab 18, proof 7, markets 6, predict 6, home 5, positions 4, tech 1) | `app.js` TAB_GROUPS |
| Candidates pills on one row | 23 plus 3 horizon divider rows | `app.js:455-470` |
| Static payload | index.html 107 KB, app.css 267 KB, JS 1.45 MB; about 1.82 MB uncompressed; 1,597 tags pre-rendered | `public/` |
| Requests on boot at `#today` | 11 plus up to 12 `/api/chart` polls, about **23**; `op=maturity` fetched twice; the 5 MB scoreboard fetched eagerly even off-tab | `app.js:9434`, `evidence-badge.js:54`, `today.js:753` |
| Pollers alive on the home tab | 5 intervals | `app.js:656,736,853,10061,10177` |
| Injected "how to use" essays | 33 tabs, four paragraphs each | `app.js:207-430` |
| Sub-tab tooltips | 70, several 80 to 120 words | `app.js` SECTION_HELP |
| Overlapping onboarding surfaces | 5 (Start Here button, Guide tab, injected HOWTO, Learn modal, details help blocks) | `index.html:44-46`, `app.js:431` |
| What Simple mode hides today | about 55 `.expert-only` and 20 `.fade-caveats` elements plus the Lab link; 52 of 70 tabs stay visible | `app.js:5985-5997`, `app.css:2061-2065` |
| Honesty vocabulary | "shadow" 284 mentions, "weight-0 / never a buy signal" about 160, warning glyphs 248 | renderers |

Per-tab payload hazards on a single open (prod probe, market closed):

| Tab | Payload | Note |
|---|---|---|
| patternradar | **20.7 MB** | 12k stateful episodes; nobody can act on them |
| scoreboard | 5.1 MB | the ledger of record, needs a summarized read |
| thesis | 5.1 MB | `op=thesis` is not a real op; it falls through to the scoreboard default |
| rltlab | 4.7 MB | no-edge verdict, gate blocked |
| xalerts | 1.7 MB | A/B has never armed |
| tech-command | 598 KB | one sector view |
| today | 521 KB | fans out to 8 ops |
| swingsup | 394 KB | needs trimming |
| daytrade | 310 KB | |
| atlas | 305 KB | 0 rows in all 5 sections |
| pulse2 | 222 KB | 6 panels |
| options | 210 KB | v1 is superseded |

## 3. User jobs and the surface that serves each

| Job | Best surface | Duplicates today |
|---|---|---|
| J1 Is today a day to trade at all? | `today` (regime, sectors, opportunity banner) | gameplan, brief, ensemble |
| J2 What is the best graded setup right now, with time frame and levels? | `session` | quickhit, opportunities, ensemble, aligned, confluence |
| J3 What is igniting intraday? | `daytrade`, `ignitionlive` | lowfloat, breakoutradar, ignition, gapgo, gapdown |
| J4 One ticker, every horizon? | ticker lookup / command palette | `aligned` tab |
| J5 What am I tracking and how did picks do? | `swingsup`, `scoreboard` | evidence, baselines, leaderboard, coreperf, movermiss, intradayval |
| J6 What is moving and why? | `rotation`, `news`, `pulse` | sectors, picks, thesis, evolve |
| J7 Can I trust this signal? | `evidence`, the verdict banner on every tab | trust badge, tape badge, subtitle disclaimers |

## 4. Target information architecture

Five destinations. **Simple mode (the default) shows exactly twelve tabs.** Expert
mode shows every section under horizon dividers. Every `#hash` deep link and every
command palette entry keeps working. Nothing is removed from code or from the
nightly chains in this phase.

| Destination | Simple mode tabs | Expert mode adds |
|---|---|---|
| 🏠 Today | today, session | ensemble, start (Guide), quickhit |
| 🎯 Trade | daytrade, ignitionlive, screener, swingsup, tech-command | lowfloat, breakoutradar, gapgo, gapdown, ignition, premove, opportunities, omega, atlas, aligned, custom, ghost, coil, patternradar, downday, confluence, trendrider, fade, biotech, coremo, momentum, putsell, picks |
| 📊 Markets | rotation, news, pulse | sectors, thesis, evolve, gameplan, brief, forecast, crowd, sharp, alerts |
| 🎖️ Evidence | scoreboard, evidence | movermiss, intradayval, baselines, leaderboard, coreperf |
| 🔬 Research | hidden in Simple | events, readthrough, anomaly, secondwave, crossasset, toneshift, xalerts, options, backtest, edge, cfl, orbitlab, rltlab, psrl, gridlock, silab, catalyst, peerlab |

Mechanics: `TAB_GROUPS` keeps every id (so `SECTION_IDS`, hash routing at
`app.js:626`, `hubSub` sanitizing at `:190` and `showTab` at `:472` are unchanged);
a `SIMPLE_TABS` set filters `renderHubSubnav` (`:459`); `LEGACY_TOP` maps the old
keys (candidates, positions, tech, predict) so stale bookmarks and localStorage
land on the new destination; the three static navs shrink to five links.

Reconciliation with the inventory: `tech-command` was marked ARCHIVE by the
inventory agent and visible by the IA agent. Final call: **visible in Trade**. It is
an actively fed surface (GitHub workflow every 15 minutes) that the owner asked
for, and its ledger is one of the few with a forward-return record.

## 5. Per-tab disposition

Dispositions: KEEP-CORE (daily decision surface), KEEP-CONTEXT (cheap context),
MERGE (fold into another surface), ARCHIVE (Expert only, ledger keeps ticking),
REMOVE (UI only; libraries and ledgers untouched until Phase 3).

### Today

| id | disposition | reason |
|---|---|---|
| today | KEEP-CORE | the landing page; needs a diet (8 ops, 521 KB), not removal |
| session | KEEP-CORE | newest, user-requested, 46 KB, honest caps |
| ensemble | MERGE into today | second composition of the same rows; 0 names |
| start | KEEP-CONTEXT | one guide entry point; Expert-only pill, header button covers it |
| quickhit | MERGE into session | third shortlist of the same screener rows |

### Trade

| id | disposition | reason |
|---|---|---|
| daytrade | KEEP-CORE | most engineered intraday surface with a PIT ledger; n272, negative record stays on the tab |
| ignitionlive | KEEP-CORE | the in-session ignition view; target of the intraday merge |
| screener | KEEP-CORE | the one non-daytrade engine with a prospective cost-net ledger |
| swingsup | KEEP-CORE | the only place a pick is followed after publication |
| tech-command | KEEP-CORE (visible) | actively fed, owner-requested, forward ledger |
| lowfloat | MERGE into ignitionlive | same engine, different filter |
| breakoutradar | MERGE into ignitionlive | fourth view of the same intraday pipeline |
| gapgo | ARCHIVE | hypothesis open, governance n0; not a live tool |
| gapdown | REMOVE | census retire-duplicate; shorts fail closed, nothing actionable |
| ignition | REMOVE | demoted to shadow 08-12, 0 cards, name collides with ignitionlive |
| premove | ARCHIVE | weight-0, gate blocked, never produced scoreboard rows |
| opportunities | MERGE into today | same rows as Today's research lane |
| omega | REMOVE | registry no-edge, census baseline-only, 0 cards |
| atlas | ARCHIVE | weight-0 research, 0 rows, 305 KB |
| aligned | REMOVE | composition of the lookup reads, always empty |
| custom | ARCHIVE | demoted to a zero-weight benchmark 08-12; client twin is a drift hazard |
| ghost | REMOVE | retired by the owner 2026-08-13; ledger read only as record |
| coil | REMOVE | governance DISABLED; still shows 25 picks |
| patternradar | ARCHIVE | 20.7 MB payload; lookup panel already embeds pattern search |
| downday | REMOVE | robustly negative; registered negative lane 09-19 |
| confluence | REMOVE | always abstains; voters are one family |
| trendrider | REMOVE | never produces scoreboard rows; another trend re-rank |
| fade | MERGE into an AVOID badge | validated only as a filter; a 40-card tab misrepresents it |
| biotech | ARCHIVE | distinct data, tiny negative record |
| coremo | ARCHIVE | falsified factor presented as a 153-name book |
| momentum | REMOVE | empty and negative; alerts carries flips |
| putsell | ARCHIVE | 0 picks; VRP unproven |
| picks | KEEP-CONTEXT (Markets) | cheap news discovery; wrong group today |

### Markets

| id | disposition | reason |
|---|---|---|
| rotation | KEEP-CORE | the regime and rotation read is the app's one defensible value |
| news | KEEP-CONTEXT | cheap, useful, no claims |
| pulse | KEEP-CONTEXT | good regime context; trim to market state plus top 5 |
| sectors | MERGE into rotation | same data, second tab |
| thesis | ARCHIVE | n101 at minus 3.67 percent, stale, and the op falls through to the scoreboard |
| evolve | REMOVE | empty in every horizon |
| gameplan | KEEP-CONTEXT (merge into Today as the narrative strip) | compact, but a fourth "what to do today" page |
| brief | MERGE into today | already fetched by Today |
| forecast | ARCHIVE | calibration diary, meta-ranker IC about 0.02 |
| crowd | MERGE into one Options page | same options flow data |
| sharp | MERGE into one Options page | third view of options flow |
| alerts | KEEP-CONTEXT (fold into notify prefs) | the push plumbing is useful; a tab of flips is not |

### Evidence

| id | disposition | reason |
|---|---|---|
| scoreboard | KEEP-CORE | the honesty spine; needs a summarized payload |
| evidence | MERGE into scoreboard | 0 results now; grades already mount on every tab |
| movermiss | ARCHIVE | engineering diagnostic |
| intradayval | ARCHIVE | engineering diagnostic |
| baselines | MERGE into scoreboard | one comparison column, not a tab |
| leaderboard | REMOVE | 1 KB payload; superseded by maturity grades |
| coreperf | REMOVE | performance page for an archived book |

### Research

| id | disposition | reason |
|---|---|---|
| events (CERN) | ARCHIVE (top of the drawer) | the one non-negative cell; fails the survivorship ceiling |
| crossasset | ARCHIVE | "promising" grade is sector beta per two research passes |
| xalerts | ARCHIVE | distinct data; 1.7 MB; A/B never armed |
| options | MERGE into one Options page | v1 superseded by v2; attention layer is DISABLED |
| backtest | ARCHIVE | research harness |
| cfl | ARCHIVE | measurement tool with no decisions |
| psrl | ARCHIVE | open hypotheses, stale |
| gridlock | ARCHIVE | distinct data; keep ticking |
| readthrough | REMOVE | n6 at minus 16 percent, empty |
| anomaly | REMOVE | negative; census says consolidate |
| secondwave | REMOVE | governance DISABLED; still renders candidates |
| toneshift | REMOVE | n4, empty |
| edge | REMOVE | consumes a sleeve the registry forbids showing |
| orbitlab | REMOVE (UI) | two no-edge verdicts; keep the residualizer as infrastructure |
| rltlab | REMOVE | no-edge plus 4.7 MB per open |
| silab | REMOVE | experiment concluded NO_ALPHA |
| catalyst | REMOVE | falsified |
| peerlab | REMOVE | two no-edge verdicts; expensive op behind a tab |

Non-tab surfaces: ticker lookup is KEEP-CORE and should be promoted to the header;
the command palette is the escape hatch to archived tabs; the Simple/Expert toggle
is repurposed as the real mode switch; badge overlays (timing, flow, dilution) are
three systems on one card and deserve a visual pass in Phase 2.

Counts: KEEP-CORE 8, KEEP-CONTEXT 6, MERGE 11, ARCHIVE 20, REMOVE 23. Visible nav
goes from 8 groups and 70 sections to 5 groups and 12 tabs.

## 6. Phases

### Phase 1: this PR (frontend only, reversible, no backend edits)

1. `TAB_GROUPS` becomes five groups (`app.js:67`); every id stays registered.
2. `SIMPLE_TABS` filters the sub-nav in Simple mode; Expert mode shows everything
   under extended `SUB_HZ` dividers; horizon dividers are dropped in Simple.
3. `LEGACY_TOP` redirects old group keys in initial routing and `showTab`.
4. Header nav, mobile top tabs and bottom nav shrink to five links.
5. Mode toggle re-renders the sub-nav instead of bouncing to Candidates.
6. Today trims: empty Executable and Qualified lanes render as one line; the shadow
   challenger block, swing research lane, evidence independence and data trust
   panels, and the "Also explore" strip become Expert-only (`today.js:91-129,
   455-469, 498-562`).
7. Header buttons: Start Here becomes "📘 Guide" (the Guide tab is hidden from the Simple sub-nav, so the button is its entry point); the Learn button is Expert-only.
8. Boot hygiene: no eager scoreboard fetch at `app.js:9434`.
9. Docs: this plan and a rewritten `HOW-TO-USE.md`.

Tests that pin the nav and must stay green: `session-board-frontend.test.js:31`
(home literal byte-exact), `ignition-live-routes.test.js:125` (lowfloat,
ignitionlive, breakoutradar adjacent), `cfl-routes:67`, `psrl-routes:68`,
`catalyst-flow-routes:81`, `peerprop-routes:44` (lab adjacencies, peerlab last),
`lowfloat-api:250-282` (section ids and lazySection lines), `dilution-flag:118`.

### Phase 2: merges and copy (next one or two sessions)

- sectors into rotation; picks into news; lowfloat and breakoutradar into
  ignitionlive as lane filters; quickhit, ensemble, opportunities, aligned and
  confluence into session; the seven proof tabs into one Evidence page; options,
  crowd, sharp and putsell into one Options page.
- Copy rewrite of the 33 HOWTO entries and 70 tooltips to one sentence each,
  using the jargon table below; statistics vocabulary (FDR, Wilson, Newey-West,
  PIT) becomes Expert-only.
- Fix `op=thesis` falling through to the scoreboard; give patternradar a
  summarized read (top 50 triggered, not 12k episodes); share one `op=maturity`
  promise between `evidence-badge.js:54` and `today.js:753`; make the
  `pollSignals` chart polling opt-in behind the bell (`app.js:10163-10177`).
- One honesty stamp per tab: keep the verdict banner, fold the trust badge into
  it, drop the tape badge and subtitle disclaimers in Simple.

| Current | Plain |
|---|---|
| OMEGA Ensemble / OMEGA-Swing | Combined shortlist / 5 to 10 day momentum |
| ATLAS-X | Swing entry planner (research) |
| CERN Forced-Flow | Forced-selling bounces |
| PSRL / Persistent Trends | Steady climbers |
| RLT | New sector leaders |
| PRIMED, ARMED, TRIGGERED, ACCEPTED | Setting up, Ready, Triggered, Entered |
| weight-0 / zero live-rank weight / shadow | Research only, not on the board (once) |
| promotion is a registry change only | drop |
| evidence-cleared, governance, paper | proven, the track record, not yet proven |
| density 12/100, max exposure 0% | Weak day for setups |
| regime-gated, risk-off tape | Market is red, stand down |
| Dual Confirmed, Confluence, Aligned | Agreeing screens (one tab) |

### Phase 3: backend pruning (at least four weeks later, human-approved)

Requires explicit registry transitions logged to the hash-chained ledger. Remove
the ghost tab outright (already retired, no tick); retire gapdown as an engine
(parameterize side in gapgo); retire optionsflow v1, pulse v1, techstrats and the
second router; then prune their chains in `lib/warm-chains.js` ROOT_CHAINS and
CHAINS, `lib/health.js` BACKGROUND_CHAINS and the scoreboard readers in
`lib/apex-routes.js:776`. Caveat: the `evolve` chain carries the `@postdecision`
handoff (`warm-chains.js:118`) and must be re-homed before that root is dropped.
Coil, secondwave and attention are governance-disabled but their ticks keep
writing so the disabled evidence stays honest.

## 7. Guardrails: what not to remove and why

- **No ledger stops.** Every tick that writes a ledger feeds the scoreboard and
  `op=maturity`; hiding a tab never touches it. Phase 1 and 2 have zero backend edits.
- **No strategy leaves `lib/strategy-registry.js`** without a logged transition.
- **The verdict banner stays on every visible tab.** It is the honest grade; the
  other stamps are the noise.
- **Simple stays the default.** Expert is opt-in and persists in localStorage.
- **Deep links keep working.** `SECTION_IDS` still contains every id; hidden tabs
  render their own pill while active so the user can see where they are.
- **The daytrade pipeline and its diagnostics (movermiss, intradayval) are never
  removed**; they are the app's only intraday-verified fill path.
- **Session and Today both stay**: Session is the graded board, Today the narrative
  and regime read; they answer different questions.

## 8. How to measure success

| Measure | Before | Target |
|---|---|---|
| Requests before first paint at `#today` | about 23 | 6 or fewer |
| Visible tabs in Simple mode | 52 | 12 |
| Sub-nav pills per group in Simple | up to 23 | 5 or fewer |
| Top-level destinations | 8 | 5 (4 in Simple) |
| Horizontal scroll on a 400 px phone | yes (23 pills) | none |
| Largest single-tab payload in Simple | 5.1 MB (scoreboard) | under 500 KB after the Phase 2 summarized read |
| Onboarding surfaces | 5 | 2 (Guide pill and injected details) |

Re-measure after each phase with the same probes (curl per tab, count of fetch
calls on the boot path, pill count per group) and record the numbers here.
