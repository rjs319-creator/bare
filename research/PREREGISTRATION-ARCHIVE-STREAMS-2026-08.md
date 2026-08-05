# Preregistration — Alpha-Archive Streams (2026-08)

**Registered:** 2026-08-05 · **Hypothesis ids:** `earnings-date-revision` (family `event-drift`), `gex-vol-damping` (family `volatility-structure`), `revision-cascade-velocity` (family `alt-signals`) — plus two EXPLORATORY registrations `overnight-share-conditioning` (family `swing-ranking`) and `announcement-congestion` (family `event-drift`).
**Status at registration:** OPEN — for the three archive-stream hypotheses, **no confirmatory data exists at all**: the ledgers each test needs begin accruing the day the collectors in this same diff first run. The seal is this document's commit hash; any post-hoc edit shows in git history.

---

## §1 Motivation (why archive-first, and what is NOT spent)

This program's repeated finding is that standalone cross-sectional factors on free EOD data are dead (see the registry graveyard: momentum, reversal, NSL, PEAD-SUE, congress, revisions-level, wiki era). The three hypotheses here are different in kind: each depends on **data that cannot be bought retroactively** —

| Stream | Unrecoverable datum | Why no vendor can sell the history |
|---|---|---|
| calarchive | scheduled earnings-date **revisions** | vendors overwrite the scheduled date in place; only daily snapshots preserve the change events |
| gexarchive | per-name option-chain **OI snapshots** | OI is published daily and never archived per-name at chain grain in any retail-accessible feed |
| revarchive | analyst grade/PT **event arrivals** with timestamps | the FMP feeds truncate; the cascade record (who moved first, how fast others followed) survives only if pulled daily |

Nothing is spent at registration: no outcome has been computed from any of these ledgers, because the ledgers do not exist yet. This is the strongest sealing this program can achieve — the entire confirmatory dataset is future data.

The two exploratory registrations (§6) run on the existing 2022-2026 panel/event window and are declared here so the trials are **counted in their family denominators even if the answer is null**.

## §2 Hypotheses

1. **earnings-date-revision** — firms that move a scheduled earnings date earlier outperform (SPY-excess) from the reschedule observation through ~21 sessions past the announcement; delayers underperform (Johnson & So, JFQA 2018).
2. **gex-vol-damping** — high positive single-name dealer-gamma (netGex, customer-flow sign convention) predicts realized vol BELOW the snapshot's ATM implied; negative netGex predicts realized above implied.
3. **revision-cascade-velocity** — initiating analyst grade changes with a slow/no follower cascade (no second firm within 5 sessions) are followed by continued drift in the grade direction; fast-cascade events are already priced.

## §3 Fixed design (no degrees of freedom remain)

Frozen in `lib/research/hypothesis-registry.js` (the registry entry is the authority; this doc summarizes):

- **earnings-date-revision**: events = calarchive revision ledger rows with |deltaDays| ∈ [2, 45]; signed drift-eval (advanced = long, delayed = short) at 21/63 sessions from `observedAt`; success = long-short t ≥ 2 AND signed t ≥ 2 AND ≥2 positive regimes AND BH q ≤ 0.10 within `event-drift` at evaluation-time familyTrials; baseline = sign-shuffled control.
- **gex-vol-damping**: name-days with ≥500 total OI and ≥4 contracts used; target = forward 5-session realized vol ÷ snapshot atmIV; metric = mean daily Spearman vs netGex/dollar-OI with Newey-West HAC t, ESS ≥ 30 days; must survive excluding expiry weeks; benchmark = atmIV-only ranking (the claim is INCREMENTAL to IV). **The vol-forecast test gates any return-signal work on this data.** Sign convention (net = calls − puts) is frozen in `lib/alpha-archive.js`; flipping it post hoc is prohibited.
- **revision-cascade-velocity**: initiating event = upgrade/downgrade with no other firm's grade on the symbol in the prior 10 sessions; cascade window = 5 sessions; success = slow-cohort signed t ≥ 2 AND slow-minus-fast spread t ≥ 2, ≥2 positive regimes, BH-corrected within `alt-signals`.

## §4 Confirmatory data — sealed prospective ledgers (registry `HOLDOUTS`)

| Holdout | Earliest evaluation | Sample condition |
|---|---|---|
| `calrev-prospective` | 2027-02-01 | ≥400 qualifying revisions spanning ≥2 earnings seasons |
| `gex-prospective` | — | ≥60 trading-day snapshots, ≥300 qualifying names/day median |
| `revcascade-prospective` | 2027-02-01 | ≥500 initiating events with observed cascade windows |

ONE evaluation each. Reading a ledger to compute any outcome-shaped quantity before its condition holds **opens the holdout** and is recorded irreversibly. Collector telemetry (row counts, coverage, truncation) is explicitly NOT outcome-shaped and may be monitored freely — data-quality monitoring is required, peeking is prohibited.

## §5 Prohibitions

- No interim drift/IC/correlation reads of any stream before its earliest-test condition.
- No threshold tuning (delta-day band, OI floor, cascade window, initiation lookback are frozen above).
- No post-hoc sign-convention changes, no normalization search, no subgroup mining beyond the preregistered splits.
- No added horizons. Any deviation is a NEW hypothesis that widens its family denominator.
- A collector outage does not reset anything: gaps simply extend accrual time. Backfilling from any retroactive source is prohibited (it would not be PIT).

## §6 Exploratory registrations (spent on completion)

- **overnight-share-conditioning**: one pass of `research/67-overnight-share.js` on panel-v3 2022-2026 with `onShare63`/`tugOfWar63` features frozen in `research/15-panel-features-v3.js` before the run. Known artifact to check FIRST: vendor opens are split-adjusted but not dividend-reinvested — ex-div bars must be handled or the "overnight" return embeds the dividend.
- **announcement-congestion**: one pass of `research/68-announcement-congestion.js` — SUE long-short drift split by same-day announcer-count tercile (counted over ALL US announcers from the FMP calendar), within-scope so congestion is not a size proxy. Honest prior is LOW: unconditional SUE-PEAD already failed on this window; this asks only whether congestion modulates it.

Both windows are spent when the passes complete. Any confirmatory claim requires a new preregistration on unseen data.

## §7 Analysis code

The confirmatory runners for §2 deliberately DO NOT EXIST yet — they will be written against the frozen designs when the earliest-test conditions approach, mirroring `research/58-momentum-horizons-confirmatory.js` (accrual-count-only interim mode, no-peek key guards). The collectors shipped with this document are write-only: `lib/alpha-archive.js`, `lib/alpha-archive-routes.js` contain no drift, IC, or correlation computation, and `test/alpha-archive-prereg.test.js` locks the registry entries, the sealed holdouts, and the write-only property.

## §8 Post-registration amendments & exploratory outcomes (2026-08-05, same day)

- **Amendment (announcement-congestion denominator):** the FMP earnings-calendar endpoint rejects historical `from` dates on the current plan (probed; the first run threw on chunk 1 **before any outcome was computed**). Substituted denominator: same-day announcer counts across the full 3,438-symbol `research/data/earnings/` cache. Recorded in the runner header and the evidence record.
- **overnight-share-conditioning: NOT-CONFIRMED** (record `547ef66c6cd9bcbf`, panel-v3.3): onShare63 meanIC −0.0015 HAC-t −0.32; tugOfWar63 0.0166 t 1.30 (fails ESS + FDR; control ran t 1.34). Window spent; registry status `no-edge`.
- **announcement-congestion: NOT-CONFIRMED** on the frozen 63s primary (record `2bfd95c8e9bd0895`): spread positive in both scopes but t 0.20/1.43. Secondary (NON-primary, not a result): small-cap 21s congested-minus-quiet spread +4.46% t 2.55, monotone terciles. Any follow-up is a NEW hypothesis on FUTURE events — the calarchive stream supplies prospective congestion counts for exactly that. Window spent; registry status `no-edge`.
