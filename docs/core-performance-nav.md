# Core Performance — daily NAV repair & reconciliation

**What was wrong.** The Core Performance headline (`SINCE INCEPTION (realized)`) compounded
per-quarter averages of **resolved trades only**. While positions remain open that is not a
portfolio return: quick stop-outs and quick wins resolve first, so the compounded number
described a systematically different book than the one actually held, and quarters flagged
"partial" still contributed to the since-inception compound.

**What the old headline was actually measuring:** "the compounded average return of the
subset of picks whose outcome windows happened to have closed, grouped by quarter" — a
selection-biased diagnostic, not NAV.

## The repair (no historical records changed)

`lib/nav-ledger.js` (`buildNavLedger`) computes a daily mark-to-market NAV ledger from the
untouched signal ledger + outcome records:

- **cash + every open position** marked at each day's close + **every resolved position**
  realized at the price the outcome resolver recorded (`entry × (1 + r)`) on its recorded
  exit date, with one per-side cost charged at each leg (cost-v3 small tier), and a
  benchmark (IWM) NAV on the same daily axis;
- **fail-closed marks**: a missing close for any held position truncates the series at the
  last fully-covered date and reports the exact gap (`{ticker, missingOn, why}`). A missing
  mark can never be silently omitted from the return. Positions whose logged entry price is
  >2× off the adjusted close series are declared corporate-action mismatches and also fail
  closed;
- **identities preserved and tested** (`test/nav-ledger.test.js`):
  `NAV(d) = cash(d) + Σ shares×close(d)` every day, and
  `ΔNAV = realized P&L + unrealized P&L − costs paid` (`reconciliation.maxAbsError` in every
  response);
- open positions carry an explicit **unpaid exit-cost accrual** (`pendingExitCost`) instead
  of hiding it in the marks; the headline uses the accrual-net figure.

`op=coreperf` now returns a `nav` block (curve decimated to ≤130 points, totals, coverage,
reconciliation). If the ledger spans more tickers than the per-request fetch budget, NAV is
**withheld** with the reason — never computed on partial coverage.

## The three lanes, kept separate

| Lane | What it is | Where |
|---|---|---|
| Portfolio NAV return | daily-marked, cost-net, fail-closed | headline (`SINCE INCEPTION — PORTFOLIO NAV`) |
| Open-position MTM avg | opens marked at latest close, cost-net | strip lane ② (EA-1/EA-2, unchanged) |
| Resolved-trade average / compound | resolved outcomes only | `RESOLVED-ONLY COMPOUND (diagnostic — ignores open positions)` + quarter table |

The legacy resolved-only metric is retained verbatim for compatibility — relabeled as a
diagnostic, and barred (by `test/coreperf-nav-render.test.js`) from ever being the
since-inception headline again.

## Reconciliation: repaired vs legacy

The divergence the repair exists to expose is pinned as a test
(`nav-ledger.test.js` — "THE HEADLINE BUG"): a book whose one resolved trade won +20% while
the still-open half was cut in half reports **+20%** on the resolved-only lane and
**−15% NAV**. On live data the same comparison is served side-by-side in every
`op=coreperf` response (`nav.totals.navReturnNetPendingExit` vs `cumulative.strategyReturn`)
and rendered on the Core Performance tab, so the gap between the two lanes is permanently
visible instead of hidden inside a headline. Live-data caveat: entry prices remain logged
feature-cache references (basis disclosed by the API, EA-3), so the NAV is the honest NAV
of the *logged* book, not of verified fills.
