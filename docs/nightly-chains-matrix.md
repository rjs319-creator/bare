# Nightly chains as a GitHub Actions matrix + dead-man monitoring

Proposals #2 and #3 of `docs/GITHUB-RESOURCE-SCAN-2026-10-02.md`. Shipped 2026-10-02.

## What changed

| Piece | Where | Role |
|---|---|---|
| Workflow | `.github/workflows/nightly-chains.yml` | 22:05 UTC daily. `spine` job = `ledger`; `chains` matrix = every other `ROOT_CHAINS` entry, `needs: spine`, `fail-fast: false`, `max-parallel: 4`, `timeout-minutes: 6`; `summary` job (`if: always()`) posts the night's record. |
| Per-chain runner | `scripts/run-nightly-chain.js` | Calls the existing `op=warmchain&name=<root>` with the `CRON_SECRET` bearer. Two attempts, but only when the first failed FAST (transport error or 429/502/503 inside 30 s). Grades from the BODY (a warmchain is HTTP 200 even when steps failed). Writes `.nightly/<chain>.json`; exit 1 = red job = GitHub e-mail. |
| Summary poster | `scripts/nightly-chains-summary.js` | Folds the downloaded result artifacts into one payload; a root with no result file is `no-report` (failed). POSTs to `op=chainsummary`; writes the run's step summary table. |
| Matrix generator | `scripts/gen-nightly-matrix.js` (`--check` in tests) | Rewrites the two generated blocks in the YAML from `lib/warm-chains.js ROOT_CHAINS`. `test/nightly-chains-matrix.test.js` pins `spine ∪ chains == ROOT_CHAINS`. |
| New op | `op=chainsummary` → `lib/chain-summary-routes.js` + `lib/chain-summary.js` | PRIVILEGED (bearer), POST-only, validated at the boundary, written with `writeChecked` to `chains/<date>.json` (one key per date, idempotent per run). |
| Health | `lib/health.js` `buildHealthResponse` → `chains: { date, ok, failed, skipped, source, runUrl, at, missing }` | `source` is `github-matrix`, `manual` (a filtered `workflow_dispatch`), `in-process` (derived from warm's own record) or `none` (dead-man tripped). Failures are folded into `problems` as `chain:<name>`; `missing:true` adds `chains:no-summary` and flips `healthy:false`. |
| UI | `public/js/app.js checkHealth` | The existing banner lists the failed chain names; when the source is the GitHub matrix it adds the night's date and an **open run** link. A tripped dead-man gets its own warning line. |
| Opt-out switch | `api/warm.js` + `WC.inProcessChainsEnabled()` | `WARM_CHAINS_INPROCESS=0` (or `false`/`off`) stops warm dispatching the roots in-process. Default ON. Cache warms, AI ticks and single kicks are untouched either way (they are now explicitly drained so they still dispatch when the chain drain is gone). |

## Why these numbers

- **22:05 UTC** — the Vercel cron (`0 22 * * *`) runs warm's cache warms first (~22-30 s: backtests, screeners/candle caches, sectors, optionsflow). `ledger`'s `op=track` snapshots exactly those caches, and `cfl`/`ephemeral`/`psrl` read them. GitHub schedules land 3-15 min late, so `5 22` is a floor of ≥5 min after the caches are rebuilt. The run can overlap `evidence-tick.yml` at 22:30; the FMP-heavy roots run in `ROOT_CHAINS` order — if evidencetick's `noNews` 429s reappear, move `altprobes`/`alphacal` earlier in `ROOT_CHAINS` rather than retiming.
- **max-parallel 4** — the in-process wave WIDTH (`DISPATCH_WAVE_SIZE`), now held for the whole night instead of only at the start. In-process, all ~41 roots were concurrently running after 90 s; that peak is what OOM-killed co-tenant invocations in August.
- **timeout-minutes 6** — `CHAIN_DEADLINE_MS` is 240 s inside a 300 s function wall; the runner caps a request at 290 s and retries only a fast failure: worst path 30 + 15 + 290 s < 6 min.
- **`needs: spine`** — in-process, `evolve`/`challenger`/`bearcase`/`swing`/`atlasx`/`maturity`/`router` raced the decision spine and accepted a one-tick-stale `op=today`. Here they wait for it. `if: !cancelled()` keeps them running when the spine fails (stale inputs are better than none; their own ledgers must still advance).

## In-process fallback: the dispatch ceiling (2026-10-02)

The in-process dispatcher (`WARM_CHAINS_INPROCESS` unset or `1`) is the rollback path, so it has to keep working at any root count. Until 2026-10-02 it used a fixed schedule — `DISPATCH_WAVE_SIZE` 4 × `DISPATCH_WAVE_GAP_MS` 9 s — and four tests pinned the literal `dispatchDelayMs(ROOT_CHAINS.length - 1) <= 90000`. With 44 roots the last wave sat exactly on 90 s; the 45th root would have failed every copy of the pin, which is why `redflagstick` had to become a step instead of a root.

**Choice: (a) make the dispatcher scale; keep the invariant, drop the constant.**

- `LAST_WAVE_CEILING_MS` (90 s) is now a named constant in `lib/warm-chains.js`, and the gap is **computed**: `effectiveWaveGapMs()` returns the nominal 9 s while the last wave fits under the ceiling, and `min(9 s, floor(ceiling / lastWaveIndex))` once it would not. Wave **width** (the OOM lever — how many invocations land on one instance at once, mirrored by the matrix's `max-parallel: 4`) never changes; only the spacing between waves compresses.
- At the current 44 roots the schedule is byte-identical to before (4 × 9 s, last wave at 90 s). At 45 roots the gap becomes 8.1 s; at 60, 6.4 s; at 100, 3.75 s. Below ~4 s between waves the fallback is still *correct* but the arrival spikes are closer together — at that point the matrix is the real answer and a very large `ROOT_CHAINS` should prompt nesting, not more trimming.
- The pins now assert the **invariant** (`<= WC.LAST_WAVE_CEILING_MS`) and `test/warm-chains.test.js` checks it for every root count from 1 to 200, so adding a root no longer requires touching four test files.
- Rejected: (b) retiring the pin. Without it a flipped-back `WARM_CHAINS_INPROCESS` could silently dispatch the last roots past the drain and record them as `running-past-warm` every night.

## Dead-man semantics (no new vendor)

1. **Job failure = e-mail.** GitHub e-mails the workflow's author on a failed scheduled run. Each root is its own job, so the e-mail names the chain.
2. **`chains/<date>.json`.** The summary job writes what happened, including `no-report` for a job that was cancelled or timed out before writing. `op=health` reads the newest record inside a 3-day lookback (`LOOKBACK_DAYS`, so a Monday-morning check finds Friday's night).
3. **Nothing ran.** The one failure an e-mail cannot deliver. With `WARM_CHAINS_INPROCESS=0` and no record in the lookback, `op=health` returns `chains.missing:true`, `healthy:false`, problem `chains:no-summary`, and the banner says so. (GitHub disables schedules in repos idle for 60 days — this is how you would find out.)

## Cutover — exact steps

The in-process dispatcher stays ON by default, so merging this PR changes nothing at 22:00 UTC except that the GitHub workflow ALSO runs at 22:05. **Do not leave both on for more than one verification night**: most chain steps are idempotent per day, but running every root twice doubles the provider spend and the Yahoo/FMP burst.

1. **Merge the PR.** CI auto-deploys production; `op=chainsummary` is live, `op=health` gains the `chains` block (source `in-process` for now).
2. **Confirm the repo secret** `CRON_SECRET` exists (Settings → Secrets and variables → Actions) — it already does if `daytrade-scan.yml` / `evidence-tick.yml` are green.
3. **First manual run — cheap, idempotent roots:**
   `gh workflow run nightly-chains.yml -f only=maturity,bearcase` (or Actions → *Nightly chains* → *Run workflow* with `only = maturity,bearcase`).
   Both are single-step, idempotent per day, read-only on live state (maturity rewrites `governance/latest.json` from the persisted summary; bearcase is a no-op when the day's doc exists).
   Expect: `spine` job SKIPPED-by-filter (green), `chains` matrix green for the two, `summary` green.
   Then `curl -s https://market-news-app-chi.vercel.app/api/tracker?op=health | jq .chains` →
   `{ source: "manual", date: <today>, ok: true, failed: [], runUrl: ... }`.
4. **Flip the Vercel env var** (Production only):
   `vercel env add WARM_CHAINS_INPROCESS production` → value `0`
   (or Vercel dashboard → Project → Settings → Environment Variables → `WARM_CHAINS_INPROCESS` = `0`, Production). Redeploy is required for env changes to take effect: `vercel redeploy <current prod url>` or push an empty commit — the dashboard's *Redeploy* button on the latest production deployment works too.
   From the next 22:00 UTC, warm's run record shows `chainsInProcess:false`, `chainsDispatched:0`; the 22:05 matrix does the work.
5. **Verify the first full scheduled night** (next day):
   - Actions → *Nightly chains* → the run is green or names the red roots.
   - `op=health` → `chains.source == "github-matrix"`, `chains.date == <that night>`, `failed == []` (or the same names as the red jobs).
   - `lastRun.chainsInProcess == false` and no `chain:*` problems derived from warm itself.
6. **Rollback** at any point: set `WARM_CHAINS_INPROCESS=1` (or delete the var) + redeploy, and disable the workflow (Actions → *Nightly chains* → ··· → *Disable workflow*). Nothing else to undo.

## Operating notes

- `workflow_dispatch` with `only=` records the night as `source: "manual"` and only expects the listed roots — it will not mark the others `no-report`.
- A red `summary` job means the POST to `op=chainsummary` failed (401 = secret mismatch, 503 = `CRON_SECRET` unset in prod, 400 = payload rejected — read the job log). Chain failures do NOT fail the summary job; they fail their own jobs.
- Budget skips (`skipped:budget`) keep a job green with a `::warning::` annotation and are carried in the record (`chains.skipped`), matching `lib/health.js`'s lenient per-run treatment; the chronic-skip detector still runs on warm's own record while in-process is on.
- Adding a root: append to `ROOT_CHAINS`, run `node scripts/gen-nightly-matrix.js`, commit both. CI fails otherwise.
- The old per-chain reports (`warm/chains/<name>.json`, written by `op=warmchain` itself) still exist and still overlay `running-past-warm` entries while in-process dispatch is on. They are untouched.

## Deliberately not done

- No healthchecks.io / external pinger — GitHub job failure + the posted record + `op=health` cover the three failure modes without a vendor.
- The six AI ticks and the single kicks (`optionsassess`, `putsell`, `optionsepisodes`, `calibration`, `research`, `biotechgrade`) stay in `api/warm.js`: they are single dispatches with no ordering and were never part of the chain machinery. They could become a `kicks` matrix job later.
- Nested chains (`@decision`, `@universescan1..4`, `@gexb/@gexc`, …) are not matrix jobs: their parent awaits them inside its own invocation, exactly as before.
