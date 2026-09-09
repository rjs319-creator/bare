# system-design — can a swarm-agent system earn `validated` here? (2026-09-09)

Worktree /Users/ravishah/mna-alpha @ f5a778e. Read-only. Prior pass: docs/alpha/ALPHA-SWARM-2026-09-09.md.

## 0. What "reliable" has to mean in THIS app

Not "the agents are smart" — "the app's own governance would clear it and keep clearing it." Concretely:
1. **Prospective, contract-graded evidence** at a frozen horizon/side/cost basis (lib/strategy-contracts.js:21-29 `PROMOTION_REQUIREMENTS`: 50 resolved episodes, 20 independent dates, cost-net, incremental over baseline, CI excludes zero, regime-robust, prospective confirmation).
2. **Fail-closed on every data gap** (missing governance = stale = no clearance, lib/eligibility.js:67,72,120-125; adaptive layers default FREEZE, lib/adaptive-layers.js:66,132).
3. **Reproducible decisions**: model id + prompt version + input fingerprint stamped on every record (precedent lib/evidence-extract.js:66,141 `newsFingerprint` / `extractor:{model,promptVersion}`), and a `scoringVersion` bump resets evidence (strategy-contracts.js:9-10).
4. **Weight only via a promotion artifact** with the evidence hash (lib/governance.js:30-45,59-68; apex-routes.js persists `evidenceHash`).
5. **Cost- and time-bounded** inside the platform (12-function cap → every op lives in api/tracker.js; cron 22:00 UTC, tracker 300s/3009MB, vercel.json; chain deadline 240s, lib/warm-chains.js:58).

## 1. The gates a new strategy must clear (file:line)

| Gate | Where | Value |
|---|---|---|
| Leave `experimental` | lib/maturity.js:31 `MIN_PROMISING` | ≥8 benchmarked resolved |
| Positive vs SPY AND vs sector (net) | maturity.js:219-220, 255-261 | sector record required; missing sector fails closed |
| Resolved episodes | maturity.js:34, 262 | ≥50 |
| Independent decision dates (known, no pick fallback) | maturity.js:35, 265-268 | ≥20 |
| Date-level cost-net CI95 excludes zero | maturity.js:271-279 | HAC/bootstrap dateNet |
| Effective dates after autocorrelation | maturity.js:39, 281 | ≥12 |
| Chronological block stability | maturity.js:40, 288 | ≥3 of 4 blocks positive |
| **Executable-fill verification** | maturity.js:293; strategy-registry.js:356-381 `PROMOTION_CEILING`; episode-ledger.js:59,163 `deriveFillVerified` (≥20 resolved, ALL bases in VERIFIED_FILL_BASES) | derived from canonical episodes only — screener's op=swingverify (5-min bars, lib/screener-verify.js:73-83) is the ONLY live pipeline; daily-bar next-open is REJECTED |
| Ungradeable share | maturity.js:45 | ≤5% no-history picks |
| Declared incremental value | maturity.js:81-96 (criteria text), contract `incrementalOverBaseline` | must be MEASURED and CLEARED, not just declared |
| Prosecution (leak/concentration) | maturity.js:132-153 `prosecuteRecord` → lib/cfl/prosecutor.js:85 (excision 5/10/20, concentration) | REJECTED blocks |
| FDR across the registry | maturity.js:47, 589-607 | BH α 0.05 over every graded strategy; demote-only |
| PBO (CSCV) | lib/research/pbo.js; consumed by lib/challenger-eval.js:17-35,223-249 | applied to multi-variant selections |
| Governance clearance | lib/governance.js:88-96 status ladder; eligibility.js:153-162 | weight >0 only at production/reduced/probation, artifact-backed |
| Preregistration | research/lib/experiment-kit.js:157 `recordExperiment` (frozenConfig, variationsAttempted, holdoutFraction, BH over the reported family, costStress, immutable artifact sha256); lib/research/evidence-log.js:107 `registerHoldout` | the shape every study already uses |
| Graveyard check | lib/research/hypothesis-registry.js:8-33 | a `no-edge` id cannot be re-run as new |

Time floor implied by the gates: ≥20 independent decision dates with ≥12 effective and 4 usable blocks ⇒ **~4-6 months of daily decisions** before any grade above `promising`, regardless of how good the agents are. Nothing shortens that; it is the point.

## 2. Three architectures

### A. Agent-as-picker (LLM proposes trades; ledger grades)
- Daily: Fable reads the screener cross-sections / news, emits ≤N picks with entry/stop/target; logged to a new section; graded by the Scoreboard like any pick. Frozen: prompt version, model, universe, contract (5d or 1m). Look-ahead: only decision-time inputs (candle cache asOf, news fingerprint) — the same discipline api/picks.js and the AI screeners use.
- Reuse: api/picks.js (`picks` registered 2026-08-13), lib/crossasset/anomaly/secondwave/readthrough/toneshift (Sonnet-5 + web_search), lib/evidence-thesis (thesis), lib/bearcase.js, lib/gameplan-reflection.js.
- **This is the architecture the app already ran five times.** Prod maturity 2026-09-09: thesis n=52 avg −6.10% CI [−19.95, −2.27] 0/4 blocks; secondwave n=70 −3.32%; readthrough n=6 −16.3%; tone/toneshift n≤4; crossasset +3.44% but +0.17% vs sector and Weak tier > Lead (sector beta); picks n=0 after a month registered. Zero of five positive after sector control.
- Gates it can never clear as designed: fill verification (no canonical episode stream; lead-only contracts), incremental value over the mechanical baseline (undeclared), and the FDR family now includes every agent variant.
- Cost: ~3 calls/day × (15k in + 3k out) ≈ $0.9/day ≈ **$30-60/month** at Fable 5.1. Cheap, and that is the trap — cheap to run, expensive in false hope. Verdict window ≥4-6 months per variant.
- Score: gates 2/10 reachable, data access full, cost low. **Reject.**

### B. Agent-as-hypothesis-factory (LLM proposes falsifiable rules → app harness tests → preregistered prospective ledger)
- Daily/weekly: agents read the graveyard (hypothesis-registry) + research/results + the scoreboard cells, write ONE preregistered hypothesis each in the `recordExperiment` shape (frozenConfig, primaryMetric, holdoutFraction 0.25, variationsAttempted counted honestly), the harness runs it (lib/research/harness-v3.js:241 `runExperimentV3` with purge/embargo :59, BH with the FULL denominator :164, promotion gate :183; PBO via lib/research/pbo.js; prosecutor for excision/concentration), the artifact is written immutably, the registry gets the entry. A survivor becomes a new registry strategy with `scoringVersion`, a frozen normalizer, and a prospective ledger — i.e. it re-enters the standard 4-6-month path.
- Frozen: harness, cost model, universe manifest, holdout seal (`registerHoldout`). Agents never touch the scorer after preregistration; the only agent output is the hypothesis JSON + the rule code, reviewed by a second agent for leakage (the app's own "tests that couldn't fail" pattern is the risk to check).
- Look-ahead: harness-owned (purged CV, embargo, PIT candle cache, survivorship manifest); the agent cannot bypass it because it does not run the numbers.
- Reuse: everything above + research/experiments/registry.json (55 entries), lib/cfl/* (funnel, forecastability, null-calibration), lib/research/label-purge.js, survivorship.js, target-factory.js.
- Cost: an agent proposal is code-reading heavy: ~150-250k input + ~15k output ≈ $2.5-3.5 per hypothesis at Fable 5.1; a leak-review pass ≈ $1. 20 hypotheses/week ≈ **$300-400/month** + local compute (harness runs are free on the box). Retrospective verdict in hours; prospective still ≥4-6 months.
- Base rate from this repo: 55 preregistered experiments, 0 confirmed, 24 no-edge; the strongest surviving retrospective effects are AVOIDs (dilution 424B5 q 0.0002, extended-gap). Expect ≤1-2 retrospective survivors per 100 hypotheses and most to fail prospectively.
- Score: gates fully reachable (it is the app's own promotion path), data access = whatever the harness has (price + EDGAR + FMP Premium fundamentals; NO transcripts/13F), cost moderate. **Viable, but it is a research accelerator, not an alpha source** — its value is throughput of honest NOs.

### C. Agent-as-text-reader (LLM turns filings/news into structured events → event-study harness → AVOID or event signal)
- Daily: pull EDGAR filings for the tracked universe (lib/edgar.js:124 `fetchRecentFilings`, Form 4 :101, CIK map :19; dilution-flag.js:46 already polls 424B5/S-3 daily with immutable filing dates), extract a FIXED event schema with a bulk model (schema style of lib/evidence-extract.js:31-66 / lib/challenger-events.js), stamp `{model, promptVersion, fingerprint, acceptanceDatetime}`, write an immutable per-day event ledger. Evaluate with lib/drift-eval.js:68 `evalDrift` (SPY-excess drift by quintile, byYear + VIX/credit byRegime, date-clustered) against a placebo (random-date) family, BH across the ≤5 preregistered event types.
- Frozen: event taxonomy (≤5 types), extraction prompt version, window (e.g. 5d/21d), universe. Look-ahead: EDGAR acceptance timestamp gates `asOf` (the Form 4 publication-date fix, data-lineage F-1); news uses `newsFingerprint` at decision time; nothing re-labels history.
- Two outputs: (i) **AVOID characteristics** (the dilution precedent, lib/dilution-flag.js:11-24: shadow until ≥50 resolved decision dates + manual registry change) — useful without fill verification because they subtract from a long book; (ii) **event signals**, which face the full strategy gates including the fill ceiling.
- Reuse: lib/edgar.js, lib/dilution-flag.js/-filings.js, lib/evidence-extract.js, lib/drift-eval.js, lib/challenger-events.js, sec8karchive/calarchive ops, apex/insider sharded storage pattern.
- Data ceiling (this is the real gate): FMP Premium has no transcripts, 13F, or COT (memory: gated at Ultimate); Finnhub free earnings capped. So the readable text is EDGAR (free, complete, immutable) + headlines. Retrospective history is available for years → a retrospective verdict in days, prospective AVOID verdict in ~3 months (50 dates).
- Cost: bulk extraction on Haiku 4.5 ($1/$5): ~200 filings/day × (5k in + 1k out) ≈ $2/day; Fable 5.1 only for adjudicating ambiguous events (~10/day × 8k/2k ≈ $1.8/day). **≈ $80-150/month.** Refusal rate on filings ≈ 0 (financial documents).
- Score: AVOID lane clears its own (documented) gate without fill verification; event-signal lane faces the ceiling like everyone; data access good for EDGAR, poor for transcripts; cost low. **Best fit to the app's one repeatable finding (avoidance).**

## 3. What makes it UNRELIABLE regardless of alpha — and what already exists

| Failure | Consequence | Existing handling / what the pilot must do |
|---|---|---|
| Blob read-back lag 10-30s+, RMW lost updates | ledger rows vanish, cursor handoffs break | sharded per-batch docs (apex/fundshard pattern), writeChecked, single-step nightly (memory: evidence-feedback-pass) — pilot writes ONE immutable doc per day per stream, never RMW |
| Cron OOM / chain depth | silent nightly failures | own root chain in ROOT_CHAINS (warm-chains.js:476), ≤1 hop, no self-fetch fan-out; health banner via lib/health.js classifyProblems (weight-0 chains muted) |
| 12-function cap | no new endpoint | new ops inside api/tracker.js; PRIVILEGED for writers (api/tracker.js:51) |
| 300s tracker wall / 240s chain deadline | extraction batch dies mid-way | resumable cursor ops (op=fundbuild pattern: time-boxed 45s, `nextStart`) |
| Fable refusals / no tool call | missing extraction read as "no event" → biased ledger | lib/fable-call.js returns `refused`/`input:null`; pilot MUST log a `data-gap` row, never an empty event list (evidence-extract.js:124 currently returns `events: []` on failure — that conflation is a defect for this use) |
| Model/prompt drift | a silent regime change in the extractor | stamp model+promptVersion (precedent :141); treat a change as a `scoringVersion` bump = new evidence stream |
| Non-determinism | same filing → different event | two-pass agreement audit on a 5% sample; disagreement rate is a health metric, >10% halts adoption |
| Cost blow-up | $/day runaway on a busy filing day | EXPENSIVE_OPS rate limit (api/tracker.js:204) + a per-day token budget doc; Haiku bulk / Fable adjudication split |
| Look-ahead via re-labelling | a "clean" retrospective that isn't | EDGAR acceptance datetime as `asOf`; immutable ledger sha256 (experiment-kit); prosecutor excision/concentration on the claim |
| Multiple comparisons inside the swarm | 20 agents × 5 event types = 100 tests | BH with the full denominator (harness-v3.js:164 `bhWithDenominator`), `variationsAttempted` counted per hypothesis, one preregistered primary metric |
| CDN-cached empty state | a healthy-looking empty ledger | never `s-maxage` an empty result (memory: options-intelligence-v2) |

## 4. Verdict

- **A (agent-as-picker): no.** Five prior instances, zero positive after the sector control, structurally blocked by fill verification and undeclared incremental value.
- **B (hypothesis factory): yes, as the harness C feeds into** — it is the app's own promotion path with agents supplying preregistered hypotheses. Alone it produces honest NOs at scale, not alpha.
- **C (text-reader → AVOID): the only architecture whose output matches the app's one replicated finding (avoidance is the validated lever) and whose evidence does not need the fill-verification ceiling.** Worth a 90-day pilot.

**90-day pilot (preregister before the first extraction):**
- Scope: EDGAR 8-K items 1.01/2.02/3.02/5.02 + 424B5/S-3 + Form 4 cluster sells, tracked universe (lib/universe.js), ≤5 event types, extraction on Haiku 4.5 with Fable 5.1 adjudication, frozen prompt v1.
- Primary metric (one): flagged names' cost-net excess vs matched same-date same-liquidity-band controls at 5d (AVOID window), date-clustered; secondary 21d.
- Retrospective gate (week 1-2, 2022→2026 EDGAR history): per event type, date-level CI95 hi < 0, BH q ≤ 0.10 across the ≤5 types + placebo family, PBO < 0.5 if any variant selection, prosecutor not REJECTED. Types that fail are dropped BEFORE the prospective phase and recorded in hypothesis-registry as `no-edge`.
- Prospective gate (day 90): ≥50 resolved independent dates per surviving type, CI95 hi < 0, ≥3/4 blocks negative, extraction agreement ≥90%, data-gap rate < 5%. Then a registry entry + drift-eval artifact + manual promotion to an active filter on Quick Hit/Opportunities/Today (the negative-lanes precedent), still weight-0 as a strategy.
- **Stop rules:** retrospective q > 0.10 on every type; OR at 50 dates the prospective CI spans zero; OR extraction disagreement > 10% or data-gap > 10% in any month; OR spend > $200/month; OR any refusal-as-empty conflation found in the ledger.
- What "success" buys: not a return stream, but a validated subtraction from the long book — the same kind of value the regime gate provides, with a number attached.
