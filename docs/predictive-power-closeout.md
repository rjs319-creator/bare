# Predictive-Power Closeout — 2026-07-28

Audit-then-implement pass over the "one evidence-driven prediction system" assignment.
Five parallel deep audits (identity spaces, prediction/ledger infrastructure, promotion
gates, router inputs, rejection/archive infrastructure) established what actually exists;
the implementation phase then fixed the confirmed defects and built the highest-value
missing pieces. **No strategy was promoted. No live ranking changed. No new alpha is
claimed.**

## What was already present (audit findings)

The assignment's premise — "sophisticated but disconnected screeners" — was **partially
stale**. Much of the requested architecture already existed:

- **Canonical registry & fail-closed authority chain.** `lib/strategy-registry.js` (37
  entries, explicit maturity) → `strategy-gate` → `eligibility` → `decision-routes` is
  centralized and fails closed for *permission*: an unknown id cannot obtain live
  eligibility. Day Trade freeze is protected by byte-identical golden tests
  (`test/rlt-daytrade-unchanged.test.js`, `test/premove-contracts.test.js`,
  `test/today-golden.test.js`).
- **RLT was already committed, merged (PRs #214–#217) and walk-forward-tested** — with a
  recorded NO-EDGE verdict in both cap bands. The "untracked RLT files" claim was stale.
- **Rejection capture existed for 5 of 21 algorithms** (ghostobs full cross-section with
  selected/near-threshold/rejected/excluded; ATLAS-X matched controls; Coil
  decile-stratified controls — the only one that also *graded* its controls; ORBIT/RLT
  exclusion ledgers with reason codes).
- **The IV/RV groundwork was deliberately pre-wired** (2026-07-01 archive widening puts
  Coil names first in the options archive), with a pre-registered ≥150-matured-pick bar.
- **A hash-chained immutable ledger + run manifest** existed but covered ~9 streams
  (mostly batch summaries) out of ~40.
- **The router** had strong architecture with genuinely strict binding (budgets fail
  closed to zero on missing inputs).

## What was implemented (this pass)

1. **Identity honesty fixes** — the Core Momentum tab wore production momentum's
   "Proven" banner while being a registered *shadow* strategy
   (`public/js/evidence-badge.js` stale `TAB_STRATEGY.coremo` mapping — removed);
   `rltlab` now resolves to `rlt`; the emitted-but-unregistered `Evidence` Scoreboard
   section is now a registered shadow strategy (`thesis`); `SECTION_TO_ID` completed
   (Evidence/OMEGA/AtlasX/Challenger/Orbit/OrbitMl). A **generalized bidirectional
   invariant test** (`test/registry-coverage.test.js`) source-scans `runScoreboard` so an
   emitted section can never again ship unregistered, and a tab can never wear a
   higher-maturity strategy's banner.

2. **RLT promotion-path contradiction fixed both ways** (`lib/rlt-governance.js`,
   `lib/rlt-config.js`). Before: the documented promotion path (registry maturity flip)
   crashed every RLT request (`assertShadow` threw on production unconditionally), while
   `RLT_MODE=enforce` + a hand-written artifact computed `mayAffectLive: true` without
   consulting the registry — and `rlt-utility` *does* read that flag. Now:
   `mayAffectLive` requires **enforce mode AND valid version-matched artifact AND the
   human registry flip**, and even then only a `canaryCap` (10%); `assertShadow` rejects
   an *un-earned* production flip (production without artifact) instead of production per
   se. The caller-less 12-criterion `promotionView` is now wired into the RLT board
   payload with honest fail-closed inputs. RLT remains shadow / weight-0.

3. **Router evidence inputs** (`lib/algo-router-routes.js`, `lib/redundancy-routes.js`).
   The section→source mapping now resolves through the canonical `SECTION_TO_ID` (the
   local copy would have silently emptied CERN's series: `cern` ≠ registry id `events`).
   Real **recent rank IC** is now computed from ledger tier conviction (per-date Spearman,
   ≥4 names/date, ≥8 dates) — *fail closed*: only algorithms with a declared unambiguous
   tier ordinal (screener: Breakout>Setup>Early; ghost: GHOST>STALKING>WATCH) get an IC;
   momentum's is undefined by construction and stays null. The **net/gross basis** of
   maturity stats now propagates — a gross figure can no longer wear the
   `expectedNetEdge` label (it moves to `grossEdge` with `edgeBasis`). Calibration and
   execution confidence remain null with documented reasons (no per-pick probabilities /
   no per-algorithm verified-fill feed) — so **binding budgets remain zero and
   `bindingReady` remains false**, which is correct.

4. **False-negative lab closes its loop** (`lib/premove-obs-resolve.js`, op
   `premoveresolve`, wired into the `atlasx` warm chain). ghostobs records captured
   selected AND rejected candidates but nothing ever graded them. The new resolver is
   censor-aware (null until matured or terminal), grades all four cohorts identically
   (trigger→stop/target/timeout, no-trigger, consumed-at-fill, plain forward window for
   plan-less rejected rows), resolves same-bar ambiguity to the stop, fills gap-throughs
   at the worse open, labels returns **gross**, and appends outcomes to a separate
   grader-owned doc (`ghostobs/resolved.json`) — observations are never rewritten.

5. **Source-integrity generator** (`scripts/gen-full-source.js`). Now includes
   untracked-but-not-ignored source files (`git ls-files --others --exclude-standard`) —
   the mechanism by which a 17-file subsystem once vanished from review dumps — and
   emits an explicit exclusion manifest (path, byte size, sha256) for oversized files
   (currently only `public/js/app.js`). Tested end-to-end in a scratch git repo,
   including proof that env/secret files structurally cannot enter the dump.

6. **Display↔grading parity hash** (`lib/decision-routes.js`). Every op=today response
   now carries `boardHash` — sha256 over the stable serialization of the served snapRow
   set — and the first logged board of each day is pinned **write-once** to
   `today/parity/<date>.json`. A graded record can now be proven to be about the
   recommendation set the user actually saw.

7. **Coil × IV/RV sample sufficiency is machine-checked** (`lib/ivrv-sufficiency.js`,
   op `ivrvsample`). Joins Coil picks (realized vol) to same-date archived atmIV,
   counts fully-usable and maturable rows against the pre-registered ≥150 bar, and
   discloses archive truncation. It **never** emits a verdict — `status` is only
   `INSUFFICIENT_SAMPLE` or `READY_FOR_EVALUATION` (`verdict: null` always).

## What remains blocked by external data (recorded, not faked)

- **True PIT analyst-estimate vintages** — FMP Premium gates quarterly analyst-estimates
  and >10-row estimate pulls behind Ultimate. The existing `lib/revisions.js` uses
  monthly *rating counts* (tested 2026-07: NOT-CONFIRMED, t≈0.6). The Phase-8 EPS/revenue
  revision experiment is therefore **UNAVAILABLE** on current data; do not build a fake
  backtest against today's restated consensus.
- **Coil × IV/RV verdict** — the LIVE sufficiency check (2026-07-28) surprised the
  audit estimate: 646 Coil picks, 342 fully-usable joins, **163 maturable ≥ the 150
  bar → READY_FOR_EVALUATION** already. BUT with two disclosed caveats: (a) the
  maturable rows predate cohort labeling or are all selected — the **control cohort is
  starved (0 usable controls)**, so the selected-vs-control comparison is not yet
  runnable (op=ivrvsample now warns exactly this); (b) maturity is calendar-approximate
  and must be re-verified against candles by the experiment itself. IV/RV *level*
  studies are sample-ready; the controlled comparison needs control-side accrual.
- Borrow/locate feeds, ETF creations/redemptions, OPRA trade-level options, verified
  supply-chain graph, alt-data panels, bond/CDS — unchanged: documented, not fabricated.
- Point-in-time sector history (validFrom/validTo) — RLT's registered limitation stands;
  research-side PIT security master exists, app-side remains the thin version.

## Empirical results

**None claimed.** Nothing in this pass ran a new market experiment. The standing recorded
verdicts are unchanged: RLT walk-forward NO EDGE (both bands); NSL experiments no-edge;
SUE-PEAD / congress / revisions NOT-CONFIRMED; Gap & Go remains the strongest validated
event edge; broad momentum (~0.10 rank IC) plus regime avoidance remain the only
repeatable general levers.

## Promotion / demotion status

- **Promoted: none.** (By design — nothing passed any gate, and this pass added guards
  making un-earned promotion strictly harder: registry flip alone now insufficient for
  RLT live influence; env var + artifact alone also insufficient.)
- **Demoted: none.**
- **Still shadow / weight-0:** RLT, ATLAS-X, premove, OMEGA, ORBIT/ORBIT-ML, coremo,
  thesis (newly registered), and all other non-core entries.
- **Known remaining control gap (documented, not yet closed):** five subsystems
  auto-promote *internal* weights without consulting central governance (apex Module-2
  recalibrate, timing tune, dualread adapt, EVOLVE strength tilt, alerts-Fable
  promotion). These operate inside already-production strategies; consolidating them
  under the governance doc is the next structural task.

## Router readiness

`bindingReady: false`, and it must stay false until (a) calibration quality and
execution confidence are *measured* (not defaulted), and (b) the counterfactual
evaluation shows router allocation beating equal weight on identical episodes,
cost-net, with prospective confirmation. Both halves of (b) are now BUILT
(second pass, same day): op=router force runs persist a per-day weight history
(`router/history.json` — latest.json alone made replay impossible), and
`op=routercf` evaluates router vs equal-weight vs best-recent-chaser vs cash on
identical resolved ledger rows (gross-labeled, paired router−equal primary
metric, no-lookahead chaser, abstention = cash). Status is INSUFFICIENT_HISTORY
until ≥40 evaluated dates accrue prospectively; the report never carries a
verdict or binding recommendation.

## Adaptive-layer disclosure (second pass)

The five self-adapting layers the audit flagged (apex Module-2 recalibrate,
timing tune, dualread adapt, EVOLVE strength tilt, alerts-Fable promotion) are
now DISCLOSED centrally: `lib/adaptive-layers.js` reads each layer's own state
doc and the block rides on op=maturity and inside governance/latest.json —
ACTIVE/DORMANT/UNKNOWN per layer, with `governanceConsulted: false` stated
explicitly. This is visibility only; bringing them *under* governance remains
open work.

## Validation

- Baseline before changes: 2536 tests, 0 fail.
- After: **2571 tests, 0 fail** (+35 new: registry coverage invariants, RLT promotion
  invariant, router evidence, ghostobs resolver, board parity hash, source generator,
  IV/RV sufficiency).
- Reproduce: `npm test` · `node --test test/<file>.test.js` for any single suite ·
  `node scripts/gen-full-source.js` regenerates the dump (673 files, 1 disclosed
  exclusion).

## Next prospective sample requirements

- RLT: prospective-only path — daily shadow accrual; promotion gate now visible per-run
  in the board's `promotion` block (currently ~all criteria unmet).
- Coil × IV/RV: `op=ivrvsample` → `remaining` counts down to the ≥150 bar.
- ghostobs false-negative lab: outcomes now accrue via the warm chain; the
  selected-vs-rejected comparison becomes meaningful once rejected cohorts mature
  (~2–3 weeks of accrual for first waves).
- Router binding: blocked on measured calibration + execution inputs, then the
  counterfactual harness, then prospective confirmation.
