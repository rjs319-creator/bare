# Alpha-research delta pass — 2026-08-11

A coordinated non-Day-Trade pass against the full alpha-research rebuild brief. A four-agent
audit first mapped every brief section onto the existing architecture (most of the brief —
governance, abstention lanes, decision ledgers, HAC/FDR/DSR statistics, sealed holdouts,
episode accounting — was already built in the 2026-08 redesign passes); this pass shipped
only the verified genuine deltas. Market Pulse freshness (brief §1) was implemented
concurrently on `fix/pulse2-story-freshness` by a parallel session and is deliberately
absent here.

**Day Trade untouched** — no daytrade/lowfloat/ignition file is modified; the frozen
fixtures and pins all pass.

## Shipped

1. **Governance transition ledger** (`lib/governance-transitions.js`). The
   `governance/latest.json` overwrite now leaves an append-only, hash-chained record of
   every status/version transition (old→new state, weights, reason, approval linkage) on
   the immutable ledger stream `governance-transitions`, reported per run as
   `governanceTransitions` on op=maturity. Previously the history of capital-control
   decisions lived nowhere.

2. **Shadow vocabulary + zero displayed size** (brief §2). OMEGA's `BUY_ABOVE`/
   `BUY_ON_PULLBACK` labels and its "Suggested size N%" row (a weight-0 strategy publishing
   a %-of-equity), PSRL's raw `BUY ZONE` states, the Opportunities cards' "at 1% account
   risk ≈N% position" line, and CERN's unproven-type "Suggested size" are all replaced with
   research/observation vocabulary and zero-size disclosures; CERN may show a size only for
   an earned `validated` grade. Locked by `test/ui-claims.test.js`.

3. **Honest abstention everywhere a fallback filled a section** (brief §3).
   - `rrGate` no longer returns "the top-3 best available" when nothing clears 2:1 R:R —
     the screener/momentum sections abstain with the below-floor count.
   - Confluence no longer drops its 4/5 vote bar to ≥3/5 on quiet days — it abstains with
     `rejectionReasonCounts`.
   - The high-conviction filter no longer silently substitutes `['breakout']` when nothing
     survives OOS — the label says "none OOS-robust → static default".
   - The client logistic model may re-sort the screener only at/above its own OOS-AUC
     reliability floor (it previously re-sorted below it).
   - op=today's `governanceGate` now carries `abstained`, `actionableCount`, and a
     `rejectionReasonCounts` histogram over **all** excluded rows (the `excluded[]` sample
     is truncated at 50, so the histogram is the only complete view).

4. **Unvalidated factor demotions, versioned** (brief §2). `screener-v2`: volume-surge
   (measured rank-IC ≈ −0.004) no longer admits a Breakout on its own and no longer earns
   techScore credit (which orders api/picks); the rising-50-DMA bonus is removed; RVOL
   remains a descriptor. Contract + payload stamps + replay bumped together; the golden
   fixture regenerated (version-string-only diff — no score/order drift). The Ghost AF
   pillar and Apex P4 no longer fall back to the dead vol percentile when accum/ud are
   missing (neutral instead; client copy kept in sync). The conviction sleeve is now a
   REGISTERED shadow strategy (`conviction`), keeps logging as a frozen benchmark, and no
   longer lights the 🔥 Prime standout badge.

5. **Transparent challenger** (brief §5) — `lib/transparent-challenger.js`
   (`transparent-v1`), the one multi-factor swing ranker with no fitted weights:
   `rank(sector-residual momentum 126→21) + rank(tightness20d) − rank(extension/ATR) −
   rank(idio vol 63d) − rank(expected round-trip cost)`; frozen eligibility gates
   (liquidity floor, extension ceiling, repeated-failed-breakout veto), ranks not z-scores,
   cost inside the score, full rejection denominator retained. Registered shadow/weight-0
   in the strategy registry and the hypothesis registry (family `swing-ranking`).
   **First identical-date ablation run** (`research/75-transparent-challenger.js`, 97
   dates): harness valid (frozen inverse mirrors to −5e-5; placebo IC +0.006); full-arm
   IC +0.037 (t 2.26) but top-10 cost-net **negative** (−1.12%/21d) while
   residualMomentumOnly is the only arm with a positive top book (+0.97% base / +0.53%
   doubled). Recorded as-is; the composite failed its own pre-declared direction at the
   top of book. No reweighting is permitted under this version.

6. **Decision-record enrichment** (brief §10). Live `Prediction` records now carry, at
   decision time: the verbatim eligibility verdict (`signalClass`, `sizingWeight`,
   `reasonCodes`, governance status), the **declared** fill rule (`intendedFillRule` =
   the same `POLICIES.NEXT_OPEN` constant the grader uses — policy drift becomes a
   code-review diff), and `dataCutoffTs`.

7. **Decision-time sector stamping** (brief §4/§9). Pick logging now stamps
   `sector`/`bench` at decision time; grading prefers the stamped benchmark and falls back
   to the current `SECTOR_OF` map only for legacy rows (previously ALL historical
   sector-relative grading silently used today's map).

8. **Experiment-ledger immutability** (brief §10). `recordExperiment` no longer silently
   replaces a same-id row while stamping `immutable: true` — re-runs append as
   `<id>.rN` with a `parentExperimentId` link.

## Explicitly not done (verified gaps, in value order)

- **Live PIT universe**: candidate generation still starts from curated current-day lists;
  the correct machinery (`lib/pitdata/v3/universe.js`, research secmaster with 2,573
  delisted names) exists and remains structurally shadow-isolated. Not code-solvable
  honestly without the vendor decision the user has deliberately deferred (Sharadar).
- **Common-date mark-to-market accounting**: every user surface is still resolved-only
  (open/pending disclosed, never marked). A real MTM lane needs a position/cash model.
- **23 Scoreboard sections still grade at signal-day close** (entry basis `null` in
  `entryBasisForSection`); costs are charged but the entry is unexecutable. Migrating them
  is an evidence-identity change per section.
- **No participation/impact cost term outside the Day Trade lane**; `lib/costs.js` is
  size-independent.
- **Cross-fitted meta-labeling gate, forecast-covariance ensemble shrinkage, OOD
  abstention, cost-aware portfolio optimizer, market-neutral book with borrow**: audited
  as genuinely missing; each needs either resolved-outcome accrual or data (borrow feed)
  that does not exist yet.
- **Sector/exchange/float history, halts, spinoff/merger handling**: no data source;
  disclosed in-code where relevant.
