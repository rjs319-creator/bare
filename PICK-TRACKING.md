# Pick-Tracking & Signal Scoreboard

Logs every ticker the **Screener** and **Momentum** sections surface — with timestamp
and entry price — to persistent storage, then scores each signal's **realized** 1-week /
1-month / 3-month forward returns so you can see which signals actually have positive
expectancy and disable the ones that don't.

## Architecture

| Piece | File | Role |
|---|---|---|
| Storage | `lib/store.js` | Vercel Blob; one JSON file per day at `picks/<YYYY-MM-DD>.json`. No-ops gracefully without a token. |
| Logger + Scoreboard | `api/tracker.js` | One function, two ops (Hobby plan caps a deployment at 12 functions): `?op=track` snapshots today's picks; default/`?op=scoreboard` returns the aggregated scoreboard. |
| Cron trigger | `api/warm.js` | The existing daily warm cron calls `/api/tracker?op=track` after warming (one cron does both). |
| UI | `public/index.html` | 🏆 **Scoreboard** tab + per-signal enable/disable toggles. |

> Note: to stay within the 12-function Hobby cap, the old `/api/summarize` was folded into `/api/news` (POST = summarize, GET = headlines).

Forward returns are reconstructed from daily price history at scoreboard time
(`fetchDailyHistory`), so no separate price-update job is needed.

## One-time setup

1. **Create a Vercel Blob store**: dashboard → project → **Storage → Blob → Create**.
   This injects `BLOB_READ_WRITE_TOKEN` into all environments.
2. **Deploy**: `vercel --prod --yes` (picks up `@vercel/blob`, the new functions, and the
   warm→track wiring).
3. **Seed the first snapshot** (optional): `curl 'https://<host>/api/tracker?op=track&force=1'`.

Until step 1, the Scoreboard tab shows a "not enabled" message and nothing logs; the rest
of the app is unaffected.

## Day-to-day

Hands-off. The daily cron (`/api/warm`, 13:00 UTC ≈ 9 AM ET) warms caches then logs that
day's picks. Weekends are skipped to avoid duplicate cohorts.

- Screener entry price = the pick's close at scan time.
- Momentum entry price = the live intraday price at log time.

## Reading the scoreboard

- **Expectancy badge** (Positive / Negative / Pending) — based on the **1-month** average
  return, falling back to 1-week then 3-month until matured.
- **1-Week / 1-Month / 3-Month** columns — average return, win rate, sample size `n`.
- **Avg win / Avg loss** — magnitude of winners vs losers.

Conventions:
- **First-appearance only** — each `section:tier:ticker` is scored once, on its earliest
  log (so lingering names aren't over-weighted). The raw daily log is kept intact; dedup
  happens at read time, so the policy is reversible. Header shows distinct signals + raw rows.
- **Strong Sell is inverted** — positive return = a profitable short.
- Small samples (`n` < ~15–20) are noise.

## Disabling / re-enabling signals

Click **✓ Enabled / ✕ Disabled** on a card to hide that tier from its section. It keeps
being logged and scored, so you can re-enable it if expectancy recovers. Stored per-device
in `localStorage` (`disabledSignals`).

## Maturity timeline

Forward-only — no backfill. 1-Week fills after ~5 trading days, 1-Month after ~21, 3-Month
after ~63. Until then a horizon reads "pending."

## Endpoints

| Action | Endpoint |
|---|---|
| Force a log now (incl. weekends) | `GET /api/tracker?op=track&force=1` |
| Scoreboard data (JSON) | `GET /api/tracker` |
| Raw logs | Vercel dashboard → Storage → Blob → `picks/` |

## Troubleshooting

- **"Pick tracking isn't enabled yet"** — Blob store not created, or not redeployed since
  creating it. Do both, then `/api/track?force=1`.
- **Configured but empty** — no logs yet; trigger `/api/tracker?op=track&force=1` or wait for the cron.
- **`picks` rises but horizons stay pending** — normal; picks too recent to have matured.
- **Numbers look off** — Strong Sell is inverted; entry basis differs (screener = close,
  momentum = intraday).

---

# Apex Runner — Custom Screener & Drift Detection

The **🧠 Custom Screener** tab runs the **Apex Runner** model: a 4-pillar, regime-adaptive
score layered over the existing `/api/screener` data (no extra Serverless Function — stays
within the Hobby 12-function cap).

## The model (Module 1)
- **Pillars** (0–100 each): ① Momentum/RS, ② Technical structure, ③ Fundamental acceleration, ④ Supply/smart money — mapped from screener percentiles + narrative + fundamentals.
- **Regime-dependent weight presets**, auto-selected by the screener's regime read (`RISK_ON` / `NEUTRAL` / `RISK_OFF`), with **3-refresh hysteresis** (client-side, localStorage) before a preset switch, and **Risk-Off threshold tightening** (volume gate 1.5×→2.0×, 2× liquidity floor).
- **Tiers** (balance rule): **Apex** (≥72, no pillar <45, confirmed setup) · **Loaded** (≥58) · **Watch** (≥45).
- Scoring lives in `lib/apex.js` (server) and an identical copy in `public/index.html` (client). **Keep the two in sync.**

## Signal ledger + drift detection (Module 3)
| Piece | File | Role |
|---|---|---|
| Ledger storage | `lib/store.js` | `writeApexDay` / `readAllApex` under `apex/<YYYY-MM-DD>.json`. |
| Logger + drift | `api/tracker.js` | `?op=apexlog` logs today's Apex/Loaded signals (score, pillar breakdown, regime, entry/pivot/stop); `?op=drift` resolves outcomes + returns model health. |
| Cron trigger | `api/warm.js` | The daily warm cron calls `?op=apexlog` after `?op=track`. |
| UI | `public/index.html` | Health badge + banner in the Custom Screener header; live-vs-backtest table + failure forensics in the Model panel. |

**Outcome resolution:** each signal resolves **WIN** at +20% (before −8%), **LOSS** at −8% first,
**EXPIRED** if neither hits within 63 sessions, else **OPEN**. Health compares the trailing-60-day
live win rate / profit factor against the backtest baseline (weighted by the live regime mix):
**HEALTHY** (≥ baseline−5) · **DEGRADING** (−5 to −15, yellow "reduce size" banner) ·
**BROKEN** (< −15, red "informational only" banner). Requires ≥15 resolved signals before judging;
**BROKEN** sets `recommendRecalibration` (the Module 2 hook — recalibration itself is not yet built).

**Not yet built:** Module 2 (walk-forward re-optimization) and the narrative-tag scoring layer.

## Module 2 — Walk-forward re-optimization
`lib/recalibrate.js` is a pure, inspectable coarse grid search (±10 pts from each regime preset, 5-pt steps → 625 combos/regime). `api/tracker.js?op=recalibrate` fits per-regime weights on the resolved ledger, **maximizing Apex+Loaded profit factor**, subject to hard anti-overfit bounds: **≥40 resolved signals/regime**, and the re-fit must **beat the incumbent preset on a held-out 8-week out-of-sample window** or it's rejected. Accepted re-fits are versioned in `apex/model.json` (`versions[]` + `activeId`, effective date, per-regime ablation); a pillar with negative marginal contribution across **two** consecutive recalibrations is flagged for review (not auto-zeroed). `op=model` serves the active weights to the client (it overrides the static presets when present; logging in `op=apexlog` uses them too, keeping ledger ↔ tab consistent). Trigger: the **⟳ Recalibrate now** button in the Model panel, or auto-recommended when drift goes BROKEN. Dormant until the ledger matures — by design.

## Sentiment layer — weekly narrative tag
`api/tracker.js?op=narrative` (warm cron, cached per ISO week) has Claude tag the week's dominant market narrative into one label (`apex/narrative.json`, e.g. `GEOPOLITICS`, `AI_CAPEX`, `RATE_CUTS_HOPE`). `op=apexlog` stamps every signal with the current tag; `op=drift` reports **win rate by narrative tag** (observational — promoted to a scoring input only once a tag has ≥30 resolved signals). Shown as a chip in the header + a table in the Model panel.

**Now built:** Modules 1, 2, 3 + the narrative-tag layer (its scoring promotion stays gated at ≥30 signals/tag).

## Statistical-rigor hardening (#2) & historical seed (#1)
**Module 2 objective → rank-IC.** Weights have little leverage over a *thresholded* Apex+Loaded selection (the balance rule + tier cutoffs do the selecting), so re-optimization now maximizes **rank-IC** (how well the weighted composite ranks winners above losers) — what the weights actually control. Validated by **purged, date-blocked, expanding-window walk-forward CV**: weights are re-selected per fold and must beat the preset on **every** out-of-sample fold by a rank-IC margin (≥3 folds). Unit-tested: rejects pure noise (~0–1/25 seeds), adopts a genuine edge (~17–21/25) and tilts toward the true pillar. CV folds by **whole distinct dates** (point-in-time cohorts cluster many signals per date).

**Drift status → asymmetric + sample-aware.** Live win rate carries a **Wilson 90% interval**. **BROKEN** (auto-recalibrates) needs the interval's *upper bound* below baseline−15 — so a small noisy sample can't trip a false alarm; **DEGRADING** (soft "reduce size") uses the point estimate below baseline−5.

**Historical backfill (#1).** `api/tracker.js?op=backfill` replays `screenTicker` on 2-year candle slices (`fetchDailyHistory(t,'2y')`) to reconstruct point-in-time pillars cross-sectionally — **P1/P2/P4 faithful from price/volume; P3 can't be reconstructed historically (live LLM narrative) so it's pinned at the neutral default** and every seed signal is `p3synthetic:true`. Outcomes resolved on the +20/−8/63 barrier. Written to `apex/backfill.json`; `?op=recalibrate&source=backfill|all` fits on it with **P3 fixed**. Full S&P 500 seed runs in ~6s (≈3,650 signals). **The seed is isolated from live drift** — `readAllApex` only reads `apex/YYYY-MM-DD.json` daily files, so the synthetic seed never pollutes live health metrics. UI: "🌱 Seed from history" button in the Model panel. On the current ~12-month risk-on tape the seed honestly **keeps presets** (rank-IC ≈ 0 → no robust reweighting edge), which is the anti-overfit machinery working, not a failure.

## Correctness & product pass (5 fixes)
1. **Consistent outcome resolution** — `lib/outcome.js` `resolveTrade` resolves every signal against its OWN logged stop/target (WIN = target before stop, LOSS = stop first, EXPIRED at 63 sessions; **R is the actual realized return at the level**, not a fixed ±%). Used by the live ledger and the backfill. The ledger now stores `target` alongside `entry`/`stop`. Effect: tighter structure stops → more LOSS, lower win rate, but it measures the strategy you'd actually trade.
2. **Drift baseline from the seed** — the baseline (winRate + PF by regime) is computed from the backfill seed, which uses the *same* `resolveTrade` against the same levels → apples-to-apples with live. Falls back to the ATR backtest only if no seed (flagged "different methodology").
3. **Resolved-outcome cache** — `apex/resolved.json` keyed `ticker|tier|date`; `resolveLedger` only fetches prices for OPEN/uncached signals. Cost stays flat as the ledger grows.
4. **Pillar 3 grounded in hard fundamentals** — `fundamentalScore(fd)` (revenue & EPS growth, margin trend, margin level) leads; the LLM narrative is a 40% overlay. Kept identical in `lib/apex.js` and `public/index.html`. (TTM growth, not true 2nd-derivative acceleration — that needs a quarterly series the plan lacks.)
5. **Portfolio + alerts** — the Custom tab shows a Portfolio panel (Apex+Loaded count, sector exposure with concentration warning, **equal-risk position sizing** from entry−stop at a configurable portfolio size & risk %, capped 20%/name) and fires a notification when a name newly enters the Apex tier (reuses the service-worker flip-notification path).

**Survivorship bias (honest limitation, not fixed):** the universe is today's constituents, so the backtest/seed never see delisted names → baseline win rates are a mild over-estimate. A real fix needs point-in-time index membership the data plan doesn't provide. Surfaced in the "What this does NOT do" panel + a `survivorshipBias` flag on the seed.

## The two "hard" items — actually solved
- **Revenue/EPS acceleration (real 2nd derivative).** `lib/fundamentals.js` now parses Finnhub's `series.quarterly` (already in the `metric=all` response — zero extra API calls) for `salesPerShare` and `eps`, computing YoY-of-YoY acceleration (≥6 quarters). `fundamentalScore` folds it in (accelerating sales/earnings → bonus, decelerating → penalty). Live-verified: EXPD revAccel +7.2/epsAccel +27.8, APH epsAccel −33.5 (decelerating despite 54% revenue growth — now penalized). Kept in sync across `lib/apex.js` + `index.html`.
- **Survivorship bias — point-in-time corrected.** `lib/constituents.js` scrapes Wikipedia's authoritative "changes" table for S&P names removed in the last 3y (with dates; best-effort, graceful []). The backfill adds them to the universe but only emits their signals for dates BEFORE removal (true point-in-time membership). Live: 55 removed names included. Residual bias remains only for fully delisted names (no price history) — small over a 1–2y window. `stats.survivorshipBias` now reports `partially-corrected`.

## Edge discovery — factor efficacy (op=research)
`lib/research.js` + `api/tracker.js?op=research` build a point-in-time LABELED cross-section (every scanned name's broad factor vector + its 63-session cross-sectional excess forward return) and compute each factor's rank-IC + quintile win-rate gradient. Findings (5,500–7,400 labeled records, trailing 12mo):
- **Real edge:** 6-mo momentum (rank-IC ~0.10, monotonic), trend template (0.10), 3-mo momentum (0.08), **accumulation ratio (0.08)**, up/down volume (0.07), proximity-to-52w-high (0.07).
- **Dead (≈0 IC):** volume surge (−0.004), base length, VCP contractions, volume dry-up — i.e. several of the "breakout structure" factors the screen *gates* on carry no forward-return signal.
- **Acted on it:** Pillar 4 rebuilt from `volSurge+volAdj` → `accumRatio + udVol + volAdj` (added accum/ud to the screener percentiles). Validated out-of-the-refit: composite rank-IC 0.1007 → 0.1023.
- **Honest scope:** the gain is small — the composite already rides almost entirely on momentum (~0.10 IC), which is real but modest, and at structure stops still yields seed PF ~0.67. Reweighting price/volume factors has diminishing returns; the bigger levers are exits, non-price factors, or a simpler momentum screen. `op=research` makes this repeatable across periods/scopes.

## Exit-strategy experiment — the actual lever (op=exits)
`lib/exits.js` + `op=exits` replay the model's historical Apex/Loaded selections under 8 exit rules. THE finding (robust across universes):
| exit | S&P PF | small-cap PF |
|---|---|---|
| **time63 (hold ~63 sessions, no stop)** | **1.06** | **1.30** |
| catastrophic (measured target, −15% stop only) | 0.81 | 0.62 |
| structure stop (current model) | 0.66 | 0.64 |
| 3×ATR / 2×ATR / chandelier trail / EMA-21 cross | 0.4–0.67 | — |
Net-profitable **only** with a time-based ~3-month hold and no tight stop. The relationship is monotonic — the more actively you stop out, the more you lose. These are high-vol momentum names; tight stops fire on noise before the ~63-day directional edge (rank-IC 0.10) plays out. Small caps prove the mechanism (structure stop −5.2%/trade vs hold-63 +4.4%). **The stops were the leak, not risk management.** Cached in `apex/exits.json`, exposed via `op=model`, surfaced in the Custom-screener Model panel with the recommendation. Honest caveats: in-sample ~12mo (mostly risk-on); no-stop = full per-name drawdown risk (the −15% catastrophic variant is the risk-managed compromise, still <1); PF ~1.1 is a thin, real edge, not a money printer; needs out-of-sample confirmation as the live ledger matures.

## Out-of-sample validation — the exits "edge" was a risk-on artifact
Extending `op=exits` to 5 years (9,562 selections, incl. the 2022 bear) with regime + quarterly breakdowns **overturned the earlier result**:
- Overall time63 PF **0.77** (not >1); by entry regime: Risk-On **0.93** · Neutral 0.82 · Risk-Off **0.47**.
- time63 profitable in only **6 of 17 quarters** — wins in sustained uptrends (2023-Q4 PF 4.8, 2024-Q1 1.75), destroyed in corrections (all of 2022, 2025-Q1 −11.7%).
- **Conclusion:** the structure stops *are* a leak (time63 beats them almost everywhere), but fixing the exit does NOT create edge. "Hold, don't stop" is **regime timing, not a standalone edge** — profitable only in risk-on uptrends, catastrophic in risk-off. The PF 1.06–1.30 reported on the trailing 12 months was a risk-on-window artifact; OOS validation caught it.
- **What actually works:** avoid Risk-Off entries entirely (PF ~0.47 regardless of exit). The model's regime gate (Module 1) + drift defensiveness are doing the real work, not the exit rule. The Custom Model panel now shows the regime/quarter breakdown with this honest framing.

## Market-neutral test — no security-selection edge (op=longshort)
`lib/longshort.js` + `op=longshort`: at each date rank the cohort by Apex composite, long the top decile, short the bottom — beta cancels, isolating stock-selection skill. 5y / 50 rebalances:
- Decile spread **+0.86%/63d** but **t-stat 0.53** → not statistically significant (need t≥2); 20% baskets weaker (+0.46%, t 0.39).
- Still regime-split even hedged: Risk-On **+2.89%** (hit 65%) vs Risk-Off **−4.18%** (hit 41%) — a textbook momentum crash (high-momentum longs fall harder than laggard shorts in bear tapes). Worst quarter 2022-Q4 −12%.
- **Conclusion:** removing the market does NOT reveal a durable edge. What's here is a weak momentum tilt, not stock-picking skill — positive in risk-on, crashes in risk-off, statistically zero over the cycle. Surfaced in the Custom Model panel.

## Arc summary (honest)
Across the full investigation: the breakout screen is net-unprofitable (PF<1); the only real factor is momentum (~0.10 IC), breakout-structure factors are dead; stops bleed money but fixing exits doesn't create edge; "hold don't stop" is regime timing (works risk-on, crashes risk-off); and market-neutral construction shows no significant selection edge (t=0.53). **There is no robust standalone edge in this long-only breakout strategy. Its one defensible lever is regime avoidance (don't go long in risk-off).** All experiments are repeatable via op=research / op=exits / op=longshort.

## Event-driven (PEAD) — blocked by data access, not edge
`lib/pead.js` + `op=pead` test post-earnings drift: enter the close AFTER an earnings announcement, hold 21/63d, measure SPY-excess return bucketed by surprise quintile (long big beats / short big misses), by regime, with t-stat. Self-diagnosing. **Result: not runnable on current data plans** — Finnhub free caps the earnings calendar at ~927 rows total (~50 in the S&P); FMP's earnings-calendar returns 0 on free tier. PEAD needs thousands of events with estimates. The engine is built and validated structurally; it will produce a real result the moment a paid earnings feed (Finnhub paid / FMP paid / similar) is connected. This is a data wall, not a code or method limitation.

## PEAD update — paid FMP key unlocked it; found the first real lead (data-limited)
With a paid FMP Starter key, `op=pead` now runs (753 resolved S&P events). Smaller (30-day) calendar chunks were needed — the 90-day chunks hit a per-call row cap. KEY FINDING:
- **63d horizon: biggest earnings MISSES drift −4.65% below the market, t-stat −3.3 (statistically significant).** 21d: biggest BEATS +1.69%, t 1.83 (borderline). The short/miss side is the robust half — consistent with the academic PEAD anomaly and the FIRST significant signal in the whole investigation.
- **But:** FMP Starter caps earnings/estimates history at ~12 months (both calendar and per-symbol endpoints bottom out ~2025-06), a single risk-on window — the *exact* data shape that made the exits "edge" look real before it died OOS. So: a **promising lead, NOT a confirmed edge** — needs multi-year, multi-regime validation that requires deeper earnings data (Alpha Vantage's free EARNINGS endpoint has full history but is rate-limited; FMP Premium's earnings depth is unverified). Cached `apex/pead.json`, exposed via op=model, shown in the Custom Model panel with this honest caveat.

## PEAD validated out-of-sample — NOT confirmed (the lead died)
The 1-year FMP-estimate finding (misses −4.65%/63d, t−3.3) was validated over 5 years using FMP announcement DATES (available 5y, unlike estimates) + the announcement-day price reaction as the surprise proxy (`op=pead&mode=reaction`, `runReactionPEAD`). Over 2,364 events / 2021–2026 incl. the 2022 bear:
- Signed reaction→drift: **t=0.45 at 63d (zero)**; top-reaction quintile **−1.84%, t=−2.74 (reversal, not drift)**.
- By year: only **2025 significant** (t=2.16) — the same risk-on window the 1-year finding came from; every other year noise/negative.
- **Verdict:** the −3.3 was the one-year-risk-on-window artifact again (same trap as the exits study). No durable PEAD edge in this data. Cached to `apex/pead.json` (`validation5y`), shown in the Custom Model panel leading with the non-confirmation. Caveat: reaction-proxy ≠ true estimate-surprise, so a paid multi-year *estimate* feed could differ — but the reaction proxy is a reasonable/strong test and shows nothing.

## FINAL: every edge direction tested and exhausted
Breakout screen (PF<1) · factors (only momentum ~0.10 IC, weak) · exits (regime timing, not edge) · market-neutral (t=0.53, insignificant) · PEAD (1yr looked real t−3.3, died over 5yr). **No durable, regime-robust, statistically-significant standalone edge found in any direction reachable with this data.** The app's honest identity: a momentum/regime dashboard whose one defensible value is regime avoidance, not an alpha engine. Diagnostic suite (op=research/exits/longshort/pead[/mode=reaction]) all repeatable + cached + shown in the Model panel with honest verdicts.

## Trade Alerts (social) — deployed as an app tab
The external-collector Python tool (`~/trade-alert-ranker/`) now feeds the app. Architecture: the fragile/headless SCRAPING stays in the collector (`python3 trade_alert_ranker.py push`, where a browser exists); it POSTs raw posts to `/api/tracker?op=alertsingest`; the app does everything else. `lib/alerts.js` is the Node port of the validated ranker (within-account dedup, coordination clustering → score on INDEPENDENT SOURCES not raw accounts, word-boundary per-ticker direction, Bayesian account weighting, decay) + the edge harness (excess-return grading, rank-IC/Wilson, refuses verdict <50 graded). Ops (all in tracker.js, still 12 functions): `op=alertsingest` (POST, optional `x-ingest-token` via `ALERTS_INGEST_TOKEN` env; `?reset=1` to wipe), `op=alerts` (GET ranked+edge), `op=alertsgrade` (grade matured via Yahoo, auto-run by the warm cron). Blob docs under `alerts/`. UI: "Trade Alerts" tab (`data-tab=xalerts`) with edge-verdict banner + ranked cards + coordination flag + empty-state setup instructions. Honest status: pipeline works end-to-end (verified with synthetic posts); needs a live X source (collector) to produce data; edge unproven until ≥50 alerts grade.
