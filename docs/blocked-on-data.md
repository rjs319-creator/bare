# Blocked on data — what each gap needs before it can be closed

Everything here is **blocked on an external input**, not on engineering. The code paths
exist, are tested, and currently report `UNAVAILABLE` / `UNKNOWN` with a reason. That is
the intended behavior: the alternative is a favorable default, which is the class of defect
the redesign removed.

This document exists so the acquisition decisions can be made deliberately rather than
rediscovered. Costs are **indicative list prices as understood at time of writing
(2026-08-13) and must be re-checked before any commitment** — they are here to convey
order of magnitude, not to be quoted.

---

## 1. Quoted spread (equities) — highest impact

**Blocks:** `execution.spread` in `lib/alerts-execution.js`. It is one of the two REQUIRED
components for every side, so its absence caps `coverage` at 0.5 for a long and 0.33 for a
short, which is what currently drives most cards to `UNKNOWN` → `WAIT`.

**Needed:** a real-time or 15-min-delayed NBBO bid/ask per symbol. Level 1 is sufficient;
no depth required. Fields: `bid`, `ask`, `bidSize`, `askSize`, `quoteTime`.

**Note:** `lib/quote-provider.js` already returns `price` and `asOf` from Yahoo but **no
bid/ask**. Adding spread is a provider question, not a plumbing one — `assessExecution`
already accepts `spreadBps` and will use it the moment it is supplied.

| Option | Order of magnitude | Notes |
|---|---|---|
| Polygon.io Stocks Starter | ~$30/mo | 15-min delayed NBBO; adequate, since decisions build on a cron |
| Alpaca Market Data | free tier / ~$99 mo | IEX-only on the free tier — a partial book, and spread from one venue is not the NBBO |
| Databento | usage-based | Overkill for this; priced for tick archives |

**Acceptance:** `execution.components.spread.state === 'MEASURED'` on ≥90% of scanned
names, and long-side `coverage` reaching 1.0.

---

## 2. Borrow availability and fee (shorts)

**Blocks:** `execution.components.borrow`. REQUIRED for `side === 'short'` — so **no short
can currently reach `OK`**, only `DEGRADED` at best.

**Needed:** per-symbol short availability and indicative fee. Fields: `available` (bool),
`feePct` (annualized), `asOf`.

**Reality check:** this is the hardest item on the list. Borrow data is broker-proprietary;
there is no cheap neutral vendor. Realistic paths:

- **Broker API** (IBKR has a shortable-shares feed) — free with an account, but ties the
  app to one broker's inventory and needs auth plumbing.
- **Accept the gap permanently** and let shorts cap at `DEGRADED`, which is honest. Given
  the layer is shadow and shorts are a minority of episodes, this is a defensible choice.

**Recommendation:** do not buy for this. Either wire IBKR if you already have an account,
or leave it declared-unavailable.

---

## 3. Macro series — the strategic regime layer

**Blocks:** `strategicLayer` in `lib/pulse2-regime-stack.js`, which needs ≥2 of its 5 legs
and currently gets 1 (the curve proxy, derived from ETF prices). It reports
`UNAVAILABLE — only 1/5 strategic inputs available`.

**Needed:** `growth`, `inflation`, `liquidity`, `earningsRevisions`, `valuation`, each as
`{ trend: 'up'|'down'|'flat', value, source }`.

**Good news:** four of the five are **free**.

| Leg | Source | Cost |
|---|---|---|
| growth | FRED (`GDPC1`, `INDPRO`) | free, API key |
| inflation | FRED (`CPIAUCSL`, `PCEPILFE`) | free |
| liquidity | FRED (`WALCL`, `RRPONTSYD`, `WTREGEN`) | free |
| valuation | derivable from existing index data + FRED yields | free |
| **earningsRevisions** | **not free** — needs an estimates vendor | see §4 |

**STATUS: BUILT — needs only the key.** `lib/fred.js` + `lib/pulse2-macro.js` are wired
into `pulse2statetick`. Growth, inflation, and net liquidity come up as soon as
`FRED_API_KEY` is set in Vercel prod; valuation additionally needs an index earnings yield
(see below). With no key the strategic layer stays `UNAVAILABLE` with that reason, and
`op=pulse2` exposes per-leg provenance under `macroDiagnostics`.

Two implementation notes worth knowing:

- **Liquidity is a NET.** `WALCL − RRP − TGA`. The balance sheet alone is the wrong read —
  reserves drained into reverse repo or the Treasury's account are not in the system. If
  any of the three series is missing the leg is **refused rather than partially computed**,
  because dropping a drain flips the sign.
- **This is a LIVE read only.** FRED serves the latest vintage, so values for past dates
  are not what was known then. Everything is stamped `backtestSafe: false`; feeding it to
  the research harness requires ALFRED vintage endpoints.

**Remaining for the valuation leg:** an index earnings yield (S&P 500 forward or trailing).
Currently passed `null`, so that leg reports unavailable rather than substituting a
constant. Three of four legs is already above the strategic layer's two-leg floor.

---

## 4. Earnings estimates and revisions

**Blocks:** the `earningsRevisions` strategic leg, and the "investor expectation analysis"
section of the mission brief (consensus revenue/EPS/FCF revisions, what is already priced).

**Prior art:** a Nasdaq Data Link key exists in Vercel prod and a shadow estimates adapter
was built, but the pull returned EMPTY — see `nasdaq-data-link-setup` in memory. That path
should be re-verified before anything new is bought.

| Option | Order of magnitude |
|---|---|
| FMP (already integrated) — `analyst-estimates` | included in some tiers; **check the current plan first** |
| Nasdaq Data Link / Zacks | ~$50+/mo |
| Refinitiv / FactSet | enterprise; not proportionate here |

**Do first:** confirm whether the existing FMP plan already covers estimates. This may be
a zero-cost fix.

---

## 5. Corporate-action calendar

**Blocks:** the `corpAction` hypothesis in `lib/options-hypotheses-v2.js`, which currently
returns `UNRESOLVED — no corporate-action calendar is wired to this deployment`. Dividend
capture and split adjustment are common benign explanations for unusual call volume, so
this hypothesis staying open weakens every options read slightly.

**Needed:** ex-dividend dates and split dates per symbol, forward-looking ~30 days.

**STATUS: BUILT.** `lib/corp-actions.js` pulls the FMP dividend and split calendars
(date-ranged, **two calls per scan regardless of universe size**) and feeds
`options-hypotheses-v2`.

The load-bearing behavior is an asymmetry that is easy to get wrong: a calendar that
**answers** and lists nothing **REFUTES** the hypothesis; a calendar that **failed or is
plan-gated** leaves it **UNRESOLVED**. Both produce an empty result, and treating them
alike would manufacture a refutation out of a provider outage. Each ticker therefore
carries a `coverage: { dividend, split }` flag, and only full coverage permits a
refutation. Test-locked as an explicit regression.

**Live-plan verification still outstanding:** no FMP key is available locally, so the
endpoints have not been exercised against the real subscription. If they are not on the
plan, `fmp-client` categorizes it `plan-gated` and the diagnostics say so permanently
rather than retrying — check `op=optionsradar` → `corpActions.dividend.category` after the
next scan.

---

## 6. Per-contract Greeks / dealer positioning

**Blocks:** `greeksCapability` in `lib/options-execution-v2.js`, which currently discloses
that Greeks are not supplied and refuses to estimate them.

**Needed:** per-contract `delta`/`gamma`/`vega` **and** full-chain open interest for every
listed strike. Both are required — Greeks alone are insufficient for dealer positioning,
and the module enforces that.

**Cost:** ORATS ~$100+/mo, or Polygon Options ~$30/mo. Note the delayed Yahoo chain already
carries `impliedVolatility`, which is why IV rank and expected-move **do** work while
Greeks do not.

**Judgement:** low priority. Dealer-positioning analysis is heavily model-dependent and
would introduce exactly the kind of unfalsifiable claim this redesign is trying to avoid.

---

## 7. True intraday cadence

**Blocks:** market-state freshness. Not a data-vendor problem — a **transport** problem.

GitHub throttles the declared `*/5` cron to roughly hourly (9 firings/day observed; see
`MARKET-PULSE-V2.md` → *Scheduling reality*). Options:

| Option | Cost | Trade-off |
|---|---|---|
| External pinger (`~/market-news-pinger`, launchd) | free | Only runs when that machine is awake |
| Vercel Pro cron | ~$20/mo | Reliable; minute-level granularity |
| A second CI provider on a cron | free tier | Same throttling risk, different vendor |

---

## 8. "No demonstrated edge" — NOT a data problem

Listed here only to keep it from being mistaken for one.

Every layer is SHADOW / weight 0. The decision-utility formula, freshness TTLs, and
evidence-strength bands are **hypotheses with exposed components**. They resolve only by
letting the shadow layers accumulate prospective, independently-dated outcomes and then
evaluating them against the promotion gate in `lib/strategy-gate.js`.

**No purchase and no code change can shorten this.** Anything that appeared to would be
the precise dishonesty the redesign exists to prevent. The relevant timeline is the gate
itself — ≥50 resolved episodes across ≥20 independent dates with cost-aware incremental
value over the price/setup baseline — which is a matter of months of accrual, not of
engineering.

---

## Suggested order

1. ~~**§5 corporate actions**~~ — **DONE** (`lib/corp-actions.js`); live-plan check pending.
2. ~~**§3 macro via FRED**~~ — **DONE** (`lib/fred.js`, `lib/pulse2-macro.js`); key set, 3/4 legs live.
3. **§4 estimates** — check the existing FMP plan before spending anything.
4. **§1 spread** — the single highest-impact paid item; unblocks execution coverage.
5. **§7 cadence** — only if intraday freshness actually matters to how you use the page.
6. **§2 borrow / §6 Greeks** — probably decline both; declared-unavailable is honest and
   the alternatives are disproportionate.
