# Day-Trade × Gap-and-Go Fusion — 2026-07-06 — **NO-SHIP**

Hypothesis (H): among Day-Trade screener candidates, the subset that ALSO qualifies as a
Gap-and-Go setup the same day (unscheduled non-earnings gap-up ≥5%, ADV ≥ $10M, ORB
triggered — the step-36 event definition) has materially higher forward performance than
non-overlapping candidates. Rationale: the tradeable next-open day-trade label is a coin
flip (step 33), Gap & Go is the one deflation-surviving continuation event — maybe the
intersection concentrates the picks onto real continuation.

Reproduce: `node --env-file=research/.env research/40-daytrade-gapgo-fusion.js`
Data: `research/data/daytrade-gapgo-fusion.json` (45,126 rows + summary).

## Method (pre-registered in the script header before results)

- **Panel**: step-33's candidate panel rebuilt over the full survivorship-corrected cache
  (9,558 names scanned, delisted-inclusive, 2021H2–2026H1) using the **shipped**
  `lib/daytrade` `dayMetrics` + `passesScan` on the three live SCANS → **45,126
  candidate-days** (building 27,217 / liquid 13,042 / explosive 4,867). Step-33 earnings
  (filing-in-hold-window) exclusion applied.
- **Label (a)** — the tradeable one: 3-session excess over SPY entered at the **next
  session's open** (step 33's Y, winsorized [−90%, +300%]).
- **Label (b)**: step-36 realized ORB R (trigger = signal-day high, 2.5×ATR stop, 1:2
  target, HOLD 3).
- **Overlap flag** decomposed per step 36: gap ≥5 · ADV ≥ $10M · non-earnings (±2d) ·
  ORB triggered. **Look-ahead honesty (pre-registered)**: "ORB triggered" resolves
  *during* the forward window, so for label (a) the full flag leaks. The headline test
  uses the **knowable flag** (gap≥5 & liquid & non-earnings — fully known at next open;
  n=4,141); the full flag (n=2,509) is a leak-flagged diagnostic only.
- **Pass bar (pre-registered)**: knowable overlap beats the rest on label (a) with
  t≥2 / perm p<0.05, positive in the majority of years incl. 2022, AND adds
  within-gap-bucket lift over gap-size / continuationScore alone. Else NO-SHIP.

## Results

### 1. Headline (knowable flag, tradeable next-open excess): **FAIL — wrong sign**

| Group | n | mean excess | median | win rate |
|---|---|---|---|---|
| Gap&Go-qualified (knowable) | 4,141 | **−0.25%** | −0.86% | .435 |
| Rest of day-trade candidates | 40,985 | **−0.10%** | −0.44% | .464 |

Diff **−0.15pp** (overlap *worse*), Welch t −0.66, one-sided perm p 0.83. The
intersection does not concentrate continuation at the tradeable entry — if anything the
big-gap day-trade names fade slightly harder after the open.

### 2. The look-ahead flag "works" — and that is the proof of the leak

Full overlap (+ ORB-triggered): mean excess **+3.54%** vs −0.33%, t 12.3. Conditioning
on "the price later broke above the signal-day high" is conditioning on the outcome.
This is exactly the artifact the pre-registration predicted; it is **not** tradeable at
the next open and is reported only to document the trap.

### 3. ORB R label (fair — both sides enter at the trigger): real but not new

Among the 33,729 triggered candidates: qualified n=2,509 meanR **+0.074**, win .491,
PF **1.39** vs not-qualified n=31,220 meanR +0.040, PF 1.24 (t on R 2.56). R-diff by
year: 2021 −0.07, 2022 **+0.08**, 2023 +0.00, 2024 +0.08, 2025 +0.00, 2026 +0.03 —
positive 5/6 but ~zero in two of them. This is the **already-shipped STRONG-tier
Gap & Go edge re-observed inside the day-trade panel** (shipped tier stats: win .498,
PF 1.29, expR +0.046 — statistically the same trade). It's confirmation of the existing
edge, not incremental alpha, and the app already surfaces exactly these events in the
🚀 Gap & Go tab with the ORB plan.

### 4. Robustness (headline diff, excess pp)

Years: 2021 −0.78 · **2022 +0.37** · 2023 +0.17 · 2024 +0.04 · 2025 −0.85 · 2026 +0.23
(4/6 positive incl. 2022 — but all tiny and the pooled diff is negative and insignificant).
Regimes: risk-on −0.75 · neutral +0.42 · risk-off −0.49. No regime pocket rescues it.

### 5. Controls: the flag adds nothing over the existing knobs — **FAIL**

- Nested means: gap<5 −0.13% · gap≥5 all −0.07% · gap≥5 knowable **−0.25%** — the
  extra screens (non-earnings + liquidity) make the next-open hold *worse*, not better.
- Within-gap-bucket knowable-vs-not: 5–7% −0.90pp · 7–10% +0.27pp · ≥10% −0.70pp.
- Rank ICs vs tradeable excess: gap −0.005, relVol −0.032, contScore −0.024, knowable
  flag −0.021 — everything ~0 or slightly negative, consistent with step 33's coin flip.
- Within-contScore-quintile flag diffs: mixed sign, top quintile −0.17pp.
- Curious inversion (diagnostic only, small consolation): gap≥5 candidates *near
  earnings* did better on the next-open 3d hold (+0.32%, n=1,763) than non-earnings
  (−0.25%) — the opposite of the ORB-trade earnings result. Different trade shape
  (unconditional hold vs breakout-conditional); logged, not actioned.

## Verdict: **NO-SHIP**

Pre-registered bar: (i) significance — **failed** (t −0.66, p 0.83, wrong sign);
(ii) year-majority incl 2022 — technically passed but on a negative pooled diff;
(iii) incremental over gap-size/contScore — **failed** (within-bucket diffs ≤0 on
average). The hypothesis is rejected: Gap & Go overlap does **not** rescue the
day-trade coin flip at the tradeable next-open entry.

Why this is the coherent picture, not a fluke: the Gap & Go edge was never "gap-day
names drift up over 3 sessions" — it is specifically the **breakout-conditional** ORB
trade (entry at the trigger, ATR stop, skewed R). Buying every qualified gapper at the
next open without the trigger condition captures the fade side of the distribution too,
and the step-33 finding (all predictable continuation lives in the untradeable overnight
leg) applies with full force. Section 3 confirms the ORB edge is still there inside the
day-trade panel — but that trade is already shipped, as the Gap & Go tab.

No integration proposal (pass-gated; it did not pass). The one defensible non-change:
day-trade cards should **not** get a "Gap & Go confluence" boost for next-open buyers —
the data says that boost would be a small negative.
