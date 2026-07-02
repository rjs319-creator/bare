# Day-Trade Momentum-Continuation Probability (`pcarry`) — 2026-07-02

Goal: invent a technique to improve the Day Trade section — surface MORE picks and attach
a PROBABILITY that each keeps carrying momentum, from all available data (price/volume/
news/regime), organized into its own algorithm. Designed by a **Fable 5** agent, then
built + validated on the survivorship-corrected daily rig (`research/33-daytrade-continuation.py`).

## The headline finding (the honest truth)
On 26,271 day-trade candidate-days (survivorship-corrected, delisted-inclusive, 2021–2026),
the SAME features predict continuation completely differently depending on the entry:

| Label (3-session) | OOS AUC | Decile spread | Permutation null | Verdict |
|---|---|---|---|---|
| **close-to-close** | **0.70** | **+18.0%** | beats (p=0.000) | strongly predictable… |
| **tradeable next-open** | **0.47–0.50** | +0.9% (both deciles NEGATIVE) | FAILS (p=0.77) | …but a coin flip |

**The entire predictable edge lives in the un-tradeable CLOSE→NEXT-OPEN overnight leg.**
The screener is EOD — you buy at the next open, by which point the continuation is gone.
At the tradeable entry, day-trade momentum candidates on average UNDERPERFORM SPY over 3
sessions (both deciles negative). A sign-constrained fit kept only **2 of 10** price/volume
features (`extHinge`<0, `nearHigh5`>0): the only durable, causal, tradeable-relevant signal
is **fade avoidance** — don't chase overextended blow-offs; favor names still near their
recent high. By-scan base rates confirm it: explosive small-caps continue **43%** vs
building **51%** vs liquid **47%**.

This corrects the section's implicit "momentum continues" premise (and explains why the old
rankScore's +0.08 Spearman — measured close-to-close — wasn't tradeable).

## What shipped: `pcarry` (lib/pcarry.js)
An **honest, calibrated continuation-odds** — NOT a winner-picker. It anchors at the empirical
base rate (~49%) and tilts only with causally-grounded, validated levers:
- **overextension penalty** (`extHinge = max(0, pctChange/ADR20 − 3)`, data-fit coef < 0) — the blow-off-fade, represented *causally* (a +8% day on a 1.5%-ADR name is penalized; on a 6%-ADR name it isn't).
- **near-recent-high bonus** (`nearHigh5`, data-fit coef > 0).
- **news catalyst** (via `classifyGapCause`): offering/dilution & M&A → −; FDA/guidance/contract → + (theory-priors from the gap-cause pilot; news history isn't trainable).
- **regime**: risk-off → − (the one durable macro lever).
- **scan base-rate offset**: explosive_small −, building +.
Output clamped to **[30%, 66%]** — it structurally can't overclaim. Shipped as a pure-JS
logistic (data-fit price coefs + theory-prior offsets), fully unit-tested (8 tests).

Live behaviour (verified): moderate mover 53% · blow-off 38%⚠ · explosive 35%⚠ ·
offering 42% · FDA 58% · risk-off 47% · moderate-building 58%.

## More picks
Wider net (caps 40/30/30 → 60/45/45) — quality preserved by ranking on carry odds instead
of a hard cutoff. "⭐ Best Opportunities" now ranks the WHOLE green pool by carry;
overextended/explosive names flow through but the model discounts them so they sort to the
bottom (soft, calibrated tilt vs the old hard exclusion).

## Fable-5 extras carried into the design (not all shipped in v1)
- Staged news fit (offset logistic) once ≥300 tagged ledger rows accrue; ship theory-priors meanwhile. ✅ priors shipped.
- Short-interest squeeze fuel (x12) — exploratory, dropped (own research found SI negative/unstable). Not shipped.
- Sector sympathy — pre-registered **v2** hypothesis (sector ETF 5d excess), not tested yet.
- Post-deploy calibration monitor: bucket resolved ledger picks by carry quintile vs realized beat rate (follow-up).

## Failure modes caught
Redundancy (must beat rankScore — it does by ΔSpearman on close-to-close, but that's overnight);
**label leakage / non-tradeability** — the whole point of the finding (close-to-close flatters,
next-open is honest); regime overfit (regime is an explicit input + per-regime checks).

Reproduce: `research/intraday/.venv/bin/python research/33-daytrade-continuation.py [open|close]`.
Model: `research/data/pcarry-model.json`.
