# Preregistration — Ephemeral Edge Factory (2026-08)

**Registered:** 2026-08-06 · **Hypothesis id:** `ephemeral-edge-factory` (family `novel-signal-lab`, confirmatory).
**Status at registration:** OPEN — **no scan has run**: the survivor stream begins with the first cron tick. The seal is this document's commit hash.

## §1 The disciplined version of scenario-grinding

Searching endless scenarios until a "mismatch" appears is guaranteed to succeed — test 200 cells and several beat p<0.05 by luck alone. The factory makes grinding safe by separating it from believing:

| Chamber | What it does | Why it's honest |
|---|---|---|
| Generator | mechanical grammar: 5 cross-sectional features × hi/lo extremes, singles + cross-feature pairs, × long/short × 2/5-session horizons = **200 cells**, nothing hand-picked | the search space is enumerated and FROZEN — no human favorite can sneak in |
| Screen | per-cell Deflated Sharpe (Bailey–López de Prado, `lib/evolve-dsr.js`) at **trials = 200**, ≥30 events, 62bps round trip charged | surviving means beating the expected maximum of the WHOLE search under the null, not one lucky backtest |
| Live queue | survivors' current firings logged as paper picks (≤15/tick, overflow recorded), resolved at their horizons; survivor sets recompute daily so decayed cells stop firing | the ONLY evidence lane; temporariness handled by rental, not belief |

## §2 Fixed design (frozen in `lib/ephemeral.js`)

Features: gap1, ret5, relVol, dist20, rangePos — z-scored **cross-sectionally per day** (extreme vs the market that day = the dislocation frame). |z| > 1 defines an extreme. Entry basis: next-session open; label: SPY-excess to +h close; cost: 62bps per event in BOTH screen and live record. Universe: large+small candle caches (~690 names), trailing ~230 sessions.

## §3 Sealed evaluation — holdout `ephemeral-live-prospective`

ONE evaluation, no earlier than **2026-12-01** AND ≥200 resolved live picks spanning ≥3 months. Success: pooled mean net excess > 0 with **date-clustered** t ≥ 2 (per-pick t is overlap-naive and never citable), BH-corrected within `novel-signal-lab`. The in-sample survivor stats shown by `op=ephemeral` are selection artifacts **by construction** and may never be cited as evidence of anything.

## §4 Prohibitions

No grammar/feature/threshold/cost/horizon edits while the stream accrues — any edit is a NEW factory version whose prior stream is closed and recorded. No cell-level claims ever (the hypothesis is about the stream). No early reads of the live lane as evidence. Any deviation is a NEW hypothesis widening `novel-signal-lab` (a family whose 9 prior engines all closed no-edge — the honest prior here is LOW, and the factory exists to beat it live or die trying).
