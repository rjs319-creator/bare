# Alpha swarm pass — 2026-09-09

Seven parallel Claude Fable 5.1 agents mined the app's PRE-EXISTING evidence (op=scoreboard
2026-09-09 13:03 UTC: 6,325 picks / 16,585 rows / 81 section:tier:scope groups × 7 horizons;
op=maturity: 61 strategies; research/experiments/registry.json: 55 experiments; the
graduation ledgers) for alpha the app is leaving on the table. Full agent reports were kept
outside the repo; this file records the findings and what shipped.

## Findings (evidence first)

1. **No positive cell survives multiple-comparison correction.** 1,512 group×horizon and
   regime/liquidity/sector cells with ≥8 dates were tested; 220 are nominally p<0.05; 25
   survive Benjamini-Hochberg at q≤0.10 and **all 25 are negative**. Nothing is promotable.
2. **CrossAsset:Lead — the only lane-level positive at several horizons (5d +1.94% [0.06,
   4.91], 4/4 blocks, 25 dates; 1m +3.48% [0.89, 8.21]) — is sector/theme beta, not
   selection.** Versus its sector it is +0.17% at 1m; the Weak tier (+4.90%) beat Lead; the
   record is one risk-on window (2026-07-02 → 08-07) with monotonically rising block means; the
   app's own FDR block rejects it (q 0.20). Stays shadow.
3. **Every section's own ranking score is noise at 5d** (`scoreQuality`: date-clustered IC
   −0.019, rho −0.31; the 90-100 bucket averaged −0.68% vs base −0.30%; screener top decile
   −1.53% vs base −0.78%; calibration "90" → actual 46%). Yet the Today composite multiplied a
   95th-percentile name to ~2× the confidence of a 45th-percentile one.
4. **The Today rank tilt was blind to the worst lanes.** op=today loads the LIVE op=scoreboard
   payload, which did not carry `evidenceKeyVersion`, so `expectancyFor` joined on first-match
   (section,tier): screener:Early:small (5d −3.80%, 1m −12.42%) was tilted on the Early:large
   record; every coil signal on the expanded group.
5. **Proven-negative lanes still took Quick Hit / Opportunities slots with trade plans:**
   screener:Breakout:large (5d −2.10% [−4.25, −0.32], 0/4 blocks, negative at all 6 horizons)
   and screener:Early:small (5d −3.80% [−6.95, −1.07], 1m −12.42%). Both are already excluded
   controls on Today; the two client tabs read /api/screener directly with no evidence input.
6. **Horizon contracts are not the lever.** No lane flips positive at a longer horizon in a way
   that survives; most decay monotonically. Ghost:STALKING:large graded `promising` on the one
   flattering bar (5d +0.28) while 1d/3d were CI-negative over 35 dates.
7. **Research registry: 0 confirmed, 24 no-edge; no shadow AVOID flag has matured** (dilution
   1/50 resolved, stbull 7/50 and wrong-signed, extended-gap avoid flagged 0 of 113). The gapgo
   prospective ledger is −2.32% over 113 resolved, matching the daytrade:A 5d cell.
8. 86% of losses are gross underperformance, not cost; cost flips sign only in thin groups.

## What shipped (all derived from the ledger, nothing hardcoded)

- **Score-informativeness gate** — `lib/decision.js` `scoreInformativeness` /
  `informedConfidence`: the comparable score's spread around neutral is scaled by the persisted
  per-section rank-quality verdict (predictive 1, weak-positive 0.5, noise/inverted 0,
  unmeasured 0.5; no verdicts at all = feature-off). With every native section at `noise`, Today
  orders by realized lane record × execution × cost — the part of the formula the ledger
  supports. Decomposition carries the factor; Today renders it.
- **Live scoreboard payload now ships `evidenceKeyVersion`, `sectionDecile`, `negativeLanes`**
  (`lib/apex-routes.js`), fixing the scoped-join blindness (finding 4) and feeding the gate.
  Per-section and per-regime rank-quality lanes now carry `date`, so their verdicts can earn a
  date-clustered basis instead of pooled-IID.
- **Evidence-negative lanes** — `lib/negative-lanes.js` (pure): a lane qualifies only when its
  date-level cost-net CI95 at its OWN contract horizon is entirely below zero, ≥15 effective
  dates, ≤1/4 positive blocks, an adjacent horizon agrees, long-side contract. On the
  2026-09-09 ledger exactly two qualify: screener:Breakout:large and screener:Early:small.
  Quick Hit and Opportunities split these out of Top-5 / best-by-cap and show them as excluded
  controls with the record (verified in a browser against prod data: 8 held out on Quick Hit,
  7 on Opportunities small scope).
- **Opportunities scope join fixed** — candidates carry `capTier: 'Small'`, never `scope`; the
  Ghost reliability join had been silently unscoped. `candidateScope()` resolves both.
- **Adjacent-horizon warning on the maturity grade** (`lib/maturity.js`
  `adjacentHorizonReads`): descriptive only, never a gate; reason line names CI-negative
  neighbours.
- **Today card labels a ranked-out row** ("⛔ evidence negative — ranked out") instead of
  printing an unlabelled plan.
- **🎯 Top-conviction badge gated on registry eligibility** (the conviction sleeve is shadow).
- **Fable 5.1 migration** — `lib/fable-call.js`: one helper for `claude-fable-5-1` (auto
  tool_choice + strict schema instead of the forced tool call 5.1 rejects, refusal handling,
  server-side fallback to Opus 4.8 opted in, effort control); 8 call sites migrated.

## Deliberately NOT done

- No strategy promoted, no horizon contract changed (post-hoc horizon selection is max-of-7 mining).
- DownDay `WATCH` left in its policy cohort: negative at 1d, but its 3d contract cell spans zero.
- daytrade:A not suppressed: its 1d contract cell spans zero; the −4% at 5d is post-exit carry.
- Sector sub-cells (e.g. Health Care 20d, 4/4 blocks) are 1-of-11 forks over ≤13 dates — not filters.

## Post-deploy verification

1. `op=scoreboard` carries `evidenceKeyVersion`, `sectionDecile` (≈19 sections), `negativeLanes` (2).
2. `op=today` rows from `screener` show `scoreDecomposition.scoreInformativeness.w === 0` and
   `informedConfidence 50`; a screener:Early:small row carries `expectancyTilt 0.1`.
3. Quick Hit shows the "held out" note; Opportunities small scope likewise.
4. One shadow Fable op (e.g. `op=alertsassess`) runs without `[fable-call]` 400s in runtime logs.
