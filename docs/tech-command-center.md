# Technology Command Center

Section id `tech-command` · top-level nav destination **🖥 Technology** ·
schema `tech-command-v1`.

One technology universe, **three independent conclusions** — day trade, swing, and
long-term investment — each with its own features, action vocabulary, holding
period, benchmark and failure mode. A stock may be a poor day trade, a promising
swing setup and an attractive long-term holding at the same time, and the page is
built to say exactly that rather than blend them into one number.

---

## 1. Integration inventory

Everything the page consumes, and the exact terms on which it consumes it.

| Source | How it is read | Cadence | Timestamp semantics | Horizon | Evidence maturity | May affect ranking? | Limitations / fallback |
|---|---|---|---|---|---|---|---|
| **Day Trade board** (`op=daytrade`, `lib/screener-routes` + `lib/daytrade-actionability`) | public cached read, projected read-only | its own board tick (≈5 min in-session) | `dataFreshness.candidateAsOf` / `quoteAsOf` / `intradayBarAsOf`; lifecycle state is authoritative | intraday | **validated-executable** (frozen production engine) | **No** — consumed verbatim; the page adds annotations only | The engine is frozen. This page cannot advance its lifecycle, emit its alerts, or change a decision. Source down ⇒ empty board **labelled as a data gap**. |
| **Governed swing cross-section** (`op=today` → `horizons.swing`, `lib/decision` + `lib/eligibility`) | public cached read | daily + intraday refresh | `detectedAt`, `state`, `retainedLabel` | swing (3–30 sessions) | **evidence-supported** where `signalClass === ACTIONABLE`; otherwise QUALIFIED_LEAD / RESEARCH | Ordering is the **upstream governed score**; technology-relative evidence is displayed but never re-ranks | The sector-neutral / volatility-aware replacement produced negative ranking IC and is **not deployed**. |
| **Eligible tradable universe** (`lib/tradable-universe` → NASDAQ Trader directory + FMP company-screener) | one Blob read, rebuilt ≤ daily | daily, pre-open | `universeAsOf` / `builtAt` | all | verified provider data | Membership only | Directory carries no sector/industry; without the FMP key classification collapses → **curated fallback**, labelled `degraded`. Securities the metadata provider never matched are counted as `noProviderMetadata` and surfaced as an explicit coverage gap. |
| **Long-term trend** (`lib/longterm.longTermRead`) | computed from daily candles | per tick | last bar date | long term | heuristic | Yes, inside the long-term model only | Needs ≥60 daily bars; below that it returns `insufficient`. |
| **Fundamentals** (`lib/fundamentals.fetchFundamentals` → Finnhub company metrics) | bounded fan-out, tick only | per tick, ≤18 names | provider's own TTM/quarterly vintage | long term | heuristic | Yes, inside the long-term model only | No FCF / ROIC / balance sheet / SBC / dilution / concentration / capex — all declared unavailable by name. |
| **Earnings calendar** (`lib/fundamentals.fetchEarningsInfo`) | bounded fan-out, tick only | per tick | scheduled date (date-only) | swing + long term | verified schedule | Yes — as an execution gate (blackout) and an event | Not fetched by the public read; absence is reported, not assumed to mean "no earnings". |
| **Analyst recommendations** (`fetchRecommendation`) | tick only | per tick | provider period label | long term | **PIT_UNPROVEN** | **No — weight 0** | Point-in-time integrity of values *and* publication timestamps is unproven; display-only context. |
| **Options flow** (`op=optionsflow`, `lib/optionsflow` + `lib/options-confirm`) | public cached read | provider-permitted | delayed chain snapshot; `asOf` stamped | annotation | shadow | **No — weight 0, `canOriginate: false`** | Delayed data cannot establish buyer/seller, open/close, bet/hedge or sweep aggression. Not order flow. |
| **StockTwits attention archive** (`op=attention`, `lib/attention`) | public cached read | daily archive | archive `asOf`, 14-day window | annotation | shadow | **No — weight 0** | Trending-list membership only. A missing day is **no observation**, never zero mentions. Not a firehose. |
| **Benchmark ETFs** (SPY QQQ XLK RSPT SMH IGV SKYY CIBR TLT via `lib/screener.fetchDailyHistory`) | bounded fetch + shared candle cache | per tick / per read | last bar date | all | measured | Yes — regime + relative strength | A benchmark that will not resolve is named in `regime.missing`. |
| **Shared candle cache** (`lib/candle-cache`, scope `large`) | one Blob read | rebuilt by the warm cron | per-entry `lastBarDate` | all | measured | Breadth + context | Breadth uses the cache **only** — the page never fans out across the universe. |
| **News** (via `op=today`) | tick only, ≤10 items | when the tick runs | `publishedAt` + `retrievedAt` preserved | events | research | No | Syndicated copies deduplicate; undated items are quarantined out of the timeline. |
| **Read-through relationships** | subsector co-membership (direct) + optional inferred edges | per tick | classification `asOf` | events | direct = verified · inferred = research only | No | An edge with no mechanism **and** no source is never emitted. |
| **Market session** (`lib/market-session`) | pure clock | every render | ET, DST/holiday/early-close aware | all | authoritative | Gating only | — |

Nothing on this list is recomputed by the page: every engine that already exists
and is correctly governed is consumed through its published contract.

---

## 1b. Provider-vocabulary audit (2026-08-06)

The classification rules were verified against the **live** FMP company-screener
response, not against an assumed vocabulary. Result: **837 technology securities,
100% classified, 0 unclassified, `basis: tradable-universe`, `degraded: false`.**

Three things the audit changed, all of which would otherwise have shipped as silent
mis-classification:

1. **`"Credit Services"` contains the substring `"it services"`.** The IT-services
   rule was swallowing every Financial-Services credit name, which the
   adjacent-sector allow-list then dropped — Visa, Mastercard, PayPal and Amex were
   being *deleted from the universe entirely*. Fixed with a `\bit\b` word boundary;
   fintech now carries 39 names. Locked by a regression test.
2. **`"Electronic Gaming & Multimedia"` was matching the electronic-components
   rule** — 35 games publishers filed as component makers. Gaming is not one of the
   spec's named areas, so it now resolves to `other-technology`.
3. **`"Hardware, Equipment & Parts"` (105 names) matched nothing** and fell to
   `other-technology`. Now mapped to `hardware`.

Two structural limits the audit exposed, both now stated in the code and on the page:

- **`semiconductor-equipment` is not derivable from provider data.** The provider
  files AMAT, LRCX and KLAC under the single industry `Semiconductors`. The
  distinction exists only in the labelled overlay, which now carries 11 semicap
  names with a stated basis each. Same for memory, servers/networking, cloud,
  cybersecurity, AI infrastructure and AI applications — all listed in
  `OVERLAY_ONLY_SUBSECTORS`.
- **`datacenter-infrastructure` renders empty on purpose.** The power and thermal
  companies that would populate it are classified *Industrials* by the provider, and
  the overlay may only refine a name Layer 1 already placed in technology — it may
  never add one. Enforced by a test.

### The truncation defect (fixed at source)

The audit's largest finding was not a rule at all. `fetchScreenerMetadata` in
`lib/tradable-universe.js` made ONE call with `limit=10000`. The endpoint **hard-caps
its response at 10,000 rows and ignores a higher limit** — verified: `limit=20000` and
`limit=50000` both return exactly 10,000. So the call was silently truncated, and
**969 of 4,711 eligible securities (20%) carried no sector, industry or market cap at
all.** Nothing surfaced it; the unmatched names simply kept null metadata.

The fix needs no new provider and no new entitlement: query **per exchange** over the
three exchanges this universe supports. Each page then sits under the cap
(NASDAQ 6,123 · NYSE 3,047 · AMEX 367) and a page that still returns at the cap is
reported as `truncated` rather than trusted. One exchange failing keeps the others
(partial coverage beats collapsing to nothing).

| | before | after |
|---|---|---|
| eligible securities matched | 3,742 / 4,711 (79.4%) | 4,670 / 4,704 (99.3%) |
| technology securities | 646 | **837** |
| unmatched | 969 | 34 |

`ASML`, `STX` and `TSM` were among the casualties — all three now resolve. Seven
names were also newly revealed as no longer actively trading and correctly dropped.

The fix lands in the shared module, so the low-float / breakout-radar / mover-audit
stack gains the same coverage. The frozen Day Trade engine does **not** consume the
tradable universe, so it is unaffected.

Live subsector distribution: software 345 · hardware 101 · IT services 82 ·
semiconductors 76 · internet platforms 46 · fintech 45 · communications equipment 45 ·
advertising 32 · other technology 20 · semiconductor equipment 11 · solar 9 ·
cybersecurity 6 · servers & networking 5 · AI infrastructure 5 · cloud 4 · memory 3 ·
AI applications 2.

**Residual coverage gap: 34 securities (0.7%).** These are dual-class share lines
(`LBTYA`/`LBTYB`/`LBRDK`/`CENTA`/`KELYB`…) that the provider indexes under the primary
class only. The count and reason ship in `universe.exclusions.noProviderMetadata` and
`universe.enrichmentGapNote`. Closing it would mean a second classification basis
(SEC EDGAR SIC codes are free and keyless) mixed into the same field — a provenance
cost that is not worth 0.7%.

---

## 2. Architecture

### Backend

| Module | Responsibility |
|---|---|
| `lib/tech-command-taxonomy.js` | Two-layer subsector classification: provider industry rules (verified) + a small labelled overlay (current approximation). Explicit `unclassified` state. |
| `lib/tech-command-universe.js` | Loads the eligible tradable universe, classifies it, reports coverage/exclusions, degrades to the labelled curated fallback below a viability floor. |
| `lib/tech-command-regime.js` | Deterministic technology-regime arithmetic + a rule-generated one-sentence novice line + named missing measurements. |
| `lib/tech-command-evidence.js` | Evidence families, correlated-cluster discounting, quality demotion on missing data, weight-0 research overlays, the probability gate. |
| `lib/tech-command-daytrade.js` | Read-only projection of the frozen Day Trade engine onto the technology universe + annotation-only tech-relative context. |
| `lib/tech-command-swing.js` | Technology swing board over the governed cross-section; execution gates vs governance ceiling kept separate. |
| `lib/tech-command-longterm.js` | A distinct 6–36 month model with its own factors, actions and named unavailable factors. |
| `lib/tech-command-events.js` | "Around the Corner": dedupe, bucket, order, and build mechanical bull/base/bear scenarios with no probabilities. |
| `lib/tech-command-readthrough.js` | Group state, company-specific vs group-wide attribution, beta check, direct vs inferred edges. |
| `lib/tech-command-options.js` | Honest options states with the delay/limitation disclosure on every row. |
| `lib/tech-command-sentiment.js` | Attention (not sentiment) states with explicit coverage semantics. |
| `lib/tech-command-risk.js` | Concentration / overlap / event-clustering map. Informational only. |
| `lib/tech-command-lifecycle.js` | Persistent candidate records, "what changed?", transition alerts with per-session dedup and cooldown. |
| `lib/tech-command-dossier.js` | Per-ticker assembly + the multi-horizon alignment strip + the contradictions block. |
| `lib/tech-command-evaluation.js` | Immutable per-day decision records and matured-outcome resolution. |
| `lib/tech-command-build.js` | Snapshot assembly (`full` for the tick, `lite` for the bounded public fallback). |
| `lib/tech-command-routes.js` | HTTP surface, persistence, lease, health. |

### Operations

| Op | Access | Effect |
|---|---|---|
| `op=techcommand` | public, rate-limited, `s-maxage=45` | Versioned snapshot. Serves the persisted document; when none is fresh it runs a **bounded** `lite` rebuild and never writes. |
| `op=techcommandticker&ticker=` | public | One name's dossier. |
| `op=techcommandhealth` | public | Data health, freshness, disclosures, tick health, evaluation-ledger status. |
| `op=techcommandtick` | **privileged** (CRON_SECRET bearer) | The only writer: full build → lifecycle advance → alerts → immutable evaluation record → snapshot persist. Lease-guarded. |
| `op=techcommandresolve` | **privileged** | Resolves matured swing / long-term outcomes. |

A public GET cannot append an episode, change a lifecycle state, emit an alert, or
fan out across the universe. Enforced by `PRIVILEGED_OPS` in `api/tracker.js` and
covered by a test that fails if a public handler ever calls a store write.

### Frontend

`public/js/tech-command.js` (state, filters, adaptive polling, error boundary) and
`public/js/tech-command-render.js` (section renderers). Polling pauses while the
tab is hidden or the section is inactive, adapts to the market session, and an
unchanged `generatedAt` does not repaint the board.

---

## 3. The three horizon models

**Day trade.** Not a model — a *projection*. The engine's lifecycle state is mapped
to a display action (`ACTIONABLE_NOW → TRIGGERED`, `ARMED → READY`, `FAILED →
INVALIDATED`, …) and carried through beside the untouched engine state. QQQ- and
subsector-relative numbers appear as `techAnnotations` with a note stating they do
not modify the decision; a test asserts a maximally-negative annotation changes
nothing.

**Swing (3–30 sessions).** Two gate sets. *Execution* gates (plan completeness,
trigger, liquidity, earnings blackout, chase distance, staleness) decide the
mechanical action. The upstream *governance* class then applies a ceiling that only
ever moves the action **down**: `ACTIONABLE → ENTER`, `QUALIFIED_LEAD → READY`,
`RESEARCH → WATCH`, and a row that is not sizing-eligible can never be an `ENTER`.
Ordering is the upstream governed score; the composed evidence record ships with
`usedForRanking: false`.

**Long term (6–36 months).** Growth, growth acceleration, margin trajectory,
valuation-against-growth, multi-quarter trend and relative leadership → an
uncalibrated relative score → `ACCUMULATE / WATCH_VALUATION / HOLD /
THESIS_WEAKENING / REDUCE / EXIT_THESIS_BROKEN / INSUFFICIENT_DATA`. Eight factors
the configured providers cannot supply are listed by name on every card and reduce
the data-completeness grade.

---

## 4. Around the Corner

Deterministic facts first: dated earnings, computed options expiry, measured price
responses, and news with `url` + `publisher` + `publishedAt` + `retrievedAt`.
Syndicated copies collapse by normalized headline (keeping the earliest sourced
copy and counting the rest). Scheduled catalysts are structurally separate from
emerging narratives, and company scope from sector scope. Undated items are
quarantined out of the timeline rather than given a time.

Scenarios are built **by rule** from those facts: a bull/base/bear condition, a
price context, confirmation and invalidation conditions, affected related names, and
a `dataConfidence` list describing the *inputs*. `probabilities` is always `null`.
Every scenario carries a `factHash` so an LLM narration, if one is ever added, can
be cached without surviving a change in the underlying facts — and the deterministic
scenario remains the guaranteed fallback.

---

## 5. Honesty invariants (all test-enforced)

- No probability is displayed anywhere. `probabilityDisplay()` blocks unless the
  outcome is precisely defined, the horizon explicit, and a current out-of-sample
  calibration artifact exists **for that exact model version**. None does.
- Correlated evidence families collapse — Breakout + Ghost + momentum cannot count
  as three confirmations.
- Missing data lowers evidence quality; it never reads as neutral-good.
- Options and social carry `weight: 0`, `canOriginate: false`. Options may confirm,
  contradict or qualify an *independently valid* setup. "Smart money" appears only
  inside an explicit denial.
- Attention ≠ sentiment. A name absent from a day's trending list has **no
  observation**, not zero mentions.
- A research signal cannot become an actionable recommendation by passing through
  this page.
- Nothing disappears silently: departed candidates are retained for 21 days with an
  explicit exit reason.
- Empty boards state the reason and distinguish "nothing qualified" from "the source
  was unavailable".

---

## 6. Remaining validation blockers

1. **No prospective record yet.** The evaluation ledger starts empty. Nothing here
   is evidence of edge, and `op=techcommandhealth` says so.
2. **Classification is current-only.** No point-in-time sector membership exists on
   the configured providers, so any historical study over this universe carries
   look-ahead classification risk.
3. **Analyst revisions stay PIT_UNPROVEN** until the estimates audit proves value
   *and* publication-timestamp integrity.
4. **Options weight stays 0** until prospective validation shows incremental value
   over the base setup.
5. **Long-term fundamentals are partial** — eight named factors are unavailable.
6. **Breadth depends on the shared candle cache**; when it is cold, breadth is
   withheld rather than estimated.
7. **Inference protocol not yet run**: purged walk-forward, HAC standard errors,
   moving-block bootstrap, effective sample size and multiple-testing correction all
   remain to be applied once records accrue.

---

## 7. Operations

**Scheduling.** Point an authenticated scheduler at:

```
GET /api/tracker?op=techcommandtick       # every ~15 min during market hours
GET /api/tracker?op=techcommandresolve    # once daily after the close
```

Both require `Authorization: Bearer $CRON_SECRET`. Without a schedule the page
still works: public reads fall back to the bounded `lite` build, clearly labelled,
with the long-term board and news reported as unavailable.

**Rollback.** The page is additive. To disable it, remove `tech` from `TAB_GROUPS`
in `public/js/app.js` and the three `data-tab="tech"` nav links in
`public/index.html`; the ops keep working and nothing else changes. To remove it
entirely, delete `lib/tech-command-*.js`, `public/js/tech-command*.js`, the
`tech-command` section from `index.html`, the five dispatcher lines and the two
`PRIVILEGED_OPS` / two `EXPENSIVE_OPS` entries in `api/tracker.js`. No existing
module was modified beyond those wiring points, and the persisted state lives under
its own `techcommand/` Blob prefix.
