# Preregistration — Congestion 21s Prospective (2026-08)

**Registered:** 2026-08-05 · **Hypothesis id:** `congestion-21s-prospective` (family `event-drift`) · **Mode:** confirmatory.
**Status at registration:** OPEN — **no qualifying event exists**: the design applies only to earnings announced after 2026-08-05. The seal is this document's commit hash.

## §1 Motivation (exploratory — spent, never reusable)

`announcement-congestion` (record `2bfd95c8e9bd0895`) FAILED its frozen 63-session primary on 2021-2026 events. Its recorded SECONDARY observation: small-cap **21-session** congested-minus-quiet LS spread +4.46% (t 2.55), monotone across terciles (quiet −1.19% → congested +3.27%, t 3.48). The horizon was chosen by that data, so that window can never confirm it. This registration is the program's template case for *lead → prospective test*.

## §2 Hypothesis

On earnings events announced **after 2026-08-05**, small/micro-cap SUE long-short drift at **21 sessions** is stronger on congested announcement days than quiet days.

## §3 Fixed design (no degrees of freedom remain)

- Events: SUE per the frozen `lib/pead.js` construction (PIT trailing σ over ≤12 prior surprises excluding the event, ≥4 prior, winsor ±8), small and micro scopes (cached-universe membership at evaluation time recorded).
- Congestion: same-day announcer count over the full research earnings-cache universe; within-scope terciles.
- Outcome: SPY-excess, close-after-announcement → +21 sessions. **Only** 21 sessions — the 63s question was asked and answered (failed); re-asking it is prohibited.
- **Success (ALL required):** congested-minus-quiet spread of top-vs-bottom-SUE-quintile LS positive in BOTH scopes; pooled-SE t ≥ 2 in at least one scope with the other positive; sign-shuffled control ≈ 0; BH q ≤ 0.10 within `event-drift` at evaluation-time familyTrials; cost-net long leg positive at the small tier.

## §4 Sealed data — holdout `congestion21-prospective`

ONE evaluation, no earlier than **2027-08-01** AND ≥800 qualifying events spanning ≥3 distinct earnings seasons. Accrual arithmetic: the exploratory window produced ~430 small-scope events/year from 150 names; with micro added, ≥800 plausibly accrues by mid-2027. Interim reads of any spread/drift on accruing events open the holdout (event/coverage counts are fine). The calarchive stream provides an independent PIT congestion cross-check at evaluation time.

## §5 Prohibitions

No horizon changes, no tercile redefinition, no scope/subgroup mining, no backfilled congestion sources. A collector or cache gap extends accrual; it never justifies substitution. Any deviation is a NEW hypothesis widening `event-drift`.

## §6 Even a pass is not promotion

A pass yields pass-provisional evidence for a conditioning feature; live use additionally requires the governance ladder (shadow → artifacts → probation) and survivorship-safe review.

## §7 Analysis code

Deliberately not written yet; will mirror `research/58-momentum-horizons-confirmatory.js` (accrual-count-only interim mode, no-peek guards) when the earliest-test window approaches.
