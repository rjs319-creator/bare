# CATALYST–FLOW RANKER — preregistration, schema, and result

**Status: RESEARCH / SHADOW. Weight 0. Not promotable.**
Engine `catalyst-flow-v1` · built 2026-08-14 · branch `research/catalyst-flow-ranker`

A leakage-safe, event-conditioned swing-ranking experiment. Fresh earnings or material
guidance events are observed for one complete post-event session, every feature is frozen
at that session's close, entry is the next session's open, and the hold is exactly five
trading sessions. Up to ten positive-edge candidates are ranked and held equal-weight; the
rest of the book is cash.

The economic hypothesis is **post-earnings/guidance underreaction**. Signed customer
opening option flow is a potential incremental confirmation signal. The model does not
supply the hypothesis — it only ranks within it.

---

## 1. Headline result

Measured on 310 out-of-fold decision-date cohorts (7,030 event rows), sector-relative and
net of the liquidity-aware cost model. The inference unit is the **decision-date cohort**,
never the stock row, because five-session holds started on nearby dates overlap heavily.

Every arm uses the **same abstention machinery**: its own scores, calibrated to expected
net edge inside the training fold only. Only the score differs. (An earlier build gave E2 a
fitted calibration while E0/E1 used a raw one-day return as their edge proxy; that made the
arms abstain at wildly different rates and confounded the ablation — see §10.)

| Arm | Primary (calibrated abstention) | p | BH q | Abstained | Forced top-10 (no abstention) | p |
|---|---:|---:|---:|---:|---:|---:|
| `E0_CURRENT_OMEGA` | −0.9 bps | 0.919 | 0.919 | 291/310 | **−79.2 bps** | 0.001 |
| `E1_SIMPLE_PEAD` | −3.3 bps | 0.712 | 0.919 | 289/310 | **−84.4 bps** | 0.001 |
| `E2_CATALYST_RANKER` | −19.8 bps | 0.479 | 0.919 | 153/310 | **−83.4 bps** | 0.001 |
| `RIDGE` | 0 bps | — *(all-cash: constant series, no dispersion to test)* | — | 310/310 | −84.1 bps | 0.000 |
| `E3_CATALYST_FLOW_RANKER` | — | — | — | — | — | **INSUFFICIENT_DATA** |

**Ablations**

| Ablation | Value | p | BH q | Verdict |
|---|---:|---:|---:|:--|
| `E2 − E1` — incremental value of nonlinear ranking | −16.5 bps | 0.569 | 0.919 | **NO_INCREMENTAL_ALPHA** |
| `E2 − E1` with abstention REMOVED — pure ranking | +1.1 bps | 0.916 | — | **no ranking-skill difference at all** |
| `E3 − E2` — incremental value of signed options flow | — | — | — | **INSUFFICIENT_DATA** — never measured |
| `E2 − RIDGE` — nonlinear vs linear, same folds | −19.8 bps | 0.479 | — | no difference |

Deflated Sharpe, deflated by the **80 configurations actually tried**: E2 `DSR = 0.246`,
E1 `DSR = 0.333`. Both far below any promotion bar, both on a negative raw Sharpe.

**What this says, precisely.**

1. **No arm produced positive net sector-excess return.** Nothing survives FDR.
2. **The forced-ranking diagnostic is the real finding.** Strip abstention away and make
   every arm hold the same slots on the same dates, and all four rank *identically badly*:
   −79 to −84 bps per cohort, each significant at p ≈ 0.001, and `E2 − E1` collapses to
   **+1.1 bps (p = 0.92)**. LambdaMART has **no ranking advantage** over a transparent
   surprise-plus-confirmation score on this data.
3. **The only thing that helps is refusing to trade.** Each arm's primary result is close
   to zero purely because its calibrated edge is almost always negative, so it holds cash
   (E0 291/310 dates, E1 289/310, RIDGE all 310). The abstention rule works; the ranking
   underneath it does not.
4. **The signed-options question was never asked.** `INSUFFICIENT_DATA` is not
   `NO_INCREMENTAL_ALPHA`.

---

## 2. Data reality (measured, not assumed)

Everything below is a count produced by the pipeline, recorded in
`research/data/catalyst-flow/ledger-manifest.json` and `dataset-manifest.json`.

| Input | State | Consequence |
|---|---|---|
| Earnings actuals + consensus | `research/data/earnings/*.json`, 110,238 reported rows | **1 row** has a `lastUpdated` predating its own announcement. The archive is ~100% post-release. |
| Point-in-time observation | 0 of 24,533 ledger rows were held at their own decision cutoff | Family A is `RECONSTRUCTED_EXPLORATORY`. **Promotion-eligible events: 0.** |
| Announcement time (BMO/AMC) | absent — 0 of 12,749 sampled rows carry a time field | The confirmation session is taken conservatively as the first session *strictly after* the announcement date. |
| Daily bars | 10,096 symbols, 2021-07-07 → 2026-07-06, delisted names' series simply end | Survivorship **reduced**, not eliminated. Delisting *returns* are absent. |
| Sector + security type | Yahoo `assetProfile` / `quoteType`, free, cached | Classification is a **current-state** read: `sectorPitVerified: false`. |
| Sector benchmarks | 11 SPDR sector ETFs, fetched free | Target is sector-relative with **no SPY fallback**. |
| FINRA short interest | 54 usable vintages, settlement-dated | Made visible only after a **derived 10-session publication lag**. Coverage 96.8%. |
| Quoted spread (NBBO) | absent (`docs/blocked-on-data.md` §1) | `spreadProxyBps` is a declared high/low **proxy**. |
| Borrow availability | absent (`docs/blocked-on-data.md` §2) | Feature stays missing; never defaulted to "available". |
| **Signed opening option flow** | **absent** | **Family C is entirely null. E3 is `INSUFFICIENT_DATA`.** |

### Feature coverage actually achieved

| Family | Declared | Populated |
|---|---:|---|
| A — fundamental catalyst | 13 | 5 (surprise trio ~71%, Friday flag, same-day count). Guidance, analyst actions, tone, transcripts, text novelty: **0%** — no feed. |
| B — first-session confirmation | 19 | **19 (97.8–100%)** — the only genuinely point-in-time family. |
| C — signed option confirmation | 13 | **0** — by refusal, not by failure. |
| D — risk / context | 7 | 5 (days-to-cover 96.8%). Dilution and borrow: 0%. |

E2 therefore trains on **29 usable columns** of 39 declared.

---

## 3. The signed-options refusal

The free Yahoo option chain gives end-of-day volume and open interest. It cannot determine
**who** traded (customer / professional customer / firm / market maker), **which side**
(buy or sell), or **whether the trade opened or closed** a position. A call print may be a
customer buying to open, a customer selling to close, or a market maker hedging.

So `lib/catalyst-flow/options-signed.js` refuses any adapter that does not declare all
three capabilities, and the refusal is total: a partially-capable adapter cannot populate a
single family-C value at any coverage level. Absent a feed:

- `optionsSignedCoverage = false`
- every family-C value is `null` — **never `0`**, because a zero would assert *balanced
  flow*, a measurement nobody made
- the no-options arm (E2) still runs
- the with-options arm reports `INSUFFICIENT_DATA`
- `NO_INCREMENTAL_ALPHA` is never printed for an empty arm

Free-chain features may be studied in a separately labelled exploratory arm
(`X_FREE_CHAIN_EXPLORATORY`), which carries `substitutableForFamilyC: false` and
`comparableToE3: false` inside the value itself, so a downstream reader cannot lose the
caveat. Exchange coverage rides along because Cboe's C1 history is longer than BZX/EDGX/C2,
and a study that silently mixes a C1-only early period with a four-exchange later period is
comparing two different instruments.

---

## 4. Architecture

Six layers, cleanly separated. `/research/` is `.vercelignore`d, so **no `lib/` module may
require anything under it** — the boundary is enforced by a test.

| Layer | Location |
|---|---|
| 1. Point-in-time event ledger | `lib/catalyst-flow/schema.js` → `research/88-catalyst-flow-ledger.js` → `events.jsonl` |
| 2. Feature builder | `lib/catalyst-flow/{registry,features,eligibility,clock,labels}.js` → `research/89-…` → `dataset.jsonl` |
| 3. Offline trainer / evaluator | `research/catalyst_flow/train_lambdamart.py`, `research/90-catalyst-flow-arms.js` |
| 4. Versioned prediction artifact | `lib/catalyst-flow/artifact.js` → `research/91-catalyst-flow-publish.js` |
| 5. Serving (read-only) | `lib/catalyst-flow/serving.js`, `lib/catalyst-flow-routes.js`, `lib/catalyst-flow/store.js` |
| 6. Research UI | `public/js/catalyst-lab.js`, Research Lab → **⚡ Catalyst–Flow (research)** |

**Ops** (all read-only, dispatched from `api/tracker.js`):
`op=catalystflow`, `op=catalystflowcoverage`, `op=catalystflowregistry`.
There is deliberately **no tick op and no train op** — the absence of a write path is what
guarantees a request can never train LightGBM, and a test asserts the module exports only
`run*` readers and loads only local modules.

**Feature flags** (all safe-default off; the app builds and serves normally with none set):
`CATALYST_FLOW_ENABLED=false`, `CATALYST_FLOW_MODE=shadow`, `CATALYST_FLOW_MODEL_PATH`,
`CATALYST_FLOW_PREDICTIONS_PATH`, `CATALYST_FLOW_ESTIMATES_PROVIDER`,
`CATALYST_FLOW_SIGNED_OPTIONS_PROVIDER`.

`CATALYST_FLOW_MODE=live` **does not make it live.** Mode is earned: `resolveMode()`
returns shadow, naming the failing gates, until every gate in §7 is recorded as passed.

---

## 5. Immutable point-in-time schema (`catalyst-event-v1`)

One row = one observation of one event by one source at one moment. Rows are append-only;
a vendor revision appends a new version with a `supersedes` hash link, and the earlier
observation is never rewritten. `observationAsOf(ledger, id, ts)` returns what was known
*then*, so a later revision is invisible to an earlier decision by construction.

Required: `eventId`, `symbol`, `securityIdAsOf`, `eventType`, `providerEventTimestamp`,
`firstSeenAt`, `ingestedAt`, `featureCutoffTs`, `decisionDate`, `plannedEntryTs`, `source`,
`rawPayloadHash`, `revision`, `pitClass`. Plus EPS/revenue actuals with their frozen
pre-release consensus **and that consensus's own observation timestamp**, guidance fields,
raw-text reference/hash, and data-quality flags.

Enforced invariants: `firstSeenAt ≥ providerEventTimestamp`; `plannedEntryTs >
featureCutoffTs` **strictly**; a consensus observed at or after the release **cannot** be
marked `IMMUTABLE_PIT`; a consensus with no observation timestamp is refused outright.

**Two questions kept apart.** `consensusIsPreRelease` asks whether the *vendor* last wrote
the estimate before the release. `pitClass` asks whether *we* held the observation at the
cutoff. For a bulk archive pull the second answer is always no — we cannot distinguish
"never rewritten" from "rewritten to the same value" — so archive rows are
`RECONSTRUCTED_EXPLORATORY` regardless of the vendor's timestamp. A row observed after its
own cutoff is a *warning* on an exploratory row (that is what makes it exploratory) and a
hard *error* on one claiming point-in-time provenance.

---

## 6. Event clock, eligibility, target

**Clock.** All arithmetic runs on an exchange **session axis**, never calendar days.
Confirmation session = first session strictly after the announcement date (conservative,
since BMO/AMC is unknown: late is a cost, early is leakage). Decision at that close; entry
at the next session's open (or the configured 09:35–09:45 VWAP, which is **refused** rather
than downgraded to the open when intraday bars are absent); exit after exactly five
sessions. A source that misses the cutoff **postpones** the event; nothing is backfilled. A
symbol in an open five-session position cannot be re-entered, checked order-independently.

**Eligibility**, rebuilt independently on every historical date: US-listed operating common
shares (unknown security type is **rejected**, not assumed); unadjusted prior close ≥ $5;
trailing 20-session **median** dollar volume ≥ $5M (median, so one halt-and-reopen print
cannot carry a name over the floor); most liquid 2,000, ties broken on symbol so membership
is byte-reproducible.

**Target.**
`netTarget = winsorised(±30%) 5-session return − 5-session sector-benchmark return − round-trip cost`,
with all three cost cases always reported: fixed 10 bps/side, the liquidity-aware
spread/ADV model, and a 25 bps/side stress case. Cost inputs come only from decision-time
dollar volume.

**Grades**, computed **within one decision date** — never pooled, never using future dates.
Percentile bins (4: top 0.5%; 3: 95–99.5; 2: 80–95; 1: 50–80; 0: bottom half) require ≥200
names to resolve the narrowest bin. **Measured: only 1 of 1,061 dates reached that floor**
(median cohort = 8), so the deterministic rank-based fallback ran on 1,060 dates. It
preserves ordering and the same five-level scale, and each date records which rule it used.
This is also why the trainer's mean validation NDCG@10 of 0.70 is **near-degenerate** and
must not be read as skill: with a cohort of 8, every name is already inside the top 10.

---

## 7. Validation and promotion gates

Nested, strictly causal, purged walk-forward. Outer test blocks of 3 and 6 months, always
later than training. Exactly two preregistered training schemes: rolling-3y and expanding.
Inner validation is the latest 20% of the training window. **Purge:** a training row is
dropped unless its five-session label closes, plus a **5-signal-date embargo**, strictly
before the block — measured in signal dates on the observed axis, never in calendar days.
All stocks from a date stay in the same split. Winsorisation, scaling, categorical
encoding and the edge calibration are fit **inside the training fold only**; LightGBM
consumes NaN natively, so missing stays missing.

Model: `objective=lambdarank`, `metric=ndcg`, `ndcg_eval_at=[10]`,
`label_gain=[0,1,2,4,8]`, `lambdarank_truncation_level=25`, `max_depth` 3–6,
`num_leaves ≤ 31`, learning rate 0.02–0.03, `min_child_samples` 100–200, feature/bagging
fractions 0.7/0.8, L1 1–2, L2 5–10, early stopping at 50. **Four preregistered
configurations only**; all 80 trials are appended to `trials.jsonl` and the count deflates
the Sharpe.

Inference: HAC (Newey-West, lag 4, floored at the IID SE) plus a seeded moving-block
bootstrap, reporting the **wider** interval; Benjamini-Hochberg across exactly the declared
six-member family. The deliberately unpurged read is reported as a **leakage diagnostic
only** (unpurged mean NDCG@10 0.659 vs purged validation 0.701 — the purge is not the thing
inflating this metric; the cohort-size degeneracy is).

**Final holdout: the most recent 12 months remain LOCKED** (`holdoutOpened: false`).
Opening it is a one-time act, and spending it on an experiment already blocked on data
grounds would burn it for nothing.

### Promotion gates — all must pass, on immutable point-in-time evidence

| Gate | State | Why |
|---|---|---|
| `pitImmutableEvidence` | ❌ | 0 of 24,533 ledger rows observed at their own cutoff |
| `delistingsIncluded` | ❌ | delisting *returns* absent from the price cache |
| `signedOptionsCoverage` | ❌ (E3) | no participant/side/open-close feed |
| `ablationSurvivesFDR` | ❌ | `E2 − E1` q = 0.919; forced-ranking variant +1.1 bps at p = 0.92 |
| `positiveNetOfStressCost` | ❌ | negative at the base case, before the 25 bps stress |
| `deflatedSharpePositive` | ❌ | DSR 0.246 on a negative raw Sharpe |
| `holdoutUntouched` | ✅ | deliberately never opened |

---

## 8. What would change the answer

1. **A genuine estimates vintage feed.** The blocker is *history depth*, not access —
   `lib/est-archive.js` is already accruing daily annual-consensus snapshots (`op=estarchive`),
   which are point-in-time by construction. Quarterly is plan-gated
   (`docs/blocked-on-data.md` §4). Until enough vintages accrue, family A stays exploratory.
2. **Cboe Open-Close or an equivalent licensed feed.** This is the only thing that turns
   E3 from `INSUFFICIENT_DATA` into a measurement. Preserve the exchange-coverage fields.
3. **Delisting returns.** Needed before any survivorship claim.
4. **Larger cohorts.** The median 8-name cohort makes NDCG@10 near-degenerate and forces
   the rank-fallback grading on 99.9% of dates. A wider event universe or a longer window
   would let the preregistered percentile bins actually bind.

## 9. Reproducing

```bash
node research/88-catalyst-flow-ledger.js          # PIT event ledger  (+ free reference ingestion)
node research/89-catalyst-flow-features.js        # frozen feature snapshots + targets + grades

python3 -m venv research/catalyst_flow/.venv
research/catalyst_flow/.venv/bin/pip install -r research/catalyst_flow/requirements.txt
brew install libomp                               # macOS: LightGBM's OpenMP runtime
research/catalyst_flow/.venv/bin/python research/catalyst_flow/train_lambdamart.py --arm E2_CATALYST_RANKER

node research/90-catalyst-flow-arms.js            # locked arms, ablations, FDR, DSR, trial registry
node research/91-catalyst-flow-publish.js         # versioned artifact (add --publish to upload)
```

LightGBM is **never** silently substituted: if it will not import, the trainer exits with
the setup command.

---

## 10. Defect log

Bugs found and fixed in this build. Recorded because each one produced a *plausible*
wrong answer rather than an error, which is the only kind worth writing down.

**1. Ridge solver returned all-`NaN`.** The Gauss-Jordan back-substitution ended
`row[n] / row[i][i]`, indexing into a number. Every coefficient and every prediction was
`NaN`, so the RIDGE arm scored zero candidates on every date and the evaluator recorded it
as a clean, deliberate abstention. A test asserting `beta.length` would have passed; the
test now asserts finiteness and that the fit recovers a known relationship.

**2. p-values computed from a rounded mean.** `lib/evidence-stats.summarizeDateSeries`
rounds its reported mean to 2 decimals — correct for percentages, fatal for a per-cohort
excess return of ~0.002, which becomes `0.00` and drives every t-statistic to noise. The
evaluator now recomputes the mean at full precision and derives p from that. Every number
in §1 would otherwise have been wrong, in both directions.

**3. `Number(null) === 0` in the eligibility screen.** A *missing* unadjusted close was
reported as `price-below-floor` — an attrition ledger claiming a measurement nobody made.

**4. Revision rows had unverifiable hashes.** `appendObservation` rehashed over
`{...row, rowHash: undefined}`, which the canonical serialiser rendered as a
`"rowHash":undefined` member that the originally-hashed object did not have. Revision 1
verified; revision 2 onward did not. The append-only ledger's whole purpose is to be
auditable, and from the first vendor revision it silently was not. Fixed at the root —
`canonicalJson` now omits `undefined` members exactly as `JSON.stringify` does — and a test
walks a three-revision chain checking both recomputability and the `supersedes` links.

**5. The ablation confounded ranking quality with abstention policy.** *(the one that
changed the answer)* E2 received a fitted in-fold decile→edge calibration; E0 and E1 used a
raw one-day sector-excess return as their "expected edge". The machinery differed, so the
arms abstained at very different rates (E2 held cash on 153 of 310 dates, E1 on 45). Every
arm's mean is negative, so abstaining more mechanically moves an arm toward zero — and
`E2 − E1` was reading that difference as ranking skill. It reported **+43.4 bps**.

With one calibration mechanism applied to every arm, and a forced top-10 variant added to
isolate ranking with abstention removed entirely, the same ablation is **−16.5 bps
(p = 0.57)** primary and **+1.1 bps (p = 0.92)** forced. The apparent advantage was
essentially all abstention, none of it ranking.

**6. A constant series emitted a `NaN` p-value.** An arm that abstains on every date is
all-cash, so its per-cohort series has no dispersion and there is no test to run. It now
reports `p: null` with `pUnavailableReason`, because a `NaN` printed in a results table
reads like a number.
