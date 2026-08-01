# Swing Baselines & Regime Router — Coverage Status (2026-07-31)

Companion to `docs/predictive-redesign-audit.md` (Phases 5–6). This records what the
mandatory-baseline and router requirements actually cover today, what was added in this
pass, and what remains open. Nothing here promotes any model; the existing negative/null
findings (OMEGA `no-edge`, momentum rank-IC ≈ 0 survivorship-free) remain authoritative.

## Swing baseline coverage matrix

Requirement: every swing challenger must be compared against random ranking, raw momentum,
SPY-relative strength, sector-relative strength, within-sector rank, rank acceleration,
current Breakout/Ghost/Coil ranks, and the current production Today rank — on executable
entries with costs on a PIT universe.

| Baseline | Implemented | Where |
|---|---|---|
| random ranking | ✅ | `lib/research/baseline-ranker.js` `randomRanker` (used by RLT + ATLAS-X walk-forwards) |
| raw momentum | ✅ | `lib/atlasx-research.js` `simple-momentum`; RLT ladder carries residual momentum |
| residual momentum | ✅ | RLT `resid10`, ATLAS-X `residual-momentum` |
| within-sector rank | ✅ | `lib/rlt-stage-a.js` `rank-level` |
| rank acceleration | ✅ | `lib/rlt-stage-a.js` `rank-acceleration` |
| SPY-relative strength (as a ranking arm) | ❌ open | only an outcome basis today |
| sector-relative strength (as a ranking arm) | ❌ open | outcome basis only |
| Breakout/Ghost/Coil ranks as arms | ❌ open | RLT exposes an `opts.extraRankers` hook (`lib/rlt-research.js`) that is not yet wired with their scores on identical events |
| production Today rank as an arm | ⚠️ proxy only | `lib/atlasx-research.js` `production-composite` is a proxy, not the served rank |
| executable next-open fills | ⚠️ partial | ✅ ATLAS-X research + `lib/swing-evaluate.js`; ❌ RLT, ❌ `lib/baselines.js` |
| costs in the comparison | ⚠️ partial | ✅ `lib/omega-backfill.js` + offline `research/53-*`; ❌ ATLAS-X (`costAware:false`), ❌ RLT |
| PIT universe (delisted incl.) | ❌ server ops | only the offline `research/50–53-*` scripts run the PIT security master |

**Interpretation discipline:** because no single server op runs the full suite cost-net on a
PIT universe, *no swing walk-forward result from the server ops may support promotion* —
each is stamped `survivorshipSafe:false` and the registries keep every challenger weight-0.
The offline survivorship-free rigs are the promotion-grade venue, and their standing verdict
is negative. Closing the ❌ rows (SPY/sector-relative arms, wiring `extraRankers` with
Coil/Ghost/Today scores on identical events, costs in RLT/ATLAS-X) is the next research
engineering block — see "next experiments" in the final report.

## Swing action vocabulary

The required vocabulary exists across three modules (no single enum carries all six):
`lib/swing-lifecycle.js` (`ENTER_NOW … DO_NOT_CHASE … EXIT_INVALIDATE`),
`lib/patterns/decision.js` (`WAIT_FOR_TRIGGER`), and `lib/atlasx-contracts.js`
(`AVOID`, `NO_TRADE`). Unifying them into one canonical display vocabulary is open work;
until then each view renders its own enum with per-view legends.

## Regime router status

Three routers exist (`lib/algo-router.js` active, `lib/algorithm-router.js` ORBIT-only,
`lib/swing-router.js` episode tilt). Findings against the Phase-6 requirements:

- **Hysteresis / capped increments** — ✅ strong: per-run step caps (`maxStepUp 0.10`,
  `maxStepDown 0.20`), cooldowns, family caps, emergency snap-to-zero.
- **Cash is allowed** — ✅ by design: weights are deliberately not renormalized;
  `unallocated`/`cash` is explicit and fail-closed budgets zero anything unmeasured.
- **Prospective evaluation vs comparators (`op=routercf`)** — ✅ equal weighting, ✅
  recency chaser, ✅ cash, and (added this pass) ✅ **staticBest**: locks the best
  algorithm once from ≥40 strictly-prior rows and holds it forever — the missing "static
  best validated algorithm" arm. Primary metric remains the pre-registered paired daily
  (router − equal) excess.
- **Exact-contract cells (algorithm × horizon × side × regime × …)** — ❌ open: the active
  router keys on algorithm id alone; regime is a scalar compatibility multiplier, side does
  not exist. Building true cells requires per-cell graded samples that do not yet exist at
  meaningful size; with hierarchical shrinkage they would collapse toward the per-algorithm
  evidence the router already uses, so the current per-algorithm behavior is the honest
  small-sample limit of the requested design.
- **Shrinkage toward global evidence** — ⚠️ mixed: `swing-router.js` implements genuine
  empirical-Bayes shrinkage toward a global prior (`PRIOR_STRENGTH 12`); `algo-router.js`
  shrinks small samples toward **zero** (toward cash, the conservative direction). This is
  deliberately left unchanged: shrinking toward a global cross-algorithm prior would *raise*
  small-sample weights, i.e. allocate on thin evidence — the opposite of fail-closed.
- **`routercf` is gross, survivorship-unsafe** — labeled on the payload (`returnsBasis`);
  binding remains triple-locked (fail-closed budgets AND pre-registered CF criteria AND
  prospective confirmation) and no verdict field exists by construction.
