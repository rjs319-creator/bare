# ORBIT-ML — Promotion Policy

ORBIT-ML is a shadow EVOLVE specialist (`idiosyncraticPersistence`) with **no
`SOURCE_SPECIALIST` mapping** — the structural `affectsLiveRank:false` flag. Promotion means
adding a source mapping so it can fire on live candidates. That is gated and monotonic-in-rigor.

## The incremental-value gate (the decisive one)
ORBIT-ML does **not** earn live influence from standalone performance. It must **improve the
ensemble after a redundancy adjustment**:
- `lib/orbit-ml-ensemble.js redundancyContribution` — average credit vs peers ≥ 0.6
  (largely-independent) AND
- `leaveOneOutIC.marginalDelta > 0` (adding ORBIT-ML raises the ensemble rank-IC).

Current status: `marginalDelta = −0.016` ("hurts-ensemble") on the validation sample →
**the gate is currently FAILED.** No promotion.

## Full promotion gates (all required)
1. **Survivorship-safe PIT universe** with delisted names — else `survivorshipSafe:false` and
   production-grade is blocked outright.
2. **Nested outer-OOS rank quality** — purged, embargoed daily rank-IC positive with ICIR and a
   positive-IC date fraction across ≥8 outer blocks spanning ≥2 regimes (survives a 2022 bear).
3. **Positive net expectancy after costs** at the horizon claimed.
4. **Calibration** — horizon-specific OOF calibrator beating the base rate; else probabilities
   are exposed as `null` + rank score only.
5. **Positive marginal ensemble contribution** (the gate above).
6. **Prospective shadow validation** — a live-forward `orbit-ml/` ledger (≥ ~20 independent
   decision dates) reproducing the OOS edge out-of-time, health `HEALTHY`.
7. **Multiple-testing honesty** — deflated Sharpe (`evolve-dsr`) over the specialist×regime×horizon
   grid, configurations logged in the experiment manifest.

## Grades (native A–F → maturity vocabulary)
A validated · B promising · C inconclusive · D degradation · F broken/negative. Current: **C**,
gated toward FAIL by the negative marginal contribution. Grade A requires gates 1–7 all clear.

## Promotion steps
1. Shadow accrual (now): tick logs the ranked cross-section, resolve labels forward, monitor.
2. If gates clear on a survivorship-safe universe → add a `SOURCE_SPECIALIST` mapping so it fires,
   but keep EVOLVE's own cold-start pooling + calibration + DSR gates in front of it (a fresh
   specialist cannot reach the TRADE gate alone by construction).
3. Any regression (health BROKEN / negative marginal) → remove the source mapping (immediate).
