# Sharadar Integration Plan — Historical Listing Universe (DRAFT, 2026-08-03)

**Status: PLAN ONLY — nothing purchased, nothing integrated.** The purchase decision and
license acceptance are yours. This document exists so that decision has concrete shape,
numbers and acceptance gates behind it.

## 1. What this unblocks

The single blocker recorded in `research/data/history-expansion.BLOCKED.json`: an
**authoritative monthly historical listing universe with delisting reasons**. With it:

- `survivorshipStatus` can move from `survivorship-reduced` to **proven-safe** (measured,
  via the existing contract gates in `lib/research/survivorship.js`) — the hard
  prerequisite for any promotion eligibility, ever.
- The 2010–2021 panel becomes buildable → **Era A of the preregistered
  `momentum-longer-horizons` study** (sealed holdout `momentum-historical-2010-2021`)
  gets its one-shot evaluation.
- Delisting **reasons** for the pre-2021 era (bankruptcy vs acquisition) feed
  fwd-outcome-v3's treatment table instead of failing closed on unknown.
- Real rename chains with dates replace span-reconstructed alias intervals.
- A **second price provider** for 2021–2026 overlap: the corpactions layer already
  anticipates contemporaneous cross-provider confirmation; this would let unconfirmed
  extremes be confirmed/refuted and could retire the standing single-provider audit
  warning for the overlap era.

## 2. What Sharadar provides (via Nasdaq Data Link)

**Sharadar Equity Prices (`SEP` database)** — EOD prices **since 1998**, **>21,000
active AND delisted tickers**. Five tables:

| table | contents | role here |
|---|---|---|
| `SHARADAR/SEP` | daily OHLCV per ticker (split-adjusted; dividends separate) | historical bars 2010–2021; membership-by-observation |
| `SHARADAR/TICKERS` | metadata: **permaticker** (stable integer identity), ticker, name, exchange, **category** (Domestic Common Stock / ADR / ETF …), **isdelisted**, firstpricedate/lastpricedate, related tickers, sector | security master seed; instrument typing; delisting flags |
| `SHARADAR/ACTIONS` | corporate actions: **splits, dividends, spinoffs, acquisitions, delistings incl. reasons, ticker changes** | delisting reasons → outcome-v3 treatment; rename chains → identity-v3; corpaction provenance |
| `SHARADAR/METRICS`, `SHARADAR/INDICATORS` | ancillary metrics / field definitions | reference only |

**Core US Equities Bundle (`SFA`)** adds fundamentals (`SF1`, since 1990) and the
**`DAILY` table (daily marketcap/EV per ticker)** plus insiders, 8-K events, and S&P 500
constituent history since 1957.

**Why the bundle matters for us specifically:** the panel's universe rule is
cap-band + ADV. ADV comes free from SEP (close × volume). But market cap for 2010–2021
needs shares/marketcap history — that is the `DAILY`/`SF1` side. Without it we'd
approximate caps from FMP's ~15-year income statements (thin at the 2010 edge, and it
mixes providers inside the universe rule — a disclosed weakness).

## 3. Cost (to confirm at checkout — figures are gated behind the NDL login)

- Exact current prices are **not publicly displayed**; NDL shows them only to a
  logged-in account. Historically the non-professional tiers ran on the order of
  **~$25–50/month (~$299–599/year)**: SEP-only at the low end, the Core US Equities
  Bundle at the high end. Treat these as ballpark, not quotes.
- License tier: **non-professional/personal** fits this research use; professional use
  is priced differently.
- You already have an NDL account + API key (Vercel prod, sensitive; `.env.local` is
  filled manually — see `npm run probe:nasdaq` infrastructure from the estimates work).
  Log into data.nasdaq.com with that account to see the real price before deciding.

**Recommendation:** Core US Equities Bundle if the checkout price is acceptable
(marketcap history makes the 2010–2021 universe rule exact, and SF1 later enables a
proper historical SUE era). Budget fallback: SEP-only + FMP-derived approximate caps,
with the approximation disclosed in the manifest and the survivorship notes.

## 4. PIT contract mapping (how it plugs into the existing spine)

- **Identity:** `lid = shrd:<permaticker>` — a vendor-stable permanent identity that
  replaces reconstruction for the historical era. Cross-era join to the existing
  `secmaster-v3` lids via (ticker, date-interval) overlap + price-series consistency
  (`identity-v3.seriesConsistent`), quarantining conflicts exactly as today.
- **Monthly membership (the survivorship core):** point-in-time **by construction** —
  a security is a member of month M iff it has ≥15 SEP bars in M **and** TICKERS
  classifies it as domestic common stock on a US exchange. Never derived from a
  present-day list.
- **Delistings:** ACTIONS `delisted` rows + TICKERS `isdelisted`/`lastpricedate`;
  reasons mapped into fwd-outcome-v3's `REASON_TREATMENT` categories
  (bankruptcy/liquidation → haircut; acquisition/merger → carry; unmappable → the
  existing fail-closed `exclude`).
- **Renames:** ACTIONS ticker-change rows → dated alias intervals for identity-v3.
- **Corp actions:** ACTIONS splits/dividends become a second corpaction source;
  `corpactions-v2.verifySplitAdjustment` runs against both, and 2021–2026 overlap
  disagreements are surfaced, never silently merged.
- **Survivorship contract:** a new source id (e.g. `sharadar-sep-tickers-v1`) becomes
  `historicalListingSourceAuthoritative: true` **only after the §5 gates pass**;
  `monthlyExpectedListingCount` = Sharadar-derived membership;
  `monthlyCoveredListingCount` = what the panel actually carries. Proven-safe still
  requires the measured gates (worst month ≥ 98%, delisted coverage ≥ 95%).
- **Provenance:** every pulled table lands in content-addressed partitions
  (`research/data/sharadar/<TABLE>/<year>.json` + per-file sha256 → Merkle root into
  `manifest.sourceHashes`), same pattern as the price cache.

## 5. Validation gates — Sharadar is *candidate*-authoritative until it passes these

All mechanical, all producing artifacts; failure ⇒ BLOCKED artifact, not a shrug:

1. **Overlap reconciliation 2021–2026** against the existing FMP+EDGAR secmaster:
   delisting-date agreement within ±5 sessions for ≥95% of the 636 known delistings;
   the disagreement list is published, not averaged away.
2. **Known-event spot checks:** the 8 verified rename chains (CDAY→DAY, SGMS→LNW, …),
   a sample of EDGAR Form-25 delistings, and famous era events (e.g. 2008–2015
   bankruptcies if in range) resolve correctly.
3. **Monthly membership sanity:** 2010–2026 domestic-common counts inside a plausible
   band (~3,500–6,000), no discontinuity months (>10% cliff without a known cause).
4. **Price agreement:** sampled monthly closes vs FMP on the overlap era within
   tolerance; split-adjustment basis verified per symbol via the existing
   `verifySplitAdjustment` before any bar is trusted.
5. **Identity join audit:** permaticker↔lid joins with conflicting overlapping bars
   quarantine (never merge), counted and reported.

## 6. Build sequence (dependency order, all resumable)

1. `research/60-sharadar-fetch.js` — bulk pull via the NDL datatables API
   (`qopts.export=true` bulk CSV per table, then incremental slices); key from
   `research/.env` (never printed); content-addressed partitions; BLOCKED artifact on
   entitlement failure (e.g. key lacks the subscription).
2. `research/61-sharadar-secmaster.js` — permaticker master + alias intervals +
   delisting reasons; runs the §5 gates; writes `secmaster-hist.json` + a measured
   survivorship artifact; refuses to publish on gate failure.
3. Calendar extension — `us-sessions-v1` rebuilt from SEP-observed sessions
   (a date is a session iff >50% of active members have bars), hashed and versioned;
   verified equal to the SPY-derived calendar on the overlap era.
4. `research/62-panel-hist.js` — 2010–2021 panel through the **unchanged** v3.2
   builder logic (injected sources), producing `panel-features-hist-2010.json` with its
   own manifest, cohort ledger and measured survivorship contract.
5. `npm run audit:research` extended to the historical panel artifact.
6. **Era A one-shot:** only after the audit passes and survivorship reads proven-safe,
   `research/58-momentum-horizons-confirmatory.js` gets its verdict path implemented
   per the preregistration, runs ONCE, and the `momentum-historical-2010-2021` holdout
   is opened via a reviewed diff — irreversibly.

Estimated effort once data access exists: fetch ~1 session (bulk export is fast; the
partitioning/hashing is the work), secmaster + gates ~1 session, panel + audit ~1–2
sessions, Era A run gated on all of it.

## 7. Risks and honest limits

- **Sharadar ≠ CRSP.** It is widely used and survivorship-inclusive, but its pre-2010
  membership completeness is itself something we *measure* (§5.3), not assume — if the
  gates fail, survivorship stays reduced and Era A stays sealed.
- **Sector history** remains non-PIT (TICKERS sector is current-state) — the existing
  manifest limitation carries over.
- **1998–2009** comes along for free and could later extend Era A, but the
  preregistration fixes 2010–2021; using more history would be a new preregistered
  hypothesis.
- Exact pricing/license terms must be read at checkout with your NDL account; nothing
  here constitutes the vendor's current offer.
