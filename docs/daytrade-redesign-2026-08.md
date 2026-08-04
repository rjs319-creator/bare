# Day Trade Redesign — 2026-08 (engineering + research-readiness pass)

Implemented 2026-08-03/04 on top of the two-stage v3 base (PR #258). This document is the
operating manual: the pipeline map, every contract that changed (with versions), migrations,
rollout/rollback, and the honest predictive status.

**Predictive status: UNPROVEN.** Nothing in this pass claims alpha. The engineering,
observability and validation machinery are the deliverable; every learned-model surface
remains fail-closed behind the pre-registered promotion gates, which now additionally
require prospective shadow evidence, adverse-cost survival, and multiple-testing deflation.

## 1. Pipeline map (current, authoritative)

```
universe/candle caches (daily cron; per-entry provenance: lastBarDate/sourceScope/fetchedAt)
  → discovery baselines (baseline-v2: ONE cohort date adjudicated vs the exchange calendar;
     mixed-vintage entries EXCLUDED + counted; freshest-wins ticker conflict resolution)
  → scan universe selection (liquidity-ranked core + deterministic rotating tail;
     inclusionReason + inclusionProb per name)
  → Stage-A scan  op=daytradescan (privileged, leased, 5-min GH cron)
     · bulk quotes (FMP→Yahoo fallback, capability-reported)
     · QUOTE INTEGRITY: no server-time fallback; missing/unparseable/future/stale/
       wrong-session/non-monotonic asOf → no CUSUM update, no ranking, no dataset,
       counted by reason (excludedByReason) + display-only unusableSample
     · CUSUM change detection (NaN-guarded state) → anomalies (freshness = live quote)
     · compression/pre-break watch lane (daily geometry, watch-only)
     · PIT dataset capture (intraday-dataset-v2: cap = recorded-rate hash thinning,
       never a silent top-N slice; capContract persisted per bucket)
  → board computation  computeDaytradeBoard (ONE code path, writer-authority flag)
     public op=daytrade            → mutate:false — READ-ONLY projection (no saves, no
                                     alerts, no captures, no inline scan)
     privileged op=daytradeboardtick → mutate:true — THE one lifecycle mutator (leased,
                                     per-tick health doc, non-200 on persist/alert failure)
     · Stage-1 daily scans + price-only pcarry (NO news in the hot path)
     · discovery merge (never discard known-ticker evidence)
     · Stage-2 lane selection (management/revalidation/discovery/anomaly reserves)
     · Stage-2 deep validation: 5-min bars (fetchWithTimeout, per-ticker failure counters)
       + validated quote + SPY/sector bars + microstructure adapter (explicit missingness)
     · features: COMPLETED BARS ONLY for every confirmation (forming bar → labeled
       PROVISIONAL observation; equivalent-completed-interval time-of-day volume;
       dayChangePct/gapPct vs prior close; reclaim streak; intraday-features-v3)
     · live plan: entry from the VALIDATED QUOTE (labeled), trigger from completed bars,
       frozen levels + timestamps; expiry → explicit PLAN_EXPIRED (never silent re-mint)
     · lifecycle advance (requireLivePlan; live-plan-authoritative stop/target/expiry:
       STOP_REACHED / TARGET_REACHED / PLAN_EXPIRED / DAY_COLLAPSE; production
       reversal-reclaim wiring via stage2EvFor)
     · execution gate: tiered cost model (intraday-cost-v1) — risk-vs-cost + dollar-volume
       always; spread/halt when observed. Blocks Best Opportunities.
     · alerts (signal-gate language; TWO classes; episode-stable dedup; budgets)
     · persistence (ONE save) → snapshots (LIVE plan captured; daily plan = provenance;
       evidenceBasis recorded) → rejections log → BATCH shadow scoring (one artifact
       load) + shadow-observation accounting
     · POST-validation catalyst enrichment (≤12 displayed cards, deadline-aware,
       timestamped) — news can no longer starve validation
  → best-gate-v2: admission = actionable ∧ currentSessionFresh ∧ thesisValid ∧ planValid
     ∧ livePlan ∧ execution-gate-not-blocked ∧ no fade catalyst; pcarry/overextension
     RANK ONLY (a multi-day model can no longer veto an intraday setup)
  → UI: live price node + honest change labels on actionable cards; "wrong if" line;
     Managing lane = real fills only (honestly labeled unavailable); 3d-carry chip
  → post-close: op=daytradecapture + op=datasetgrade (labels v2: executable next-bar-open
     entry, +0.75 ATR multiple, real 30/60/120-min timeout races, tiered costs, POLICY
     label per daytrade-policy-v1)
  → training/evaluation  op=datasetsurvival (dataset-utility-v2)
     · joins fail closed on dataset/label versions; joinLossRatio reported
     · nested chronological calibration (inner split → none/Platt/beta/isotonic by held-out
       Brier+logloss; frozen before outer test); logLoss + calibration slope/intercept
     · three heads: hazard (Model A, recall), target/stop competing-risk (Model B,
       simplex-projected), EV ranker (Model C, tiered costs, base+adverse)
     · POLICY-LEVEL evaluation: episode-deduped top-K on real policy trades; promotion
       consumes THIS block; session-clustered bootstrap CI on the lift
     · trials ledger (config-hashed) → multiple-testing deflation of the lift bar
  → model governance (authenticated ops; actor-stamped, auditable)
     op=modeltrain → immutable artifact + complete card (never promotes)
     op=modelpromote → SHADOW only, gate-checked
     op=modelchallenger → shadow challenger BESIDE a live champion
     op=modelpromotelive → requires passed-gates card AND the accrued prospective shadow
       window (minShadowDays/Episodes) — a backtest alone can never serve
     op=modelrollback → one-call pointer restore    op=modelstatus → public read
```

## 2. Contract versions introduced/bumped

| Contract | Version | Change |
|---|---|---|
| Feature schema | `intraday-features-v3` | completed-bar semantics; +dayChangePct, gapPct, distFromOrHigh, closesAboveVwapStreak, timeOfDayDollarRelVol; MODEL_FEATURES unchanged |
| Dataset | `intraday-dataset-v2` | cap = recorded-rate hash thinning (sampleProb always true); capContract persisted; baseline/inclusion provenance + `provenance:'prospective-live'` per row |
| Labels | `intraday-labels-v2` | executable next-bar-open entry (unfillable ⇒ skipped, never fabricated); +0.75 ATR multiple; real 30/60/120-min timeout races; tiered costs + scenarios; `policyLabel`; signal-price grade kept as diagnostic |
| Decision policy | `daytrade-policy-v1` | ONE canonical object (trigger/fill/gap-skip/stop/target/time-stop/sizing/costs/no-fill) shared by live plan, labels, training, capture |
| Cost model | `intraday-cost-v1` | tiered (liquidity/price/vol/time-of-day/notional/order-type), modeled-vs-observed labeled, base/adverse/severe |
| Best-Opportunities gate | `best-gate-v2` | intraday-validated admission; pcarry/overextension rank-only; execution gate blocks |
| Baselines | `baseline-v2` | cohort adjudication + exclusion counts + provenance (old-shape cached docs are rebuilt) |
| Promotion gate | v2 | +distinct dates, episode-counted testEpisodes, fold dominance, ticker concentration, adverse costs, comparators, slice stability, data health, provenance, prospective shadow, trials deflation |
| Evaluator | `dataset-utility-v2` | nested calibration, hazard head, simplex EV, policy-level block, clustered CI |

Old v1 dataset rows and labels are **versioned out** by the fail-closed joins (counted in
`joinSkipped`, never silently mixed). The accrued few days of v1 data are the cost of
fixing the sampling and entry-realism contracts honestly.

## 3. Writer authority (Phase 10C)

- Public `op=daytrade`: read-only projection. Classifies against persisted records but
  cannot save, alert, capture, or run the inline scan. Response carries
  `authority: 'read-only-projection'`, `readOnly: true`.
- Privileged `op=daytradeboardtick`: the ONE mutator (55 s lease, per-tick health doc
  `lifecycle/daytrade/boardtick-health.json`, non-200 when persistence or alert emission
  fails while a durable store exists). Driven by the GH scheduler every ~5 min,
  authenticated, failures visible (no `|| true`).
- `op=lifecycle`: read-only view of the persisted records (its old write path re-saved the
  same doc under DEFAULT engine config and dropped `activePlan`/`earlyState` — removed).

## 4. Migration & rollback

All storage changes are additive or version-keyed; no backfill required.
- New Blob docs: `boardtick-health.json`, `board-tick-lease.json`, `models/trials.json`,
  `models/challenger.json`, `models/shadow-stats.json`. Baseline docs rebuild as
  `baseline-v2` on first scan of a date.
- Lifecycle records gain nothing mandatory; new states (`TARGET_REACHED`) and reasons
  (`STOP_REACHED`/`PLAN_EXPIRED`/`DAY_COLLAPSE`) are additive; old readers ignore them.
- Rollback: `git revert` restores the previous engine (old code ignores new fields);
  reverting the workflow file alone restores the old public-tick scheduling;
  `DAYTRADE_STALE_WEIGHT`/VAPID/etc. flags unchanged from v3. Model rollback:
  `op=modelrollback` (pointer restore); with no pointer the deterministic baseline is the
  champion by construction.
- Safe rollout order: (1) lib changes (inert without traffic) → (2) workflow file (switches
  the scheduler to the authenticated tick) → (3) verify `op=daytradescanhealth` shows
  `boardTick.state: healthy` → (4) UI. Each step reverts independently.

## 5. Evidence still required before the predictive grade can rise

1. ≥21 distinct graded sessions of `intraday-dataset-v2` rows (accrues prospectively;
   there is no historical intraday depth on current feeds).
2. `op=datasetsurvival` policy-level lift positive under ADVERSE costs, across ≥60% of
   folds, without ticker concentration, across session/liquidity slices.
3. Calibration (nested OOF): ECE ≤ 0.10, Brier ≤ 0.25, sane slope/intercept — else no
   probability is ever displayed (deterministic scores remain labeled non-probabilistic).
4. A trials-ledger-deflated lift bar cleared (the search is logged; best-of-N pays for N).
5. A prospective shadow window (≥5 sessions / ≥50 episodes) recorded by the board tick.
6. Human-authorized `op=modelpromotelive` — never automatic.

Until every one of these holds, the honest label everywhere remains: **no verified edge;
deterministic research scores only; probabilities not shown.**
