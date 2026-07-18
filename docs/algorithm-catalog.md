# Algorithm Catalog

The canonical inventory of every signal-generating algorithm the app runs, joined to its
source, mechanism, horizon, production status, and how the Algorithm Effectiveness Monitor
(`op=router`, `docs/market-regime-router.md`) grades it. The machine-readable source of truth
is `lib/strategy-registry.js` (`STRATEGY_REGISTRY`); the per-algorithm *credibility* findings
(leakage, survivorship, validation design) live in `docs/quant-system-audit.md`.

## ID spaces (read this first)

Three overlapping identifiers exist and are bridged, not unified:

- **registry id** — `lib/strategy-registry.js` (`screener`, `ghost`, …). Used by the Monitor.
- **scoreboard section** — the track-record join key (`screener`, `Ghost`, …). `maturity.js`
  grades against this.
- **decision source** — `lib/decision.js` (`screener`, `ghost`, `rt`, …). Sizes the live rank.

Bridges: `SECTION_SOURCE` (`lib/redundancy-routes.js`), `SLEEVE_BY_SECTION`
(`lib/apex-routes.js`). The Monitor keys on the registry id and maps correlated ids into
families via a local table in `lib/algo-router-routes.js` (`FAMILY`).

## Catalog

Legend — **Core**: stays in the main workspaces regardless of grade. **Overlay**: lives in the
Research Lab until Validated. **Direction**: L=long, S=short, LS=both. Live-rank column =
whether it feeds the user-facing `op=today` composite (`lib/decision.js`).

| id | Label | Kind | Horizon | Dir | Mechanism (what it predicts) | Primary source | In live `op=today`? |
|---|---|---|---|---|---|---|---|
| `screener` | Breakout | Core | swing | L | Range/consolidation breakout continuation | `lib/screener.js`, `api/screener.js` | yes |
| `momentum` | Momentum | Core | position | L | Trend persistence in leaders | `api/momentum.js` | yes |
| `ghost` | Ghost Accumulation | Core | swing | L | Quiet volume/price accumulation before a move | `lib/ghost.js` | yes |
| `gapgo` | Gap & Go | Core | intraday | L | Unscheduled ≥5% gap-up + ORB continuation | `lib/gapgo.js` | yes |
| `daytrade` | Day Trade | Core | intraday | L | Intraday relative-strength momentum | `lib/daytrade.js` | yes |
| `coil` | Coil Radar | Core | swing | L | Volatility compression → abnormal (vol-normalized) break | `lib/coil.js` | yes |
| `custom` | Adaptive Momentum (Apex) | Core | position | L | Calibrated multi-factor conviction model | `lib/apex.js`, `lib/conviction.js` | own panel |
| `biotech` | Biotech Radar | Core | swing | L | Catalyst-aware early biotech runner | `lib/biotech.js` | yes |
| `downday` | Down-Day Bounce | Core | swing | LS | Red-tape reversion-bounce longs / overheated shorts | `lib/downday.js`, `lib/vreversal.js` | yes |
| `fade` | Overheated (Fade) | Overlay | swing | S | Exhaustion / blow-off mean reversion | `lib/fade-engine.js` | shadow |
| `gapdown` | Gap-Down Continuation | Overlay | intraday | S | Unscheduled gap-down continuation | `lib/gapdown.js` | shadow |
| `events` | CERN Forced-Flow | Overlay | position | L | Event-driven forced-flow decay curves | `lib/cern.js`, `lib/cern-decay.js` | shadow |
| `readthrough` | Read-Through | Overlay | position | L | Second-order beneficiaries of a mover (not-yet-moved) | `lib/readthrough.js` | shadow (AI) |
| `anomaly` | Stealth | Overlay | position | L | No-news volume anomalies, AI-triaged | `lib/anomaly.js` | shadow (AI) |
| `secondwave` | Second Wave | Overlay | position | L | Re-acceleration after a first leg | `lib/secondwave.js` | shadow (AI) |
| `crossasset` | Cross-Asset | Overlay | position | L | Cross-asset confirmation tells | `lib/crossasset.js` | shadow (AI) |
| `toneshift` | Tone Shift | Overlay | position | L | Narrative/tone inflection | `lib/toneshift.js` | shadow (AI) |
| `tone` | Earnings-Call Tone | Overlay | position | L | Earnings-call tone via web search | `lib/earnings-tone.js` | shadow (AI) |
| `attention` | Attention (Sticky/Fast) | Overlay | swing | L | Sticky vs fast attention decomposition | `lib/attention.js` | shadow |
| `xalerts` | Trade Alerts | Overlay | swing | L | Social trade alerts | `lib/alerts.js` | shadow |
| `challenger-decision` | Challenger Decision | Overlay | swing | LS | Four-outcome cross-sectional residual + survival challenger | `lib/challenger-decision.js` | shadow (paper/weight-0) |

Informational surfaces (`sectors`, `rotation`, `news`, `pulse`, `gameplan`, `forecast`) are
context, never graded, never routed.

## Correlated families (shared evidence budget)

The Router caps each cluster at 50% because members re-express the same underlying factor
(established empirically — ghost×screener ≈ 0.96 correlated, `measured-redundancy`):

- **price-momentum** — `screener`, `momentum`, `ghost`, `coil`, `custom`, `biotech`
- **intraday-event** — `gapgo`, `daytrade`, `gapdown`
- **catalyst** — `events`, `readthrough`, `secondwave`
- **mean-reversion** — `downday`, `fade`
- **sentiment-context** — `crossasset`, `toneshift`, `tone`, `anomaly`, `attention`

## Per-algorithm record (what the Monitor computes)

For each id, `op=router` emits: `health` (7-state), `effectiveSampleSize` (distinct decision
dates), `expectedNetEdge` (avg SPY-relative excess), Wilson CI, `regimeCompatibility`,
`independentContribution`, `currentWeight`/`targetWeight`, `reason`, and `limitations`. Fields
that require inputs the live ledger does not yet carry — `recentRankIC`, `longTermRankIC`,
`calibrationQuality` — are honestly `null` (no per-pick probability in the forward ledger yet).

## Validity ceiling (applies to every row)

Long-term skill is measured on the **live forward ledger over a present-day universe**:
genuinely prospective and point-in-time at the decision, but **survivorship-unsafe**. No row
is survivorship-safe until real point-in-time constituents + delisting returns exist
(`docs/quant-system-audit.md` §6). The Monitor stamps `survivorshipSafe:false` accordingly.
