# Alpha refresh — 2026-09-19

Re-read of the live evidence ten days after the 2026-09-09 swarm pass
(docs/alpha/ALPHA-SWARM-2026-09-09.md), on the persisted `op=scoreboard` written
2026-09-19 02:06 UTC (7,072 picks / 18,668 rows / 82 section:tier:scope lanes × 7 horizons),
`op=maturity` (62 strategies), `op=today`, `op=insidercluster` and the three live
`/api/screener` scopes. Reproducible: `node research/99-alpha-refresh-fdr.js` (fetches
production read-only; or pass saved payload paths). Artifact under
`research/data/evidence/alpha-refresh/` (gitignored).

Method is the 09-09 method, unchanged: one BH family over every lane × horizon cell and its
regime / liquidity / sector sub-cells with ≥8 decision dates; p from
`lib/evidence-stats.pValueOf` (HAC SE, Student-t at the effective sample size — the same
statistic the maturity gates use); survivors at q ≤ 0.10 split by sign.

## Verdict

| | 2026-09-09 | 2026-09-19 |
|---|---|---|
| cells tested | 1,512 | 1,727 |
| nominal p<0.05 | 220 | 258 |
| BH survivors q≤0.10 | 25 | 50 |
| positive survivors | **0** | **0** |
| negative survivors | 25 | 50 |

**Nothing has become promotable.** Ten more sessions of ledger doubled the robust-negative
set and produced no robust positive. The survivor list is not diffable name-by-name (the
09-09 pass kept its cell list outside the repo), so from here on the artifact is committed
by date and the diff is mechanical.

### Negative survivors, by lane (50 cells, 14 lanes)

- **screener:Breakout:large** — 1m −4.24% [−6.44, −2.05] over 31 dates, 20d −4.20%, 10d
  −3.87% (all 0/4 blocks). Contract 5d −1.98% [−3.92, −0.24] over 30 effective dates.
- **screener:Early:small** — 20d −13.3% [−19.45, −7.15] (21 dates), 1m −12.71%; contract 5d
  −3.60% [−6.42, −1.33]. Its Technology sub-cell is −24% at 20d over 8 dates.
- **coil small** (normal/quiet/elevated) — 1m −10.7% to −12.7%, 20d −9.8% to −11.3%, 0/4
  blocks; **coil:normal:micro** 3d −2.81% [−4.27, −1.34] (18 dates). Contract 5d cells all
  span zero (e.g. coil:normal:small 5d −3.82% [−8.6, 0.96]), so the coil lanes are NOT
  negative lanes under the contract rule — the damage is post-exit carry, as with daytrade:A.
- **daytrade:A** — 5d −5.33% [−7.86, −2.79] over 33 dates, 10d −5.09%; contract 1d +0.71%
  [−1.89, 3.30]. Same shape as 09-09: the 1d exit is flat, what follows it is not.
- **DownDay:WATCH** — 1d −2.00% [−2.94, −1.06] (20 dates, 0/4 blocks); contract 3d −1.65%
  [−3.07, −0.24] over 19 effective dates. **New negative lane since 09-09** (its 3d cell
  spanned zero then). Now the third entry in `negativeLanes`.
- **EmergingLeader:large** 10d −2.85% [−4.49, −1.21] (14 dates); **SecondWave:Early**
  risk-on 1d −1.97%; **Ghost:STALKING:large** Industrials 20d/1m −6.6% and Real Estate 10d
  −6.25%; **Fade:SHORT_LIGHT** Consumer Staples 3d / Unknown 1m (sector forks, ≤17 dates).

### Nearest positive misses (all fail FDR; none at their contract horizon)

| cell | avg | CI95 | dates (eff) | blocks+ | q |
|---|---|---|---|---|---|
| CrossAsset:Lead risk-on 10d | +4.45% | [1.41, 7.49] | 18 (18) | 4/4 | 0.165 |
| Fade:SHORT Real Estate 10d | +3.53% | [1.10, 5.95] | 10 (10) | 4/4 | 0.192 |
| GapDown:STRONG risk-on 10d | +5.78% | [1.04, 10.26] | 17 (8) | 4/4 | 0.230 |
| momentum:StrongSell 10d (short basis) | +4.82% | [0.66, 8.98] | 12 (10) | 4/4 | 0.269 |

- **CrossAsset:Lead** is still the only lane with a positive point estimate at several
  horizons: contract 1m +3.39% [−0.27, 7.05] over 20 dates (12 effective), 4/4 blocks — but
  **vs its sector −0.34% (42% beat rate)** at 1m, and the maturity grade says the same
  ("beats SPY +2.18% but NOT its sector −0.17%"). The 09-09 sector-beta read stands. Its
  window is still 2026-07-02 → 08-19 at 1m.
- **momentum:StrongSell 10d** is a 12-date, off-contract (contract is 1d, where
  HIST_StrongSell is −0.39% over 25 dates) read of a short-basis lane. Mining, not a lead.
- **GapDown:STRONG 10d** (+6.58% net vs SPY, +3.02% vs sector) has 8 effective dates and 2/4
  blocks at the all-regime cell; the risk-on sub-cell is the same 17 dates relabelled.

### Regime-conditional reads

None are testable. The ledger is 5,193 risk-on picks vs **3** risk-off: no lane has ≥8 dates
in both regimes, so every "risk-on" sub-cell is the all-regime cell renamed. The regime
lever remains an untested prior on this ledger.

### Accrual and earliest plausible promotion

Lanes accrue 1.5–4.75 decision dates/week (trailing 4 weeks). Everything with a positive
point estimate at its contract already has ≥20 dates; what stops each is the CI, not the
count:

- CrossAsset:Lead 1m — CI lower −0.27; 12 effective dates (needs ≥12, met); sector-relative
  negative. Would need ~2 more months at its current mean AND a sector-relative reversal.
- screener (maturity strategy) — "beats SPY net but only 48 resolved episodes (needs 50)":
  clears the count within a week, then fails the date-level-CI gate (every screener lane's
  contract CI spans zero or is negative).
- CERN:LOCKUP_EXPIRY 1m +8.93% [−7.89, 25.76] over 31 dates, **−22.66% vs sector** — a
  lottery-shaped distribution; not a candidate.
- Ghost:STALKING:large 5d +0.29% [−4.14, 4.72] over 35 dates — flat.
- InsiderCluster shadow ledger: **0 days, 0 rows** (deployed after the 09-18 cron; first
  tick due 2026-09-19 22:00 UTC). Expected ~0.3 clusters/session → 20 dates ≈ 3–4 months.

Honest projection: no lane is on a trajectory to clear the Validated gates before the
InsiderCluster ledger matures, and that ledger's retrospective was flat vs SPY.

## Hold-out rules — verified against live data

- `negativeLanes` recomputed with `lib/negative-lanes` from the payload's own groups ==
  shipped: `DownDay:WATCH:`, `screener:Breakout:large`, `screener:Early:small`. No drift.
- Quick Hit / Opportunities (client `splitEvidenceNegative` on `screener:<status>:<scope>`)
  against the live `/api/screener` scopes: large 28 results (Early 9 / Breakout 2 / Setup
  17) → **2 held out (RVTY, TMO)**; small 4 → **1 held out (CRSP)**; micro 10 → 0. Correct.
  DownDay:WATCH never reaches those tabs (they read `/api/screener` only), and the DownDay
  tab is a separate surface — the lane's exclusion there is the expectancy tilt on Today.
- op=today: 19 research rows, 0 from an evidence-negative lane; Today uses its own
  contract-CI "ranked out" rule (`lib/decision.js`), not the `negativeLanes` set — two rules,
  same three lanes today. The screener section's rank-quality verdict has moved from
  `noise` (09-09) to `weak-positive` (IC 0.003, t 0.07 — not significant); the informativeness
  gate now weights its score spread ×0.5 instead of ×0. Cosmetic at that IC.

## Not done, deliberately

No horizon contract touched (the 10d positives are max-of-7 mining); no regime filter
built on 3 risk-off picks; no promotion; coil small lanes NOT added to `negativeLanes`
(contract-horizon CIs span zero — the rule is right to refuse them).
