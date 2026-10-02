'use strict';
// ARK HOLDINGS DIFF → TRADES → ADV-SCALED CERN EVENTS. Pure: no I/O, no clock.
//
// Snapshot(prev) vs snapshot(cur) per fund gives that fund's share changes; legs are then
// NETTED per ticker across the six funds (ARKK and ARKW often trade the same name the
// same day, sometimes in opposite directions — the market only sees the net). Each net
// row is scaled by the name's trailing-20-session dollar ADV from the app's candle cache,
// and the FROZEN thresholds below decide which rows become CERN events. Frozen in the
// hypothesis registry (ark-net-buy-pressure / ark-net-sell-avoid) BEFORE the first tick.
const ADV_LOOKBACK_SESSIONS = 20;          // dollar ADV window (close × volume)
const EVENT_MIN_PCT_OF_ADV = 0.10;         // |net delta $| ≥ 10% of ADV20 → event
const EVENT_MAX_ADV_USD = 50_000_000;      // only THIN names (ADV20 < $50M) — pressure needs a thin book
const EVENT_TYPE_BUY = 'ARK_NET_BUY';
const EVENT_TYPE_SELL = 'ARK_NET_SELL';
const USD_DP = 2, PX_DP = 4, PCT_DP = 4;

const round = (x, dp) => +Number(x).toFixed(dp);
const absDesc = (a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd) || (a.ticker < b.ticker ? -1 : 1);

// Dual listings / split rows of one ticker are summed before diffing.
function byTicker(holdings) {
  const m = new Map();
  for (const h of holdings || []) {
    if (!h || !h.ticker) continue;
    const cur = m.get(h.ticker) || { shares: 0, marketValue: 0 };
    m.set(h.ticker, { shares: cur.shares + (h.shares || 0), marketValue: cur.marketValue + (h.marketValue || 0) });
  }
  return m;
}
const impliedPrice = (h) => (h && h.shares > 0 && h.marketValue > 0 ? h.marketValue / h.shares : null);
const kindOf = (prev, cur) => (!prev ? 'new' : !cur ? 'exited' : cur > prev ? 'added' : 'trimmed');

/**
 * One fund, prev snapshot → cur snapshot. Both: { fund, asOf, holdings }.
 * → [{ fund, ticker, prevShares, curShares, deltaShares, price, deltaUsd, kind }], ticker order.
 * Throws on a fund mismatch or a non-advancing as-of date (a stale republish is NOT a trade).
 */
function diffFundHoldings(prev, cur) {
  if (!prev || !cur || prev.fund !== cur.fund) throw new Error(`ark-diff: fund mismatch (${prev && prev.fund} vs ${cur && cur.fund})`);
  if (!(typeof cur.asOf === 'string' && typeof prev.asOf === 'string' && cur.asOf > prev.asOf)) {
    throw new Error(`ark-diff ${cur.fund}: as-of must advance (prev ${prev.asOf}, cur ${cur.asOf})`);
  }
  const P = byTicker(prev.holdings), C = byTicker(cur.holdings);
  const tickers = [...new Set([...P.keys(), ...C.keys()])].sort();
  const out = [];
  for (const ticker of tickers) {
    const p = P.get(ticker), c = C.get(ticker);
    const prevShares = p ? p.shares : 0, curShares = c ? c.shares : 0;
    const deltaShares = curShares - prevShares;
    if (deltaShares === 0) continue;
    const price = impliedPrice(c) ?? impliedPrice(p);
    if (price == null) continue;                              // no price on either side → unpriceable, skip
    const px = round(price, PX_DP);
    out.push({ fund: cur.fund, ticker, prevShares, curShares, deltaShares, price: px, deltaUsd: round(deltaShares * px, USD_DP), kind: kindOf(p ? prevShares : 0, c ? curShares : 0) });
  }
  return out;
}

// Legs across funds → one net row per ticker, sorted by |deltaUsd| desc.
function netTradesByTicker(trades) {
  const m = new Map();
  for (const t of trades || []) {
    const cur = m.get(t.ticker) || { ticker: t.ticker, deltaShares: 0, deltaUsd: 0, funds: [], legs: 0 };
    m.set(t.ticker, { ...cur, deltaShares: cur.deltaShares + t.deltaShares, deltaUsd: cur.deltaUsd + t.deltaUsd, funds: [...cur.funds, t.fund], legs: cur.legs + 1 });
  }
  return [...m.values()]
    .map((n) => ({ ...n, deltaUsd: round(n.deltaUsd, USD_DP), funds: [...new Set(n.funds)].sort() }))
    .filter((n) => n.deltaShares !== 0)
    .sort(absDesc);
}

// Trailing mean of close × volume over the last `n` bars; null when history is too short.
function adv20Usd(candles, n = ADV_LOOKBACK_SESSIONS) {
  const bars = (candles || []).filter((b) => b && b.close > 0 && Number.isFinite(b.volume));
  if (bars.length < n) return null;
  const win = bars.slice(-n);
  return win.reduce((s, b) => s + b.close * b.volume, 0) / n;
}

// Attach adv20Usd + pctOfAdv20 (|deltaUsd| / adv). Missing ADV stays null — never 0.
function withAdv(net, advByTicker) {
  const get = (t) => (advByTicker instanceof Map ? advByTicker.get(t) : (advByTicker || {})[t]);
  return (net || []).map((n) => {
    const adv = get(n.ticker);
    const ok = Number.isFinite(adv) && adv > 0;
    return { ...n, adv20Usd: ok ? adv : null, pctOfAdv20: ok ? round(Math.abs(n.deltaUsd) / adv, PCT_DP) : null };
  });
}

/**
 * Net rows (with ADV) → CERN events for the thin-name / big-flow cells.
 * `row.asOf` (the trade session) overrides `opts.asOf`; `sessionDate` = the decision
 * session (the day the app READ the file — CSVs land after the close).
 * direction −1 ⇒ long pick in the decay ledger (buy pressure), +1 ⇒ short/AVOID (sell pressure).
 */
function selectCernEvents(rows, { asOf, sessionDate } = {}, { minPct = EVENT_MIN_PCT_OF_ADV, maxAdvUsd = EVENT_MAX_ADV_USD } = {}) {
  return (rows || [])
    .filter((r) => r.deltaShares !== 0 && r.adv20Usd != null && r.adv20Usd < maxAdvUsd && r.pctOfAdv20 != null && r.pctOfAdv20 >= minPct)
    .map((r) => {
      const tradeSession = r.asOf || asOf;
      const isBuy = r.deltaShares > 0;
      return {
        type: isBuy ? EVENT_TYPE_BUY : EVENT_TYPE_SELL, symbol: r.ticker, direction: isBuy ? -1 : 1,
        dateMs: Date.parse(tradeSession + 'T00:00:00Z'), sessionDate, estFlowShares: Math.abs(r.deltaShares),
        meta: { source: 'ark', asOf: tradeSession, funds: r.funds, legs: r.legs, deltaShares: r.deltaShares, deltaUsd: r.deltaUsd, adv20Usd: r.adv20Usd, pctOfAdv20: r.pctOfAdv20 },
      };
    });
}

module.exports = {
  ADV_LOOKBACK_SESSIONS, EVENT_MIN_PCT_OF_ADV, EVENT_MAX_ADV_USD, EVENT_TYPE_BUY, EVENT_TYPE_SELL,
  diffFundHoldings, netTradesByTicker, adv20Usd, withAdv, selectCernEvents,
};
