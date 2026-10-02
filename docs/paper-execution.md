# Paper-execution ledger on Alpaca paper

Proposal #28 of `docs/GITHUB-RESOURCE-SCAN-2026-10-02.md` (lane 6, top proposal 3). Built 2026-10-02 **dormant**: no Alpaca account or keys exist yet. Everything below is wired, tested offline, and switches on with one env change.

## What it does

Every trading day, one **1-share** order per Session Board **A/B** row at the row's **frozen** entry/stop/target, placed in a shared Alpaca **paper** account; fills are polled through the session and appended to `paper-exec/YYYY-MM-DD.json` (Blob, CAS `updateJSON`, union-monotonic by order id). The ledger is then read against the Scoreboard's own daily-bar resolution.

What it measures (all in `lib/exec-paper-measure.js`, pure, tested):

| Question | Field |
|---|---|
| How often does an A/B plan actually fill, per grade and per time frame? | `summary.byGrade`, `summary.byTimeframe` |
| Stop-first or target-first inside the day? Daily bars cannot say; a timestamped fill can. | `summary.compare.counts.sameDayAmbiguous` + per-row `paperExit` vs `dailyExit` (`op=paperexec&compare=1`) |
| How far from the frozen level does a touch actually fill, per `lib/costs.js` tier? | `summary.slippageByTier[tier]` — `medianBps/p25/p75/mean` next to the tier's `priorBps` (halfSpread + slippage). **TIERS are not changed by code**; recalibration is a reviewed human edit once N is meaningful. |
| Is every snapshot row accounted for? | `summary.reconciliation` — each snapshot row id is either a planned order or carries a `notPlaced` reason (`grade-below-B`, `held-out`, `no-stop`, `no-target`, `levels-inverted`, `sub-dollar`, `illiquid`, `bad-symbol`, `duplicate-symbol`). |

**Honesty.** Alpaca paper fills on NBBO touch with no queue position and no market impact. Every friction number here is a **lower bound**, not realism. Equities only, regular hours only, 1 share (sizing is irrelevant to fillability).

## Pieces

| Piece | Where |
|---|---|
| Pure planning + reconciliation | `lib/exec-paper-ledger.js` — `planOrders(snapshot)`, `reconcile(plan, orders, {placed})`, `newLedgerDoc`, `recordPlacements`, `applyPoll`, work selectors `pendingPlacements` / `exitsToArm` / `rowsToFlatten` |
| Measurement | `lib/exec-paper-measure.js` — `fillRates`, `slippageByTier`, `dailyBarResolution` (reuses `lib/outcome.resolveTrade`), `compareDailyBar`, `reconciliationCheck`, `summarize` |
| Broker client | `lib/alpaca-paper.js` — raw `fetch`, no SDK; `paperConfig(env)`, `createAlpacaPaperClient()`; bounded retries (3 attempts, 429/5xx/transport only), strict response validation |
| Ops | `lib/exec-paper-routes.js` → `api/tracker.js`: `op=paperopen` (PRIVILEGED), `op=paperpoll[&flatten=1]` (PRIVILEGED), `op=paperexec[&date=YYYY-MM-DD][&compare=1]` (public read) |
| Scheduler | `.github/workflows/paper-exec.yml` — 13:35 UTC open; polls 14:05→20:05 UTC every 30 min; 19:50 UTC flatten; weekdays. Needs only the existing `CRON_SECRET` repo secret. |
| UI | Session Board tab: one line under the header, "paper fills: n / m · median slippage vs frozen level" — rendered only when a ledger with placed orders exists |
| Tests | `test/exec-paper-ledger.test.js`, `test/exec-paper-measure.test.js`, `test/alpaca-paper.test.js` (offline stub), `test/exec-paper-routes.test.js` (in-memory CAS store + stub client), `test/paper-exec-workflow.test.js` (YAML pins + the run block under `bash -e`), `test/session-board-frontend.test.js` |

### Order shapes

Alpaca's bracket parent may only be `market` or `limit`, so:

- **Price already at/through the entry** (pullback) → `limit` parent with `order_class: bracket` (take-profit limit + stop legs attached at placement).
- **Price short of the entry** (breakout) → `stop_limit` parent alone (stop = entry, limit = entry ± 0.5 %). The next poll arms an `oco` exit (take-profit + stop) once the parent has filled. A plain limit above the market would fill at the ask immediately and measure a chase, not the plan.

All orders are `gtc`, `client_order_id = <snapshotId>:<rowId>` (`sb-YYYY-MM-DD:<row id>`), exits `…:exit`, flatten closes `…:flat`. A duplicate `client_order_id` is the idempotency signal: the broker rejects it with 422, the client looks the order up and records it as already placed.

### Horizons

- **Intraday rows** are flattened at 19:50 UTC (`DELETE /v2/positions/{symbol}?cancel_orders=true`) → `exitKind: horizon`.
- **Swing/position/portfolio rows** keep their GTC bracket; the ledger shows `exitKind: none` until the stop or target fills. A multi-day horizon exit (close after the row's hold window) is **not built** — follow-up once the first weeks of fills exist and show it is needed.

### EST vs EDT

The 13:35 UTC trigger is 09:35 ET only in summer. In winter it is 08:35 ET and `op=paperopen` self-skips (`market-premarket`); every poll calls `paperopen` first, so the 14:35 UTC poll places the day's orders. Nothing is ever placed outside the regular session (manual `workflow_dispatch` is the same; `op=paperopen&force=1` exists for a hand test and queues GTC orders for the open).

## Enable (one step, three values)

1. Create an Alpaca account and open the **Paper** dashboard; generate an API key pair there. Paper key ids start with `PK`; the client refuses anything else and has no live base URL.
2. Add to the **Vercel Production** environment (Project → Settings → Environment Variables):
   - `ALPACA_KEY_ID` = the paper key id
   - `ALPACA_SECRET_KEY` = the paper secret
   - `ALPACA_PAPER` = `1`
   Mark the first two Sensitive. Redeploy (env changes need a new deployment).
3. Nothing to add on GitHub: the workflow already exists and uses the existing `CRON_SECRET` repo secret. Until step 2 lands, both writers answer `{ ok:true, skipped:true, dormant:true, reason }` and the workflow logs a `::notice::`.

Verify: `curl -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/tracker?op=paperopen"` during the regular session → `planned/placed` counts; then `op=paperexec` → `exists:true`. The Session Board tab shows the paper-fills line once at least one order is placed.

To **disable**: set `ALPACA_PAPER=0` (or remove it). Open GTC orders at the broker are not cancelled by the app — cancel them in the Alpaca dashboard.

## Reading the ledger

`GET /api/tracker?op=paperexec&date=2026-10-05&compare=1`

```json
{ "ok": true, "exists": true, "date": "2026-10-05", "snapshotId": "sb-2026-10-05",
  "summary": { "placed": 6, "filled": 4, "fillRate": 0.667, "medianSlippageBps": 3.1,
    "exits": { "stop": 1, "target": 2, "horizon": 1, "none": 0 },
    "byGrade": { "A": {"placed":2,"filled":2,"rate":1}, "B": {"placed":4,"filled":2,"rate":0.5} },
    "slippageByTier": { "liquid": { "n": 3, "medianBps": 2.0, "priorBps": 8 }, "small": { "n": 1, "medianBps": 12.5, "priorBps": 30 } },
    "compare": { "counts": { "compared": 4, "agree": 3, "disagree": 1, "sameDayAmbiguous": 1 } },
    "reconciliation": { "ok": true, "missing": [], "extra": [], "duplicates": [] } },
  "rows": [ { "rowId": "gapgo:intraday:ABCD", "filled": true, "fillPx": 21.43, "exitKind": "target", "realizedR": 1.97, "slippageVsFrozen": { "px": 0.03, "bps": 14 } } ],
  "notPlaced": [ { "rowId": "screener:swing:EFGH", "reason": "grade-below-B" } ] }
```

`realizedR` is in multiples of the **frozen** risk `|entry − stop|`; `realizedRetPct` is the Scoreboard's convention (fraction of entry). `slippageVsFrozen.px` is positive when the fill was **worse** than the frozen level in the trade's direction.

## Risks / follow-ups

- No alpha claim anywhere: this is an execution-measurement ledger, weight 0, affects no ranking.
- `REQUEST_TIMEOUT_MS` (15 s) and `SNAPSHOT_PULL_TIMEOUT_MS` (45 s) are unmeasured against a live account — measure in the first week.
- GitHub cron jitter: the ledger records every poll's timestamp; coverage is whatever actually ran.
- Multi-day horizon exits for swing rows; options legs; a `cancel-all` op for disabling — deliberately not built.
