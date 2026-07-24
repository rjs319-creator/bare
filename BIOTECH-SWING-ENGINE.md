# 🧬 Biotech Swing Engine

A ground-up redesign of the Biotech Radar from an **early-runner detector** into a **staged swing
engine** that concentrates attention on verified, liquid, properly-timed setups while pulling
unresolved binaries, dilution traps, illiquid promotions, M&A-near-offer names, and already-consumed
moves *out* of the actionable set.

> The 0–100 headline is a **Research Priority** (attention ordering), **not a probability**.
> Probabilities stay withheld until a frozen, out-of-sample-calibrated model clears the Phase-13
> validation gate. **No governance maturity, eligibility, or production weight was changed** — biotech
> still feeds `decision.js` as `catalystForcedFlow` / `event`, and the shadow episode grading changes
> no live weight.

## Pipeline (current vs redesigned)

| Stage | Legacy (`lib/biotech.js`) | Redesigned (Biotech Swing Engine) |
|---|---|---|
| Universe | curated `BIOTECH` ∪ name-matched expanded | `biotech-universe.js` — PIT membership date + discovery method, dedup, false-positive filter, delisted retention, coverage report |
| Evidence | one AI web-search per name, AI is the factual source | `biotech-events.js` verified event ledger + `biotech-capital.js` deterministic capital state; **AI interprets a retrieved bundle only** |
| Features | ADR, run-age, spike-fade | `biotech-features.js` — event-anchored VWAP/gap-retention/close-location, base tightness, participation, XBI residual |
| Classification | one blended /100 → Hot/Emerging/Watch | `biotech-archetypes.js` — 7 distinct opportunity lanes |
| Risk control | trap penalties inside the score | `biotech-gates.js` — independent action ceilings + severe-loss gates that can only *lower* the ceiling |
| Plan | none | `biotech-plan.js` — entry/stop/targets/R:R, mandatory exit-before, biotech cost |
| Score | one number | `biotech-score.js` — **separated** setup / catalyst-evidence / scientific / capital / execution + a ceiling-capped Research Priority |
| Lifecycle | daily overwrite | `biotech-episodes.js` — reuses the Swing Episode Supervisor (immutable origins, union guarantee, no silent disappearance) |
| Grading | Scoreboard vs XBI | `biotech-grade.js` — next-open, XBI-relative, 3/5/10/21 with per-horizon `resolved` flags, per-archetype |
| AI | Haiku + web_search, ID-whitelist | `biotech-ai.js` — bounded interpreter: evidence bundle, citation whitelist, "Verified" requires a cited primary source, model/prompt/timestamp stamped |

## Opportunity lanes (archetypes)

`POST_CATALYST` · `POST_EVENT_PULLBACK` · `CATALYST_BASE` · `FINANCING_RELIEF` · `PRE_EVENT`
(exit-before-mandatory) · `SYMPATHY` · `BINARY_WATCH` (routed out of normal ranking) · `UNCLASSIFIED`.

## Action ceilings (a gate can only lower these)

`PRIMARY-SOURCE CONFIRMED` → `ACTIONABLE` → `WAIT` → `WAIT FOR FINANCING` → `NEEDS REVIEW` →
`WATCH ONLY` → `BINARY WATCH ONLY` → `LATE` → `NON-EXECUTABLE` → `AVOID`.

## Capital-structure states (deterministic where free data allows, else UNKNOWN)

`FUNDED_THROUGH_CATALYST`* · `ADEQUATE_RUNWAY`* · `FINANCING_LIKELY` · `ACTIVE_ATM` ·
`PENDING_OFFERING` · `COMPLETED_FINANCING_RELIEF` · `SEVERE_DILUTION_RISK` · `UNKNOWN`.
`*` cannot be asserted on free data (no cash/runway feed) → degrade to `UNKNOWN`.

## Ops & wiring

- `op=biotechtick` — full pipeline (cron/force only; `SHARED_FORCE_OPS`). Warmed in `api/warm.js` `aiTicks`.
- `op=biotech` — fast cached board (public). Payload is a **superset** of the legacy `items[]`.
- `op=biotechgrade` — shadow multi-horizon grading; warmed fire-and-forget. **No live-weight impact.**

## Storage / migration

- `biotech/latest.json` — serve cache (superset; old readers ignore new fields).
- `biotech/<date>.json` — daily ledger via `writeBiotechDay`: **back-compat `picks[]`** (apex + calibration)
  **plus** a full immutable `snapshot[]` and `dataProvenance:'prospective_live'`.
- `biotech/episodes.json` — supervisor episode state.
- `ledger/biotech-episodes/*` — append-only hash-chained origins (best-effort).
- No destructive migration: new keys are additive; existing `picks[]` schema is unchanged.

## Data availability

**Works on existing free data:** universe, mechanical features, XBI regime/benchmark, deterministic
capital state from **EDGAR filing dates** (S-3/424B5/8-K via the new `edgar.fetchOfferingFilings`) +
**Form-4 insider net** + **news offering-headline classification** + shares-outstanding snapshot,
archetype routing, gates, plan, episodes, grading, bounded AI (needs `ANTHROPIC_API_KEY` + a news key
for the bundle).

**Requires additional / paid data (currently degrades to UNKNOWN):** cash, burn, runway quarters
(balance-sheet feed); shares-outstanding time series / dilution growth; XBI/IBB **holdings** (no free
feed — benchmark price only); survivorship-complete delisted-inclusive PIT master (research-only today);
ClinicalTrials.gov / FDA structured calendars for exact future event dates.

## Environment

No new required env vars. Optional (already used elsewhere): `ANTHROPIC_API_KEY` (bounded AI),
`FMP_API_KEY` / `FINNHUB_API_KEY` (news bundle + shares), `SEC_USER_AGENT` (EDGAR etiquette),
`BLOB_READ_WRITE_TOKEN` (ledger/cache). All absent → the engine degrades honestly.

## Validation gate (Phase 13 — pre-registered, NOT auto-promoting)

≥150 resolved episodes · ≥60 independent dates · per-archetype coverage · positive incremental excess
over the price/volume baseline · CI excluding zero · no single-name/regime dependence. Until cleared,
grading is shadow-only and no probabilities are shown.

## Known limitations

- No exact future-event dates without a clinical/FDA calendar feed → `PRE_EVENT` requires a dated event
  or it routes to `BINARY_WATCH` (safe).
- Capital model confirms overhang but cannot confirm "funded through catalyst" on free data.
- Universe is not survivorship-complete on the live feeds (`survivorshipSafe:false`).
- Event verification currently derives from AI-cited retrieved sources; a dedicated EDGAR/CT.gov
  event extractor would raise `PRIMARY`/`CORROBORATED` coverage.

## Local verification

```bash
cd /Users/ravishah/Documents/market-news-app
npm run check
node --test test/biotech-*.test.js   # engine suite
node --test                          # full suite (2217 pass)
```

## Recommended deployment order

1. Merge `feat/biotech-swing-engine` → `main` (keep main the integration point).
2. Ensure `candles/biotech.json` + `candles/expanded.json` are warm (`/api/screener?scope=biotech`).
3. `vercel --prod` from main. Verify `op=biotech` serves, then trigger `op=biotechtick` (cron warms it).
4. Let episodes accrue; `op=biotechgrade` reports the shadow gate status. Do **not** change weight
   until the validation floors are met.
