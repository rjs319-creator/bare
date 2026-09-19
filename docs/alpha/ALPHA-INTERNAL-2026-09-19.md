# ALPHA-INTERNAL pass — 2026-09-19

One Claude Fable 5.1 agent, part of the 2026-09-19 swarm, mined the app's OWN Scoreboard ledger for
conditional structure the 09-09 pass did not test. Everything below was preregistered (families and
gates fixed before any number was computed — see the preregistration block in the agent report,
reproduced in `research/experiments/registry.json` id `ledger-conditional-structure-2026-09`) and
is reproducible with `node research/95-ledger-conditional-structure.js --file <op=scoreboard.json>`.
Read-only: no privileged op, no live ranking touched.

Data: persisted `op=scoreboard` 2026-09-19 02:06 UTC — 7,072 picks / 18,668 rows / 82
section:tier:scope groups; each group's date-level cost-net (cost-v3) excess series at its
`lib/strategy-contracts` metric; 72 groups carry a series, 51 have ≥15 dates.

## Verdict: NO CONDITIONAL EDGE. Nothing promotable.

| Family | Cells | BH q≤0.10 survivors | Best nominal |
|---|---|---|---|
| A inverse (short-book) economics | 51 lanes | 0 | SecondWave:Primed +7.0%/1m short, 18 dates, q 0.65 |
| C1 entry weekday | 5 | 0 | max−min spread 0.99pp, all q 0.84 |
| C2 lane persistence | 2 | 1 naive → 0 after null calibration | prior-10 mean slope −0.85 (t −3.51) = demeaning bias |

### A. Shorting the proven-negative lanes does not pay after borrow
Short book = −(gross) − round trip − tier borrow prior (lib/costs: liquid 0.3%/yr, small 2%, micro
12%, biotech 8%); conservative sensitivity liquid 0.5% / small 6% / micro 25% / biotech 15%. Two-sided
p from the app's Newey-West / block-bootstrap summary; BH across all 51 lanes.

Nominal p<0.05 only (none survive; family q for every one of these is 0.6544):

| lane | H | dates | long net | SHORT net | CI95 | t | q | +blocks | conservative |
|---|---|---|---|---|---|---|---|---|---|
| CrossAsset:Lead: | 1m | 20 | +3.39 | -4.76 | [-8.42, -1.1] | -2.86 | 0.6544 | 0/4 | -5.09 |
| screener:Early:small | 5d | 31 | -3.60 | +2.36 | [0.09, 5.23] | 2.18 | 0.6544 | 3/4 | +2.28 |
| SecondWave:Primed: | 1m | 18 | -8.37 | +7.00 | [0.12, 13.89] | 2.3 | 0.6544 | 4/4 | +6.67 |

The three `negativeLanes` the app already holds out (DownDay:WATCH 3d, screener:Breakout:large 5d,
screener:Early:small 5d) flip to +2.4% / +1.7% / n.s. as shorts before FDR and to nothing after it.
CrossAsset:Lead is the most significant cell in the family — as a LOSING short (−4.8%/1m, 0/4 blocks),
i.e. the same sector-beta finding as 09-09 read from the other side. **The AVOID filter is the whole
value of a proven-negative lane; there is no short book in it.**

### C1. Entry weekday: nothing
Lane-demeaned, one observation per calendar date (96 dates, 51 lanes pooled):
Mon -1.11 (n 18, t -0.89) · Tue -0.69 (n 17, t -0.41) · Wed -1.14 (n 16, t -0.49) · Thu -0.15 (n 14, t -0.21) · Fri -0.89 (n 13, t -0.95). Every q 0.8407.

### C2. Lane persistence: a false positive caught by its own null
Pooled OLS of a lane's date value on its prior-10-date mean (both demeaned by the lane's full-sample
mean), date-clustered SE over 73 clusters: slope -0.8535, **t -3.51, q 0.0016, all four
chronological blocks negative** (-0.3987, -1.1892, -0.865, -0.6398). This would have read as
"lanes mean-revert — fade a lane's recent record".

It is mostly arithmetic. Demeaning by the full-sample mean makes a lagged regressor's slope biased
by ≈ −lookback/T (Nickell); 400 within-lane iid permutations — same bias, no time structure — put
the null mean at -0.522 with a 5–95% band [-1.2563, 0.1351]: one-sided permutation p
**0.212**, bias-adjusted slope -0.3315. (Overlapping forward windows would push the null
positive, so the iid shuffle is conservative for a negative finding.) The prior-10 hit-rate cell is
flat (t 0.12).

The preregistered follow-up (triggered by |t|≥2.5 and 4/4 blocks) — long a lane's date only when its
prior-10 mean is below its EXPANDING prior mean, no demeaning, no fitted parameter — makes things
worse, not better: selected dates -0.98% (46 dates, t -2) vs unselected
+1.61% (53, t 1.05); paired difference -1.56% (t -0.93, 1/4 blocks).
**Recorded so the −3.51 is never re-found as a discovery.**

### E. Cohorts no Scoreboard section grades (standing from their own ledgers, public reads)
- **Fade `SKIP` action cohort** — fadebook byAction: n 3,024 resolved, beatRate 57 (Wilson lo 55),
  avgAlpha **+1.73** where fade alpha = −excess (positive = the name fell). The names the fade engine
  declines to short fall MORE than the ones it shorts (SHORT −0.96, SHORT_LIGHT −1.56, WATCH −3.12).
  Pick-level, ungraded on the Scoreboard, no date clustering available publicly, and it pools
  risk-off-gated and drift-suspended reasons. This is the one cohort worth a date-clustered contract
  grade — it needs the fade day ledger rows (privileged `fade/` prefix), not more public reads.
- alphabook prospective (post-registration rows): n 145, meanAlpha −0.88, t −2.37 (DownDay-dominated);
  CERN sleeve +10.85 on 7 resolved — too few to read.
- techev forward: 152 resolved events / 70 dates; every arm still `COLLECTING` on its own gate.
- omegaab r10-vs-score: 25 logged dates, `INSUFFICIENT_DATA`.
- timing: 69 resolved, IC −0.347, green bucket −1.74% (n 68) — the timing light is inverted on this sample.
- coreperf: 20 resolved of 223, cumulative excess −1.7pp over 2 quarters; NAV unavailable (mark gaps).
- alerts legacy edge: n 13,431, hit 48.3%, mean excess −0.03%, conviction rank-IC −0.013 (t −1.47).
- daytradebook 454 resolved: A −2.23% / B −0.90% excess; gapgobook 154: −3.09% net; downdaybook 205: −0.65%.
Nothing here is a positive cohort with a date-clustered basis.

## Infeasible from public data (recorded, not "null")
- (b) per-pick feature splits — gap size, ATR%, score decile, dollar volume, regime/macroRisk at log
  time, first-vs-repeat appearance — need row-level ledgers; `op=scoreboard` ships only date-level
  series plus the byRegime/byLiquidity/bySector cuts already mined on 09-09.
- (d) daytrade time-stop vs contract on logged bars — needs the `daytrade/` day docs.
- (e) archive/, insarchive/, calarchive/, gexarchive/, estarchive/, sec8karchive/, predmkt/, cstudy/
  rows are behind privileged ops; nothing public exposes them.
A one-off privileged row export (or the store token in a research shell) unlocks all three; none is
worth a live code path.

## Deliberately NOT done
No horizon mining, no sector sub-cells, no section overlap, no pure regime lever, no DownDay WATCH
re-read, no re-run of the 09-09 FDR cell pass (ALPHA-REFRESH owns it). No strategy promoted, no live
change, no weight moved.
