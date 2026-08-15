# OMEGA ridge training lift — OMEGA_RIDGE_LIFT_5D_TOP10

> Research only. Does not affect live OMEGA. Generated 2026-08-14T14:49:09.781Z.

**Verdict: `SHADOW_CANDIDATE`** (all frozen gates passed — see interpretation before drawing conclusions)

## Specs (B−A lift = trained ridge minus fixed OMEGA, net per cohort)
| spec | OOS | lift | 95% CI | folds+ | p(1s) | q |
|---|---|---|---|---|---|---|
| primary_62_top10_5s (PRIMARY) | 158 | +0.673% | [0.1117, 1.3403] | 3/4 | 0.026774 | 0.0268 |
| broad_top10_5s | 158 | +1.019% | [0.1128, 1.9839] | 4/4 | 0.02518 | 0.0268 |
| secondary_top5_5s | 158 | +1.000% | [0.1846, 1.9212] | 3/4 | 0.025834 | 0.0268 |
| secondary_top10_10s | 158 | +1.430% | [0.3303, 2.8022] | 3/4 | 0.00265 | 0.0132 |
| doubledcost_top10_5s | 158 | +0.694% | [0.1544, 1.3317] | 4/4 | 0.016144 | 0.0268 |

## Controls (primary universe)
- shuffledLift: +0.109%/cohort CI [-0.314, 0.5637], p(1s) 0.330987, drop-3-best -0.032%
- randomLift: +0.434%/cohort CI [0.0168, 0.8527], p(1s) 0.025378, drop-3-best +0.302%
- momentumLift: +0.915%/cohort CI [0.2217, 1.6052], p(1s) 0.004942, drop-3-best +0.592%
- ridgeVsMomentum: -0.242%/cohort CI [-0.8424, 0.4363], p(1s) 0.766461, drop-3-best -0.474%
- Arm means/cohort: fixed OMEGA -0.003%, ridge +0.670%, r10 momentum +0.912%, random +0.431%.
- Broad universe (306 names): ridge lift +1.019% vs momentum lift +1.018%, ridge-vs-momentum +0.001%, random lift +0.529%.

## Interpretation

The gates pass, but the momentum control explains the lift: plain r10 beats fixed OMEGA by at least as much as the ridge does, and the ridge does not beat plain r10 — the "training lift" is momentum exposure, not learned structure. A seeded random ranker also beats fixed OMEGA, so beat-A lifts sit on a below-random baseline. Recommendation: do NOT build a ridge overlay; the repeat finding is that the fixed OMEGA score ranks poorly on its own universe (consistent with lib/omega-research-verdict.json).

## Limitations
- Hypothesis and primary panel share the same data (see hypothesisProvenance).
- Broad universe is the PRESENT-DAY LARGE/SMALL lists with a full-sample ADV screen — selection is not point-in-time; comparable momentum lifts previously deflated to no-edge on survivorship-complete panels.
- Ridge is trained on realized net residuals of an overlapping panel; per-date cross-sections are not independent.
- Same execution realism limits as research/89 (next-open fills, tiered costs, frozen SPY regime rule).
