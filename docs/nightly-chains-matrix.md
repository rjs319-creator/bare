# Nightly chains as a GitHub Actions matrix + dead-man monitoring

Proposals #2 and #3 of `docs/GITHUB-RESOURCE-SCAN-2026-10-02.md`. Shipped 2026-10-02.

## What changed

| Piece | Where | Role |
|---|---|---|
| Workflow | `.github/workflows/nightly-chains.yml` | 22:05 UTC daily **plus retry schedules 22:40, 23:20, 01:00 UTC** (all after the close, so all the same **target session** — see *Session keying* below). `preflight` job (idempotence gate, see below; publishes the `session` output every job stamps as `TARGET_SESSION`); `spine` job = `ledger`; `chains` matrix = every other `ROOT_CHAINS` entry, `needs: [preflight, spine]`, `fail-fast: false`, `max-parallel: 4`, `timeout-minutes: 6`; `summary` job (`if: always()` unless the night was skipped) posts the run's record. |
| Preflight | `scripts/nightly-chains-preflight.js` | Computes the **target session** (`CS.targetSession(now)` = the last completed NYSE session) and GETs `op=health` (public, cache-busted by run id). A FULL clean record whose `chains.session` (legacy: `date`) equals the target → `skip=true`, every chain job and the summary skip via `if:`. A partial/red record → `already_ok=<csv>`; the runner reports those chains `already-ok` without a request and only the rest run. Fail-open; `only=`/`force=true` always run what was asked. |
| Direct trigger | `lib/nightly-dispatch.js` ← `api/warm.js` | With `WARM_CHAINS_INPROCESS=0` **and** `GITHUB_DISPATCH_TOKEN` set, the 22:00 UTC cron POSTs a `workflow_dispatch` for `nightly-chains.yml` right after the cache warm, and records `lastRun.dispatch: {attempted, status}` in op=health. Dormant without the token; never throws. |
| Per-chain runner | `scripts/run-nightly-chain.js` | Calls the existing `op=warmchain&name=<root>` with the `CRON_SECRET` bearer. Two attempts: the second after a FAST failure (transport error or 429/502/503 inside 30 s, 15 s backoff) **or after a platform crash at any elapsed time** (chain-level `FUNCTION_INVOCATION_FAILED` 500 / 502 / 503, or a step that died with the marker or a 502; 75 s backoff — the one exception to "a slow failure ran, don't re-run", because every chain op is idempotent per date). Grades from the BODY (a warmchain is HTTP 200 even when steps failed). Records every failure instant (`attemptFailures`, `failedAt`, `failDetail[].at`) for the co-located-crash detector. A chain named in `ALREADY_OK` (from the preflight) is reported `already-ok` with no request. Every result is stamped `session` (`TARGET_SESSION` from the preflight, else the clock's target session) and `date` (ET wall-clock, informational). Writes `.nightly/<chain>.json`; exit 1 = red job = GitHub e-mail. |
| Summary poster | `scripts/nightly-chains-summary.js` | Folds the downloaded result artifacts into one payload; a root with no result file is `no-report` (failed). The record's key is `session` — `TARGET_SESSION` from the preflight, else the **target session of the earliest start** (a 01:00 UTC run is still that evening's session; a 02:14 ET run is the PREVIOUS session); `date` is the ET wall-clock date of the earliest start, for display. A filtered `only=` run posts `partial:true` + `covered:[...]`. Failures of different chains within 5 s of each other (`PEER_CRASH_WINDOW_MS`) are marked `crashedWithPeers:true` + `peers:[...]` — one co-located instance kill, not N defects. POSTs to `op=chainsummary`; writes the run's step summary table (💥 rows). |
| Matrix generator | `scripts/gen-nightly-matrix.js` (`--check` in tests) | Rewrites the two generated blocks in the YAML from `lib/warm-chains.js ROOT_CHAINS`. `test/nightly-chains-matrix.test.js` pins `spine ∪ chains == ROOT_CHAINS`. |
| New op | `op=chainsummary` → `lib/chain-summary-routes.js` + `lib/chain-summary.js` | PRIVILEGED (bearer), POST-only, validated at the boundary (`session` must be a real trading session inside the window; a legacy body with only `date` is keyed by that date), **CAS-merged** (`store.updateJSON`) into `chains/<session>.json`: a full run replaces the night (earlier posts kept as `priorRuns`), a partial run folds its chain statuses in (`patches`). Several runs per night are expected now. |
| Health | `lib/health.js` `buildHealthResponse` → `chains: { session, date, ok, full, partial, covered, failed, skipped, crashedWithPeers, source, runUrl, at, missing, noMatrixRun }` | `session` is the night (the trading day the chains processed); `date` is the wall-clock ET date the run happened on, informational. `source` is `github-matrix`, `manual` (a `workflow_dispatch`), `in-process` (derived from warm's own record) or `none` (nothing posted). `ok` is true only for a FULL run with no failures. Failures (including roots missing from a full run) fold into `problems` as `chain:<name>`; `missing:true` adds `chains:no-summary`; `noMatrixRun` adds `chains:no-matrix-run`. Any of those flips `healthy:false`. |
| UI | `public/js/app.js checkHealth` | The existing banner lists the failed chain names; when the source is the GitHub matrix it adds the night's date and an **open run** link, and when ≥2 of the failures are `crashedWithPeers` it says so ("failed together within seconds — a co-located crash, not separate defects"). Each dead-man gets its own plain line ("Tonight's background refresh has not run yet" / "No nightly chain summary has been posted in the last few days"). |
| Opt-out switch | `api/warm.js` + `WC.inProcessChainsEnabled()` | `WARM_CHAINS_INPROCESS=0` (or `false`/`off`) stops warm dispatching the roots in-process. Default ON. Cache warms, AI ticks and single kicks are untouched either way (they are now explicitly drained so they still dispatch when the chain drain is gone). |

## Why these numbers

- **22:05 UTC** — the Vercel cron (`0 22 * * *`) runs warm's cache warms first (~22-30 s: backtests, screeners/candle caches, sectors, optionsflow). `ledger`'s `op=track` snapshots exactly those caches, and `cfl`/`ephemeral`/`psrl` read them. GitHub schedules land 3-15 min late, so `5 22` is a floor of ≥5 min after the caches are rebuilt. The run can overlap `evidence-tick.yml` at 22:30; the FMP-heavy roots run in `ROOT_CHAINS` order — if evidencetick's `noNews` 429s reappear, move `altprobes`/`alphacal` earlier in `ROOT_CHAINS` rather than retiming.
- **max-parallel 2** (was 4, the in-process wave width `DISPATCH_WAVE_SIZE`) — on 2026-10-02 the full manual run (37074906407) lost `capture`, `universe`, `pulse`, `pattern` and `pitdata` to `FUNCTION_INVOCATION_FAILED` 500s whose timestamps clustered at the same instants (22:56:28-33 for three, 23:00:23-24 for two): one Fluid-compute instance hosting several heavy invocations died (OOM) and took every co-located request with it — the 2026-10-01 `insidercluster` signature, no code defect. Halving the width halves what can share an instance. **Trade-off:** wall time roughly doubles, ~25-45 min for 44 chains at ~1-2 min each (worst case a few 12-min jobs), still well inside the night even for the 01:00 UTC retry schedule. If kills persist at width 2 the next lever is `vercel.json` memory for `api/tracker.js`, not width 1.
- **timeout-minutes 12** (was 6) — `CHAIN_DEADLINE_MS` is 240 s inside a 300 s function wall; the runner caps a request at 290 s and may retry once: after a fast failure (15 s backoff) or after a platform crash (75 s backoff, at any elapsed time). Worst path 290 + 75 + 290 s ≈ 11 min.
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
2. **`chains/<session>.json`.** The summary job writes what happened, including `no-report` for a job that was cancelled or timed out before writing. `op=health` reads every record inside a 3-day lookback (`LOOKBACK_DAYS`, so a Monday-morning check finds Friday's night) and shows the newest night.
3. **Nothing ran for days.** With `WARM_CHAINS_INPROCESS=0` and no record in the lookback, `op=health` returns `chains.missing:true`, `healthy:false`, problem `chains:no-summary`, and the banner says so. (GitHub disables schedules in repos idle for 60 days — this is how you would find out.)
4. **Tonight has not run — and a partial run cannot fool it (2026-10-02).** On 2026-10-02 a morning `workflow_dispatch -f only=delisting,dilution,housebook,maturity` had written `chains/2026-10-02.json`, so at 22:53 UTC — with the 22:05 schedule still not fired — `op=health` read `healthy:true, chains.ok:true, source:'manual'`. Now:
   - a record is **full** only when it comes from `github-matrix` or `manual` **and** is not `partial:true` (legacy docs without the flag are full only if they name every `ROOT_CHAINS` entry — which is what makes that morning's doc partial);
   - a partial record contributes per-chain statuses (`covered`/`failed`) but `chains.ok` stays false for the night;
   - a full record missing a root (one added after the run posted) lists that root in `failed`;
   - if the last warm run has `chainsInProcess:false` and **no full record for its target session** exists `NO_MATRIX_RUN_GRACE_MS` (90 min) after `lastRun.at`, `op=health` adds `chains:no-matrix-run`, sets `healthy:false`, and `chains.noMatrixRun = { session, warmAt, graceMs }`. The banner says "Tonight's background refresh has not run yet" (or "The background refresh for session <date> never ran" the next morning — the rule follows the warm run's session while it is inside the lookback). The 22:00 UTC cron is after the close, so a weekday warm's session is that day; a weekend/holiday warm targets the previous session, which Friday's record already covers (a repeat full run there is a no-op that still reads covered). The grace is 90 min because the matrix is scheduled 5 min after the cron, takes 15-30 min at `max-parallel 4`, and GitHub's normal lag is 3-15 min; it is still early evening ET when it fires, so it is actionable the same night.

## Session keying — the night is the target session, not the ET date (2026-10-02)

Until this change every nightly artifact was keyed by the **ET calendar date at run time**. GitHub ran the `0 1 * * *` retry cron five hours late on Fri 2026-10-02, at 06:14 UTC = 02:14 ET — **before Friday's session**. That pre-market run processed Thursday's already-done data (every chain op is idempotent per session, so it was a no-op server-side) and was recorded as the full, clean record for "2026-10-02". Friday's real post-close runs at 20:28 ET then found "tonight already covered" and skipped almost every chain as `already-ok`. Friday's data was processed only because the 06:41 UTC Saturday run crossed ET midnight and was labelled "2026-10-03".

Now **everything is keyed by the target session** = the last completed NYSE regular session at run start — `CS.targetSession(ms)` → `lib/market-session.js lastCompletedRegularSession` (the same clock the chain ops use; weekend, holiday and early-close aware — no second holiday list):

| Run start (UTC) | ET | `date` (informational) | `session` (the key) |
|---|---|---|---|
| Fri 06:14 | 02:14 Fri, pre-market | 2026-10-02 | **2026-10-01** (Thu) — already ok → preflight skips |
| Sat 00:28 | 20:28 Fri, post-close | 2026-10-02 | **2026-10-02** (Fri) — no record yet → run everything |
| Sat 06:41 | 02:41 Sat | 2026-10-03 | **2026-10-02** (Fri) — now covered → skip |
| Thu 22:10 on Thanksgiving | 18:10 ET, holiday | 2026-11-26 | **2026-11-25** (Wed) |

- The **preflight** decides the session once and publishes it as the `session` output; the chain jobs and the summary receive it as `TARGET_SESSION`, so one run can never straddle two keys. Absent/invalid, each script falls back to the clock (`targetSession(now)`; the summary uses the earliest chain start).
- `op=chainsummary` validates `session` (YYYY-MM-DD, inside the window, a real trading session) and files the doc under `chains/<session>.json`; the merge rule compares sessions. A legacy body with only `date` is keyed by that date, and legacy docs without `session` are read the same way (`CS.sessionOf`).
- `op=health` `chains.session` is what the preflight compares against; `chains.date` stays as the wall-clock date. `matrixRunOverdue` judges the **warm run's target session**: the Vercel cron fires at 22:00 UTC, after the close, so a weekday warm targets that day; a weekend or holiday warm targets the previous session, which Friday's full record covers.
- Pinned by `test/chain-summary.test.js`, `test/nightly-chains-preflight.test.js`, `test/nightly-chains-runner.test.js` and `test/health-chains.test.js` (the exact Fri/Sat sequence above, a holiday, a weekend warm, legacy fallback).

**Transition note.** The two legacy docs from the incident stay as they are: `chains/2026-10-02.json` (the 02:14 ET pre-market record, which really describes Thursday) reads as session 2026-10-02 and `chains/2026-10-03.json` (the Saturday run that actually processed Friday) reads as session "2026-10-03" — a Saturday. Both age out of the 3-day lookback after Monday 10-05's run posts `chains/2026-10-05.json`.

## Schedule lag — what fixed it (2026-10-02)

GitHub does not guarantee `schedule:` fires on time, and for this repo it has not: the 13:30 UTC `evidence-tick` fired at 18:38 and the 22:05 nightly had not fired by 22:53. Three layers, each sufficient on its own for a normal night:

1. **Retry schedules** — `5 22`, `40 22`, `20 23`, `0 1` UTC. All four fire after the close, so they share one **target session** (01:00 UTC = 21:00 EDT / 20:00 EST) — and when GitHub runs one hours late into the next pre-market, it targets the session that already ran and the preflight skips it (see *Session keying*). Nothing after 01:00: later than that the premarket readers would meet a half-refreshed app, and the dead-man has already alarmed.
2. **Idempotence (`preflight`)** — each run first asks `op=health`. Full clean run already posted for tonight → the whole run skips (one tiny job). Partial or red record → only the chains that are not yet ok run; the rest are reported `already-ok` so the summary still covers every root and the night ends up full. A failed probe runs everything (fail-open). `only=`/`force=true` dispatches always run what was asked.
3. **Direct trigger (recommended)** — see below. The reliable Vercel cron starts the GitHub run the moment the caches are warm, so the first schedule is a backup rather than the plan.

### Direct trigger — `GITHUB_DISPATCH_TOKEN` setup

The 22:00 UTC warm cron POSTs `https://api.github.com/repos/rjs319-creator/bare/actions/workflows/nightly-chains.yml/dispatches` with `{ "ref": "main" }` when `WARM_CHAINS_INPROCESS=0` and the token is set (`lib/nightly-dispatch.js`). It never throws and is recorded as `lastRun.dispatch` in `op=health`.

1. **Create a fine-grained PAT** (github.com → Settings → Developer settings → Personal access tokens → Fine-grained → *Generate new token*):
   - Token name: `market-news-app nightly dispatch`; expiration: 1 year (set a calendar reminder — an expired token shows as `lastRun.dispatch.status: 401`).
   - Resource owner: `rjs319-creator`. Repository access: **Only select repositories → `bare`**.
   - Repository permissions: **Actions: Read and write** (Metadata: Read-only is added automatically). Nothing else.
2. **Add it to Vercel** (Production only, mark *Sensitive*):
   `vercel env add GITHUB_DISPATCH_TOKEN production` (paste the token) — or the dashboard → Project → Settings → Environment Variables. **Redeploy** the current production deployment so the function picks it up (`vercel redeploy <prod url>` or the dashboard's *Redeploy*).
3. **Verify the next night**: `curl -s https://market-news-app-chi.vercel.app/api/tracker?op=health | jq .lastRun.dispatch` → `{ "attempted": true, "status": 204, "ok": true }`, and Actions → *Nightly chains* shows a run "manually run by <you>" a few seconds after 22:00 UTC. The 22:05 schedule then arrives at a night that is already running or recorded and the preflight skips it.
4. **Failure modes**: `status: 403 "Resource not accessible by personal access token"` = the token lacks Actions: write or is scoped to the wrong repo; `404` = repo/workflow name wrong or token has no access to the repo; `401` = expired/revoked; `status: null` = GitHub API unreachable from the function. None of these fail the cron — the retry schedules and the dead-man still cover the night.
5. **Rollback**: delete the env var + redeploy. The workflow's own schedules continue unchanged.

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

- `workflow_dispatch` with `only=` records the run as `source: "manual"`, `partial: true` and only expects the listed roots — it will not mark the others `no-report`, and it can never make the night count as run. A `only=` re-run of a red chain after a full run MERGES into the night's doc (per-chain, newest wins) and can turn `chains.ok` green.
- A `workflow_dispatch` with no `only=` is a full run (`source: "manual"`, `partial: false`) and covers the night exactly like the schedule. With `force=true` it runs even when the preflight would have skipped.
- A red `summary` job means the POST to `op=chainsummary` failed (401 = secret mismatch, 503 = `CRON_SECRET` unset in prod, 400 = payload rejected — read the job log). Chain failures do NOT fail the summary job; they fail their own jobs.
- Budget skips (`skipped:budget`) keep a job green with a `::warning::` annotation and are carried in the record (`chains.skipped`), matching `lib/health.js`'s lenient per-run treatment; the chronic-skip detector still runs on warm's own record while in-process is on.
- Adding a root: append to `ROOT_CHAINS`, run `node scripts/gen-nightly-matrix.js`, commit both. CI fails otherwise.
- The old per-chain reports (`warm/chains/<name>.json`, written by `op=warmchain` itself) still exist and still overlay `running-past-warm` entries while in-process dispatch is on. They are untouched.

## Deliberately not done

- No healthchecks.io / external pinger — GitHub job failure + the posted record + `op=health` (two dead-man rules) cover the failure modes without a vendor.
- No GitHub App for the direct trigger — a fine-grained PAT scoped to one repo and one permission is the smallest credential that can start a workflow; an App adds an installation flow for the same capability.
- The six AI ticks and the single kicks (`optionsassess`, `putsell`, `optionsepisodes`, `calibration`, `research`, `biotechgrade`) stay in `api/warm.js`: they are single dispatches with no ordering and were never part of the chain machinery. They could become a `kicks` matrix job later.
- Nested chains (`@decision`, `@universescan1..4`, `@gexb/@gexc`, …) are not matrix jobs: their parent awaits them inside its own invocation, exactly as before.
