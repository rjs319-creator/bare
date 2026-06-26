# Integration Assessment — Master Screener Pipeline → market-news-app

**Verdict up front:** Do NOT port this script's scoring into the app wholesale.
It is a clean, generic confluence-ranker, but the app already has more
sophisticated, *backtested* versions of three of its four ideas — and your own
multi-session research arc has shown most of its assumed edges are dead or
non-additive on the free/Starter data tier. The honest integration is a thin
**format adapter**, not a new model.

This maps the script's four "improvements" to current reality.

---

## #1 — Master Confluence Score (multi-screener agreement)

**App already has this, better:**
- `lib/apex.js` (4-pillar regime-adaptive) + `lib/ghost.js` (6-pillar GAI) +
  `lib/conviction.js` (refined SSOT) + `lib/stablecore.js` (the deployed Core
  Momentum screener).
- **Key finding the script ignores:** the "multi-factor" confluence is really
  ~1.5 effective factors — RM/AF/SF/p1/p2 are all collinear momentum (~0.10 IC),
  AV is documented-dead. Summing 5 collinear screens as if independent
  **overstates agreement**. The script's flat additive weights repeat exactly
  the mistake `op=research` already corrected.
- **Worth borrowing:** nothing model-wise. The normalisation FIX in this
  refactor (don't clip a 110-sum at 100) is a generic lesson, not app-relevant.

## #2 — Unusual Options Flow boost

**Untested in the app, and flagged risky:**
- The app has a qualitative LLM `api/options.js` and the numeric
  `lib/options-baseline.js` (Yahoo chains, archived daily), but **no validated
  options-flow edge** — it was never run through the purged-WF harness.
- The script's flow rules (sweep+premium+repeat → +points) are **hand-tuned
  priors with zero backtest**. Importing them would add an unvalidated signal,
  contrary to the project discipline (economic prior → standalone validation →
  purged WF → deflation).
- **If you want this:** validate first via the existing harness
  (`ghost-backtest.js` pattern) against archived `archive/<date>.json` options
  baselines. Don't ship the boost until it clears IC + WF gates.

## #3 — Catalyst layer (FDA / earnings / corporate)

**This is the painful one — already tested, mostly DEAD on this tier:**
- **PEAD = dead** (25,617 in-band events, reaction→drift IC 0.002, quintile
  wrong sign). The script's "earnings catalyst +5" has no forward edge here.
- **FDA/clinical calendar = blocked by data** (no free PIT FDA feed; Healthcare
  was the *worst* sector for momentum, IR 0.14, binary events kill it — Phase-3b).
- BONUS (fundamental-accel) is the *one* additive catalyst (+0.118 IC large-cap)
  and the app **already uses it** (`lib/earnings.js`, Finnhub quarterly actuals).
- The script's `days_until ≤ 7 → +10` proximity logic is a reasonable prior but
  **the underlying events don't drift on free data**. Importing it would surface
  catalysts the research says don't pay.

## #4 — Ghost Accumulation refinement hooks

**App's `lib/ghost.js` is the real, deployed version** (6 pillars, server-side
SSOT, own Blob ledger, insider via EDGAR/Finnhub). The script's
`ghost_accum_score > 50 → +30` is a placeholder that consumes an output the app
*produces*. Nothing to port; the dependency runs the other direction.

---

## What IS worth taking from this exercise

1. **The regime gate** (`--regime-gate`) is the only lever the whole arc
   validated (`smallcap-edge-project`: risk-off long = negative expectancy;
   regime gate ~2× IC). The refactor elevates it from a +10 bonus to a hard
   ordering lever — consistent with the research. This is the *correct* emphasis
   the original script buried.
2. **As an offline triage/format tool:** if you ever export the app's screener
   tiers to CSV (Apex/Ghost/Core), this pipeline is a fine *presentation* layer
   to merge + rank them for a human eyeball — provided `final_score` is treated
   as a display sort, NOT a new alpha signal.

## Recommended integration (if any)

- **Default: keep this as a standalone offline tool.** It is genuinely useful
  for ad-hoc CSV ranking and as a teaching-clean reference implementation.
- **If wiring to the app:** write a tiny exporter (`op=export` → CSV of the
  live Apex/Ghost/Core books) and feed THAT to this pipeline read-only. Do not
  add the options/catalyst boosts to any *logged/ledgered* score until each
  clears the purged-WF + deflation gates the project already enforces.
- **Do not** create a 12th+ Serverless Function or duplicate scoring into
  `index.html` (the apex.js sync-hazard the project deliberately avoids).
