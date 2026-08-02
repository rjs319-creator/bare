# DATA-FOUNDATION-V3 — Implementation Record

**Date:** 2026-08-02 · **Baseline:** `main` @ `b0fe35a`, suite 2881 pass / 0 fail
**After:** suite 3014 pass / 0 fail (+133 tests, 0 modified assertions)

Objective: maximize the **credible** predictive power of the screeners by fixing
correctness, completeness, point-in-time integrity, reproducibility and
statistical validity of the underlying data. This work is a **data and
validation redesign**. It claims no alpha. Several previous results become
*weaker or unquotable* under the corrected contracts — that is an improvement.

How the deltas classify (per the honesty taxonomy):

1. **Data-quality improvements** — everything in phases 1–6 below.
2. **Reductions in false/overstated alpha** — fwd-outcome-v3 labels, HAC/MBB
   inference, benchmark-coverage exclusion, BH-bound verdicts, panel-v2
   revalidation flags.
3. **Predictive improvements supported by OOS evidence** — **none claimed.**
   Nothing here was measured to predict better; the corrected dataset has not
   even been regenerated yet (blocked on an operational step, see Migrations).
4. **Speculative** — the Phase 8 feature families (interfaces only, no data).

---

## Phase 0 — verified before-state defects (all 12 CONFIRMED)

Executable reproductions: `test/v3-defect-repro.test.js` (16 tests). Each pins
the defective v2 behavior (v2 stays frozen for compatibility) and the v3 fix.

| # | Defect (verified location) | v3 fix |
|---|---|---|
| 1 | `research/lib/pit.js forwardOutcome`: last bar ≥30d before cutoff ⇒ `delisted` + haircut, no authoritative record | `research/lib/outcome-v3.js` — stale tail ⇒ `unresolved`, null label |
| 2 | `lib/pitdata/collector.js`: step `done` is a permanent no-op | v3 runs are keyed to dates; a completed run never blocks the next day |
| 3 | Same file: provenance hard-coded `historical_reconstruction` | per-run provenance; recurring runs are `prospective_live` |
| 4 | `saveRaw` hashed `{rows:N}`, stored `payload:null` | content objects hash the exact canonical payload and store it |
| 5 | Old ticker missed when old/new tickers shard to different letters | alias index keyed by EVERY historical ticker's own letter |
| 6 | `resolve.js listingsForSymbol` ignores alias effective intervals | half-open `[from,to)` intervals enforced; expired aliases never resolve |
| 7 | `universeAt` admits listings with unknown exchange through an exchange filter | unknown data FAILS any requested filter (bucket `unavailable`) |
| 8 | stock-list rows get ticker-only low-confidence identity | FIGI/CIK/IPO-keyed ids, confidence tiers, candidates preserved |
| 9 | `reconcile.js`: 4 shallow gates; passes with 100% low-confidence identity | 26-gate battery incl. identity, longitudinal, instrument, raw integrity |
| 10 | `harness.js summarizeICs`: "block bootstrap" resamples single dates IID | genuine moving-block/stationary bootstrap + Newey-West HAC |
| 11 | `baseline-ranker momentum121`: missing `mom121` scored **0** and included | rows missing a required benchmark feature EXCLUDED + coverage reported |
| 12 | `benjaminiHochberg` existed but bound no verdict | verdicts decided AFTER BH with trial denominator ≥ registry family count |

## Architecture and storage paths (Phase 2)

All shadow, versioned BESIDE v2 (`pitdata/` untouched; nothing deleted):

```
pitdata/v3/raw/content/<full-sha256>.json      immutable content objects (payload + hash)
pitdata/v3/raw/observations/<date>/<runId>/<seq>.json   append-only sightings
pitdata/v3/runs/<date>/<runId>.json            run manifests (pages, counts, hashes, failures, retries)
pitdata/v3/state/<collector>.json              cursor + run history + prospective dates
pitdata/v3/listings/<A-Z|0>.json               listing records (append-only interval tracks)
pitdata/v3/aliases/<A-Z|0>.json                alias index keyed by the ALIAS's own letter
pitdata/v3/universes/<policyVersion>/<date>.json  immutable UniverseSnapshots
pitdata/v3/health/<date>.json                  daily immutable health artifact
pitdata/v3/reconciliation/<date>.json          gate reports
pitdata/v3/promotion/<date>.json               human promotion proposals (separate artifact)
research/decision-events/<date>/<eventId>.json append-only decision events
research/evidence/<hypothesisId>/<recordId>.json append-only evidence records
```

Modules: `lib/pitdata/v3/{schema,identity,resolve,collector,universe,reconcile,health,features}.js`,
`lib/research/{stats-v3,harness-v3,evidence-log,decision-events}.js`,
`research/lib/outcome-v3.js`, `research/15-panel-features-v3.js`, `research/16-secmaster-v3.js`.

## Exact time semantics

Four distinct timestamps on every observation: `effectiveAt` (true in the
world) · `sourcePublishedAt` · `observedAt`/knownAt (first observed by this
system) · `ingestedAt` (persistence complete). Intervals are **half-open
`[effectiveFrom, effectiveTo)`**; comparisons preserve full ISO timestamps
(intraday queries are NOT truncated to days); a date-only knownAt bound means
end-of-day; a date-only effective bound means start-of-day. Current-only values
(profile, float, sector) begin at observation time and are never backdated.

Two explicit query policies stamped on every resolver result, never mixed
silently: `prospective_replay` (only knowledge by the decision knownAt; replay
without a cut fails closed) and `retrospective_universe_reconstruction` (later
STABLE listing/delisting facts admitted, result marked `reconstructed:true`;
mutable facts still respect the knowledge cut).

## Label contract (fwd-outcome-v3, Phase 1)

States: `mature` · `confirmed_delisted` · `pending` · `unresolved` · `no_fill`.
Only `mature` and `confirmed_delisted` carry `labelReady:true` / a training
label; `pending`/`unresolved`/`no_fill` are null. A delisting requires a
versioned master record with listing ID, confirmed date, authoritative source,
confirmation/source-publication timestamp and provenance; reason category
drives treatment — bankruptcy-like ⇒ configured haircut (−30% Shumway);
acquisition/merger/rename/exchange-move ⇒ **carry, never haircut**; unknown
reason ⇒ haircut recorded as `haircut:unknown-reason-default`. Conflicting
status (bars after the confirmed delisting) fails closed. The adjustment basis
is validated (`raw+adjusted-preserved` / `adjustment-inconsistent` /
`unverified-vendor-close`) — the vendor close is never silently trusted.

Panel-v3 (`panel-features-v3.json`) is generated BESIDE panel-v2 and only when
`research/data/secmaster-v3.json` exists; otherwise it writes
`panel-v3.BLOCKED.json` with deterministic migration commands. Panel-v2 is
never overwritten. Findings that depend on inferred delistings are flagged in
`research/PANEL-V2-REVALIDATION.md`.

## Identity and alias policy (Phase 3)

Ticker is an alias. Listing IDs are deterministic and assigned once:
FIGI (share-class) > CIK+IPO+symbol > CIK+symbol > symbol+IPO >
symbol+firstObserved. **CIK alone never merges share classes** (symbol stays in
the key). Confidence tiers high/medium/medium-low/low; missing identifiers
lower confidence, never break collection; competing candidates preserved;
ambiguity fails closed (`ambiguous` with all candidates — never first-pick).
Renames close the old alias at the rename date (half-open) in both the listing
track and the alias index; the raw observation layer stays append-only, the
derived identity state is corrected. Delisted-feed rows for a renamed ticker
merge into the existing listing via resolve-before-create.

## Universe policy (Phase 4)

`us-common-v3.0`: confirmed `common_stock` only (a `/stock-list` "stock" row is
`stock-unverified` until a profile corroborates ⇒ `unavailable`), NASDAQ/NYSE/
AMEX, US/USD, PIT price ≥ $1, PIT cap ≥ $50M, PIT $ADV ≥ $250k. Unknown data
never passes a requested filter. Snapshots partition selected/rejected/
unavailable with stable reason codes, carry coverage stats, provenance mix,
policy + master versions, and are content-addressed (`snapshotId`).
`survivorshipSafe` is structurally false.

## Data-source capabilities and limitations

- **FMP (paid Premium, `/stable/*` only — newer keys 403 on `/api/v3/*`)**:
  stock-list, delisted-companies, symbol-change, profile, historical market
  cap, splits, dividends, shares-float — all wired into the v3 probe; the probe
  runs before any claim of availability. Known caps: quarterly analyst
  estimates and transcripts are Ultimate-tier; estimate vintage history
  unverified.
- **SEC** (free): `company_tickers.json` CIK/ticker corroboration probed;
  filing acceptance timestamps available via EDGAR (throttled ≤10 req/s — full
  universe requires the external box, per the earlier lib/edgar.js pilot).
- **OpenFIGI** (optional): no `OPENFIGI_API_KEY` ⇒ identity confidence capped
  below `high`; collection is never blocked by its absence.

## Reconciliation thresholds (Phase 5)

26 gates in `lib/pitdata/v3/reconcile.js` `GATES_V3` (code-reviewed constants):
run freshness ≤3d, all pages, raw-hash re-derivation (≥5 samples, 0 failures),
≥5 distinct prospective dates, ≥5000 listings, ≥1000 confirmed delistings,
≥50 renames, ≥50% IPO-dated, ≤30% low-confidence identity, 0 unresolved
identity conflicts, ticker-reuse test coverage, ≥60% instrument-typed, ≥40%
confirmed common stock, ≥80% exchange-known, ≥40% country/currency, sector,
≥10% corporate-action coverage, ≥40% cap/ADV joinable, ≥3 historical universe
samples, ≤2% v1-only symbols, ≤25% divergence vs external control totals,
label-state rates supplied and ≤60% unresolved, ≤0.1% duplicate security-date
pairs, 0 impossible timestamps. Missing inputs (external controls, label
stats) **fail** their gates rather than passing silently.

Passing everything = **engineering-complete only**. `survivorshipSafe` and
`consumerSwitchAllowed` are hard-coded false in the report. A switch requires
the separate promotion artifact (`makePromotionProposal`: engineering-complete
report + named human approver + report hash binding) **and then a reviewed code
change**. `op=pitdata&view=v3promote` writes the proposal; nothing applies it.

## Validation protocol (Phase 7)

`lib/research/stats-v3.js`: Newey-West HAC t (Bartlett, horizon-appropriate
lags), genuine moving-block + stationary bootstrap (seeded), paired daily
candidate-minus-baseline diffs, effective sample size, outlier dependence.
`lib/research/harness-v3.js`: benchmark coverage + exclusion (comparable
populations), chronological folds, regime/cap blocks, required no-information
control, BH q-values with denominator = max(candidates + declared variants,
registry family trials), verdicts decided after correction. PASS requires:
positive paired HAC t, q ≤ 0.10, ESS ≥ 30, ≥2 positive chronological periods,
beats the control, not outlier-driven, cost-net positive when supplied — and is
still only **PASS-PROVISIONAL** (survivorship + prospective gates remain).
`lib/research/evidence-log.js`: append-only evidence records keyed by
(hypothesis, dataset, period, horizon, code, manifest); registry status becomes
a derived view; sealed-holdout ledger (register-before-open, open-once).
`lib/research/decision-events.js`: append-only decision events, deterministic
idempotency key, intraday-capable, **no force parameter exists**; the legacy
snapshot store's `force` flag remains only as an explicit named argument on the
v2 path (documented isolation; v3 consumers use decision-events).

## Tests added (133)

`v3-defect-repro` (16) · `pitdata-v3-collector` (11) · `pitdata-v3-resolve`
(15, incl. the ticker-reuse coverage marker) · `pitdata-v3-universe` (7) ·
`pitdata-v3-reconcile` (11) · `outcome-v3` (11) · `harness-v3` (10) ·
`evidence-decision-events` (9) · `pitdata-v3-isolation` (7, incl. secret
hygiene + live-rank isolation) · `pitdata-v3-features` (3) · `panel-v3-blocked`
(2) + subtests. **No existing test was modified**; all 2881 baseline tests
still pass, so no defect was encoded in an existing assertion.

## Operational cron sequence

The existing daily warm root `pitdata` now runs, in order (all shadow):
`op=pitdata&view=collect` (v2, unchanged) → `op=pitdata&view=v3collect` (one
bounded step of today's run; multiple invocations complete it over days) →
`op=pitdata&view=v3health` (writes the immutable daily health artifact).
Manual/privileged: `view=v3probe`, `view=v3reconcile`, `view=v3export`,
`view=v3promote&approvedBy=<name>`. All privileged views 401 without
`CRON_SECRET`.

## Migration and rollback

**Forward:** (1) let the v3 collector complete its first historical-
reconstruction run (or run `view=v3collect` repeatedly with `CRON_SECRET`);
(2) `view=v3export > research/data/pitdata-v3-listings.json`;
(3) `node research/16-secmaster-v3.js --from …` (or direct with `FMP_API_KEY`);
(4) `node research/15-panel-features-v3.js`; (5) re-run the flagged studies on
panel-v3 via harness-v3, appending evidence records.
**Rollback:** delete/ignore the `pitdata/v3/` prefix and the three new warm
steps — v2 artifacts, ledgers and all prior research outputs are untouched by
construction (v3 writes only to new paths; panel-v2 is never rewritten).

## Shadow-to-production promotion requirements

1. Reconciliation report engineering-complete (all 26 gates).
2. Human promotion proposal (named approver, bound to the report hash).
3. A reviewed code change switching the consumer (nothing auto-applies).
4. For any FEATURE promotion additionally: stable cost-net OOS incremental
   value over simple momentum, market-relative momentum, sector-relative
   momentum, the production rank AND a price/volume-only baseline, surviving
   harness-v3 (BH + HAC + ESS) — a standalone backtest is insufficient.

## Previous research requiring revalidation

See `research/PANEL-V2-REVALIDATION.md`: panel-v2 delisting-labeled rows,
`nonlinear-ml-panel` (28-mlrank rerun), `pead-sue` clean-panel rerun, panel-v2
tail statistics, and `pit-secmaster-v1`'s delisted counts. None were promoted,
so no live behavior changes; their numbers should not be quoted until re-run
on panel-v3. Harness-v2 verdicts (IID bootstrap, zero-filled benchmark) are
superseded by harness-v3 for all future verdicts.

## Remaining blockers / data not available

- **First v3 collection run** needs prod (Blob store + `FMP_API_KEY`); prod
  secrets are Vercel *sensitive* vars, unreadable locally, and the cron is
  privileged — so the collector was implemented and tested against fixtures.
  The exact remaining operational step: **deploy, then let the daily `pitdata`
  warm root run (or trigger `view=v3collect` with `CRON_SECRET`) until
  `state.initialBackfillComplete`, then follow the migration above.**
- Delisting **reason categories** (bankruptcy vs acquisition): FMP's
  delisted-companies feed carries no reason; until a reason source is wired
  (8-K/25-NSE parsing), confirmed delistings default to the haircut with
  `unknown-reason-default` recorded — conservative and explicit.
- Analyst-estimate **vintage** history, LULD/halt feed, borrow/locate data,
  realized fills: not available on current sources; their families stay
  `unavailable` (fail-closed interfaces in `lib/pitdata/v3/features.js`).
- OpenFIGI key absent: identity confidence capped below `high`.
- `survivorshipSafe` remains false everywhere, deliberately.

## What evidence would be required to claim improved predictive power

Regenerated panel-v3 + a harness-v3 run where a candidate beats the momentum
benchmark with q ≤ 0.10 under HAC/MBB inference on comparable populations,
positive in multiple chronological periods, cost-net, on survivorship-complete
data — followed by prospective agreement in the shadow ledgers. Until then the
correct claim is only: **the data and the inference are now more valid**.
