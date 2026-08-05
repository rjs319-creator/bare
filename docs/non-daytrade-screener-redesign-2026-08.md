# Non-Day-Trade Screener Redesign — Audit & Implementation Record (2026-08)

Principal-researcher audit-then-implement pass over every screener EXCEPT Day Trade
(frozen by user directive; its pinned eligibility, golden fixtures and uncommitted
in-flight work were not touched). Method: every suspected defect was verified against
current source (file:line) before any edit; already-fixed items are recorded as such.
Baseline before changes: `npm test` 3,509 tests / 3,507 pass / 0 fail; after:
**3,542 / 3,540 pass / 0 fail**; `npm run check` clean.

Governing evidence (authority order): `research/SWING-SCREENER-VALIDATION-V3-2026-08.md`
(no swing strategy passed promotion; production selection fails cost stress),
`research/OMEGA-SURVIVORSHIP-FREE-2026-07.md` (no-edge), `research/MOMENTUM-SURVIVORSHIP-FREE-2026-07.md`
(rank-IC ≈ 0), `docs/model-promotion-policy.md`, `docs/validation-protocol.md`.
**No model was promoted in this pass. No new alpha is claimed. Every change is an
evidence-integrity or fail-closed-governance correction.**

---

## 1. Inventory (condensed; full grading detail in §2)

| Screener | Impl | Universe | Graded entry (pre-pass) | Scoreboard section | Registry (pre → post) | Actionable reach | Disposition |
|---|---|---|---|---|---|---|---|
| Breakout | `api/screener.js` + `lib/swing-screener-engine.js` | static lists + expanded cache | next-open (exec-v1) in replay; ledger close-based | `screener` | production (kept) | Today board | production (weights unchanged per V3 verdict) |
| Ghost | `lib/ghost.js` (rides screener) | screener cross-section | logged entry assumed filled; stop/target logged then ignored | `Ghost` | production (kept) | evidence overlay on Breakout rows; standalone lane shadow | production overlay; standalone = visible-research |
| Apex / Adaptive Momentum | `lib/apex.js`, `lib/apex-routes.js` | screener cross-sections | own resolveTrade drift ledger | none (`custom`) | production (kept) | none (no board normalizer) | production tab; structurally board-unreachable |
| Trend Rider | `lib/trend.js`, routes 674–871 | live fan-out scan | **signal-day close, 21s close-to-close, no levels** | own book | **UNREGISTERED → shadow `trendrider-v1` + contract** | none | visible-research |
| Dual Confirmed / Aligned | `lib/aligned.js`, `lib/aligned-routes.js` | 4-scope candle caches | **signal-day close; displayed stop/target not logged; first-appearance-forever dedup** | own book | **UNREGISTERED → shadow `aligned-v1` + contract** | none | visible-research (book v2 shipped) |
| Confluence | `lib/confluence.js`, routes 1850–2251 | 3-scope caches, day-rotated | **signal-day close; displayed pullback/2R plan not graded** | own book | **UNREGISTERED → shadow `confluence-v1` + contract** | none | visible-research (family admission fixed) |
| Momentum v2 | `api/momentum.js` | DT discovery ∪ screener cross-sections (defect #14 already fixed) | live quote, 1d close | `momentum` | shadow (kept) | Portfolio tab | shadow, accruing v2 record |
| Core Momentum | `lib/stablecore*.js` | FMP in-band screen | same-close resolveTrade (levels ARE graded) | `CoreMomentum` | shadow (kept) | Today board (annotate) | visible-research |
| Momentum Ignition | `lib/ignition*.js` | **op=today funnel ONLY** | signal-close close-to-close | `Ignition` | production (kept — core backbone; proxy gate now blocks its evidence from Validated) | none (consumes Today) | actionable-conditional; discovery broadening = backlog |
| Gap & Go | `lib/gapgo.js`, routes 2508–2757 | candle caches | ORB trigger LOGGED but grader uses gap-day close ×3d (labeled proxy) | `GapGo` (ledger NOT folded into groups) | **production → shadow** (challenger cannot be production) | Today board (annotate) | visible-research / prospective challenger; intraday-bars grading = data-blocked, fails closed |
| Down-Day Bounce | `lib/downday.js`, `lib/vreversal.js` | widest cache union | signal-close ×3d; ledger already red-tape-gated | `DownDay` | production (kept) | Today board | actionable-conditional (red-tape sleeve) |
| Coil Radar | `lib/coil*.js` | per-scope caches | Stage-A close-based; **`reliability` block = the app's only executable-fill screener lane (LT2)** | `coil` | **production → shadow** (watchlist detector; Stage B unproven) | Today board (annotate) | visible-research / watchlist |
| Pattern Radar | `lib/patterns/`, `lib/pattern-routes.js` | own two-stage scan | frozen episodes, fill-aware (honest) | `Pattern` (**was missing from SECTION_TO_ID — fixed**) | shadow (kept) | none | visible-research |
| Biotech Radar | `lib/biotech*.js` | biotech + expanded caches, PIT layer | 3 lanes; badge lane assumed-filled trigger; episode lane = swing-evaluate (honest) | `Biotech` | **production → shadow** (lead-only research) | Today board (annotate) | visible-research; episode lane is the promotion venue |
| Fade / Overheated | `lib/fade-engine.js` | 3-scope caches | signal-close ×21d; borrow charged only in Scoreboard lane | `Fade` | shadow (kept) | none (posterior feeds 3 other screeners' ranks — recorded) | long-avoid filter only |
| Gap-Down | `lib/gapdown.js` | caches | OR-low trigger logged; grader close ×3d, costs NOT deducted (labeled) | `GapDown` | shadow (kept); shorts watch-only fail-closed | Today board (annotate) | watch-only until borrow + intraday execution |
| OMEGA / RLT / ORBIT(+ML) / ATLAS-X / Pre-Move / PeerProp / EVOLVE / GRIDLOCK | various | various | executable engines where present; all weight-0 | own sections | shadow (kept) | none | infrastructure + shadow research (standing no-edge verdicts unchanged) |
| AI screens (Read-Through, Anomaly, Second Wave, Cross-Asset, Tone Shift) | `lib/*-routes.js` | various | lead-only | own sections | shadow (kept) | Today board (annotate, RESEARCH-classed) | visible-research |
| Swing Supervisor / Opportunities | `lib/swing-supervisor*.js`, `lib/opportunity-density.js` | consumes op=today only | swing-evaluate (honest engine) | — | — | orchestration, not alpha | infrastructure |

Candle caches available for broad Stage-1 discovery: `candles/{large,small,micro,biotech,expanded}.json`
(expanded = full-market NASDAQ-directory universe). Ignition uses none of them (defect recorded, backlog).

## 2. Defects proven and FIXED in this pass

1. **Maturity verdicts used a pick-level beat rate projected onto a date count**
   (`lib/maturity.js:75` pre-fix): Wilson ran on `round(beatMktRate% × min(dates, picks))` —
   correlated same-day picks counted as independent evidence. → `maturity-v2`: Validated
   now requires **date-level portfolio net-excess statistics** (equal-weight per-date
   portfolio, 95% CI must exclude zero), produced by `dateLevelNetExcess` in the
   Scoreboard summarizer (`lib/apex-routes.js`).
2. **Missing sector evidence passed open** (`maturity.js:80` pre-fix:
   `beatsSector = !sectorKnown || …`). → Validated requires a sector-relative record;
   missing fails closed to Promising with an explicit reason.
3. **Validated at 20 resolved picks.** → ≥50 resolved episodes AND ≥20 KNOWN independent
   decision dates (no raw-pick fallback for the promotion grade). Disabled (protective
   demotion) deliberately stays at 20.
4. **Proxy outcomes could drive maturity** (every screener's badge fed by close-to-close,
   fill-unverified grading; all 24 contracts `fillVerified:false`). → the contract's
   `fillVerified` now gates Validated: **a fill-unverified pipeline caps at Promising**.
   This structurally enforces Phase-1 rule 8 for every strategy at once, including the
   Gap & Go requirement "label the daily-close proxy not-promotion-evidence and fail closed".
5. **An earned grade auto-converted to Production sizing clearance**
   (`lib/governance.js:82–87` pre-fix). → `gov-v2`: Production requires a reviewable,
   **version-matched promotion artifact** (`governance/promotion-artifacts.json`); absent /
   unapproved / version-mismatched ⇒ paper/probation (`awaitingPromotionArtifact: true`).
6. **Adaptive-layer policy failed OPEN** (`lib/adaptive-layers.js` v2: absent/broken doc ⇒
   `allow`; live finding in July: dualread-adapt auto-active). → v3 fail-CLOSED: default is
   **freeze** (persisted adapted state kept; nothing new adopted without an explicit human
   `allow`). Derived-flag layers (evolve strength tilt, alerts-Fable) now require explicit
   `allow` to apply a per-run re-derived promotion (a re-derivation IS an adoption). Local
   `.catch(() => 'allow')` escapes corrected.
7. **Trend Rider, Dual Confirmed and Confluence ran user-visible tabs unregistered** —
   no maturity grade, no governance route, no contract; the Dual Confirmed tab **wore the
   production Breakout evidence banner** (`public/js/evidence-badge.js` `aligned:'screener'`).
   → all three registered shadow with honest fill-unverified contracts; banner mapping fixed
   to their own identities.
8. **Contradictory production registrations** (mission item 5): Gap & Go (self-described
   unproven challenger, ledger not even folded into Scoreboard groups), Coil (abnormal-
   expansion detector, conviction rankers INVERTED vs realized R), Biotech (lead-only,
   badge lane assumes fills). → all three re-registered **shadow** with promotion criteria;
   tabs/ledgers untouched (`core:true`), annotate-mode board byte-identical.
9. **Aligned book graded a different instrument than displayed and could never re-grade a
   name** ("first appearance per ticker forever"; live-quote entry discarded for signal-day
   close; stop/target computed for the card then dropped). → book v2: episode cooldown (21
   sessions, from the contract), **next-session-open entry** (the contract's fillPolicy),
   cost-net channel (conservative `small` tier — cheap tier never assumed), displayed
   levels now logged, `signalVersion` stamped.
10. **Confluence admission accepted single-family votes**: display admitted on raw
    `bullishCount` even when all votes were one price-trend family (`singleFamily`
    computed but decorative). → a Confluence label now requires **≥2 independent evidence
    families** in both the strong and relaxed branches; single-family names keep accruing
    in the ledger as flagged observations. Honest-empty display beats fake confluence.
11. **`Pattern` missing from `SECTION_TO_ID`** — silently took the default cooldown and
    was invisible to section-resolution invariants. → mapped to `chartpattern`; a new test
    requires every registry section to resolve.
12. **No honest actionable/research separation on the served payload** (annotate mode
    ranked shadow sources on the board with only a per-card badge). → `op=today` now
    carries **`actionableByHorizon`**: per-horizon shortlists built from the boost-free
    trade-eligible-only merge — research signals can neither enter nor boost it, and when
    nothing is cleared it is honestly EMPTY (never backfilled). `topByHorizon` remains the
    full research-visible cross-section in annotate mode (back-compat byte-identical).

## 3. Suspected defects that were ALREADY FIXED (verified, not duplicated)

- Momentum v2 top-14 StockTwits universe (predictive-redesign #14) — universe is now Day
  Trade full-universe discovery ∪ screener cross-sections; social is a weight-0 annotation;
  empty universe ⇒ honestly empty board.
- Momentum contract mismatch (#15) — corrected to intraday/1d, maturity reset to shadow.
- Display/trade/sizing eligibility separation with fail-closed governance freshness and
  scoring-version reset (`lib/eligibility.js`), short-borrow fail-closed, unknown-liquidity
  conservative tier (#13).
- No-silent-horizon-substitution in maturity (H4), cost-net-first grading (H5).
- Executable-fill machinery: `lib/swing-evaluate.js` (no-fill/gap-skip/same-bar-stop),
  `lib/execution-policy.js` (exec-v1), `lib/leadtime2.js` two-stage — exist and are used by
  the supervisor/episode lanes (Biotech episodes, ATLAS-X, RLT) and Coil's `reliability`.
- Coil two-stage separation (Stage A abnormal-expansion vs Stage B trade utility) exists in
  `lib/coil-reliability.js` with censoring, trigger-no-fill, gap-beyond-max-entry; the
  registry/contract language already refuses to call Stage A a buy probability.
- Board parity hash (`boardHash`), immutable episode ledgers, PIT research spine
  (`lib/pitdata/*`, research secmaster), purged/embargoed harness, FDR in the swing
  replay (BH m=4) — all present per the July/August passes.

## 4. Verified defects left as BACKLOG (documented, not implemented here)

- **Scoreboard grader entry basis**: `forwardPath` grades `pick.entry || close` assumed-
  filled for ALL sections (incl. daytrade's section rows) — migrating every section to the
  executable engines requires regenerating shared fixtures used by the Day Trade freeze
  tests, so it is deliberately deferred; the maturity-v2 `fillVerified` gate means this
  proxy record can no longer promote anything in the meantime.
- **Ignition discovery = op=today funnel only** (`lib/ignition-routes.js:153–158`; no
  fallback universe). Broad cache-based Stage 1 (shadow until validated) is the next
  engineering block.
- **Gap & Go real intraday ORB grading** — blocked on reliable intraday history; the
  ledger is labeled daily-close proxy and is now structurally non-promotable (fail closed),
  which satisfies the mission's fail-closed branch.
- **Fade posterior feeds live ranking inputs of Trend Rider / Confluence / Down-Day
  shorts** while being learned from close-to-close grading — an incremental-validation gap.
- **Down-Day display on non-red days** — ledger is red-gated; the display path's non-red
  rows should be explicitly labeled research controls.
- **PIT spine (Phase 4) and horizon-specific challenger interfaces (Phase 5)** — the
  research-side PIT master and swing-replay-v3 exist; app-side `universeAt` remains thin;
  Sharadar decision still pending with the user. No challenger was built in this pass
  because the standing survivorship-free verdicts are negative and nothing here may
  manufacture edge.

## 5. Governance behavior — before vs after

| Concern | Before | After |
|---|---|---|
| Validated grade | 20 picks, pick-level Wilson, sector-optional, gross-fallback-guarded, proxy-fed | 50 episodes + 20 known dates + sector required + date-level portfolio CI > 0 + cost-net + **fillVerified pipeline** |
| Grade → live clearance | validated ⇒ production weight 1.0 automatically | requires a reviewable version-matched promotion artifact; else paper/probation |
| Adaptive layers | absent policy doc ⇒ allow (fail-open) | absent/invalid ⇒ **freeze**; derived-flag promotions need explicit allow |
| Unregistered screeners | 3 user-visible tabs ungoverned; one wearing another strategy's banner | registered shadow, own contracts, own banners |
| Actionable list | ranked board mixed classes; badge-only separation | `actionableByHorizon` (cleared-only, boost-free, honest-empty) + full research cross-section |
| Gap&Go/Coil/Biotech | registry production vs evidence saying otherwise | shadow, with explicit promotion criteria |

Under the default `annotate` mode the served board is **byte-identical** (regression-
tested); every change above alters evidence labels, clearances and payload lanes, not
production ranks. Flipping `DECISION_ELIGIBILITY_MODE=enforce` is now safe-by-construction
(the stricter calculation exists) and remains an explicit operator action.

## 6. Validation

- `npm test`: 3,509/3,507 → **3,542 tests / 3,540 pass / 0 fail / 2 skipped** (+33 net).
- `npm run check`: clean. `public/js/evidence-badge.js` module-parse verified.
- Day Trade: registry entry, frozen contract, `PINNED_SOURCES.daytrade`, golden/freeze
  suites all pass unchanged (`test/today-golden.test.js`, `test/rlt-daytrade-unchanged.test.js`,
  `test/daytrade-*.test.js` — untouched and green).
- New/updated suites: `test/non-daytrade-redesign.test.js` (13 tests: contract coverage,
  SECTION_TO_ID completeness, version agreement, shadow registrations, date-level stats,
  aligned episodes, actionable lane, Day Trade pin), `test/maturity.test.js`,
  `test/governance.test.js`, `test/adaptive-layers.test.js`, `test/strategy-gate.test.js`,
  `test/eligibility.test.js`, `test/registry-coverage.test.js` (updated to the corrected
  contracts, each documented in-file).

## 6b. Follow-on batch (same pass, second commit)

1. **entry-v2 grading basis** — Scoreboard sections whose CONTRACT declares a
   next-session-open fill (`screener`, `Ghost`, `momentum`, `DownDay`, `Ignition`,
   `Fade`, `CERN`) are now graded from the NEXT session's open with a basis-consistent
   benchmark (`forwardPath`/`spyForwardReturn` opt-in `entryBasis`); conditional-trigger
   contracts (gapgo/gapdown/coil) and the FROZEN daytrade section keep the legacy basis
   (default behavior byte-identical — the pinned `test/scoreboard.test.js` passes
   untouched). Response `entryModel.basisVersion: 'entry-v2'`.
2. **Enforce-mode research visibility** — `op=today` under `enforce` now also serves
   `researchByHorizon` (the full ungated ranked cross-section, RESEARCH-classed), and
   `public/js/today.js` renders the separation structurally: an "✅ Actionable —
   evidence-cleared only" section (honest-empty message when nothing is cleared) above
   the full cross-section. Flipping `DECISION_ELIGIBILITY_MODE=enforce` no longer hides
   research from view.
3. **Ignition broad shadow Stage-1** — an INDEPENDENT price/volume Stage-1 over the
   large/small/micro candle caches (same frozen scoring engine, no catalyst enrichment,
   deterministic, capped 40) rides the payload as `broadShadow` and ledgers under its own
   `BROAD_IGNITION`/`BROAD_WATCH` tiers — a separate graded record; the funnel lane and
   the broad lane never pool. Weight-0 until its own record clears promotion.
4. **Gap & Go verified intraday channel** (`lib/gapgo-verify.js`, `op=gapgoverify`,
   wired into the ticks1 warm chain) — real FMP 5-minute bars build the genuine 30-minute
   opening range and resolve the frozen contract: OR-high stop-entry only after the range
   completes, gap-through at the worse open, >5% open beyond trigger = gap-skip, OR-low
   stop, 2R target, same-bar → stop, session-close time exit, tiered cost-net R; missing
   bars fail closed (`bars-unavailable`, retried while young). Append-only
   `gapgo/verified.json`, never rewriting the proxy ledger, no verdict emitted. This is
   the record on which Gap & Go promotion will eventually be judged.
5. **Promotion artifacts** — deliberately NOT written: no strategy has earned one, and
   fabricating approvals is what gov-v2 exists to prevent. The path stays empty.

Suite after the follow-on batch: **3,552 tests / 3,550 pass / 0 fail**; `npm run check`
clean; `today.js`/`evidence-badge.js` module-parse verified.

## 6c. Backlog batch (post-merge of PR #263 — closes §4 items 1, 4 and 5)

1. **entry-v2.1 — trigger-verified Scoreboard basis for conditional contracts** (§4
   item 1, conditional half). Sections whose contract fillPolicy is
   `stop-through-trigger`/`conditional on trigger` (coil, GapDown; GapGo never enters
   the pick loop) are graded on daily bars with verified-trigger semantics: trigger
   never traded inside the horizon → **no-fill**; open beyond the ±5% chase ceiling
   (constant reused from `lib/gapgo-verify`) → **gap-skip** (terminal); open through
   the trigger → filled at the **worse open**; intra-bar touch → filled at the trigger.
   Unfilled/skipped episodes are COUNTED per group (`fills` in the payload) and
   excluded from every return array — `summarizeReturns` does raw math on `ret`, so
   averaging a never-filled plan as 0 would fabricate a return. Benchmark legs anchor
   at the verified FILL date (open for gap-through, close for intra-bar — a documented
   daily-bar approximation, NOT intraday verification; contracts stay
   `fillVerified:false` so maturity remains closed). Coil rows grade only from their
   captured `plan.entry`; rows with no plan are ungradeable (null), a decision price
   is never silently promoted to a trigger. Daytrade stays pinned to the legacy basis
   (source-pin test unchanged). `basisVersion: 'entry-v2.1'`.
2. **posterior-rank gate** (§4 item 4). The fade-engine per-ticker posterior is
   learned close-to-close (proxy) yet carried promote-direction weight in three live
   ranks — Confluence (`indepScore + 8·learnedExcess`, whose top slice the tick
   LEDGERS, i.e. the learner selected its own training data), Down-Day shorts
   (posterior as primary sort key deciding which shorts are served) and Trend Rider
   (drifted admission veto). New registry entry `posterior-rank` (shadow, criteria
   recorded) + `posteriorRankWeight()` (mirrors the confluence-marginal fail-closed
   pattern): the boost term is weight-0 until registry production AND a version-matched
   PASS artifact. AVOID-only influence survives (drifted names still sink/drop — the
   one registry-validated use of the fade learner); learnedExcess/confidence remain
   visible as annotation; `posteriorPolicy` disclosure on all three payloads. The Day
   Trade consumer keeps its literal 8× term (frozen, source-pin tested).
3. **Down-Day conditional-context enforcement + research controls** (§4 item 5).
   `fromDownDay` rows now carry `conditionGate: { required: 'red-tape', met }`
   (unknown tape fails closed) and `assessSignal` demotes any declared-but-unmet
   condition to research — the mission's "hard-gate actionable long signals to
   objectively red-market sessions", enforced at the eligibility layer. The display
   path labels every bucket's rows `researchControl` + `controlReason` on non-red
   tapes (`displayMode: 'research-controls'`), and the UI shows a 🔬 research-control
   chip per card instead of relying on banner prose.

Still open from §4: Scoreboard executable-engine migration for the remaining legacy
sections (fixture-coupled to the Day Trade freeze), Ignition intraday grading
(data-blocked), PIT spine depth / Phase-5 challengers (Sharadar decision pending with
the user — do not purchase without them).

Suite after this batch: **3,547 tests / 3,547 pass / 0 fail** (16 new in
`test/backlog-batch-2026-08.test.js`); `npm run check` clean. No model promoted; the
fade posterior's rank influence was REMOVED, not validated — abstention over
unvalidated boosts.

## 7. Empirical results

**None claimed.** This pass ran no new market experiment; the standing negative/null
verdicts (swing V3, OMEGA, momentum survivorship-free, RLT, NSL, SUE-PEAD/congress/
revisions) are unchanged and remain authoritative. Promoted: none. Demoted (registry
honesty, not performance): gapgo, coil, biotech → shadow. Everything else stays exactly
where its evidence puts it.

## 8. Decision-time & statistics batch (2026-08-04, third pass)

Re-audit of the merged redesign against the current source (every item proven at
file:line before editing; already-fixed items verified, not duplicated). Five commits,
each with regression tests; Day Trade untouched throughout (pin proofs added where a
shared engine changed). Baseline 3,562/3,560 → **3,618 tests / 3,616 pass / 0 fail**.

1. **Gap & Go decision-time repair (`gapgo-orb-verify-v2`).** The v1 verified channel
   graded the gap session's OWN opening range while the durable decision was logged
   post-close from that session's completed candle — the graded trade began ~6.5h
   before the decision existed — and the logger never persisted the frozen `take`.
   Now: EOD decision → NEXT-SESSION ORB only (`selectEntrySession` refuses same/earlier
   sessions; holes wider than weekend+holiday fail closed as `entry-session-uncertain`);
   the tick freezes `take`/`continuationScore`/`scoringVersion`/`decisionTs`/
   `dataCutoffSession` on every ledger row (`freezeGapLedgerPick`, pure); cohorts
   TAKE (only promotion-grade) / CONTROL (`take:false`) / LEGACY-NO-DECISION; v1
   episodes immutable, marked superseded, never pooled with v2 (namespaced keys +
   version filters). One scoring identity everywhere: ledger rows and the live route
   now carry the registered `gapgo-v1` (the route's stray `gapgo-pit-v2` label removed);
   the contract declares `decisionBasis`/`eligibleEntrySession`/`verifyVersion` and the
   UI plan text describes the graded next-session contract.
2. **maturity-v3 — utility-metric promotion gates.** The mandatory pick-level Wilson
   >50% beat-rate gate is removed from Validated: promotion is earned on the date-level
   cost-net portfolio CI (clear of zero), so low-hit/high-payoff strategies with real
   utility can qualify; hit rate is descriptive only; high-hit negative expectancy is
   explicitly rejected; protective disablement gains a dependence-aware route (CI
   entirely below zero). `dateLevelNetExcess` now uses Newey-West/HAC standard errors
   over the chronological date series (lags ≈ horizonBars−1 for overlapping 5/21/63-
   session labels), floored at the IID SE so the correction can only widen the gate.
3. **Evidence-cohort separation.** `gradeStrategy` selects the exact frozen policy
   cohort: registry `policyTiers` (ignition → `['IGNITION']`, WATCH is the control) and
   always-excluded `BROAD_*`/`HIST_*` research lanes, with pooled/excluded tiers
   reported in stats. Ignition's three experiments are three identities end-to-end:
   backfilled rows (`backfill:true`, previously read by nothing) reclassify to `HIST_*`
   at Scoreboard read time (ledger immutable) and are excluded from lead-time anchors;
   the broad lane adds the expanded cache, explicit price/dollar-volume/history/
   freshness eligibility, honest funnel telemetry (attempted / eligible / scored /
   excludedByReason incl. recorded-and-deduped funnel overlap / per-scope cache
   timestamps), and runs independently when op=today is dark (display + log paths,
   unified exclusion sets).
4. **gov-v2.1 — freshness, awaited writes, real artifact schema.** Governance persists
   `scoreboardGeneratedAt` + `evidenceHash` (sha256 of stable-stringified groups) and
   every consumer (eligibility + Scoreboard allocation gate) now requires BOTH the
   write time AND the evidence time to be fresh — the daily maturity cron can no longer
   launder a stale Scoreboard with a fresh `savedAt`. The governance capital-control
   write is awaited (failure ⇒ `ok:false` + `governancePersisted.error`), as is the
   summary write. `validPromotionArtifact` enforces the complete
   docs/model-promotion-policy.md schema (19 required fields incl. approver, code
   commit, dataset/universe/feature hashes, predeclared metric, cost stress,
   survivorship/PIT status, calibration, tail risk, prospective evidence, evidence
   hash, expiry; revocation honored; malformed docs rejected, never coerced) — the old
   `{approve, version}` check was a rubber stamp. No artifact was created; the path
   stays empty. Eligibility also closes the null-version fail-open hole (unversioned
   legacy governance records cannot clear a versioned strategy) and surfaces the
   three-class taxonomy `ACTIONABLE` / `QUALIFIED_LEAD` / `RESEARCH` (`signalClass`).
5. **sb-episodes-v2 — trading-session cooldowns.** Contracts declare
   `episodeCooldownSessions` in sessions but the episode engine, the Dual Confirmed
   book and the ATLAS-X staleness gate compared calendar days (a 21-session cooldown
   ≈ 15 sessions — "independent" episodes opened ~40% early, inflating the counts the
   promotion gates lean on). Gaps are now counted with `calendarSessionsBetween`; the
   FROZEN daytrade section is pinned to the legacy calendar axis and tested.
6. **UI claim sweep (17 strings).** Hard-coded "validated / proven / passes deflation /
   calibrated odds / survivorship-safe / validated track record / failure probability"
   claims contradicting the registry were replaced with evidence-honest language
   (Gap & Go, Gap-Down, Trend Rider incl. its green "Validated edge" TRUST badge, Coil,
   Core Momentum, Breakout, Today footer/tooltips, challenger notes).
   `evidence-badge.js` verified registry-driven. A source-scan test
   (`test/ui-claims.test.js`) locks the vocabulary.

**Verified but deliberately unchanged / still blocked:** row-level scoring-version
segregation inside the Scoreboard group key remains deferred (Day-Trade-coupled fixture
regeneration; mitigated by the maturity policy-cohort filter, the fillVerified gate and
the eligibility version guard — legacy-unversioned evidence can no longer clear or
promote anything); PIT universe/provider provenance (Phase 7) stays data-blocked
pending the Sharadar decision; no challenger model was fitted (standing survivorship-
free verdicts are negative — building one would be BLOCKED_DATA theater).

**Empirical results: none claimed.** No new market experiment ran. Promoted: none.
Demoted: none (registry statuses unchanged; several strategies' *evidence pools*
shrank to their honest cohorts, which can only lower future grades until earned).

## 9. Full redesign pass (2026-08-05) — enforcement, identity, episodes, experiments

Fourth pass. Thirteen phases against the current source, each verified at file:line before
editing. Day Trade untouched throughout (pinned in eligibility AND in the new score
normalizer; its intrinsic fields are asserted byte-for-byte under both modes). Baseline
3,618 tests / 3,616 pass → **3,753 tests / 3,751 pass / 0 fail**; `npm run check` clean.

**No model was promoted. No new alpha is claimed. Two experiments ran and both came back
negative or blocked.**

### 9.1 What changed

1. **Fail-closed by default** (Phase 2). `DECISION_ELIGIBILITY_MODE` now defaults to
   `enforce`; `annotate` is an explicit diagnostic override that labels itself on the
   payload. **QUALIFIED_LEAD survives end to end** — it was being collapsed into
   ACTIONABLE/RESEARCH at the payload boundary (`evidenceClass` now carries the eligibility
   verdict verbatim). The portfolio, the ensemble Book and the opportunity density are built
   from the ACTIONABLE + sizing-eligible set **in every mode**, so the diagnostic override
   can no longer size anything. Lead-only contracts can never be sized. The shadow
   comparison runs in both directions and is explicitly labeled non-actionable.
2. **Semantic promotion artifacts + the grandfather lane** (Phase 3, `gov-v3`). Artifacts
   are validated on their VALUES (`validationResults.passed`, `costStress.passed`,
   `survivorshipStatus.safe`, calibration when probabilities are displayed, prospective
   evidence, sample / effective-sample / block floors, multiple-testing correction, identity
   match, evidence-hash binding, freshness, unresolved data-quality blockers) with
   machine-readable codes. A previously-live strategy that no longer qualifies becomes
   **reduce-only** — cannot originate new positions — and **expires automatically** after 90
   days without renewed evidence.
3. **Canonical evidence identity** (Phase 4). Eleven axes; any difference is a different
   experiment; an incomplete identity is LEGACY_CONTEXT and cannot govern, calibrate or
   promote. Gap & Go v1 → v2 is the worked test case.
4. **One population, dependence-aware statistics** (Phase 5, `maturity-v4`). Every displayed
   statistic derives from one deduplicated decision-date series; HAC + seeded moving-block
   bootstrap (the reported interval is the wider); Student-t at the effective sample size
   instead of a flat 1.96; effective-sample and 4-block stability are new fail-closed gates;
   BH-FDR across attempts. Every governed core strategy declares its frozen `policyTiers`.
5. **Canonical episode ledger** (Phase 6). One schema, attrition counted by reason, leakage
   refused as `invalid-data`, unfilled plans never averaged as 0%, adapters for
   swing-evaluate / gapgo-verify / legacy Scoreboard rows, a reconciliation report — and
   **`fillVerified` is now DERIVED from resolved episodes**; a contract flag cannot grant it.
6. **Contract/evaluator reconciliation** (Phase 7). Down-Day was graded on a 5-day bucket
   while its contract claimed a 3-session red-tape window: the Scoreboard gained a `3d`
   horizon and the contract now points at it. Breakout separates `promotionMetric` from
   research horizons; Ghost is incremental-over-screener only; Coil is split into a
   non-promotable expansion detector and a promotable Stage-B trade model; Gap & Go's
   verified lane owns the same-session R label and inherits nothing from v1; options flow
   declares what the data cannot support; Pattern Radar gained a contract.
7. **Pre-ranking data gates** (Phase 8). Freshness/coverage is resolved BEFORE the merge and
   rank. A fresh `generatedAt` over a stale information cutoff no longer passes. Blocked
   sources cannot originate a new entry; their names stay visible as MONITOR / HOLD /
   INVALIDATED / DATA_STALE with a degraded-data banner.
8. **Score comparability** (Phase 9). Within-source percentiles (or neutral shrink when the
   cross-section is too thin), frozen source priors, and an explicit merge model with
   dependence discounts, decay and a hard cap replacing `Math.max(rawConfidence)`. The
   historical rank tilt now reads the COST-NET record. Lead-only rows carry an execution-
   uncertainty penalty. Every row exposes its score decomposition.
9. **Three-lane UI** (Phase 10). EXECUTABLE IDEAS / QUALIFIED LEADS / RESEARCH WATCHLIST as
   structural sections, a plain-language "not actionable because…" line from the reason
   codes, novice enter/wait/hold guidance with the invalidation, and a collapsed expert
   panel with the decomposition and an explicit "no calibrated probability is shown".
10. **Experiments + registry** (Phases 11–12) and the **safe learning loop** (Phase 13):
    automatic demotion allowed, automatic promotion structurally impossible.

### 9.2 Empirical results (the only numbers claimed)

**A — Down-Day exact contract** (`research/66-downday-exact-contract.js`). 1,200 names,
256 red-tape sessions (2022-07-22 → 2026-06-26), 22,027 flagged bounce episodes vs 90,358
matched same-date same-liquidity-band controls, next-open entry, 3 sessions, cost-net.

| metric | result |
|---|---|
| flagged, cost-net excess vs SPY | **−0.29%** (254 dates, eff 193, 95% CI [−0.48, −0.11]) |
| flagged, doubled / stressed costs | −0.45% / −0.61% |
| flagged, vs same-sector cohort | −0.20% (CI [−0.30, −0.10]) |
| matched controls | −0.25% (CI [−0.39, −0.11]) |
| **lift vs matched controls (primary)** | **−0.04%** (254 dates, eff 254, CI [−0.16, +0.08]), 0/4 positive blocks |
| holdout (final 25% of dates) | −0.03% (64 dates) |
| p / q(BH) | 0.52 / 0.52 |

**Verdict: NOT CONFIRMED.** The Down-Day bounce carried the app's most credible conditional
evidence; measured on its OWN contract against matched controls it has no lift. The
strategy's negative absolute number is mostly a red-day universe effect (the controls are
negative too) — the honest reading is *no selection edge*, not *a bad strategy*.

**B — Gap & Go v2** (`research/67-gapgo-orb-v2.js`). 11,264 EOD gap decisions found; the
shipped resolver could grade **12** of them, because the local 5-minute cache is keyed by
event day and 11,252 decisions have no bars for the exact next session (178 more had an
uncertain entry session). **Verdict: BLOCKED_DATA.** Nothing imputed, nothing concluded; the
live `op=gapgoverify` channel is the only path that accrues this record.

**C — Unified swing baseline tournament** (`research/68-swing-baseline-tournament.js`).
900 names, 193 decision dates (2022-07 → 2026-06), 21 sessions, top-10, next-open entry,
identical eligibility and costs for every entrant. Harness verified by a within-date
shuffled-label placebo (rank IC **−0.003** ≈ 0).

| entrant | rank IC | cost-net top-10 excess (95% CI) | 2× cost | 3× cost | hit | turnover | q(BH) |
|---|---|---|---|---|---|---|---|
| production | +0.016 | **+0.04%** [−1.94, +1.76] | −0.26% | −0.56% | 45.2% | 0.37 | 0.96 |
| sectorRelative | +0.015 | +1.05% [−1.96, +3.78] | +0.74% | +0.42% | 46.1% | 0.22 | 0.59 |
| marketRelative | +0.014 | +0.86% [−2.08, +3.62] | +0.55% | +0.24% | 45.5% | 0.22 | 0.59 |
| simpleMomentum | +0.014 | +0.86% [−2.08, +3.62] | +0.55% | +0.24% | 45.5% | 0.22 | 0.59 |
| breakout ladder | +0.006 | −1.00% [−1.72, −0.35] | −1.30% | −1.61% | 45.4% | 0.86 | 0.009 |
| ghost overlay | +0.014 | −1.03% [−1.89, −0.06] | −1.34% | −1.65% | 45.4% | 0.88 | 0.042 |
| coil-triggered | +0.028 | −1.34% [−2.17, −0.47] | −1.64% | −1.94% | 40.4% | 0.35 | 0.008 |
| equal-weight eligible | n/a | −0.91% [−1.41, −0.45] | −1.24% | −1.58% | 44.6% | 0.01 | 0.001 |
| seeded random | +0.001 | −0.78% [−1.50, −0.10] | −1.12% | −1.45% | 45.8% | 0.99 | 0.043 |
| placebo (shuffled label) | −0.003 | −0.88% | — | — | 43.9% | 0.37 | 0.042 |

**Incremental value of the production score over the best simple baseline
(sector-relative): −1.01%, CI [−2.68, +0.69] over 193 dates.**

**Verdict: NO ENTRANT DEMONSTRATES DURABLE COST-NET EDGE.** Read honestly:
- the production composite is indistinguishable from zero and from a simple momentum rank;
- the Breakout ladder, the Ghost overlay and the Coil-triggered subset are *significantly
  negative* cost-net as RANKERS — consistent with their new contract roles (candidate
  generation, overlay, expansion detector), not with ranking alpha;
- the whole eligible cohort underperformed SPY at 21 sessions in this window
  (equal-weight −0.91%), so several negatives are partly a universe effect — which is why
  the *lift versus baselines on identical dates* is the metric that matters;
- the placebo is clean, so these negatives are the harness working, not a bug.

**D — Analyst revision breadth/acceleration** (`research/69-revision-breadth-gate.js`): the
frozen design is declared, the gate is implemented, and it **refuses to run** — estimates
remain PIT_UNPROVEN. The question is unanswered, not answered "no".

### 9.3 Promotions, demotions, unchanged

- **Promoted: none.** No promotion artifact exists; the path is still empty.
- **Demoted: none by status.** Several strategies' evidence pools shrank to honest cohorts
  (frozen `policyTiers`), Down-Day's grade will now be read from the `3d` bucket it actually
  claims, and `fillVerified` is derived — so every pipeline currently reports *no verified
  fills*, which caps every strategy at Promising until a canonical ledger is reduced.
- **Unchanged: Day Trade**, byte-for-byte.

### 9.4 Still blocked

Survivorship is reduced, not eliminated (no PIT constituents) · no PIT sector history · no
next-session intraday archive (Gap & Go v2) · estimates PIT_UNPROVEN (Experiment D) · no
borrow feed (shorts stay watch-only) · no pairwise ticker correlation matrix · the legacy
Scoreboard sections still grade on a proxy basis (Day-Trade-fixture-coupled), which the
derived `fillVerified` gate now neutralizes for promotion purposes.
