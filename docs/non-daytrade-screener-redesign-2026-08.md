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
