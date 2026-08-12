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

## Second pass (same day) — accounting, costs, controls

9. **cost-v3 participation impact** (`lib/costs.js`). Optional square-root market-impact
   term (same shape as the intraday model) charged only when the caller declares BOTH the
   name's ADV and an explicit order notional — the module never invents an order size, and
   every pre-existing caller keeps size-independent cost-v2 behavior exactly. Episode
   records now stamp `costModelVersion` from the module instead of a hard-coded literal.

10. **Cost-aware shadow portfolio optimizer** (`lib/portfolio-optimizer.js`,
    `optimizer-v1`). Solves for weights against one net objective (expected net −
    uncertainty − participation impact at the position's actual notional − diagonal
    idio-vol risk − turnover) under gross ≤ 100%, per-name and per-sector caps; stops
    allocating the moment the best marginal utility is ≤ 0 (cash is a first-class
    answer); ships same-objective equal-weight and rank-weight comparisons and a
    machine-readable reason per omitted name. Pure, shadow-only, no live consumer.

11. **Common-date mark-to-market lane** (`mtm-v1`, in `runScoreboard`). A pick younger
    than the 1m horizon used to fall out of every statistic until it matured
    (survivorship-in-time). It is now marked at the latest close under its section's own
    entry basis, net of the full round-trip cost, and each group reports
    `mtm: { openN, resolvedN, openAvgNet, resolvedAvgNet, combinedAvgNet }`. Dividends
    and cash drag are not modeled — the basis string says so. Pending conditional
    triggers stay pending (no fabricated fills).

12. **entry-v2.2 basis migration.** The ~23 remaining lead-only/legacy sections now grade
    from the NEXT session's open instead of the unexecutable signal-day close (the close
    is what the signal was computed FROM). Lead-only sleeves remain PROXY-labeled and
    fill-unverified; only the proxy's price basis changed. Day Trade stays pinned to
    legacy, frozen. The Scoreboard recomputes from ledgers, so history re-grades under
    the new basis — a deliberate, versioned change.

13. **Feature persistence on decision records.** Each live Prediction now carries
    `features.raw` (entry/stop/target/rawConfidence/dollarVol/ageBars/lifecycleState)
    and `features.normalized` (the audited multiplicative score decomposition) — the
    ledger is now trainable, not just gradeable.

14. **JS PBO** (`lib/research/pbo.js`, CSCV) with calibration tests (noise ≈ 0.5,
    dominant variant ≈ 0, anti-persistent ≈ high), plus the **one-bar-delayed-feature
    control** — both wired into research/75. Second run of the study: PBO across the four
    selectable arms = **0.63** (in-sample arm selection is mostly noise — corroborating
    the negative top-book), delayed-vs-same-bar IC Δ ≈ −0.002 (the expected shape for a
    slow momentum family, and proof the harness does not leak the decision bar). The
    re-runs recorded append-only as `.r2`/`.r3` with parent links — the experiment-ledger
    immutability fix exercised on real data.

15. **Abstention rate is now a series**: the daily opportunity log row records
    `abstained` + `actionableCount` from the governed board.

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
