# AI-Alpha-OS — Phase 0 audit & no-duplication map

Written 2026-07-30, against the live implementation (not docs). Companion to
`research/ai-alpha-os/GOVERNMENT-DEMAND-PREREG.md`.

## Purpose

The AI-Alpha-OS proposal asks for eight AI roles: information compiler,
expectation reconstructor, causal-reasoning engine, diffusion tracker, analog
researcher, adversarial prosecutor, value-of-information controller, and
thesis-resolution grader. This audit records which of those the app **already
implements**, in what form, and what was genuinely missing. Conclusion up
front: **~75% of the proposal already exists.** The genuinely new pieces were
(a) a verified external *demand* dataset (government obligations), (b) a
persistent expectation baseline for it, and (c) market-vs-thesis outcome
separation. Those are what slice 1 (`govdemand-v1`) builds.

## Audit of existing AI features

| Feature (modules) | Consumes | Produces | Statements verified? | Historically reconstructable? | Influences production? | Calibrated? | Outcome feedback |
|---|---|---|---|---|---|---|---|
| Evidence engine (`evidence-extract/cluster/consensus/schema`) | headlines, filings-adjacent news | canonical events, clusters, evidence-weighted consensus 0-100 | source-tier tracked; claims not independently verified | daily snapshots persisted (`evidence/`) | No — shadow/additive | No (score, not probability) | ledger accrual; no fitted learning |
| Read-Through (`readthrough.js`) | Gap&Go movers + LLM parametric graph | 2nd-order beneficiary leads | **No** — parametric links, ephemeral, honesty-framed as leads | daily docs persisted | No | No | forward log accruing; unproven |
| Second Wave (`secondwave.js`) | current web research (LLM) | qualitative wave candidates | No — qualitative | partially (daily docs) | No | No | forward log |
| Attention lifecycle (`attention.js`, Market Pulse) | news/attention counts | lifecycle states (≈ diffusion stages) | deterministic counts | yes | No | n/a | graded episodes |
| ORBIT + ORBIT-ML (`orbit-*`) | price/volume/factor features | 5/21/63-session residual predictions, calibration, severe-loss | deterministic | yes (walk-forward + purge/embargo) | No — shadow | Yes (OOF) — **but validated edge ≈ 0** | resolve → eval → promotion gates |
| Prosecutor (`atlasx-prosecutor.js`, `failure-model.js`) | signal features + failure evidence | failure modes w/ severity + evidence strings, non-binding | deterministic evidence | yes | No (never veto while unproven) | uncalibrated (labeled) | failure-model eval harness |
| Analogs (`patterns/analog.js`, `similarity.js`) | price geometry, PIT | analog distributions, leakage-guarded | deterministic | yes | No | partial | pattern grading |
| Challenger / router / redundancy / remaining-edge / leadtime | app signal ecosystem | TRADE/WAIT boards, effective evidence, move-consumed | deterministic | yes (immutable ledgers) | No (paper/weight-0) | partial | resolve + eval |
| Congress / revisions probes (`congress.js`, `revisions.js`) | FMP alt-data | drift-eval verdicts (disclosure-lag honest) | deterministic | yes (as-of disclosure) | No | n/a | `evalDrift` |

## Mapping the proposal's phases to reality

| Proposal phase | Verdict | Existing machinery reused | Genuinely new (built in slice 1) |
|---|---|---|---|
| 1 Market Intelligence Compiler | **mostly exists** | evidence-extract/cluster/schema | canonical *government-demand* event w/ PIT triplet (`govdemand-events.js`) |
| 2 Expectation graph | **new (scoped)** | — | own-cadence quarterly baseline (`govdemand-expect.js`); generic market-wide graph deliberately NOT built (YAGNI) |
| 3 Verified economic graph | **deferred** | readthrough (ephemeral) | nothing — building the persistent graph before the ephemeral one proves value is premature; static recipient map (`govdemand-map.js`) is the verified-relationship pattern in miniature |
| 4 Diffusion clock | **mostly exists** | attention lifecycle, remaining-edge, move-consumed gates | deterministic price-consumed gate per event; media-stage classification NOT built (would need coverage data we don't have — stage stays `UNKNOWN` honestly) |
| 5 Causal forecasts | **new (scoped)** | — | static falsifiable causal chain + confirming/invalidating measurements per qualifying event |
| 6-7 Gov-demand vertical + materiality | **new — the core of slice 1** | store/ledger/cron/cost infra | USAspending collector w/ revisions, verified map, deterministic materiality, cadence surprise |
| 8 Analog memory | **exists (price-analog form)** | patterns/* | event-analog retrieval deferred until events accrue |
| 9 Prosecutor | **exists** | atlasx-prosecutor pattern | deferred for gov events until there are events to prosecute |
| 10 VOI controller | **deferred** | — | core loop is deterministic (near-zero LLM spend), so VOI has nothing to control yet |
| 11 Quant layer | **exists** | ORBIT/calibration/costs | probabilities correctly SUPPRESSED (no OOF calibration possible yet — uncalibrated research rank only) |
| 12 Pre-registration | **new** | model-promotion-policy style | `GOVERNMENT-DEMAND-PREREG.md` (frozen, prospective-only) |
| 13 Validation | **exists** | drift-eval, research/ harness, purge/embargo | prospective ledger feeds it when matured |
| 14 Thesis-resolution | **partially exists** | immutable ledgers, resolve patterns | `thesisOutcome` separated from `marketOutcome` in the resolved ledger |
| 15 Research UI | **gated off** | evidence-badge/howto patterns ready | none until Gate B |

## Key honesty findings the proposal itself flagged (confirmed true here)

- Read-Through links are **temporary LLM-inferred**, not a persistent verified
  graph — confirmed; that is why the gov-demand map is static + evidenced.
- Evidence materiality is a **bounded judgment**, not a financial calculation —
  confirmed; `govdemand-materiality.js` is the first true financial-impact
  calculation in the app (obligation ÷ TTM revenue, with provenance).
- ORBIT residualizes **stock behavior, not operating activity** — confirmed;
  and its validated OOS edge is ≈ 0, so "reuse ORBIT" means reuse *plumbing*.
- The router **cannot bind live exposure** — confirmed (weight-0 governance).
- The security master is **not sufficient for production-grade historical
  claims** — confirmed; every gov-demand read reports `survivorshipSafe:false`.

## Prior expectation (recorded before any result)

The app's own experiment history — ORBIT ≈ 0, ORBIT-ML ≈ 0, all 9 NSL engines
no-edge, RLT no-edge, meta-labeling rejected — sets the honest prior: **null is
the expected outcome.** The value of slice 1 is a verified, orthogonal,
point-in-time demand dataset and a clean falsifiable test, not a promised edge.

## What slice 1 changed (all additive, all shadow)

- New: `lib/govdemand-{map,collect,materiality,expect,events,routes}.js`,
  `test/govdemand.test.js`, prereg + this audit.
- Touched: `lib/store.js` (govdemand/* helpers), `api/tracker.js` (3 ops;
  tick/resolve privileged), `lib/warm-chains.js` (`govdemand` root chain).
- Production impact: **none** — no production module imports the vertical
  (test-enforced), all records carry `shadow:true / affectsLiveRank:false /
  deploymentWeight:0 / governanceStatus:'paper'`.
