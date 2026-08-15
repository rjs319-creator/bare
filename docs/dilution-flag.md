# 424B5 dilution flag — shadow overlay runbook

**Status: SHADOW, weight 0.** Operationalises the `dilution-events-2026-08` finding
(`research/95-dilution-events.js`, `research/results/avenues_scan_2026-08.md`): names that
file a 424B5 prospectus supplement lagged SPY by ~1% over 5 sessions and ~2-4.5% (median)
over a quarter on 1,722 events (2021-2026), all cells surviving BH FDR, placebo-controlled.
EDGAR filing dates are immutable, so the live flag's event clock is genuinely PIT.

The flag **changes nothing**: no rank, no selection, no sizing, no alerts. It renders as a
labeled research badge and accrues a prospective ledger. That is all it may do until the
promotion path below completes.

## Pieces

| Piece | What |
|---|---|
| `lib/dilution-flag.js` | frozen config (91-day window, 8-day "fresh" tier), EDGAR FTS fetch, flag-set builder |
| `lib/dilution-routes.js` | `op=dilution` (public read) · `op=dilutiontick` (privileged) · `op=dilutionresolve` (privileged) |
| `public/js/dilution-badge.js` | "⚠️ 424B5" badge on candidate cards (`data-live` contract, same as the flow badge) |
| `lib/warm-chains.js` `dilution` root | nightly: tick then resolve, own budget |
| Blob | `dilution/v1/current.json` snapshot · `dilution/v1/prospective/{date}.json` write-once ledger days · `.../index.json` |
| Tests | `test/dilution-flag.test.js` (frozen semantics, PIT parse, ledger selection, outcome construction, privileged writes, honest language) |

## Daily cycle (automatic once deployed)

1. `op=dilutiontick` (22:00 UTC warm burst, own root; ~8 EDGAR calls, zero FMP):
   refreshes the snapshot **fail-closed** (a failed fetch leaves the previous snapshot —
   a partial one would render as "no dilution risk"), and appends the write-once ledger
   day: names newly filed since the previous ledger day.
2. `op=dilutionresolve`: scores ONE matured ledger day (≥9 calendar days old) with the
   research-identical 5-session next-open SPY-excess. A day with any immature name is
   postponed whole — never a partial resolve (early resolutions are a biased subset; same
   rule as the NAV repair).
3. `op=dilution` serves the snapshot + prospective progress; the badge reads it once per
   session.

Manual kick: `curl -H "Authorization: Bearer $CRON_SECRET" "$APP/api/tracker?op=dilutiontick"`.

## Promotion path (frozen — do not shortcut)

1. Ledger accrues to **≥ 50 resolved decision dates** (`prospective.resolvedDays` on
   `op=dilution`; at one ledger day per weekday that is ~2.5 months).
2. A **formal date-clustered evaluation** (HAC + block bootstrap, the running mean on the
   status endpoint is explicitly not it) confirms negative 5-session excess consistent
   with the historical estimate.
3. Only then may a **manual, reviewed registry/config change** let the flag do anything
   beyond display — and the first permitted step is a candidate-surface *annotation
   weight*, not selection. No automated promotion exists on purpose.

Rollback: the badge and ops degrade to honest absence when Blob or EDGAR is unavailable;
deleting `dilution/v1/current.json` blanks the badge; the ledger is append-only and is
never rewritten.
