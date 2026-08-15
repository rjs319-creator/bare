# Catalyst–Flow Ranker — final report

**Verdict: KEEP_RESEARCH_ONLY** (E3 arm: **INSUFFICIENT_DATA**). Generated 2026-08-15T20:19:17.359Z from the
measured pipeline outputs (arms run 2026-08-14T12:49:43.446Z). Weight zero; nothing here touches a live trade.

No arm produced positive net sector-relative alpha; with abstention equalised and then removed, LambdaMART shows zero ranking advantage over a transparent PEAD score (E2−E1 forced = +1.1 bps, p = 0.92). E3 (signed options) was never measurable. The strategy stays RESEARCH/SHADOW at weight zero.

## The numbers (net, sector-relative, per decision-date cohort)

310 out-of-fold decision-date cohorts, 7030 event rows, identical across every measured arm.
Inference is on date cohorts with Newey–West (lag 4) and a seeded block bootstrap; the wider interval is reported.

| Arm | net bps/cohort | p | abstained | forced top-10 bps | forced p |
|---|---:|---:|---:|---:|---:|
| E0_CURRENT_OMEGA | -0.9 | 0.919 | 291/310 | -79.2 | 0.001 |
| E1_SIMPLE_PEAD | -3.3 | 0.712 | 289/310 | -84.4 | 0.001 |
| E2_CATALYST_RANKER | -19.8 | 0.479 | 153/310 | -83.4 | 0.001 |
| RIDGE | 0 | — (all-cash: constant series) | 310/310 | -84.1 | 0.000 |
| E3_CATALYST_FLOW_RANKER | — | — | — | — | INSUFFICIENT_DATA |

**Paired ablations:** E2−E1 = -16.5 bps (p = 0.569);
with abstention removed the ranking difference collapses to ≈ +1 bp (p ≈ 0.92) — the model has no ranking skill the
transparent PEAD score lacks. E3−E2 was **never computed** (no signed-flow data) and is reported as INSUFFICIENT_DATA,
not as a null. Nothing survives Benjamini–Hochberg (all q = 0.919). Deflated Sharpe (over the full
80-trial registry): E2 = 0.246, E1 = 0.3334, both on negative raw Sharpe.

The only behaviour that "works" is refusing to trade: each arm looks ~flat on its primary line purely because its
calibrated edge is almost always negative, so it holds cash on most dates. That is the abstention rule working and
the ranking underneath it failing.

## Promotion gates

- ❌ `pitImmutableEvidence` — 0 of 24533 ledger rows were observed at their own decision cutoff — the consensus archive is a post-release vendor snapshot (RECONSTRUCTED_EXPLORATORY)
- ❌ `delistingsIncluded` — delisted names’ price series simply end; delisting RETURNS are absent, so survivorship safety is reduced, not proven
- ❌ `signedOptionsCoverage` — no Cboe Open-Close (or equivalent participant/side/open-close) feed — family C is 0% populated by refusal
- ❌ `ablationSurvivesFDR` — nothing survives Benjamini-Hochberg: all q = 0.919 across the 4-member family
- ❌ `positiveNetOfStressCost` — every arm’s primary mean is ≤ 0 at the liquidity-aware cost case; stress cases are moot
- ❌ `deflatedSharpePositive` — E2 DSR = 0.246 on a negative raw Sharpe, deflated by 80 recorded configurations
- ✅ `holdoutUntouched` — final holdout never opened (holdoutOpened = false) — deliberately left closed; do not burn it on a study already blocked on data
- ✅ sample floor: 310 held-out decision dates (≥ 100), 7030 event observations (≥ 500)

Six of seven gates fail; the one pass (untouched holdout) is deliberate — the holdout stays closed because the
study is already blocked on data, and a holdout is only spendable once.

## Data coverage: what is genuinely point-in-time

- **Genuine PIT:** family B (first-session price/volume confirmation, 19/19 features, ~98–100% coverage) and the
  FINRA days-to-cover overlay (visible only after a derived 10-session publication lag, 96.8%).
- **EXPLORATORY (reconstructed):** family A fundamentals — 0 of 24533 ledger rows were
  observed at their own cutoff; the earnings/consensus archive is a post-release vendor snapshot. Promotion-eligible
  events: **0**.
- **Absent by refusal:** family C signed option flow (free Yahoo chains cannot see participant, side, or open/close
  and are barred from these fields by schema and test).
- Exclusions at dataset build (paired across arms): benchmark-missing-entry-bar 651, target:stock:horizon-beyond-history 4, missing-session-bar 2; 40 overlapping re-entries rejected.

## What would change the answer

1. A licensed signed customer-opening option feed (Cboe Open-Close or equivalent) to make E3 measurable at all.
1. Provider-timestamped point-in-time consensus (or the append-only snapshot process maturing for ~2 quarters) to lift family A out of EXPLORATORY.
1. Delisting returns for the price panel so survivorship safety can be proven rather than argued.

Full preregistration, schema, defect log and reproduction commands: `docs/catalyst-flow-ranker.md`.
Operator procedures: `docs/catalyst-flow-runbook.md`.
