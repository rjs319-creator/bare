# Can a swarm of agents make this app a reliable alpha system? (2026-09-09)

Question posed after the same-day alpha pass (`ALPHA-SWARM-2026-09-09.md`) found zero
FDR-robust positive cells in the ledger. Four agents examined it from four sides; their
full reports are in `agent-feasibility/`. This is the synthesis.

## Verdict

**Not as a picker. Possibly as an AVOID layer. Definitely as a harness.**

A swarm cannot turn this app into a reliable *return-generating* system on the data it
has. Three independent lines of evidence agree:

1. **This app's own LLM record.** Sixteen LLM-driven components already run, several with
   prospective ledgers. None has a positive cost-net record with a date-level CI clear of
   zero on ≥20 dates. The one clean paired test (Fable alert review vs mechanical rule,
   n=424) is 47.9% vs 46.9%. The challenger-decision score is significantly *inverted*
   (IC −0.08, t −2.57, n=1,026). The thesis/evidence engine is CI-negative at 1d and 1m.
   CrossAsset:Lead, the only nominal positive, is sector beta. (`llm-ledgers.md`)
2. **The outside evidence.** Across 25 sources there is no credible live, prospective,
   cost-net equity alpha from LLM agents. The headline agent papers (TradingAgents et al.)
   test inside the model's training window on a handful of mega-caps with no costs; the
   first post-cutoff benchmark (StockBench) has most models losing to buy-and-hold; the
   only real-money test (Alpha Arena) lost. The one replicated positive text effect,
   headline-sentiment next-day drift, is unprofitable above ~20 bps and decaying; this
   app's round trip is 60–150 bps in the names where it lives. (`external-evidence.md`)
3. **The governance math.** `validated` needs ≥50 episodes over ≥20 independent dates,
   cost-net, CI clear of zero, sector control, incremental value, FDR, PBO, and fill
   verification. That is a 4–6 month floor per hypothesis regardless of how many agents
   propose it, and the picker path is structurally blocked by the fill ceiling.
   (`system-design.md`)

## What agents CAN do here

| Role | Evidence | Status |
|---|---|---|
| **Picker** (agent proposes trades) | Tried five times in-app; all flat/negative. Literature: contaminated or losing. | **Reject.** |
| **Hypothesis factory** (agents write preregistered rules → walk-forward/PBO harness tests → prospective ledger) | This is what the research registry already is: 55 experiments, 0 confirmed. Agents make it faster, not truer. | **Use as harness only** (~$300–400/mo at Fable 5.1). Base rate says expect "no". |
| **Text reader → AVOID** (agents extract structured events from EDGAR → event study with placebo + BH → avoid flag) | Only text finding surviving FDR in-app is negative: 424B5 dilution AVOID (q 0.0002 retrospective). Avoidance is the app's one replicated lever. AVOID flags need no fill verification. | **Worth one 90-day preregistered pilot** (~$80–150/mo). |
| **Text reader → long event signal** | Every in-app text long signal is negative or ungradeable; lead time is gone by ingestion. | Reject, except one candidate below. |

**One candidate that meets every feasibility test** (`text-edge.md`): small/micro-cap Form 4
open-market *cluster buys*, tested momentum- and sector-residual, next-open entry. Forced
informational mechanism, EDGAR pipeline already built with publication-date gating, 5-year
retrospective runnable on the dilution rig, ~1–3 events/session → 20 dates in 4–8 weeks.
Prior in-app result (IN pillar +0.067 IC, redundant inside a momentum composite) says
expect it small and preregister it as *residual*.

## The pilot, preregistered (from `system-design.md`)

- **Scope:** EDGAR → fixed ≤5-type event schema (Haiku bulk extraction, Fable 5.1
  adjudication) → `lib/drift-eval.js` with matched placebo controls → BH across types.
- **Primary metric (one):** 5d cost-net vs matched same-date/liquidity controls.
- **Gate to go prospective:** each type must clear q ≤ 0.10 *retrospectively* first.
- **Success at day 90:** ≥50 dates, CI hi < 0, ≥3/4 blocks negative, ≥90% extraction
  agreement between the two models.
- **Stop rules:** every type fails retrospectively; the 50-date CI spans zero;
  extraction disagreement or data-gap rate > 10%; spend > $200/month.
- **Reliability requirements** (each already has infra or a known gap): stamp model +
  prompt version + input fingerprint on every record; refusals logged as data gaps, never
  as empty results (`lib/evidence-extract.js:124` conflates these today); fail closed on
  Blob lag; own root chain, dispatched last, inside the 240s chain wall.

## What would change the answer

- A paid multi-year estimates/transcripts feed (the fundamentals pillar was the one feed
  that added incremental IC).
- Verified intraday fills for non-day-trade strategies (lifts the promotion ceiling).
- The 424B5 dilution ledger reaching 50 dates (~late Oct 2026) with the CI still below zero.

## Bottom line for the owner

Use agents to say **no** faster and more precisely, and to run the falsification machine
you already built at higher throughput. Do not expect them to find the yes. If the Form 4
cluster-buy study and the EDGAR AVOID pilot both come back flat, the honest conclusion is
that the remaining edge in this app is discipline (regime, cost, avoidance), not selection.
