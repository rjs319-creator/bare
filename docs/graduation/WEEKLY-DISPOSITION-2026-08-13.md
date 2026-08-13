# Weekly Disposition Report — 2026-08-13 (cycle 1)

First run of the Phase H process (`GRADUATION-LEAGUE-2026-08-12.md`). Human in the
loop: everything below is a measurement or a **recommendation**; no registry
transition is executed by this report.

## 1. op=maturity (summary written 2026-08-13T02:19Z, post-repair evidence)

- **Grades**: 4 promising (`events`, `fade`, `screener`, `gapdown`), 48
  experimental, 8 informational. 0 validated (promotion ceiling holds).
- **Governance**: clearedWeight **0**; all 60 registry entries at `paper`.
  `governancePersisted: skipped (untrusted-caller)` — correct fail-closed
  behavior for a public read; the nightly authenticated run persists.
- **FDR**: benjamini-hochberg, tested 16, demoted 0.
- **Survivorship (noHistory) — measurable again for the first time** (F-01 fix):
  23 strategies report finite rates. Three exceed the 5% validated-path ceiling:
  `events` **18.6%** (34/183), `readthrough` **16.7%**, `attention` **14.2%**.
  These fail the Validated gate closed exactly as designed.

## 2. op=scoreboard

79 groups, 4,504 picks; summary persisted with no write error; all groups carry
`noHistory` + the mtm lane; market/sector baselines read `basis: net`.

## 3. op=redundancy (⚠ cached model — predates this week's deploy)

- ghost×screener measured credit **0.248** (was 0.359 at last measurement) —
  standalone Ghost contributes ~a quarter of an independent strategy's evidence.
- ghost×momentum 0.995, momentum×screener 0.831 (measured).
- emergingleader pairs read **prior credit 1.0** — the cached model predates the
  family-map coverage fix (PR-02); after the next nightly rebuild these
  same-family pairs must read the 0.3 family prior. **Verify next cycle.**
- `confirmationPays: true (avg lift 0.57)` in this cached run contradicts the
  earlier measured −0.282 — re-read after the rebuild before trusting either.

## 4. op=hypotheses

43 registered: 24 no-edge, 16 open, **2 provisional** (`downday-v-reversal`,
`coil-compression` — both backed by in-repo docs), 1 retired.
`unscheduled-gap-orb` now reads **open** (F-08 downgrade live). The two entries
whose preregistered gates cite the drift-eval harness (`earnings-date-revision`,
`revision-cascade-velocity`) will now be judged on the **date-clustered**
statistic (QM-4 fix deployed before any earliest-test date arrived).

## 5. Disposition review (recommendations — human registry transition required)

| strategy | evidence this week | recommendation |
|---|---|---|
| screener (production) | promising; n=29 picks / 18 dates post-reset; dateNet +0.83 (CI spans 0) | **retain** — keep accruing; nothing to act on at this sample |
| events (CERN) | promising, but noHistory 18.6% and its cost tier just moved liquid→small (F-05) — record will re-earn on corrected friction | **retain-shadow**, watch; lineage task: recover/annotate the delisted third |
| fade | grade promising, but the **date-level** net excess is negative (−1.3%/date, CI [−3.99, +1.24]) | **retain-shadow (avoid-only)**, watch — if the date-level CI clears below zero the demotion route fires on its own |
| gapdown | promising on n=17 / 9 dates — far too thin to mean anything | **retain-shadow**; the census retire-duplicate (merge into gapgo) recommendation stands for review |
| ghost | measured independence credit fell to 0.248 vs screener | **retire-duplicate recommendation STRENGTHENED** — decision requested from the owner |
| attention, readthrough | noHistory 14–17% | **retain-shadow** with a data-lineage task before any grade is trusted |
| everything else | experimental/informational, accruing | **retain-shadow** per census |

**Promotions:** none proposed; nothing is near the gate and the ceiling holds.
**Demotions executed this week (from the graduation pass, already merged):**
ignition → shadow; apex/conviction consumption stripped from client surfaces.

## Next-cycle checklist (2026-08-20)

1. Confirm the rebuilt redundancy model applies family priors to emergingleader
   pairs and re-read `confirmationPays`.
2. Confirm the nightly authenticated maturity run persisted governance +
   logged the week's transitions to the hash-chained ledger.
3. Re-read `events`/`fade` grades on the corrected cost tiers and the
   date-clustered lane.
4. Ghost retire-duplicate decision from the owner.
5. Progress on open findings ledger items (prosecutor wiring, research/data
   versioning).
