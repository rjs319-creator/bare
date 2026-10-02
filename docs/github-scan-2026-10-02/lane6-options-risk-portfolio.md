# Lane 6 — Options analytics, risk/sizing, portfolio tracking, paper execution

## Lane summary
Searched GitHub (`gh search repos`, `gh api repos/*`) plus the npm registry (GitHub search was secondary-rate-limited by sibling lanes, so npm discovery filled the gaps) across five themes: options math usable from Node, risk/sizing, portfolio-tracker references, performance analytics, and paper-trading broker APIs. ~62 repos screened, 38 verified via `gh api`, 16 kept. Headline: **the official `vollib` org shipped a TypeScript port of LetsBeRational in Apr 2026** (`@vollib/vollib`, MIT, ESM, one dep), which removes the single blocker that makes `lib/options-execution-v2.js greeksCapability()` refuse Greeks/GEX today. Second headline: Alpaca's free paper API (actively maintained Node SDK) is the only serverless-friendly way to turn Session Board frozen levels into a timestamped fill ledger; IBKR/Tradier SDKs are stale or need a resident gateway. Portfolio trackers (Ghostfolio, Wealthfolio, Portfolio Performance) are REFERENCE only — the data model is worth copying, the apps are not.

Existing state checked: `lib/options-execution-v2.js` already has ivRank/expectedMove/surfaceChange/crushStress but no Greeks; `lib/position-sizing.js`, `lib/omega-sizing.js`, `lib/portfolio-optimizer.js` (diagonal σ only, "no covariance exists"), `lib/allocation.js` (inverse-vol sleeves), `lib/execution-policy.js` (exec-v1 next-open+slippage from `lib/costs.js` TIERS), `lib/evidence-stats.js` (block-bootstrap CI, FDR; no Sortino/Calmar/Omega). No Kelly anywhere in `lib/`.

## Candidates
| Repo | Stars | Last push | License | Lang | What it does | Fit | Verdict |
|---|---|---|---|---|---|---|---|
| vollib/vollib-ts (`@vollib/vollib`) + vollib/lets-be-rational-ts | 0 / 0 (official vollib org; py_vollib 436) | 2026-04-30 | MIT | TS (ESM) | BS/Black/BSM price, IV (Jaeckel LetsBeRational), Greeks | `options-execution-v2.js greeksCapability` refusal; `options-config-v2` moneyness-proxy delta band | **ADOPT** |
| Matteo-Ferrara/gex-tracker | 217 | 2023-04-08 | none | Py | Dealer GEX by strike from CBOE chain | GEX overlay formula | **PORT** (formula only; no license → re-derive) |
| jensolson/SPX-Gamma-Exposure | 166 | 2025-07-30 | none | Py | GEX + gamma-flip estimate | same | REFERENCE |
| gammagrid/gammagrid | 69 | 2026-09-19 | AGPL-3.0 | Py | GEX/DEX/max-pain dashboard | design reference; AGPL blocks vendoring | REFERENCE |
| EazyDuz1t/EzOptions-Schwab | 40 | 2026-09-30 | GPL-3.0 | Py | GEX/DEX/vanna/charm by strike | formula cross-check | REFERENCE |
| lequant40/portfolio_allocation_js | 187 | 2023-03-03 | MIT | JS | ERC / risk-budgeting / min-corr / HRP-style allocation, pure JS | `portfolio-optimizer.js` diagonal-σ limitation; `allocation.js` | **PORT** (vendor ERC + covariance helpers) |
| ranaroussi/quantstats | 7,678 | 2026-09-27 | Apache-2.0 | Py | Tearsheets: Sortino/Calmar/Omega/rolling beta | offline `research/` tearsheets of Scoreboard ledgers | RESEARCH-ONLY |
| stefan-jansen/empyrical-reloaded | 124 | 2025-12-12 | Apache-2.0 | Py | Canonical metric definitions (zipline/pyfolio) | formula source for `lib/perf-metrics.js` | **PORT** |
| whsmacon/quantstats-js | 9 | 2026-01-28 | NOASSERTION | JS | Node port of quantstats | would be ideal but license unclear | REJECT (license) |
| railpath/finance-toolkit | 10 | 2026-01-04 | MIT | TS | VaR/Sharpe/Sortino/drawdown in TS | reference impl for perf-metrics | REFERENCE |
| alpacahq/alpaca-trade-api-js | 601 | 2026-10-01 | Apache-2.0 | TS | Alpaca REST/WS incl. free paper endpoint, bracket orders | paper-execution ledger vs exec-v1 | **ADOPT** (or raw `fetch`; SDK is thin) |
| stoqey/ib | 332 | 2026-09-16 | MIT | TS | IBKR TWS/Gateway client | needs resident Gateway (ibeam/ib-gateway-docker) — not Vercel-fit | REFERENCE |
| ghostfolio/ghostfolio | 9,391 | 2026-10-01 | AGPL-3.0 | TS | Wealth tracker; Activities CSV/JSON import | paper-portfolio data model | REFERENCE |
| wealthfolio/wealthfolio | 9,097 | 2026-10-01 | AGPL-3.0 | Rust/TS | Local-first tracker; CSV importer-profile mapping per broker | broker CSV import pattern | REFERENCE |
| portfolio-performance/portfolio | 4,082 | 2026-10-01 | EPL-1.0 | Java | 50+ broker PDF/CSV importers, TTWROR/IRR | import-format catalogue | REFERENCE |
| passiv/snaptrade-sdks (`snaptrade-typescript-sdk`) | 55 | 2026-10-02 | MIT | TS | Brokerage aggregation (Plaid-Investments alternative), read positions | only once user accounts exist | RESEARCH-ONLY |
| simple-statistics | 3,521 | 2026-10-01 | ISC | JS | Stats primitives (quantiles, sampling) | MC/bootstrap helper for risk budget | REFERENCE (optional dep) |

## Top proposals

### 1. Model-derived Greeks + IV solver (ADOPT `@vollib/vollib`) — effort S
- **Build:** `lib/options-greeks.js` (pure): `greeksFromQuotedIV({spot, strike, dte, r, iv, type})` and `impliedVolFromMid()` wrapping vollib-ts; stamp every output `source:'model-bsm-from-quoted-iv'`, never "vendor greeks". Replace the moneyness proxy in `options-config-v2.js deltaBandProxy` with a true 0.30–0.50 delta band; let `greeksCapability()` return `available:true, derived:true` with the honesty label instead of refusing.
- **Shape:** npm dep (2 small ESM packages). `lib/` is CJS — needs Node ≥22.12 `require(esm)` on Vercel or a ~400-line vendored port (MIT permits). Validate against py_vollib fixtures in `node --test`.
- **Risk:** v0.1.1, 0 stars — but it is the official vollib org and LetsBeRational is the industry-standard IV solver; Yahoo chain IVs are delayed, so Greeks inherit staleness (say so).
- **Measure:** new registry hypothesis in `options-hypotheses-v2.js`: delta-band contract selection vs moneyness proxy on the existing options ledger; shadow, weight 0, FDR-gated like everything else.

### 2. Dealer GEX / gamma-flip / max-pain shadow overlay (PORT gex-tracker formula) — effort M
- **Build:** `lib/options-gex.js`: per strike `GEX = Γ × OI × 100 × S² × 0.01` (calls +, puts − under the dealer-long-calls convention), net GEX, flip level, max-pain from full-chain OI. Needs full-chain rows (not retained display rows — same rule `strikeConcentration` already enforces) from `options-snapshot.js` nightly for SPY/QQQ + Session Board tickers. Session Board `live` component gains `gammaFlipDistancePct` (null when chain incomplete), weight 0.
- **Shape:** vendored formula (re-derived, no license on source repos) + Γ from proposal 1; nightly chain under `api/warm.js` is one more fetch/ticker — gate behind the existing wave budget.
- **Risk:** GEX sign convention is an assumption, not data; delayed Yahoo OI is T-1; literature on retail GEX edge is weak — expect "no alpha", which is still useful for the intraday lane's regime read.
- **Measure:** hypothesis "intraday lane outcomes conditioned on spot above/below flip" + negative control (shuffled flip level), purged walk-forward, Scoreboard 1/5d excess.

### 3. Paper-execution ledger on Alpaca paper (ADOPT) — effort M
- **Build:** `lib/exec-paper-ledger.js` (pure order-plan + reconciliation) and a GitHub Actions tick (the pattern already used for the 22:30 UTC thesis tick — Vercel cron is wrong for intraday order monitoring). At the open, place one bracket order per Session Board A/B row at the frozen entry/stop/target (1 share; sizing irrelevant to fillability); poll fills; persist to Blob as one append-only file per session (`paper-exec/YYYY-MM-DD.json`, union monotonic — respects the lost-append pain point).
- **Shape:** `alpaca-trade-api-js` (Apache-2.0) or raw `fetch` against `paper-api.alpaca.markets` (3 endpoints). One shared house account; no user accounts needed.
- **Risk:** Alpaca paper fills on NBBO touch with no queue/impact → a **lower bound** on friction, not realism; equities only (no options legs); RTH only; secrets via Vercel/GH env.
- **Measure vs Scoreboard:** (a) fill rate per grade and per timeframe; (b) realized R vs Scoreboard's daily-bar R — crucially the paper ledger resolves **stop-first vs target-first within a day**, which daily bars cannot; (c) `fill − frozenLevel` distribution vs `lib/costs.js` TIERS → recalibrate exec-v1 slippage with measured numbers; (d) reconciliation test: every Session Board snapshot id must appear in the ledger or carry a `notPlaced` reason.

### 4. Kelly / vol-target / Monte Carlo in the risk budget — effort S
- **Build:** `lib/risk-kelly.js` (pure, tested): fractional Kelly from each lane's Scoreboard episode stats (beat-rate, avg win/avg loss, served in `summary.json`), vol-targeted size from 20d realized vol, and a bootstrap Monte Carlo of a 20-trade plan's drawdown from resolved R-multiples. `public/js/risk-budget.js` shows Kelly fraction and P(drawdown > X) next to the existing ADV cap; Kelly ≤ 0 renders "no size — lane has no measured edge", the same fail-closed stance the widget already takes.
- **Shape:** in-house (~150 lines); `simple-statistics` optional for quantiles. Must stay under `omega-sizing.js` hard caps.
- **Risk:** none to alpha claims — this is arithmetic over served evidence; caveat that Kelly on thin, noisy edges is wildly unstable (hence fractional ≤ 0.25 and the MC band).
- **Measure:** governance assertion test that no rendered size exceeds `MAX_POSITION_PCT`; no Scoreboard claim.

### 5. Paper portfolio that follows the Session Board + perf metrics (REFERENCE Ghostfolio/Wealthfolio; PORT empyrical) — effort L
- **Build:** `lib/paper-portfolio.js`: Ghostfolio-style Activities ledger (`BUY|SELL|FEE`, date, symbol, qty, unitPrice, fee, currency, `source:{sessionboardSnapshotId, grade, timeframe}`), server "house book" that buys every A/B row at next open under exec-v1 and exits at the board's target/stop/horizon; per-browser "my book" in localStorage first (no accounts). `lib/perf-metrics.js` ports empyrical's Sortino/Calmar/Omega/rolling-beta definitions (Apache-2.0) for both books and for Scoreboard ledgers; fixes nothing in evidence-stats but adds the missing metrics at `avgExact` precision (not 2dp).
- **Shape:** vendored formulas + Blob daily shards; broker CSV import later via Wealthfolio-style importer profiles (Schwab/Fidelity/Robinhood column maps); SnapTrade only if accounts arrive.
- **Risk:** AGPL on both trackers → copy the schema, not the code; equity-curve UI needs a real time-series chart (another lane's problem).
- **Measure:** house-book equity curve vs SPY and vs the Scoreboard's equal-weight aggregate of the same rows; the two must reconcile within cost tiers — a divergence is a Scoreboard dedup/episode bug detector, which is the real payoff.

## Rejected / noise
- `MattL922/black-scholes|greeks|implied-volatility` (74/58/45★, MIT) — 2014-19, naive IV bisection; superseded by vollib-ts.
- `dbrojas/optlib`, `hashABCD/opstrat`, `marketcalls/opengreeks` (Rust), `CaptorAB/quantlib-wasm` — Python/Rust/WASM toolchains for what is ~400 lines of JS.
- `jwolberg/options-scanner` (36★, JS) — depends on paid tradingvolatility.net feed; no license.
- `FlashAlpha-lab/flashalpha-js`, `thelogicaldude/options-data-mcp` — thin wrappers over paid APIs.
- `moshejs/svi-vol-surface` — SVI surface fitting is overkill for delayed single-expiry chains.
- `JoshRiang/kelly-sizer`, `t0systems/kell`, `kcfou999/kelly-criterion-tool` — ≤1★ Kelly toys; write in-house.
- `peterrhodesdev/option-pricing` (11★, MIT) — binomial/MC pricers, not needed for listed equities.
- `MasonGeloso/tradier`, `ReycoDev/tradier-client`, `mikecao/tradier-api` — stale ≤2022; Tradier sandbox is 3 REST calls anyway (note: its chains carry ORATS Greeks — a possible future Greeks source, no repo needed).
- `Voyz/ibeam`, `gnzsnz/ib-gateway-docker` — require a long-lived Docker gateway; incompatible with Vercel/GH Actions ticks.
- `rotki/rotki` (crypto-centric), `maybe-finance/maybe` (archived 2025-07), `actualbudget/actual` (budgeting), `investbrainapp/investbrain` (PHP) — wrong domain or stack.
- `PyPortfolio/PyPortfolioOpt`, `dcajasn/Riskfolio-Lib`, `skfolio/skfolio`, `cvxgrp/cvxportfolio` (GPL) — offline-only; `allocation.js` research already showed combining sleeves does not raise Sharpe.
- `anandanand84/technicalindicators` (2022, unmaintained), `general-liquidity/sharpebench`, `bonguynvan/tradecanvas` — noise for this lane.
