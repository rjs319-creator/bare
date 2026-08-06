# In-session verification runbook — low-float ignition / intraday continuation stack

**Why this file exists.** The stack shipped on 2026-08-05 and, at the time of shipping, had
only ever executed *after* the close — where every quote is correctly rejected as stale and
the board is honestly empty. That proves the guards work; it proves nothing about the path
that actually matters. This runbook is the in-session check, written down so it is repeatable
and so a scheduled agent can run it without prior context.

**Production:** `https://market-news-app-chi.vercel.app` — endpoints are `GET /api/tracker?op=<name>`.

**Auth.** Public reads need none. The writer ops (`lowfloattick`, `intradayresolve`,
`intradaypromote`, `largemoveraudittick`) require a `CRON_SECRET` bearer. **Do not call them
during verification.** The `Day Trade intraday scan` GitHub Actions workflow already invokes
them every 10 minutes in-session; the job here is to *read* what they produced.

**Best time to run:** ~10:30–11:00 ET. Opening noise has passed, ~13+ five-minute bars have
printed (the compression ratio needs 13), and several scheduled ticks have run — which matters
because interval-based acceleration needs a *prior* snapshot to compare against.

---

## 1. Provider capability — check this first

```
op=quoteprobe
```
Expect `resolvedProvider: "yahoo-quote"` and `resolvedVolumeAvailable: true`.

**If volume is false, stop and treat it as the top finding.** Three of the seven discovery
lanes (relative volume, volume acceleration, low-float turnover) need a share count. Without
it the headline low-float feature cannot work, and the scan will still report `ok: true`.
Note: FMP's `/stable/batch-quote` is HTTP 402 on this subscription — that is known and
expected; `yahoo-quote` is the provider that should be answering.

```
op=floatprobe&tickers=AAPL,GME,SAVA
```
Expect real share counts with `HIGH` confidence and recent `filingDate`s.

---

## 2. The main radar

```
op=lowfloat
```

Check `coverage`:
- `universeSize` ≈ 4,700 and `universeTruncated: false`
- `bulkQuotesReceived` ≈ universeSize, `quoteCoveragePct` near 100
- `volumeAvailable: true`
- **`candidatesDiscovered` > 0** — this is the headline number. Zero mid-session, on a normal
  tape, means discovery is broken.
- `discoveryLaneCounts` — **all seven lanes should appear across the session**:
  `PCT_MOVER`, `RVOL_MOVER`, `VOLUME_ACCELERATION`, `PRICE_ACCELERATION`, `FRESH_CATALYST`,
  `LOW_FLOAT_DEMAND`, `GAP_PREMARKET`. A permanently-empty lane is a defect worth chasing.
- `discoveryRejections.staleQuote` should now be **near zero** (it was ~4,600 after the close)
- `floatEnriched` > 0, `intradayEnriched` > 0
- `elapsedMs` — flag anything approaching the 50 s deadline
- `partialResults` — if true, the deadline is cutting enrichment short

Check the cards (`buckets.all`):
- `fiveMinPriceAcceleration` / `fiveMinVolumeAcceleration` should be **non-null** on at least
  some names. These derive from bar data and from snapshot-to-snapshot interval state; if they
  are universally null, either the bar fetch or the persisted discovery state is failing.
- `structureState` should show **variety** — not every name `WATCH`, not every name `STALE_DATA`.
- Names with a plan should carry `trigger`, `entryZoneLow/High`, `maximumChasePrice`,
  `invalidation`, `target1/2`, `riskReward`.
- `headline` should match `actionState` / `structureState` sensibly.
- **`actionState: "LIVE_VALIDATED_ENTRY"` must appear ZERO times.** The
  `ENABLE_LIVE_VALIDATED_SIGNALS` flag is off and no template has passed the promotion gate.
  Any occurrence is a serious defect — report it prominently.
- `explosionPotentialScore` and `tradeQualityScore` should be genuinely different numbers on
  at least some names; they are independent by design.

---

## 3. Structure and persistence

```
op=intradaycontinuation
```
`byStructureState` should be populated across several states.

```
op=lowfloatbook
```
For today's date, `snapshots.discovery / .ignition / .continuation` should all be > 0 and
`discoveredTickers` > 0 — that proves the scheduled writer is persisting research records.
If `durableStore` is false, Blob is not configured and nothing is accruing.

```
op=intradayvalidation
```
Every template should read `UNVALIDATED` or `INSUFFICIENT_SAMPLE` this early. Confirm no
template claims `LIVE_VALIDATED`.

```
op=largemoveraudit
```
Mid-session this is partial by nature; just confirm it returns 200 and does not throw.

---

## 4. The scheduler

```
gh run list --workflow="Day Trade intraday scan" --limit 8
```
Runs should be green. Inspect a recent one and confirm the **"Low-float ignition tick"** step
actually executed rather than skipping — in-session it should print a jq summary with
`skipped: false` (or absent), a non-null `candidatesRanked`, and snapshot write results. If it
prints `skipped: true` with an off-session reason during regular hours, the session guard in
`offSessionSkip` (`lib/lowfloat-routes.js`) is misjudging the session.

---

## 5. Sanity-check two or three individual names

Pick a couple of cards the radar surfaced and verify the numbers are believable: does the
price roughly match the quote, is the float plausible for the company, does the structure
state match what the five-minute action implies, is the trigger actually above recent
resistance rather than below the current price?

---

## Reporting — ALWAYS open a PR, even when everything passes

The person who asked for this verification will not be watching the run. **A PR is the
notification channel** — GitHub emails them, and the report stays durable and reviewable.
So the run is not finished until a PR exists, pass or fail.

1. Write the findings to `docs/verification/lowfloat-insession-YYYY-MM-DD.md`, covering:
   what worked, what did not, **exact numbers observed** (candidate counts, lane counts,
   coverage percentages, runtimes), and any defect with the specific file and line implicated.
   Lead the file with a one-line verdict.
2. Commit on a branch named `verify/lowfloat-insession-YYYY-MM-DD`.
3. Open a PR whose **title carries the verdict**, so it is readable from an email subject line
   without opening anything — e.g.
   - `verify: low-float in-session PASS — 47 candidates, all 7 lanes firing`
   - `verify: low-float in-session — 2 defects (float enrichment empty, 5m accel null)`
4. Put the headline numbers in the PR body, not just the file.

**If you find a defect:** fix it on the same branch with a regression test in
`test/lowfloat-*.test.js`, and say so in the PR title. Never push to `main` — concurrent
sessions push there constantly and you will collide.

Before opening the PR run `npm test` (expect ~3,900 passing, 0 failing, 2 pre-existing skips)
and `npm run check`.

If `gh pr create` fails for any reason, push the branch anyway and print the full report in
your final message — never let the findings exist only inside a transcript nobody opens.

**Constraints that must not be violated:** no new files under `api/` (the plan caps deployed
serverless functions — new ops fold into `api/tracker.js`); no LLM calls in the live scoring
path; no order-placement code anywhere. Tests enforce all three.

**Be honest.** If the pipeline surfaced nothing because the tape was quiet, say that rather
than treating an empty board as a failure — the system is explicitly allowed to return
nothing, and thresholds must never be lowered to populate the screen.
