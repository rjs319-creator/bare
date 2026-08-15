# Short Interest Overlay — OMEGA_SI_LEVEL_5D_TOP10

> Shadow research only. **Does not affect live OMEGA ranking.** Generated 2026-08-14T02:20:22.248Z.

**Verdict: `NO_INCREMENTAL_ALPHA`** — incremental mean -0.1071 not positive; bootstrap 95% interval not entirely above zero; positive folds 1 < 3; sign reversal (or missing result) under the 16-day availability delay; material collapse after excluding revised records; FDR q 0.9665 > 0.1

## Data
- FINRA consolidated short interest: 124 settlement cycles 2021-06-15 → 2026-07-31; 7516 records kept, 0 invalid, 0 duplicates.
- OMEGA panels: 197 decision dates (2022-07-21 → 2026-06-17), 11956 joined rows, 62 tickers, SI coverage 100.0%.

## Primary result (top-10, 5 sessions, 13-day conservative availability)
| metric | Arm A (fixed) | Arm B (trained) | Arm C (B+SI) |
|---|---|---|---|
| mean net residual/cohort | -0.0033 | 0.6696 | 0.5625 |
| median | -0.1642 | 0.3273 | 0.2316 |
| win rate | 0.481 | 0.5443 | 0.5443 |
| Sharpe-like | -0.009 | 1.07 | 0.921 |

- **Incremental (C − B): -0.107% per cohort**, 95% moving-block bootstrap CI [-0.464%, +0.206%] (B=5000, block=4).
- OOS dates 158; positive folds 1/4; one-sided paired p 0.720905; two-sided 0.55819; FDR q 0.9665.
- Portfolio: overlap 0.6278, turnover 0.3722, added-name DTC 4.746 vs removed 1.737, crowded-share B 0.0291 → C 0.0601, incremental max drawdown -39.972%.

## Fold detail
- fold 1: train 2022-07-21→2023-04-10 (37), purge 2, test 2023-05-01→2024-02-08 (40), incremental -0.148%
- fold 2: train 2022-07-21→2024-01-25 (77), purge 2, test 2024-02-15→2024-11-15 (39), incremental +0.391%
- fold 3: train 2022-07-21→2024-11-01 (116), purge 2, test 2024-11-22→2025-09-08 (40), incremental -0.532%
- fold 4: train 2022-07-21→2025-08-22 (156), purge 2, test 2025-09-15→2026-06-17 (39), incremental -0.127%

## Discrepancy investigation (arm contrasts, diagnostics only)
- B minus A: +0.673%/cohort, CI [0.1117, 1.3403], p(1s) 0.026774, folds 0.0151 / -0.0554 / 1.4674 / 1.2609 (3/4 positive)
- C minus A: +0.566%/cohort, CI [-0.0213, 1.2045], p(1s) 0.047544, folds -0.1329 / 0.3351 / 0.9354 / 1.1339 (3/4 positive)
- C minus B: -0.107%/cohort, CI [-0.4635, 0.2056], p(1s) 0.720905, folds -0.148 / 0.3905 / -0.5319 / -0.127 (1/4 positive)
- The preliminary +0.517%/cohort matches the C−A contrast here (+0.5658%/cohort, 3/4 folds positive) — trained-ridge-with-SI vs the FIXED production OMEGA score — not the true SI increment C−B. The training lift belongs to the ridge baseline (B−A), and the SI features themselves subtract from it. The preliminary run appears to have compared against the fixed score while labeling it the trained baseline.

## Reproduction vs preliminary
- Preliminary: 11770 rows / 129 OOS dates / +0.517% [0.172, 0.878] / 4/4 folds / p 0.0027 / q 0.064.
- This run: 11956 rows / 158 OOS dates / -0.107% [-0.4635, 0.2056] / 1/4 folds / p 0.720905 / q 0.9665.

## Limitations
- Fixed present-day options-liquid list — names that fell OUT of options liquidity are absent (survivorship on the universe definition; the price cache itself keeps delisted series).
- Historical FINRA publication timestamps are unrecoverable; ALL retrospective joins use the conservative settlement+13d fallback and every record carries revisionRisk:true.
- Regime is a frozen SPY-derived rule, not the live macro overlay (no PIT macro series exists).
- Retrospective reconstruction, not live-funnel parity — nothing here can promote anything.
