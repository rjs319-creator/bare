# Evidence-language audit — 2026-08-15

Scope: every candidate surface that presented an **unvalidated** score as conviction, a
star-rated recommendation, a probability, or verified "smart money"/institutional flow.
Guarded by `test/evidence-language.test.js` (regressions fail CI). The rule applied:

- A score with no validated out-of-sample track record may be called a **research rank**,
  never *conviction*, and the label must say **unvalidated** where the rank is shown.
- Accumulation inferred from candles/volume is a **proxy** and must be labeled as one —
  never "smart money", never "institutional flow".
- Genuine order-flow-ish data (Form-4 insider buys, prediction-market stakes) may be named
  for what it is, but not upgraded into a proof-of-edge claim.
- `NO TRADE` is a first-class state on the default decision surface (already implemented:
  `today.js` renders a 🔴 "No trade today" banner; `op=today` carries `abstained: true`).

## Corrections applied

| Surface | Before | After |
|---|---|---|
| `public/js/opportunities.js` `conviction()` | `High conviction` ⭐⭐⭐ / `Solid setup` ⭐⭐ / `On watch` ⭐ | `High research rank — unvalidated` ▲▲▲ / `Mid research rank — unvalidated` ▲▲ / `Low research rank — watch only` ▲ |
| `public/js/opportunities.js` card header | tier glyphs alone (label only in tooltip) | visible caption `research rank — unvalidated` under the glyphs |
| `public/js/opportunities.js` `thesis()` | "Smart money is showing {accumulation} … a name being bought before the obvious move" | "Price/volume patterns show {accumulation} — an unverified proxy, not confirmed institutional buying …" |
| `lib/ghost.js` factor label (served to Ghost pillar chips) | `SF: 'Smart-money flow'` | `SF: 'Up/down-volume flow (proxy)'` |
| `public/index.html` Ghost guide | "④ Smart-money flow — up/down volume + volatility-adjusted momentum." | "④ Up/down-volume flow (proxy) — …; a price/volume proxy, not verified institutional flow." |
| `lib/whynow.js` Ghost reason | "smart-money footprint before an obvious breakout" | "price/volume accumulation footprint (unverified proxy, not confirmed institutional flow)" |
| `lib/apex.js` + `public/js/app.js` APEX pillar 4 (label, pill, matrix row, guide) | `Supply / smart money`, "Higher = big money leaning in" | `Supply / accumulation (proxy)`, "inferred from volume patterns … not verified institutional flow" |
| `public/js/app.js` Ghost tab help | "…relative strength, accumulation, smart-money flow, insider buys…" | "…up/down-volume flow (a proxy)…" |
| `public/js/app.js` Sharp tab help | 'Signs of "smart money" positioning worth a look.' | 'Large prediction-market positioning that diverges from the crowd — real bets, not a verified edge.' |
| `public/js/app.js` Sharp tab read | "where smart money diverges from the crowd" | "where large-stake bettors diverge from the crowd" |
| `public/js/app.js` fade caveats | "Confirm entries in TradingView (MACD / RSI / Smart-Money)" | "Confirm entries in TradingView (MACD / RSI)" |
| `public/js/app.js` Core Performance headline | `SINCE INCEPTION (realized)` — a compound of partial-quarter resolved-only averages | `SINCE INCEPTION — PORTFOLIO NAV (marked daily, cost-net)`; the old number survives only as `RESOLVED-ONLY COMPOUND (diagnostic — ignores open positions)` (see `lib/nav-ledger.js`) |

## Already-honest surfaces verified, left unchanged

- `lib/gameplan.js`, `lib/tech-command-options.js`, `lib/options-classify.js` — free-chain
  options reads already carry explicit "NOT smart money / direction unknowable" disclosures
  (pinned by `test/gameplan.test.js`, `test/tech-command-overlays.test.js`).
- `lib/predmarkets.js` — "sharp" reads derive from real prediction-market stakes (size and
  pattern of actual bets), not candles; presentation reviewed, claims are about positioning,
  not edge.
- Evidence grade / governance weight / sample-size context: the Opportunities strip already
  renders the shadow track-record context line (`buildReliability` + `oppTrack`, marked
  "context only — it does not change this ranking"), and per-tab earned grades live on the
  Evidence tab (`evidence-badge.js` `mountVerdict`).
- Catalyst–Flow lab (this branch) — ordinal scores only; `test/catalyst-flow-routes.test.js`
  pins that the board never formats a model score as a percentage or probability.

## Out of scope (code comments, not rendered)

Internal comments in `lib/ghost.js`, `lib/apex.js`, `public/js/ticker-lookup.js`,
`public/js/opportunities.js` still use "smart money" as historical shorthand; they render
nothing. The guard test skips comment lines on purpose.
