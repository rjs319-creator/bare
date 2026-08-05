# Evidence & Promotion Architecture

How this app decides that something is worth acting on — and, more often, that it is not.
Companion to `docs/model-promotion-policy.md` (the policy), `docs/validation-protocol.md`
(the statistics) and `docs/non-daytrade-signal-inventory.md` (the generated matrix).

**Day Trade is out of scope and frozen.** It is pinned in `lib/eligibility.js` and
`lib/score-normalize.js`, excluded from the pre-ranking data gate, and covered by
byte-for-byte regression fixtures.

---

## 1. Five different things, never conflated

The single most expensive mistake a system like this makes is letting one of these stand in
for another. Every layer below exists to keep them apart.

| Claim | What proves it | Where it lives |
|---|---|---|
| **Software correctness** | the test suite passes | `npm test` |
| **Historical association** | a pattern appears in past data | research artifacts |
| **Out-of-sample predictive evidence** | purged/embargoed walk-forward, corrected for the number of attempts | `research/lib/experiment-kit.js` |
| **Executable cost-net performance** | real fills, real friction, honest no-fills | `lib/episode-ledger.js` |
| **Prospective validation** | it kept working after we said it would | live ledgers + `prospectiveEvidence` |

A green test suite is evidence about the code. It is never evidence about the market.

## 2. The three-class safety taxonomy

Every signal on the board carries exactly one class, preserved end to end (`signalClass` in
`lib/eligibility.js`, `evidenceClass` on the payload, its own UI lane):

- **ACTIONABLE** — current governance clearance, exact current strategy/evidence version, a
  complete executable plan, known liquidity, fresh required data, valid execution contract,
  positive allowed sizing weight. *The only class that can be sized.*
- **QUALIFIED_LEAD** — evidence-cleared, but something needed to size it is missing (no
  complete plan, unknown liquidity, or a lead-only contract). *Watch, do not size.* It is
  never folded into ACTIONABLE and never demoted to RESEARCH.
- **RESEARCH** — shadow, unvalidated, stale, version-mismatched, out-of-context, or failed.
  Visible and graded; structurally unable to originate, size, boost or count.

**Enforcement is the default.** `DECISION_ELIGIBILITY_MODE` defaults to `enforce`;
`annotate` is an explicit diagnostic override that says so on the payload, and even under
it the portfolio, the ensemble Book and the opportunity density are built from the
ACTIONABLE + sizing-eligible set only.

## 3. The pipeline

```
source payloads
  → PRE-RANKING DATA GATES        lib/data-gates.js
      required bar for the horizon · information cutoff · universe coverage ·
      reference feeds (sector/benchmark) · liquidity coverage
      a failure ⇒ the source may not originate a NEW entry; its names stay visible as
      MONITOR / HOLD / INVALIDATED / DATA_STALE
  → SCORE COMPARABILITY           lib/score-normalize.js
      within-source percentile (or neutral shrink when the cross-section is too thin) ·
      frozen source priors · dependence-discounted, decaying, CAPPED merge · missingness
  → MERGE + RANK                  lib/decision.js
      cost-net expectancy tilt · regime fit · execution quality · evidence breadth ·
      cost penalty charged once · full score decomposition
  → ELIGIBILITY                   lib/eligibility.js
      static maturity · earned governance · version match · borrow · conditional context ·
      lead-only · reduce-only · plan + liquidity ⇒ the three classes
  → SIZING SET                    lib/decision-routes.js
      portfolio · ensemble Book · opportunity density — ACTIONABLE only, in every mode
  → EPISODES                      lib/episode-ledger.js
      one canonical executable episode; attrition counted by reason
  → STATISTICS                    lib/evidence-stats.js
      one deduplicated date series → HAC · block bootstrap · effective sample size ·
      block stability · FDR
  → GRADE                         lib/maturity.js
  → CLEARANCE                     lib/governance.js + lib/promotion-artifact.js
  → LEARNING                      lib/champion-challenger.js
```

## 4. Evidence identity — the anti-transfer rule

`lib/evidence-identity.js` keys every record on **eleven axes**: strategyId, scoringVersion,
side, policyTier, scope, horizon, metric, executionPolicyVersion, labelVersion,
benchmarkVersion, cohortVersion.

- Any axis differing ⇒ a **different experiment**. Old evidence cannot validate a changed
  algorithm; a proxy label cannot approve an executable-label strategy; long and short never
  merge; Gap & Go v1 cannot promote v2.
- An identity missing any required axis is **LEGACY_CONTEXT**: viewable as history, refused
  by governance, calibration and promotion.

## 5. Grade vs clearance vs status — three different sentences

- **Maturity grade** (`lib/maturity.js`) answers *how much should I trust this?* It is
  earned from the strategy's own frozen policy cohort on cost-net, date-level, dependence-
  aware statistics with a derived fill-verification requirement.
- **Governance clearance** (`lib/governance.js`) answers *what may it do right now?* An
  earned grade is necessary and **not sufficient**: production requires a complete,
  semantically valid, identity-matched, unexpired, human-approved artifact.
- **Registry maturity** is an *operational* fact — "this runs live" — and must never be
  displayed as earned validation. The three lifecycle classes keep them apart:
  `LEGACY_OPERATIONAL`, `RESEARCH_PROMISING`, `VALIDATED_EXECUTABLE`.

### The grandfather lane

A strategy that is live by history but no longer qualifies becomes **reduce-only**: it may
manage existing exposure, may **not** originate a new position, and **expires
automatically** to paper after 90 days without renewed evidence. The safe outcome needs no
human action; only restoration does.

## 6. Semantic promotion artifacts

`lib/promotion-artifact.js` reads **values**, not keys. An artifact fails when:

`validationResults.passed !== true` · `costStress.passed !== true` (or doubled/stressed nets
≤ 0) · `survivorshipStatus.safe !== true` · calibration not passed while probabilities are
displayed · no prospective evidence · sample < 50 · effective sample < 20 · fewer than 3
positive blocks · not multiple-testing corrected · corrected p > alpha · CI includes zero ·
`approve` is not boolean `true` · any known identity axis mismatched or unstated · evidence
hash mismatched · expired, stale (>120 days), or out-of-order timestamps · any unresolved
data-quality blocker.

Every failure returns a machine-readable code. **No artifact exists in this repository. The
path is empty on purpose** — fabricating approvals is precisely what this layer prevents.

## 7. Statistics: one population, dependence-aware

- One **deduplicated decision-date series** — same-day picks are one equal-weight portfolio
  observation, because they share the market factor.
- **HAC (Newey–West)** standard errors, floored at the IID SE (a correction may only widen).
- A **seeded moving-block bootstrap**; the reported interval is the *wider* of it and the
  Student-t interval.
- **Student-t critical values at the effective sample size** — not a flat 1.96, which is
  ~15% too narrow at n≈6.
- **Effective sample size** and **4-block chronological stability** are separate gates.
- **Benjamini–Hochberg FDR** across every attempted strategy, not per test.

## 8. Episodes and honest attrition

One schema (`episode-v1`) carries identity, decision and information-cutoff timestamps,
expected vs actual entry session, fill status (`filled` / `no-fill` / `gap-skip` /
`invalid-data` / `pending`), entry price and source, spread/slippage assumptions, stop /
target / time exit, actual exit reason and price, borrow availability and cost, transaction
costs, benchmark and sector legs, delisting and corporate-action handling, missing-history
resolution, gross and cost-net outcomes, lineage and evaluator version.

- **`fillVerified` is derived**, never declared: a contract flag cannot grant it.
- An unfilled plan is **never** averaged in as a 0% return.
- Leakage (entry ≤ decision, cutoff after decision, a substituted entry session) becomes
  `invalid-data`, counted — never quietly graded.

## 9. The learning loop

`lib/champion-challenger.js`: the champion is frozen while champion; challengers run in
shadow on the identical opportunity set; seven drift monitors (calibration, rank IC,
cost-net utility, coverage, turnover, missingness, regime stability) can **demote
automatically**; the only promotion outcome the function can emit is
`REQUIRES_HUMAN_APPROVAL`. Rejected challengers are retained as negative controls. Weight
changes are inert, versioned, exactly reversible proposals.

## 10. Experiments and the registry

Every attempt — winners and losers — is recorded in `research/experiments/registry.json`
with its hypothesis, frozen configuration, data snapshot, code version, test dates, number
of variations attempted, result, corrected significance, cost stress, decision and reason.
It is committed (unlike `research/data/`) so a rejected idea cannot be quietly rediscovered.

## 11. What is still blocked

| Blocker | Consequence |
|---|---|
| Survivorship is **reduced, not eliminated** (delisted names present, series simply end) | no research run on this cache may promote anything |
| No point-in-time sector/constituent history | sector controls are same-date equal-weight cohorts, labeled as such |
| Estimate revisions are **PIT_UNPROVEN** | Experiment D refuses to run; revisions may not enter live rank or promotion |
| No next-session intraday archive | Gap & Go v2 is `BLOCKED_DATA` offline; only the live verified channel can accrue it |
| No borrow/locate feed | every short is research/watch-only, fail-closed |
| No pairwise ticker correlation matrix | concentration is proxied by sector and archetype, and says so |

## 12. What would have to be true to promote anything

1. A canonical episode ledger for the strategy with **derived** verified fills.
2. ≥50 resolved episodes over ≥20 decision dates, ≥12 *effective* dates.
3. Cost-net date-level CI clear of zero, positive in ≥3 of 4 chronological blocks.
4. Survives doubled and stressed costs.
5. Beats its declared baseline **incrementally** on identical dates.
6. Survives FDR across everything attempted.
7. Prospective (paper/shadow) confirmation.
8. Survivorship-safe data.
9. A complete, semantically valid, identity-matched artifact — approved by a human.

Nine conditions. Today, **zero strategies meet them**, and the app says so everywhere.
