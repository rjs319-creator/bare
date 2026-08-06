# Preregistration — VRP Live Paper Put-Write (2026-08)

**Registered:** 2026-08-05 · **Hypothesis id:** `vrp-put-write-live` (family `volatility-structure`, confirmatory).
**Status at registration:** OPEN — **no entry exists**: the ledger begins with the next cron tick. The seal is this document's commit hash.

## §1 Motivation (spent, never reusable)

`vrp-overlay-synthetic` (record `550fdefbf8a45dd6`) FAILED as registered — the gates were refuted (regime-gating skips the richest premium). Its recorded SECONDARY lead: the **ungated** synthetic put-write beat SPY risk-adjusted (Sharpe 1.03 vs 0.80, maxDD −13% vs −20%) on one crash-free window with no-smile pricing. Both weaknesses of that lead — synthetic marks and a benign window — are exactly what a prospective real-quote ledger fixes. The synthetic window is spent; only future entries count here.

## §2 Fixed design (frozen in `lib/vrp-routes.js`)

Every 5th SPY trading session: sell ONE SPY put, expiry = listed DTE ∈ [21, 45] nearest 30 calendar days, strike = listed strike nearest spot with **real bid > 0**, price = the end-of-day **bid** (delayed quote, conservative side — the smile and spread are in the mark), cash-secured (strike × 100), held to expiry, settled to intrinsic vs the SPY close on the first session ≥ expiry, cost $1/contract. Skipped entries (no chain, no valid bid, closed session) are recorded with reasons and stand as no-trade periods — never backfilled.

## §3 Success criteria (ALL required, one evaluation)

On the prospective ledger only: (1) mean net period return > 0 with overlap-aware Newey-West t ≥ 2 (lag ≈ 6: 30d windows on a 5-session grid overlap by construction); (2) ledger Sharpe ≥ SPY buy-and-hold Sharpe over the identical span; (3) cumulative max drawdown > −25% of single-contract collateral; (4) BH q ≤ 0.10 within `volatility-structure` at evaluation-time familyTrials.

## §4 Sealed data — holdout `vrp-live-prospective`

ONE evaluation, no earlier than **2028-02-01** AND ≥60 resolved entries spanning ≥18 months **including at least one month where SPY fell ≥5%** — a put-write record without a drawdown month is unfalsifiable marketing, not evidence; the left tail is the premium's price and must be observed. `op=vrpbook` is a public paper display; reading it is not an evaluation — **quoting it as performance evidence is**, and opens the holdout.

## §5 Prohibitions

No gates (refuted), no strike/tenor/moneyness changes, no entry-grid changes, no cherry-picked sub-periods, no early verdicts. The app panel must carry no performance claim beyond the raw paper ledger. Live capital is a human decision outside this registry. Any deviation is a NEW hypothesis.
