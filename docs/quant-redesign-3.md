# Quant Redesign 3 — Fail-Closed Governance Pass

Proof-first redesign of the screener/allocation governance layer (2026-07-25).
Companion to `docs/quant-system-audit.md`, `docs/quant-redesign.md`, `docs/quant-redesign-2.md`,
`docs/validation-protocol.md`, `docs/model-promotion-policy.md`.

> **Reality constraint (unchanged).** Nothing here claims new alpha. This pass makes the
> app's *controls* honest: what may originate a live pick, what earns sizing, what a
> number is allowed to be called. Backtests here remain survivorship-unsafe pending real
> PIT constituents/delisting data (the standing external blocker), so **no strategy was
> promoted** — the redesign is fail-closed plumbing + measurement honesty, feature-gated.

Baseline at start: `node --test` **2408 pass / 0 fail**, `main` @ `f7fd6fb`, clean tree.
End state: **2435 pass / 0 fail** (26 new tests + 1 fixture module), `npm run check` clean.

---

## 1. Audit — all 17 hypotheses adjudicated

| # | Hypothesis | Verdict | Key evidence (pre-fix) | Consequence | Action |
|---|---|---|---|---|---|
| 1 | Omitted `maturity` defaults to production | **CONFIRMED** | `strategy-gate.js:28` `DEFAULT_STATUS='production'`; 26/34 registry entries had no maturity, incl. all 10 "Research Lab until Validated" overlays | doing nothing granted live-trade eligibility | default flipped to `shadow`; every entry now EXPLICIT; test inverted |
| 2 | Today engine imports sources without central governance | **CONFIRMED** | only 1 of 11 adapters gated (`decision-normalizers.js:313`, optionsflow); `coremo` was UNREGISTERED yet live | shadow/ungoverned sources could originate & boost live picks | central `lib/eligibility.js` gate in `buildToday` (annotate default / enforce flag) |
| 3 | Health/router is shadow-only | **CONFIRMED** | `router/latest.json` written & read only by itself; `decision.js` & allocation never consult it | recommended weights control nothing | binding `computeStrategyBudgets` + allocation `routerCaps`, gated on `bindingReady` |
| 4 | Maturity uses generic horizons, not trade contracts | **CONFIRMED** | `maturity.js:35` generic map + **silent substitution** `g.horizons[metric] \|\| ['1m'] \|\| ['5d']` | strategies graded on the wrong horizon with no flag | `lib/strategy-contracts.js` metric per strategy; substitution removed (strict) |
| 5 | Promotion uses gross excess + raw pick counts | **CONFIRMED** | `maturity.js:43-68` read only gross fields; Wilson over `excessN` picks; net fields existed but unread | cost-eaten edges could reach Validated; same-day picks inflated significance | grades now prefer `avgNetExcess`/`netBeatMktRate`; Wilson over distinct `dates` |
| 6 | Intended entries treated as filled | **CONFIRMED** | `forwardReturn` uses `pick.entry` with no fill check; realistic next-open channel gated to `!p.entry` picks only | unreachable entries book wins | next-open `real*` channel now computed for EVERY pick; basis labeled; full fill-verification remains research-side (`execution-policy.js`) |
| 7 | Scoring version never reaches governance | **CONFIRMED** | `governance.js:65` guard live but `gradeStrategy` emitted no `version`; registry had none | version resets could never fire (e.g. daytrade-v2 didn't reset) | registry `scoringVersion` → `maturity` → governance; guard now live |
| 8 | Missing governance ⇒ full allocation clearance | **CONFIRMED** | `allocation.js:174` `: 1` fallback; `apex-routes` swallowed staleness | ungoverned sleeves deployed at 100% | fail-closed: ungoverned/stale ⇒ clearance 0; legacy `govDefault=1` escape for comparison only |
| 9 | Missing liquidity ⇒ cheapest cost tier / neutral | **CONFIRMED** | `decision-costs.js:57` unknown ⇒ 'liquid' (9× cheaper than micro); `decision.js:199` neutral | unknown data got the cheapest assumption | rank left byte-stable (flag-gated live surface); eligibility now makes unknown-liquidity **not sizable**; coremo marketCap-as-dollarVol bug fixed |
| 10 | Missing targets avoid cost penalties | **CONFIRMED** | `costModel` ⇒ `penalty:1` with no target; same exemption in remaining-edge | omitting a target doubled the cost multiplier | plan-incomplete ⇒ not `sizingEligible`; density now built from qualifying names only |
| 11 | Target-distance-after-costs called "expected edge" | **CONFIRMED** | `expectedBestEdgeAfterCostsPct`, "best net edge" UI, log key `expectedBestEdgePct` | geometry masqueraded as expectancy | renamed `bestNetTargetMovePct` end-to-end (lib, log row, UI); prose disclaims expectancy |
| 12 | Live rank driven by native confidence | **CONFIRMED** | rank = rawConfidence(0-100, 100× range) × bounded multipliers; history tilt realistically ±15%, order-preserving within a screener | history cannot overturn native-score gaps | documented; expected-utility ranking deferred until calibrated probabilities exist (no fabrication) |
| 13 | Router lacks calibration + rank-IC inputs | **CONFIRMED** | `calibration: null` hardcoded; nulls became constants 0.5×0.8×0.7 that cancel after normalisation | "conservative multipliers" were decorative | budgets use STRICT inputs — unmeasured ⇒ 0 + `bindingReady:false`; binding is impossible on placeholders |
| 14 | Screeners are correlated price reinterpretations | **PARTIAL** | 10 sources map to priceTrend; measured redundancy IS live in the rank; but merge path collapses family counts, and `trend-core` engine list had drifted | second votes over-credited in edge cases | `PRICE_TREND_ENGINES` aligned + guard test; family caps in budgets; deeper merge-path fix documented, deferred (rank-affecting) |
| 15 | Scoreboard keeps first ticker/tier occurrence forever | **CONFIRMED** | `section:tier:ticker` first-appearance across ALL history, ×21 ledgers | recurring setups undercounted forever | `lib/scoreboard-episodes.js` cooldown episodes (contract-driven); `?dedup=first` legacy |
| 16 | Maturity/governance not refreshed by warm chain | **CONFIRMED** | `op=maturity` in NO chain; governance/latest.json written only on human tab-open | a live capital control updated only by chance | `maturity` root chain added (daily) |
| 17 | Shorts evaluated without borrow | **CONFIRMED** | gapdown gate unsatisfiable + the only one; downday fades/vreversal/fade-engine shorts had zero borrow treatment; scoreboard shorts graded gross of borrow | short edges flattered | net channel charges tier-prior borrow on shorts; eligibility fails ALL borrow-required shorts closed w/o an observed feed |

## 2. What was already built (verified, not duplicated)

Execution policy (next-open/gap-through/no-fill), triple-barrier labels, purged+embargoed
walk-forward with exact label-end purge, uniqueness weighting, DSR, OOF calibration,
measured redundancy live in the rank, prediction contract (rank ≠ probability),
coil executable split, gap-down WATCH-ONLY tab gate, immutable ledgers/provenance,
research schemas + experiment manifest machinery, champion/challenger promotion policy.
This pass deliberately reused all of it.

## 3. Architecture implemented (Phase 4, feature-gated)

**Central eligibility** — `lib/eligibility.js`, wired in `buildToday`:
`displayEligible` (always true — badges, not hiding) ≠ `tradeEligible`
(EXPLICIT static production **and** earned, fresh (≤7d), version-matched governance
clearance) ≠ `sizingEligible`/`sizingWeight` (adds plan-completeness + known liquidity;
weight = governance status ladder). Shorts requiring borrow fail closed without an
observed feed. Unregistered/unknown anything ⇒ zero live influence.

**Modes** (`DECISION_ELIGIBILITY_MODE`): `off` (legacy) · **`annotate` (default)** — board
byte-identical, every signal carries its verdict, payload carries the
`governanceGate.shadowComparison` (current vs enforced top-10, exclusions + reasons) —
this is the required pre-enable shadow report · `enforce` — non-eligible sources are
excluded BEFORE the merge (cannot originate or boost), exclusions reported, and the
research cross-section stays UNGATED (selection-bias guard, tested).

**Day Trade frozen** — `daytrade` is pinned inside the gate to its existing behavior
(static production only); golden tests prove rows byte-identical to the pre-redesign
baseline in both annotate and enforce modes.

**Contracts** — `lib/strategy-contracts.js` (contracts-v1): per-strategy trigger/fill/
exits/benchmark/cost+borrow policy/episode cooldown/primary label/promotion bar.
Consumed by maturity (metric), scoreboard episodes (cooldown), eligibility (borrow).

**Governance loop** — registry `scoringVersion` → maturity → governance version-reset
guard (now live); `op=maturity` on the daily warm chain; allocation fail-closed on
missing/stale governance; router budgets (strict inputs, cap-only, family caps, cash
absorbs) persisted and consumed by allocation ONLY when `bindingReady`.

## 4. Baseline vs proposed (identical decisions, frozen fixture)

Golden fixture: `test/fixtures/today-sources.js` (all 11 sources).
`today-golden-baseline.json` = immutable pre-redesign control; `today-golden.json` = current.

| Surface | Baseline | Proposed (default annotate) | Diff |
|---|---|---|---|
| Signal count / ranks / scores | 18 signals, top-10 | identical | **none** |
| Day Trade rows | 2 rows | byte-identical (tested) | **none** |
| Opportunity density day-score | 77.8 | 75.9 | non-qualifying leads no longer lift density |
| Payload | — | + `eligibility` per signal, + `governanceGate` report | additive |
| Under `enforce`, no governance state | 18 signals | 2 (the pinned Day Trade rows) | fail-closed, reported not silent |
| Under `enforce`, governance cleared (screener+gapgo) | 18 | production+cleared+pinned only; shadow sources absent from `sources` of every row | tested |

## 5. Strategy status (registry, explicit; grades stay EARNED at runtime)

production (static; still needs earned governance to trade under enforce):
`screener, momentum, ghost, gapgo, daytrade (frozen), coil (watchlist contract), custom,
biotech, downday (red-tape sleeve; shorts borrow-gated), ignition`.
shadow (explicit; was implicit production): `fade (avoid-filter only), gapdown, events/CERN,
readthrough, anomaly, secondwave, crossasset, toneshift, tone, attention` + newly registered
`coremo`. Already shadow: `xalerts, challenger-decision, orbit, orbit-ml, omega, atlasx,
optionsflow, putsell`. Informational surfaces: never sized.
**No promotions were made anywhere in this pass — proof gates did not pass, so nothing earned one.**

## 6. Self-learning cadence (existing loop, now with honest inputs)

Daily: warm chain — ledgers/track → episodes-based scoreboard → `op=maturity`
(governance refresh, version guard) → router (budgets, still non-binding) → research
grading. Weekly/monthly/quarterly remain per `docs/validation-protocol.md` +
`docs/model-promotion-policy.md`: automatic demotion allowed, promotion only by explicit
review; challengers stay shadow until they beat baselines on identical purged folds.

## 7. Changed files

New: `lib/eligibility.js`, `lib/strategy-contracts.js`, `lib/scoreboard-episodes.js`,
`scripts/capture-today-golden.js`, `test/eligibility.test.js`, `test/today-golden.test.js`,
`test/fixtures/{today-sources.js, today-golden.json, today-golden-baseline.json}`,
`research/experiments/quant-redesign-3-manifest.json`, this doc.
Modified: `lib/{strategy-registry, strategy-gate, decision-routes, decision-normalizers,
maturity, apex-routes, allocation, algo-router, algo-router-routes, opportunity-density,
trend-core, warm-chains}.js`, `public/js/today.js`, tests
`{strategy-gate, allocation, opportunity-density, algo-router, trend-core, map-limit}.test.js`.

Two pre-existing tests were UPDATED because they asserted the audited defects themselves
(omitted-maturity⇒production; ungoverned-sleeve⇒full clearance); each replacement asserts
the fail-closed contract plus a legacy-mode equivalent. No test was weakened or deleted.

## 8. Remaining limitations (unchanged, restated honestly)

- **Survivorship**: backtests replay present-day lists; `?pit=1` de-survivorships
  large-cap only. THE blocker for any promotion. External data required.
- **Borrow**: no observed borrow/locate feed — all borrow-required shorts stay
  research/watch (fail-closed by design, not fixed by modeling).
- **Fill verification**: scoreboard grading still assumes the logged level/next open;
  true trigger-verified fills live only in the research/shadow sleeves.
- **Calibration/rank-IC**: no per-pick probabilities on the live ledger → router budgets
  fail closed to 0 (`bindingReady:false`); expected-utility ranking stays deferred.
- **Prospective sample**: enforcement gates on earned governance; most strategies are
  paper until their ledgers mature — under enforce the app deliberately recommends less.
