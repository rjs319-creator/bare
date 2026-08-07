# Low-float ignition / intraday continuation — in-session verification

**Verdict: 1 defect found and fixed.** The rest of the stack behaves correctly during a live
session. `FRESH_CATALYST` was a structurally dead discovery lane — 6 of 7 lanes were firing,
never the 7th, in any cycle, ever. Root cause found, fixed, and covered by a regression test on
this branch. Everything else checked out clean.

Run: 2026-08-06, 10:45–10:55 ET, market open, live production traffic (`GET` only — no writer
ops were called; the scheduled GitHub Actions workflow supplied the writes this check reads).

---

## 1. Provider capability

`op=quoteprobe`:
- `resolvedProvider: "yahoo-quote"`, `resolvedVolumeAvailable: true` — as expected.
- `fmpStatus: 402` on `/stable/batch-quote` — known and expected on this subscription.

`op=floatprobe&tickers=AAPL,GME,SAVA`: all three returned real share counts, `HIGH` confidence,
filing dates within the last day (AAPL/GME `2026-08-05`, SAVA `2026-08-01`). Clean.

## 2. The main radar (`op=lowfloat`, read twice, 14:46 and 14:47 UTC)

| metric | read 1 | read 2 |
|---|---|---|
| universeSize | 4,706 | 4,706 |
| universeTruncated | false | false |
| bulkQuotesReceived | 4,706 | 4,706 |
| quoteCoveragePct | 100 | 100 |
| volumeAvailable | true | true |
| candidatesDiscovered | 707 | 711 |
| floatEnriched | 120 | 120 |
| intradayEnriched | 60 | 60 |
| elapsedMs | 17,163 | 11,311 |
| partialResults | false | false |

Both well inside the 50 s deadline.

**`discoveryLaneCounts` — 6 of 7 lanes fired, `FRESH_CATALYST` fired in neither read:**

| lane | read 1 | read 2 |
|---|---|---|
| PCT_MOVER | 356 | 344 |
| RVOL_MOVER | 247 | 244 |
| VOLUME_ACCELERATION | 220 | 233 |
| PRICE_ACCELERATION | 22 | 27 |
| LOW_FLOAT_DEMAND | 29 | 29 |
| GAP_PREMARKET | 86 | 86 |
| **FRESH_CATALYST** | **absent** | **absent** |

This is the defect. See **Defect 1** below.

`discoveryRejections.staleQuote`: 698 (read 1), 702 (read 2) — 4,706 names, so ~14.8%. Down
enormously from the ~4,600 (near-total) seen after the close, which is the qualitative claim the
runbook asks to confirm — but it is not "near zero" in absolute terms. I looked for a cause and
did not find one: at 15 minutes, the staleness cutoff (`lib/mover-discovery.js:232`) is generous,
and ~700 thinly-traded names simply not having ticked in the last 15 minutes on an ordinary
Thursday morning is plausible on its face. I'm reporting the number rather than calling it a
defect — I have no code-level finding to point at, unlike Defect 1 below, and manufacturing a fix
for a number I can't explain would be worse than leaving it. Worth a follow-up if it recurs.

**Cards (`buckets.all`, 250 ranked candidates):**
- `structureState` spread across 10 distinct states (STALE_DATA 190, DISTRIBUTION 11,
  FAILED_BREAKOUT 10, COMPRESSION 7, BREAKOUT_ATTEMPT 7, CONSTRUCTIVE_PULLBACK 7, WATCH 7,
  BREAKOUT_RETEST 5, BREAKOUT_PENDING 5, EARLY_IGNITION 1). The 190 `STALE_DATA` names are not a
  data-freshness bug — they're candidates beyond the 60-name `INTRADAY_ENRICHMENT_CAP` that never
  got a bar fetch this cycle, which is the capped-budget behavior the runbook describes as a
  feature (`partialResults`/enrichment caps), not a defect.
- `actionState` spread across 8 states (NO_TRADE 190 — same 190, AVOID 21, WATCH_ONLY 20,
  READY_IF_TRIGGERED 11, PAPER_ENTRY_ELIGIBLE 3, MISSED_OR_EXTENDED 3, RESEARCH_CANDIDATE 1,
  SETUP_BUILDING 1).
- `fiveMinPriceAcceleration` / `fiveMinVolumeAcceleration`: non-null on **all 250** cards.
- **`LIVE_VALIDATED_ENTRY` count: 0.** Confirmed zero occurrences — matches the requirement that
  this state must never appear while `ENABLE_LIVE_VALIDATED_SIGNALS` is off.
- `explosionPotentialScore` vs `tradeQualityScore`: 49 distinct pairs in a 50-card sample —
  genuinely independent, not a copy of each other.

## 3. Structure and persistence

`op=intradaycontinuation`: `byStructureState` populated across 9 states (WATCH 5,
CONSTRUCTIVE_PULLBACK 9, COMPRESSION 7, BREAKOUT_PENDING 5, BREAKOUT_ATTEMPT 7,
BREAKOUT_RETEST 3, FAILED_BREAKOUT 10, DISTRIBUTION 13, EARLY_IGNITION 1). BREAKOUT_CONFIRMED and
EXHAUSTED were empty this cycle — plausible for prime-morning (10:45 ET is early for either),
not flagged as a defect.

`op=lowfloatbook`: `durableStore: true`. Today's snapshots: `discovery: 18, ignition: 18,
continuation: 18`. `discoveredTickers: 2488`. The scheduled writer is persisting research
records correctly.

`op=intradayvalidation`: every template reads `UNVALIDATED`, `resolvedEvents: 0`,
`datesWithOutcomes: 0`. No template claims `LIVE_VALIDATED`. Correct for this early in the
promotion pipeline's life.

`op=largemoveraudit`: HTTP 200, `ok: true`, returns a partial-by-nature mid-session doc without
throwing.

## 4. The scheduler

Last 8 runs of "Day Trade intraday scan" (GitHub Actions): all `completed` / `success`.
Inspected the most recent (run 31112855062, 14:50 UTC): the "Low-float ignition tick" step ran
(not skipped) and its jq summary reported
`{"ok":true,"skipped":null,"candidatesRanked":250,"discovered":739,"snapshots":{"discovery":"written","ignition":"written","continuation":"written"},"elapsedMs":11028,"quotes":4706,"volume":true}`.
`offSessionSkip` is correctly staying quiet during regular hours.

One operational observation, not a defect: 29 of the last 30 runs were triggered by
`workflow_dispatch`, only 1 by `schedule`, even though `.github/workflows/daytrade-scan.yml`
defines a `*/5 8-21 * * 1-5` cron. The file's own comment notes "GitHub cron is best-effort —
real cadence is ~5–15 min with jitter," which is consistent with what I saw (something/someone
has been invoking it manually alongside, or instead of, the cron firing this session) — but I
did not chase this further since it's outside today's scope and the pipeline output itself was
correct regardless of trigger source.

## 5. Sanity-checked individual names

- **GVH** (Globavend Holdings): price 0.9338, trigger 0.95 (above price — breakout entry),
  invalidation 0.92, targets 1.00/1.05, R:R 1.52, `ULTRA_LOW` float (314,634 sh). Headline
  correctly downgrades to "NO TRADE — SPREAD NOT VERIFIED" (sub-$5, ultra-low float — the manual
  spread-check gate). Internally consistent.
- **PAYS** (Paysign): price 12.29 (+28.15% day), trigger 12.26 sits just under price —
  `CONSTRUCTIVE_PULLBACK` buying the dip, tight invalidation 12.09, R:R 5.35, `SMALL_SUPPLY`
  float at a real, liquid share count (34.2M). Consistent.
- **CACI** (CACI International): price 617.78 (+19.26% day), trigger 620 sits just above price
  at the session high (`distanceFromHighPct: 0`) — `BREAKOUT_PENDING` waiting for a break of the
  high, not below it. Invalidation/targets/R:R all ordered correctly. Consistent.

No name checked showed a trigger below the current price on a breakout template, a target below
entry, or a float/structure mismatch.

---

## Defect 1 (FOUND AND FIXED): `FRESH_CATALYST` discovery lane was structurally unreachable

**Symptom:** In `discoveryLaneCounts`, six of seven lanes fire every cycle. `FRESH_CATALYST`
never appears — not "rarely," structurally never, confirmed across both live reads today and
by code inspection.

**Root cause** (`lib/mover-discovery.js:173-179`, `lib/lowfloat-pipeline.js` Stage 0b): the
`FRESH_CATALYST` lane requires `catalystTier` and `catalystFreshnessMinutes` on the per-ticker
`catalystByTicker` map passed into `evaluateLanes`/`buildCandidates`. But catalyst enrichment
(`fetchCatalystContext`, a per-symbol news call) only ever runs in Stage 2/3 of the pipeline
(`lib/lowfloat-pipeline.js:157-176`), on the narrow top-N candidates *that discovery has already
ranked* — after lanes have already been evaluated. The Stage 0b call to `runMoverDiscovery`
(`lib/lowfloat-pipeline.js:91-94`, before this fix) never passed a `catalystByTicker` argument at
all, so it defaulted to `{}` and every candidate saw `catalystTier: null` during lane evaluation.
`Number.isFinite(null)` is `false`, so the lane's admission check could never pass — no matter
how fresh or material the news. Unlike float (which has a persisted cache seeded into discovery,
`lib/lowfloat-pipeline.js:81-84`), catalyst had no equivalent seed.

**Fix (this branch):**
- `lib/lowfloat-store.js` — added `CATALYST_CACHE_KEY` / `readCatalystCache` /
  `writeCatalystCache`, mirroring the existing float-cache pair exactly.
- `lib/catalyst-context.js` — added `reassessCatalyst(record, now)`, which recomputes
  `freshnessMinutes` and `materiality` from the record's `publishedAt` against the current
  clock (mirrors `lib/float-data.js`'s `reassess`), so a headline cached several cycles ago
  correctly ages out instead of reading as still-fresh forever.
- `lib/lowfloat-pipeline.js` — Stage 0b now reads the catalyst cache and reassesses it before
  calling `runMoverDiscovery`, passing the result as `catalystByTicker` (the same treatment
  `floatSeed` already gets). After Stage 2/3's catalyst enrichment, present catalysts (tier 1-3)
  are merged back into the cache so the *next* cycle's discovery pass can see them. Catalysts
  where nothing matched (`catalystPresent: false`) are not cached, so a temporary news gap can't
  freeze into a permanent one.

**Constraints respected:** no new file under `api/` (all changes are in `lib/`), no LLM call
anywhere in the new code (pure arithmetic + the existing regex classifier), no order-placement
code touched.

**Regression test:** `test/lowfloat-catalyst-lane.test.js` (6 tests, all passing) —
1. `FRESH_CATALYST` fires when a fresh, material catalyst is seeded into discovery (isolated so
   no other lane could fire).
2. It does **not** fire with no seed (the pre-fix production shape), a >24h-old catalyst, or a
   tier-4 (dilution/social) catalyst.
3. `reassessCatalyst` correctly advances `freshnessMinutes` and decays `materiality` against a
   later clock, and leaves `catalystTier` unchanged.
4. `reassessCatalyst` pins tier-4 materiality at 0 and passes through records with no
   `publishedAt` unchanged.
5. Source-level guard: the pipeline must call `readCatalystCache`, pass `catalystByTicker:
   catalystSeed` into discovery, and call `writeCatalystCache` — so a future refactor that
   silently drops the wiring fails the test suite instead of silently going dark again.
6. `lib/lowfloat-store.js` exports both new functions.

**Not yet observed live:** this is a code fix, verified with unit tests, not yet deployed. It
needs one production deploy plus at least one full discovery → enrichment → next-discovery cycle
(catalyst cache is empty until Stage 2/3 writes to it) before `discoveryLaneCounts.FRESH_CATALYST`
will show a nonzero count in production. Worth a spot-check on the next in-session run after this
merges.

---

## Test suite

`npm test`: **3,926 passed, 0 failed** (includes the 6 new regression tests; baseline was
~3,920). `npm run check`: clean syntax check across `api/`, `lib/`, `lib/nsl/`, `lib/patterns/`,
`lib/research/`, `lib/peerprop/`, `lib/pitdata/`, `lib/pitdata/v3/`, and the `research/` scripts.
