# Pre-registration — Government-Demand Intelligence (AI-Alpha-OS slice 1)

Frozen: 2026-07-30 · Module: `govdemand-v1` · Status: **PROSPECTIVE ACCRUAL — no results viewed**

## Primary hypothesis

> Unexpected, financially material government-demand events (new obligations from
> USAspending) that have not yet produced a substantial price reaction predict
> positive 21-session market-excess returns, net of estimated costs.

## Why this experiment is prospective-only (disclosed limitation)

USAspending records the government **action date** but exposes **no publication
timestamp**, and agencies report with a lag (DoD historically up to ~90 days).
Historical availability therefore **cannot be reconstructed**, and substituting
action date for publication time would manufacture lookahead. Per the
AI-Alpha-OS rules, we do not run or claim a historical backtest. The dataset
earns its verdict by accruing forward: `availableAt` = the collector's own
observation time, recorded per transaction with revision vintages preserved.

Consequences accepted up front:

- Verdict timescale is **12+ months** at the frozen promotion bars.
- `survivorshipSafe: false`, `productionGrade: false` throughout.
- The qualifying-event rate is expected to be LOW (a handful per week at most):
  mega-primes rarely clear materiality; small-caps clear it rarely but meaningfully.

## Frozen eligibility (the gate cascade, in order)

Implemented in `lib/govdemand-events.js#qualify` — the FIRST failing gate is recorded.

1. Recipient maps to a public company via the **static verified map**
   (`lib/govdemand-map.js`; no LLM mapping, unmapped → excluded, not guessed).
2. Action classified `NEW_AWARD`, `OPTION_EXERCISE`, or positive `MODIFICATION`
   (`DE_OBLIGATION`, `ADMIN_ZERO`, `IDV_CEILING` ceilings, `UNKNOWN` → excluded).
3. No recompete/bridge/follow-on language (routine continuation → excluded).
4. **Materiality** = obligated USD ÷ modeled TTM revenue ≥ **0.02** (2%).
   Revenue modeled as `revenuePerShareTTM × sharesOutstanding` (Finnhub);
   uncomputable → `DATA_UNAVAILABLE`, excluded (null, never zero).
5. **Unexpected vs own cadence**: award ≥ **1.0×** the median completed-quarter
   obligation flow (authoritative quarterly aggregates from USAspending
   `spending_over_time`, current quarter excluded). Insufficient history →
   `EVIDENCE_BUILDING`, excluded.
6. **Not price-consumed**: |SPY-excess close-to-close move from action date to
   observation date| < **5%**. Price data unavailable → excluded.
7. Per-ticker cooldown: one prediction per ticker per **30 days**
   (event-cluster dedup).

All thresholds are named constants frozen in code at registration. They will
not be tuned after any outcome has been viewed.

## Execution & outcomes

- Entry: **next session open** after `predDate`; exit at close H sessions later.
- Horizons: **5, 21, 63** sessions (21 primary).
- **Primary outcome**: 21-session SPY-excess return **net** of the app's
  estimated round-trip costs (`lib/costs.js`).
  - Disclosed deviation from the ideal: the prompt asks for *sector*-residual;
    v1 computes *market* (SPY)-excess. Sector-residualization is listed as an
    upgrade and any promotion decision must re-check against sector controls.
- Secondary, non-promoting outcomes: 5- and 63-session net excess, hit rate,
  severe-loss rate (net ≤ −10%), time-to-price-confirmation, thesis-confirmation
  rate (see below), subgroup splits (cap tier, agency, action type).
- **Thesis outcome is graded separately from market outcome** (ledger fields
  `thesisOutcome` / `thesisCriteria`): a stock that rises for an unrelated
  reason must not reinforce the mechanism. v1 records criteria and leaves
  grading `UNRESOLVED` until quarterly revenue/backlog data can confirm.

## Comparison

Baseline = the existing app's shadow ledgers over the same window (challenger /
ORBIT baselines). The question is **incremental** value: does the
government-demand signal select names whose forward net excess beats what the
app's existing rankers already surface — not whether it beats zero alone.

## Promotion bars (ALL required; none may be relaxed post-hoc)

- ≥ **150** matured selections and ≥ **75** independent decision dates
  (scaled from the prompt's 500/150 to this vertical's low event rate — fixed
  NOW, before any outcome exists).
- Positive mean AND median net 21-session excess.
- Multiplicity-adjusted significance (this is variant 1 of 1; the manifest
  below must count every future variant).
- No single year, sector, or 5 events contributing > 35% of the total excess.
- Positive in at least 2 of the first 3 independent 4-month blocks.
- Robust to excluding scheduled-event windows (earnings-adjacent predictions).
- Survives sector-residual re-check (the disclosed v1 limitation).

Failing these → preserve the null result in `docs/ai-alpha-os-results.md`,
diagnose (data quality vs mapping vs materiality vs diffusion vs no edge), and
recommend the next economically distinct source. Do not tune thresholds.

## Multiple-testing manifest

| # | Variant | Registered | Status |
|---|---------|-----------|--------|
| 1 | govdemand-v1 (gates exactly as above) | 2026-07-30 | accruing |

Every future gate change, threshold change, or alternative materiality
definition MUST add a row here before results are examined.

## Governance

Every prediction record carries:

```
shadow: true
affectsLiveRank: false
deploymentWeight: 0
governanceStatus: paper
```

Storage is isolated under the `govdemand/*` Blob prefix + the `govdemand`
immutable-ledger stream. Production ranking modules do not import this vertical
(enforced by `test/govdemand.test.js` "production decision sources never import
govdemand").
