# text-edge — do text-derived signals in THIS app show lead time or edge? (2026-09-09)

Sources: worktree /Users/ravishah/mna-alpha @ f5a778e; prod read-only ops op=dilution / op=techev / op=evidence / op=alerts
(handlers verified: lib/dilution-routes.js:4 "public read", lib/tech-evidence-routes.js:53 no write, lib/evidence-routes.js:276 no write,
lib/alerts-routes.js:234 no write); /tmp/alpha-swarm/scoreboard.json + maturity.json; research/experiments/registry.json.

## 1. Inventory — every text pipeline and its evidence (cost-net; P = prospective ledger, R = retrospective)

| pipeline | text source → app | lag event→ingest | sample | result | P/R |
|---|---|---|---|---|---|
| **424B5 dilution AVOID** (lib/dilution-flag.js, research/95) | EDGAR full-text search (free, PIT-immutable filing dates) | FTS indexes within hours; app tick is DAILY in the warm chain (lib/warm-chains.js:393) → ≤24h | R: 1,722 events, 814 dates 2021-26. P: 12 ledger days, **1/50 resolved dates** (op=dilution 2026-09-08: 316 flagged, 15 fresh) | R: DIL_5 **−129.5 bps, q 0.0002, 0/4 blocks positive**; DIL_21 −166 bps q 0.029; DIL_63 −293 bps q 0.029 (registry dilution-events-2026-08.r3). P: meaningless at 1 date | R strong / P absent |
| **Evidence / thesis engine** (lib/evidence-extract.js Haiku extraction → lib/evidence-consensus.js tiers) | FMP + Finnhub company news headlines (near-real-time) for the SCREENER candidate universe (evidence-routes.js:58) | GH Actions tick once daily 22:30 UTC (.github/workflows/evidence-tick.yml) → 0–24h; headlines are already-public, names already moved | Evidence:EV_STRONG 37/16d; EV_MODERATE 66/21d; EV_WEAK 35/17d; `thesis` maturity: "avg −6.1% vs SPY over 52" | **EV_MODERATE 1d −0.79 [−1.44,−0.20] 0/4; 1m −7.57 [−19.95,−2.27] 0/4**; EV_STRONG 5d −0.22 [−2.80,0.98]. Tier is a consensus score ≥60/40 (evidence-routes.js:204) = a sentiment overlay on momentum names entered after the news — no lead time by construction. **Prod op=evidence 2026-09-08: universeSize 0, count 0** (pipeline currently produces nothing). | P negative |
| **Tech operational evidence** (lib/tech-evidence/*: SEC companyfacts + 8-K 1.05, npm, GitHub, jobs, pricing, statuspage) | data.sec.gov + npm/GitHub public APIs; 5 verified tickers (MDB DDOG NET TWLO ESTC), 18 mappings | daily privileged tick; SEC facts lag = filing date (weeks after quarter) | P: 158 eligible / **146 resolved events over 65 dates** | npm arm 1d: 41 events, mean net residual **−0.96%, CI [−1.82%,−0.10%], hit 34%, rankIC −0.35 (11 dates), 0/4 blocks**, p 0.03; sec arm 0 resolved; all arms COLLECTING below the 100-event/40-date floor (docs/tech-operational-evidence.md:30) | P negative-leaning |
| **Earnings tone / ToneShift** (lib/earnings-tone.js) | FMP transcript (`/stable` then legacy fallback; transcripts are Ultimate-gated per the 07-23 capability probe) | quarterly | Tone 5 picks, ToneShift 4 picks; maturity "only 2/4 resolved" | nothing measurable | P empty |
| **News composites** (lib/research/news-alpha-features.js; research/77, 78) | archived gap-conditioned headlines (2025-10-15→2026-05-22, 81 dates, 2,880 candidates) | n/a (research) | holdout n=17 | news-composite-100 F023: holdout +5.94%/21d CI [−1.18, 14.07], 2/4 blocks → NO_CONFIRMED_ALPHA; improved-news r2: `residualMomentum` alone 4/4 blocks (+3.72, CI [−0.71, 8.18]) and the news arms did NOT add; catalyst-flow r6: E2 catalyst ranker −19.8 bps vs simple PEAD −3.3 (news/catalyst features HURT); D-revision-breadth BLOCKED_DATA | R null |
| **Attention lifecycle** (pulse2, Attention section) | StockTwits trending + news mentions | intraday collectors, daily grade | Attention:Fast 327/22d, Sticky 52/9d; registry `attention` **DISABLED** | −2.1% vs SPY over 378 resolved / 22 dates, beats 35%; Fast 5d −1.80, Sticky 5d −4.03 | P negative |
| **Social alerts** (lib/alerts*, Fable review) | StockTwits streams (keyless) + 14 X handles via Nitter (X search dead) | 2h collector | op=alerts validation: **3/25 independent dates, INCONCLUSIVE**; Fable-review A/B TRACKING 47.9% vs mechanical 46.9% (n=424, no lift); per-account records ≤5 episodes | nothing | P empty |
| **CERN forced flow** (lib/cern-run.js: lockup expiries from FMP/Finnhub IPO calendar, index changes from Wikipedia/SMID tables) | calendar-known dates → lead time is real (events known days–weeks ahead) | daily tick | LOCKUP_EXPIRY 62/35d; FORCED_DOWNGRADE 64/27d; INDEX_DELETE n=3 | LOCKUP 5d +0.13 [−4.34, 3.14], 1m +3.11 [−8.84, 26.95] 3/4 (52/29d); FORCED_DOWNGRADE 1d −0.57 [−1.15,−0.01]; `events` grade promising vs SPY (+1.05) but **−1.32 vs sector** = sector beta. R index-events: DEL_5 n=31 +11.7 bps p 0.95 → NO_EDGE | P null |
| **AI screeners** (readthrough/anomaly/secondwave/crossasset/toneshift — Sonnet 5 + web_search) | open web via model search | daily | readthrough 6 resolved; anomaly 9; secondwave 70; crossasset 63 | secondwave −3.32% (Primed 5d −5.41 [−9.54,−1.85]); anomaly +0.55 (n 9); crossasset = sector beta (prior report) | P negative/null |
| **8-K market-wide archive** (lib/filing-archives.js op=sec8karchive, since 2026-08-09) | FMP filing feed (Premium OK per fmpaudit) | rolling vendor window, daily pull | archive-only — "NO features and NO reads into outcomes" by doctrine | untested | — |

**Pattern:** every LLM-read or sentiment-read text signal is entered AFTER the text is public and the price has reacted (daily cadence, screener-universe conditioning), and every one is ≤0 cost-net. The only text finding that survives FDR is NEGATIVE (424B5), and it is prospectively immature. The forced-flow class with genuine lead time (lockups/index) is null vs sector on 29–35 dates.

## 2. Reachability of text (cost / lag)

- **SEC EDGAR** full-text search + submissions + companyfacts: free, PIT-immutable, indexed within minutes–hours; already wired (edgar.js, dilution-flag.js, tech-evidence/adapters/sec-facts.js). Form 4 publication-date gating fixed (FINDINGS-LEDGER data-lineage F-1). Throttle ≤10 req/s; a full-universe Form 4 sweep took 25–50 min on an external box.
- **FMP Premium**: stock news, press-release endpoints probed AVAILABLE (lib/fmp-audit.js:48-50); market-wide 8-K + insider feeds archived daily; earnings-call **transcripts, 13F, COT, quarterly estimates are Ultimate-only** (2026-07-23 probe; earnings-tone.js:84 legacy fallback).
- **Finnhub** company-news (free tier, ~1y history, near-real-time) and insider-transactions: wired.
- **NewsAPI** (api/news.js, gameplan): domain-limited, 30-day history on free plan — research-useless.
- **StockTwits** keyless streams: wired; **X**: dead (Nitter search 403; API $200/mo).
- **Reddit**: 403 unauthenticated.

Mechanically grounded, cheap, PIT-clean and NOT yet run as an event study: **Form 4 open-market cluster buys in small caps** (≥2 insiders, ≥$100k, non-10b5-1, within 5 sessions). Prior evidence: IN pillar rank-IC **+0.067** small-cap (912 records, correct sign) but **redundant** inside a momentum composite (delta −0.0045) — never tested as a standalone, momentum-residual event study. Lockup expiries and index deletions already have ledgers (null). 8-K Items 1.01/2.02/5.02 are informational but the app's 8-K feed is archive-only and the Evidence engine's negative record shows post-news entry does not pay.

## 3. Verdict

**No text-derived signal in this app has shown prospective lead time or positive cost-net edge.** Retrospectively, only a NEGATIVE text signal (424B5 dilution) survives FDR; the news/catalyst composites are null or harmful; attention is disabled for losing; LLM extraction (Evidence) is CI-negative and currently produces zero events.

One class meets all four criteria for a fresh prospective ledger:
**Form 4 open-market cluster buying, small/micro cap, sector- and momentum-residual, next-open entry.**
(a) informational mechanism (insiders' private information), not sentiment; (b) EDGAR submissions publish within hours, and the app already parses Form 4 (lib/edgar.js) with publication-date gating; (c) a 5-year retrospective event study runs on free data (edgar.js + the bars cache, the same rig as research/95-dilution-events.js); (d) small-cap cluster buys arrive ~1–3/session in the app's universe → 20 independent dates in ≈4–8 weeks, 50 in ≈3–5 months.
Required honesty: preregister as a momentum-RESIDUAL test (the prior composite result says raw IN is what momentum already ranks); expect the finding to be small; treat it as an addition to the AVOID/confirmation layer, not a standalone book. Second-best, already running: keep the 424B5 AVOID ledger accruing (50 dates ≈ late Oct 2026).

Out of scope, noted: prod op=evidence returned universeSize 0 / count 0 for 2026-09-08 — the Evidence tick appears to be producing nothing; worth a health check by whoever owns it.
