// Fire-sale feed for CERN's FIRE_SALE event type.
//
// Thesis: when a concentrated / thematic ETF suffers heavy redemptions, the fund
// must sell its holdings MECHANICALLY, in proportion to weight, regardless of
// each name's fundamentals. That forced supply dislocates the holding below its
// peers and tends to revert once the flow clears (κ≈0.75, ~50d).
//
// True daily creation/redemption (shares-outstanding) flow isn't on our data
// tier, so we PROXY fund outflow from the ETF's OWN tape: a sharp, heavy-volume
// drawdown in the ETF is the redemption signal (APs redeem creation units → the
// fund sells underlying). For each stressed ETF we pull its top holdings and emit
// FIRE_SALE events on the top-weighted names, sizing estFlowShares by weight × the
// ETF's redeemed dollar volume ÷ the holding price.
//
// Holdings source: Yahoo quoteSummary `topHoldings` (free, reuses the app's Yahoo
// cookie/crumb handshake). FMP's etf-holder endpoints are legacy-locked / above
// our Starter tier, so Yahoo's top-10 is the source — fine here because forced
// selling concentrates in exactly those top-weighted names.
//
// HONEST CAVEATS (surfaced in the Events-tab model panel):
//  • Outflow is a price+volume PROXY, not real shares-outstanding flow — an ETF
//    can fall on beta without net redemptions; the volume gate filters most of it.
//  • Holdings are Yahoo's top ~10 by weight, refreshed periodically (not daily).
//  • Broad, liquid funds rarely force-sell a name meaningfully — the watchlist is
//    deliberately CONCENTRATED/thematic ETFs where flow actually propagates.
const { yahooAuth } = require('./options-baseline');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Curated concentrated / redemption-prone ETFs where forced selling propagates to
// identifiable, often illiquid holdings (the 2021-22 ARKK unwind is the archetype).
const FIRESALE_ETFS = [
  'ARKK', 'ARKG', 'ARKW', 'ARKF', 'ARKQ', 'ARKX',   // Ark active, concentrated
  'XBI', 'IBB',                                       // biotech
  'TAN', 'ICLN', 'PBW',                               // clean energy thematic
  'KWEB', 'CQQQ',                                     // China internet (redemption-prone)
  'BOTZ', 'FINX', 'HACK', 'JETS',                     // robotics / fintech / cyber / airlines
];

const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const last = a => a[a.length - 1];

// Yahoo quoteSummary topHoldings → [{ ticker, weight (fraction) }] for the fund's
// top equity holdings. Graceful: returns [] on any failure. Reuses the shared
// Yahoo cookie/crumb auth; refreshes once on a stale-crumb 401.
async function fetchEtfHoldings(etf, _retry = true) {
  const auth = await yahooAuth();
  if (!auth) return [];
  const sym = String(etf).toUpperCase();
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=topHoldings&crumb=${encodeURIComponent(auth.crumb)}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Cookie': auth.cookie },
      });
      if (r.status === 401 && _retry) { await yahooAuth(true); return fetchEtfHoldings(etf, false); }
      if (!r.ok) continue;
      const j = await r.json();
      const rows = j?.quoteSummary?.result?.[0]?.topHoldings?.holdings;
      if (!Array.isArray(rows)) continue;
      const out = [];
      for (const x of rows) {
        const w = x.holdingPercent?.raw;
        if (!x.symbol || !isFinite(w)) continue;
        const ticker = String(x.symbol).toUpperCase().replace(/\./g, '-');
        if (!/^[A-Z][A-Z\-]{0,5}$/.test(ticker)) continue;   // drop cash/bonds/foreign codes
        out.push({ ticker, weight: w });
      }
      // Dedupe (some funds list dual classes); keep the larger weight.
      const seen = new Map();
      for (const h of out) if (!seen.has(h.ticker) || seen.get(h.ticker).weight < h.weight) seen.set(h.ticker, h);
      if (seen.size) return [...seen.values()];
    } catch { /* try next host */ }
  }
  return [];
}

// Detect a redemption-style "dump" in an ETF from its own bars: a sharp drawdown
// over the trailing `window` sessions on ABNORMAL volume (redemptions print as a
// volume surge in the ETF). Returns null when no dump, else the magnitude plus
// the dollar value that flowed out (abnormal volume × avg price over the window).
function detectEtfOutflow(bars, { nowMs = Date.now(), window = 5, dropMin = 0.08, volRatioMin = 1.5 } = {}) {
  if (!bars || bars.length < window + 21) return null;
  const win = bars.slice(-window);
  const prior = bars.slice(-(window + 20), -window);
  const dumpPct = last(bars).close / bars[bars.length - 1 - window].close - 1;
  if (dumpPct > -dropMin) return null;
  const baseVol = mean(prior.map(b => b.volume)) || 1;
  const winVol = mean(win.map(b => b.volume));
  const volRatio = winVol / baseVol;
  if (volRatio < volRatioMin) return null;
  // Abnormal (above-baseline) volume over the window ≈ the redemption flow.
  const redeemedShares = win.reduce((s, b) => s + Math.max(b.volume - baseVol, 0), 0);
  const etfAvgPrice = mean(win.map(b => b.close));
  const dumpStartMs = bars[bars.length - 1 - window].dateMs || nowMs;
  return {
    dumpPct: +dumpPct.toFixed(4), volRatio: +volRatio.toFixed(2),
    redeemedShares, etfAvgPrice, redeemedDollars: redeemedShares * etfAvgPrice,
    dumpStartMs,
  };
}

module.exports = { FIRESALE_ETFS, fetchEtfHoldings, detectEtfOutflow };
