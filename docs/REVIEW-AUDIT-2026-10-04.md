# Review audit — eight prompts, reconciled against current code (2026-10-04 → 2026-10-15)

Branch `fix/review-prompts-2026-10-04` (local only; NOT pushed, NOT deployed, no production call was made).
Base: `main` 61c9708 (#455). The July export was NOT treated as current: every historical item below was
re-located and reproduced (or found already fixed) against this tree before any change. Full suite at
the last commit: `node --test` → 7,254 pass / 0 fail; `npm run check` clean.

Status key: **FIXED** (reproduced, changed, regression test), **PROTECTED** (already fixed; existing or added
test named), **LABELLED** (behaviour kept, claim corrected), **OPEN** (not changed — reason given).
"Evidence" is a test name unless marked *observed*.

## Prompt 1 — operation authorization and durable state (P0)

| ID | Current code | Status | Evidence | Change |
|---|---|---|---|---|
| A0 policy registry | `api/tracker.js` PRIVILEGED/EXPENSIVE/SHARED_FORCE/INGEST + new `USER_WRITE_OPS`, `PUBLIC_READ_OPS`, `policyOf()` | FIXED | op-policy: "every dispatched op has a policy", "no policy set names an undispatched op" | 141 unclassified ops were implicitly public; now explicit; unknown op → 400 before dispatch, zero I/O |
| A2/A3 AI ticks (anomaly, readthrough, secondwave, toneshift, crossasset, biotech) + biotechgrade | `api/tracker.js` PRIVILEGED_OPS | FIXED | op-policy: denied with zero store/LLM/provider I/O; cron bearer passes | were SHARED_FORCE, but the handlers never read `force` — every anonymous GET ran detection + LLM + ledger write |
| A4 universecurate · A6 today(log=1) · A17 prod no secret · A1 unknown op | `lib/auth.js`, `api/tracker.js` | PROTECTED | write-lever-auth, auth, tracker-unknown-op, op-policy (503 fail-closed) | — |
| A5 dualreadbackfill · A13 fadeseed | PRIVILEGED_OPS | FIXED | op-policy | anonymous shard overwrite / learner reset from empty |
| A7 screener warm bypass | `api/screener.js` `isWarm` | FIXED | op-policy (source pin) | `!cronSecret() \|\| isTrusted` → trusted, or unconfigured **outside production** only |
| A8 forwarding escalates a public read | `lib/auth.js` `forwardedInternalHeaders`; `lib/decision-routes.js pull`, `lib/whynow-routes.js` | FIXED | today-durable-state (a) ×2; op-policy | anonymous op=today / op=whynow no longer carry bearer + x-warm into the screener warm path |
| A9 bearer to request-derived host | `internalHeadersForHost` in aligned/challenger/predict routes | FIXED | op-policy | credentials only to the configured app host |
| A10 gameplan · readthrough levers | SHARED_FORCE_OPS | FIXED | op-policy (strip) | refresh/force/reset/log stripped for anonymous callers; first-of-day LLM generation kept (by design, reported) |
| A11 dualread POST · A15 drift | EXPENSIVE_OPS | FIXED (throttled) | op-policy | — |
| A12 recalibrate adoption | `lib/apex-routes.js runRecalibrate` | FIXED | trusted-write-levers | anonymous = dry run (`dryRun`, `wouldRefit`); adoption + model write trusted-only; `refit` now means "in force" |
| A14 daytradecapture | `lib/runner-capture.js` | FIXED | trusted-write-levers (fake Blob) | report always returned; persisted only with bearer; `daytrade-scan.yml` step now sends it |
| A16 news summarize / picks | `api/news.js`, `api/picks.js` | FIXED | — (rate limit + length cap; *observed*) | 12/min and 6/min per IP, cron exempt |
| B1 read helper collapses states | `lib/store-cas.js readState/writeGuarded/StoreReadError`, `lib/store.js strictState` | FIXED | state-read-strict (found / verified-missing / unavailable list / unavailable HTTP / invalid JSON / version conflict / create race) | `readJSON` still used for read-only callers |
| B2/B3 learner ticks (fade/trend/daytrade/confluence) | `lib/screener-routes.js` | FIXED | state-read-strict "every learner tick reads strictly…" | outage → tick throws before any write |
| B4 origins · B5 opportunity log | `lib/decision-routes.js` | FIXED | today-durable-state (b) ×4, (c) ×2 | strict read + guarded write; CAS `updateJSON` |
| B6 adaptive policy | `lib/maturity-routes.js` | FIXED | state-read-strict | CAS; a frozen layer cannot be silently lifted |
| B7 apex model history | `lib/apex-routes.js` | FIXED | trusted-write-levers | strict read; invalid doc refuses to overwrite |
| B9 CERN archive | `lib/capture-routes.js` | FIXED | state-read-strict | fresh archive only on verified absence |
| B10 gameplan narrative/reflection | `lib/gameplan-routes.js` | FIXED | gameplan-reflection (pin updated to CAS) | — |
| B8 resolved maps · B11 notify feeds | apex/stablecore/challenger/orbit/govdemand/predict/daytrade-alerts/rlt-alerts/ignition-live | OPEN | *observed* fallback-then-write | rebuildable derived caches / feeds; convert to `updateJSON` in a follow-up |
| C1–C5 ledger verification | `lib/immutable-ledger.js verifyInventory`, provenance-routes, swing-store | FIXED | immutable-ledger-inventory (19): healthy, empty, unreadable middle/tail/all, listing error, corrupted hash, unconfigured, expectedHead checkpoint | statuses verified / empty / incomplete / invalid / listing-error / unconfigured; terminal deletion `undetectable-without-checkpoint` unless `expectedHead` given; header claim reworded |
| C6 append on unreadable tail | `tipStrict` | FIXED | same file | append refuses to guess seq 0 |

## Prompt 2 — freshness, job completion, health

| ID | Current code | Status | Evidence | Change |
|---|---|---|---|---|
| A1 "live" on a closed Saturday | `public/js/live-price.js asOfLabelFor` | FIXED | live-price-asof (6) | "live" only for REGULAR; CLOSED → "last close · Oct 2, 2026, 4:00 PM ET"; poll time shown as "checked" |
| A2 quote observation time | `api/price.js shapeYahooQuote` | FIXED | price-quote-observed-at (4) | `observedAt` null when absent (never now), `fetchedAt`, `source` |
| A3 cached payload age | `public/js/last-good.js`, `today.js` | FIXED | pwa-last-good (+4), today-decision-state | freshness keyed on payload `generatedAt`, not arrival |
| A4 Today session line | `lib/decision-routes.js` `session`, `today.js sessionLine` | FIXED | today-lane-rank-session, today-decision-state | `{etDate, marketSession, isTradingDay, lastCompletedSession}` from the injected clock |
| A5 universal 30h staleness | `lib/provenance.js sessionStalenessOf` | FIXED | provenance (+5: weekend, holiday, missed session, early close, unknown ts) | EOD sources judged against `sessionDue`; unknown timestamp → neutral, not green |
| A6 Pulse "mode live" | `lib/pulse2-routes.js`, `pulse2-clocks.js` (`'complete'`), render | FIXED | pulse2-clocks/routes/freshness pins | describes document availability, labelled so |
| A7/A8 refresh failure blanks Pulse/Options | `public/js/app.js` | FIXED | review-ui-pins | last-good kept + failure strip |
| A10 legit-empty vs failure | `last-good.js passLegitEmpty` (Today only) | FIXED | pwa-last-good | — |
| A11 tape failure shown as neutral read | `app.js renderToday` | FIXED | today-regime-render-contract (pin updated) | "Market read unavailable" |
| A12 calendar coverage | `lib/market-session.js` | FIXED | market-session (+1) | `calendarCovered` false beyond 2027-12-31; no holidays invented |
| A13 `\|\| now` substitutions | alerts-routes, tech-command-universe, alerts.js | FIXED | alerts (+1) | null stays null + `timestampKnown:false`; undated posts aged by `collectedAt` |
| A9 Session Board last-good · F3–F5 | — | PROTECTED | session-board-frontend, ticker-lookup guards | — |
| D1–D3 chain step grading | `lib/warm-chains.js runChain` | FIXED | warm-chains-app-grading (16) | 200+`ok:false` → `app:failed`; nested 5xx → failed; no body → `unknown[]`, chain incomplete; `STEP_REQUIRES` blocks dependents; benign `disabled/superseded/needsDraft` → `skipped:noop` |
| D4/D5 nightly runner + summary | `scripts/run-nightly-chain.js`, `lib/chain-summary*.js` | FIXED | nightly-chains-runner (pin updated), chain-summary (idempotent duplicate, late receipt never flips) | `complete:null` is not ok; duplicate receipt → 200 `duplicate:true`, no write |
| D6 in-process warm path | `api/warm.js` | OPEN (legacy; prod runs `WARM_CHAINS_INPROCESS=0`) | — | kept |
| D7 kicks never graded | `api/warm.js kickOne`, `lib/health.js summarizeKicks` | FIXED | job-grading-health | dispatch ack ≠ done; app failures named as background problems; closed-session deferral |
| D8 old success healthy · D9 unknown data | `lib/health.js` | FIXED | job-grading-health (D8 ×3, D9 ×2) | `warm:stale-run` (≥2 sessions behind), `data:unknown`; `healthy` requires known+current data |
| D10 "prices/picks unaffected" | `lib/health.js dataCurrent`, `app.js checkHealth` | FIXED | job-grading-health, review-ui-pins | sentence only when `dataCurrent === true` |

## Prompt 3 — financial units and verified events

| ID | Current code | Status | Evidence | Change |
|---|---|---|---|---|
| U1 "2s10s inverted at -0.22bp" from IEF−SHY | `lib/pulse2-regime-stack.js strategicLayer/curveMeasurement`, new `lib/measurement.js` | FIXED | measurement-units: live defect; 4.20−4.42 ⇒ −22 bp; proxy refused; stale/unavailable silent | template reads only a validated `bp`/`spread` non-proxy measurement |
| U2 real yields unused | `lib/pulse2-ticks.js` passes `macro2.diagnostics.curve` | FIXED | measurement-units "real, fresh 2s10s…" | Treasury CSV / FRED DGS10−DGS2 (existing) now feeds the sentence with source + as-of |
| U3 rows without unit | `lib/pulse2-cross-asset.js withMeasurement` | FIXED | measurement-units | `metricId/unit/kind/instrument/source/observedAt`; curve row's unit-less `value` removed |
| U4 contradicting legs mislabelled | same, `summary.contradictingLegs`; render column "Proxy change" | FIXED | measurement-units | "SHY (proxy for 2-year Treasury yield): +0.4%" |
| U5 tactical text · U6 proxy map · U8 no LLM in templates | — | PROTECTED | measurement-units (tactical never bp/yield) | — |
| E1 "Verified fact" on every future event | `lib/pulse2-routes.js buildEventRisk`, `pulse2-market-state.js eventRiskLine` | FIXED | pulse2-event-verification (15): Oct 7 minutes / Oct 14 CPI / Oct 14 Beige Book fixtures each verified separately; combined model-dated item not verified | badge per item, from its own evidence; `sources`, `asOf`, `dateUnconfirmed` |
| E3 LLM controls badge inputs | `lib/pulse2-provenance.js deriveClaimStatus(scheduled)` | FIXED | same | scheduled macro claims capped at SUPPORTED without a PRIMARY (fed/bls) source |
| E6 silent re-date | `lib/pulse2-events.js scheduleDateChange` | FIXED | same | `date-changed` / `cancelled` transitions, `dateConflict`, identity kept, not fresh |
| E5 republished old event | — | PROTECTED (regression added) | pulse2-event-verification | — |
| E4 official calendar source | — | OPEN | *observed absence* | no Fed/BLS schedule feed added (no new provider); badge now honest without it |

## Prompt 4 — trade plans and decision state

| ID | Current code | Status | Evidence | Change |
|---|---|---|---|---|
| A1 GRML 9.60/16.95/0.01 | `lib/gapdown.js orbLowLevels` | FIXED | plan-geometry (13): GRML → `target:null, rr:null, invalidReason:'invalid_target_geometry'`; valid long/short survive; rounding cannot invert | nominal geometry checked before rounding; row kept as research |
| A1b/A1c board + eligibility | `decision-normalizers.js`, `eligibility.js REASON_CODE.INVALID_GEOMETRY` | FIXED | plan-geometry | `INVALID_GEOMETRY` reported beside `NO_BORROW`; a 0 level is now `NO_PLAN` (tighter) |
| A2/A3 signal.js, stock-setup | same files | FIXED | plan-geometry | `levels:null` / `valid:false` instead of negative targets |
| B1 HOLD for a disabled short without borrow | `lib/data-gates.js retainedLabelFor` → `'TRIGGERED'`, `today.js` | FIXED | data-gates, today-decision-state (3) | HOLD wording only when My Book holds the ticker |
| B5/B6 one universal empty-state sentence; first-code-only counts | `today.js governedEmptyText`, `eligibility.js`, `decision-routes.js` | FIXED | today-decision-state, today-lane-rank-session, eligibility (pin updated) | every blocker counted; sentence built from counts |
| B7/4.5 "#130" in a 5-item lane | `decision-routes.js laneRank`, `today.js` | FIXED | today-lane-rank-session, today-decision-state | global `rank` + hash unchanged |
| 4.5 1w relabelled 1m | `expectancyFor` exact-horizon | PROTECTED; `sbVerdict`/`ofFableEdgeHTML` now name the key used | predictive-redesign-today, review-ui-pins | — |
| Opportunities tab re-ranks client-side | `public/js/opportunities.js` | OPEN (labelled research; race + retry fixed) | opportunities-race | no second eligibility engine added |

## Prompt 5 — outcomes, benchmarks, accounting

| ID | Current code | Status | Evidence | Change |
|---|---|---|---|---|
| C2 stop fill through a gap | `api/backtest.js simAtrTrade` | FIXED | backtest-outcomes: r −0.0308 → −0.1015 | `BACKTEST_VERSION` → `backtest-exec-v3` + `FILL_POLICY_NOTE` ("not comparable") |
| C2b immature trade closed as a win | same | FIXED | backtest-outcomes | `{open:true, markR}`; `openTrades`/`openPositions` reported |
| C2c missing benchmark date = raw return | `benchmarkExcess` | FIXED | backtest-outcomes | `excess:null` + reason; `alphaN`, `benchmarkMissing` |
| C1 portfolioMode fills | `simulatePortfolio` | PROTECTED; C1b LABELLED | portfolio-reconciliation; `accounting.method` | "daily-rebalanced equal-weight return composite, not a cash ledger" |
| C3/C3b/C3c evolve labels | `lib/evolve-labels.js matchedBenchmarkReturn`, `tripleBarrier` | FIXED | evolve-labels-matched-benchmark (7): +8% exit vs flat SPY stays +8% though SPY +10% later; missing date → null; gap-through → −10% | `LABELS_VERSION` → `evolve-labels-v2` stamped on new rows only |
| C4 shorts resolved with long logic | `lib/evolve-routes.js` | FIXED | evolve-contract-v2 | `side` persisted; shorts `excluded` with reason; legacy → `sideAssumed` |
| Prompt 5 fixtures (flat prices lose exactly costs; long/short opposite signs) | `lib/outcome.js resolveTrade` | PROTECTED | backtest-outcomes, outcome | — |
| 5.5 versioned recomputation | — | PLAN | — | backtest: nothing persisted, recomputes on request. evolve: old `evolve/resolved.json` rows keep v1 (no `labelsVersion`); local re-resolve from `evolve/<date>.json` + cached candles ≈45 tickers/run; pre-change shorts are unidentifiable (no side logged) and stay `sideAssumed` longs. Not run. |

## Prompt 6 — prospective ranking, calibration, independent evidence

| ID | Current code | Status | Evidence | Change |
|---|---|---|---|---|
| D1 frozen snapshot | `lib/evolve-routes.js buildLoggedPredictions` | FIXED | evolve-contract-v2 | `side, rawProbability, calibrationStatus, modelId, labelsVersion, evolveVersion` |
| D2 calibrator refit on published P | same | FIXED | evolve-contract-v2: raw .5 / published 1 trains on .5; `excludedNoRaw`, `fitCutoff`, `n` | legacy rows ineligible with reason |
| D3 idempotent resolve · D5 embargo split | — | PROTECTED | evolve-contract-v2 (recomputePerf twice deep-equal), backtest-embargo | — |
| D3b day doc overwritten | `logEvolveDay` | FIXED | evolve-contract-v2 | write-once via `blobExists` |
| D4 duplicated specialists = effective N | `lib/evolve.js ensembleProbability`, `recomputePerf.events` | FIXED | evolve-contract-v2: six shared events effN 15 → 7.5, no TRADE | cap `ctxEvents + 0.25·globalEvents`; raw-sum pin kept when no counts |
| 6.5 evidence report / portfolio drawdown | `lib/perf-metrics.js`, `lib/paper-portfolio.js` | OPEN | — | existing per-strategy reports unchanged; no new report built. Portfolio drawdown is only ever derived from the House Book NAV path (`equitySeries`); nothing compounds overlapping signal returns. |
| 6.6 one shadow challenger | — | NOT REGISTERED | — | No challenger was added. Protocol if one is wanted: pre-register in `lib/hypothesis-registry` (objective = cost-net matched excess vs conviction-v1, same universe/horizon/costs; window = next 60 sessions; promotion = FDR-surviving positive excess with ≥10 distinct dates per cohort); shadow weight 0; no threshold changes on a null result. |

## Prompt 7 — options quotes, contract validity, execution language

| ID | Current code | Status | Evidence | Change |
|---|---|---|---|---|
| O1/O2/O3 "Executable liquidity OK … should fill" on Saturday | `lib/options-execution-v2.js contractLiquidity`, radar route, `app.js of2ExecutionHTML` | FIXED | options-snapshot-liquidity (15): Fri print read Sat → `snapshotOnly, executable:false, requoteRequired, executableFraction 0, currency{…}`; wide spread + unknown size separate; expired blocked; zero bid "no bid" | `state` = snapshot spread quality; `snapshotLiquidityFraction` keeps the utility input unchanged (decision-adapters) |
| O4 crossed/zero/missing quotes · O16 radar direction design | — | PROTECTED | options-hypotheses-v2, options-v2-* | — |
| O5–O10 Income & Entry | `lib/putsell-routes.js assembleRealPut`, `putsell-contract.js`, `putsell.js` | FIXED | putsell-honesty (10): 9500/120/93.8 reconcile; adjusted ×50 → 4750/60; earnings 40d vs 45/35 DTE; `no-expiry-in-window`; `non-standard-deliverable`; locked quote rejected; missing IV → `ivLevel 'unknown'`, no grade lift; unknown earnings ≠ "no earnings" | quote provenance (`quoteAsOf`, `delayedByMin`, `source`, `session`) carried; copy says re-quote, never a fill |
| O11/O12 fable prompt "sweep bought@ask = conviction" | `lib/optionsflow-fable.js` | FIXED | optionsflow-fable-honesty (3), optionsflow-fable (pin updated) | `high-turnover` / `last@ask`; call volume alone never confirmed buying; wire `kind` keys unchanged (ledgers) |
| O13–O15 tooltips/copy | `public/js/app.js` (16 strings) | FIXED | review-ui-pins "options UI…" | aggressor, OI, "options bets", "Single-stock conviction" reworded |
| Income & Entry source wiring (Yahoo direct, not CBOE) | `lib/putsell-routes.js` | OPEN | *observed* | left; `source` stamped |

## Prompt 8 — decision workflow and counts

| ID | Current code | Status | Evidence | Change |
|---|---|---|---|---|
| 8.1/8.2 summary first, reasons, as-of | `public/js/today.js` (session line, governed empty text, retained-why line, details) | FIXED | today-decision-state | — |
| 8.3 Pulse counts contradict rows | `public/js/pulse2-render.js` | FIXED | pulse2-counts: fixture 1/3/6 with no Day rows → "0 visible · 3 listed are expired or outside the loaded window"; tabs `Day 0/0 · Swing 0/3 · Investor 0/6` | — |
| 8.4 Enabled/Disabled vs governance; n=1 100% | `app.js sbCard/sampleVerdict`, `today.js trackLine` | FIXED | review-ui-pins, today-decision-state | "Shown/Hidden in my screens" + aria-pressed; `Insufficient (n=1)` uncoloured in every regime; CI level from data |
| 8.5 contrast / focus / keyboard / hover-only | `public/css/app.css --text-2`, `today.js` | FIXED | review-ui-pins (measured): `--text-2 #8ea0bf` 7.44/7.16/6.82 vs old `.td-dim` 1.42/1.37/1.30; Pulse grey 4.08 → 7.76; one `:focus-visible` rule; cards `tabindex/role` + Enter/Space | not changed: disabled-card opacity, card borders |
| 8.6 races / retry | `opportunities.js`, `app.js todaySeq`, `live-price.js` | FIXED | opportunities-race (2), review-ui-pins, live-price-asof | — |
| Screenshots at 390/768/desktop, keyboard flow | — | **UNVERIFIED** | no browser/DOM tooling on this machine (no Chrome/Chromium, no jsdom/Playwright in the repo) | render functions are unit-tested with fixtures; visual + keyboard flow need a manual check after deploy |

## Compatibility implications (scheduler / client)

- **Refresh buttons** on Biotech and Cross-Asset no longer trigger the LLM tick anonymously; they fall through to the cached read (the tick is cron-only).
- **Apex "Recalibrate now" / "Seed from history"** are dry runs for the browser (`dryRun:true`); adopting a re-fit requires the CRON_SECRET bearer. No scheduled job runs `op=recalibrate` today — decide whether to add one or accept manual trusted calls.
- **daytrade-scan.yml** capture step now sends the bearer; without `CRON_SECRET` the report is computed but not persisted.
- **Nightly grading is stricter**: 200+`ok:false` steps, nested 5xx, no-body and blocked steps now fail/incomplete a chain. The first night will likely expose previously invisible `app:failed` steps (e.g. "Blob storage not configured", missing keys). `op=chainsummary` duplicate POSTs return 200 `duplicate:true`.
- **op=health** is stricter (`healthy:false` on a run ≥2 sessions stale or unknown market data); new additive fields `dataCurrent`, `dataKnown`, `verdicts`, `scheduler`, `lastRun.kicks`. Kick failures never flip `healthy` by themselves.
- **op=provenance** `verification.ok` is false for `unconfigured`/`listing-error`; `chainStatus:'incomplete'` when any ledger entry is unreadable.
- **Pulse v2**: `clocks.dataMode` `'live'` → `'complete'`; playbook event-risk lines carry per-item basis + `sources`/`asOf`; event records gain schedule fields; `date-changed`/`cancelled` transitions.
- **Options**: `contractLiquidity.executableFraction` is 0 for delayed/off-session/unsized records (old scalar in `snapshotLiquidityFraction`); `realPut` gains provenance; `reason` may be `no-expiry-in-window` / `non-standard-deliverable`; Fable prompt tokens changed (LLM input text), wire `kind` keys unchanged.
- **Today payload**: additive `session`, `laneRank`, `governanceGate.excluded[].codes`, `rejectionReasonCounts` now counts every code (+ note). `boardHash` unchanged.
- **Versions**: `backtest-exec-v3` (nothing persisted), `evolve-labels-v2` (new rows only; old rows untouched). Rollback = revert the branch; no data migration was run.

## Still unverified / blocked

- Deployment relationship: the branch was cut from `main` and `main` auto-deploys on merge; the deployed app was never queried.
- Live magnitude of newly-red nightly steps; live `op=evolveresolve`/`evolvescore&log=1`/`today&log=1` against Blob (fixtures only).
- Browser verification of Prompt 8 (see above).
- Official Fed/BLS calendar ingestion (not added); Income & Entry still on the Yahoo chain path; B8/B11 derived-cache RMW sites; in-process warm chain grading (legacy path).
