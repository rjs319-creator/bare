// op=putsell — Options Moves: cash-secured put-selling setups.
//
// TWO-STAGE, FULL-MARKET (same pattern as Dual Confirmed):
//   Stage 1 — read the price-action put-sell setup for the WHOLE universe
//             (large+small+micro) from the screener's daily candle cache (no
//             re-fetching); keep qualifying setups, strongest first.
//   Stage 2 — for the top shortlist, fetch the option chain (ATM IV + liquidity)
//             and the next earnings date to layer premium/earnings context on.

const { analyzePutSetup, finalizePutSell, gradePutSell } = require('./putsell');
const { fetchChainResult, fetchChainByDate } = require('./options-baseline');
const { selectExpiry, selectPutContract, putEconomics, managementRules } = require('./putsell-contract');

const SCOPES = ['large', 'small', 'micro', 'expanded'];   // 'expanded' = the free full-market universe (Phase 2)
const STAGE2_MAX = 30;         // option-chain fetches to run (top setups)
const SCAN_BUDGET_MS = 45000;

// Robust ATM implied vol from a real expiry chain: median IV of the ~6 near-money
// contracts (rejecting stale/degenerate readings). Mirrors options-baseline's approach.
function atmIvFromChain(chain, spot) {
  if (!chain || spot == null) return null;
  const near = [...(chain.calls || []), ...(chain.puts || [])]
    .filter(c => c.strike != null && c.impliedVolatility != null && isFinite(c.impliedVolatility) && c.impliedVolatility >= 0.05 && c.impliedVolatility <= 5)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, 6).map(c => c.impliedVolatility).sort((a, b) => a - b);
  return near.length ? +near[Math.floor(near.length / 2)].toFixed(4) : null;
}

// Pull a REAL listed cash-secured-put contract for a setup: choose a 25-45 DTE expiry,
// then the best liquid OTM put below support. Returns the enriched real recommendation, or
// { contract:null, reason } (the caller shows NO trade rather than a synthetic strike).
// Earnings-crossing trades are excluded by default (allowEarnings opts in).
async function pickRealPut(setup, { allowEarnings = false } = {}) {
  const base = await fetchChainResult(setup.ticker).catch(() => null);
  if (!base || !Array.isArray(base.expirationDates) || !base.options || !base.options[0]) {
    return { contract: null, reason: 'no-chain' };
  }
  const spot = base.quote && base.quote.regularMarketPrice != null ? base.quote.regularMarketPrice : setup.price;
  const nowSec = Date.now() / 1000;
  const pick = selectExpiry(base.expirationDates, nowSec);
  if (!pick) return { contract: null, reason: 'no-expiry' };

  const nearestTs = base.options[0].expirationDate;
  const targetRes = pick.ts === nearestTs ? base : await fetchChainByDate(setup.ticker, pick.ts).catch(() => null);
  const chain = targetRes && targetRes.options && targetRes.options[0];
  if (!chain || !Array.isArray(chain.puts)) return { contract: null, reason: 'no-put-chain' };

  const atmIV = atmIvFromChain(chain, spot);
  const sel = selectPutContract(chain.puts, { spot, supportPx: setup.sma50, dte: pick.dte, iv: atmIV });
  if (!sel.contract) return { contract: null, reason: sel.reason, expiry: null, dte: pick.dte, atmIV };

  const management = managementRules({ dte: pick.dte, earningsInDays: setup.earningsInDays });
  if (management.crossesEarnings && !allowEarnings) {
    return { contract: null, reason: 'crosses-earnings', earningsExcluded: true, dte: pick.dte, atmIV };
  }
  const econ = putEconomics({ strike: sel.contract.strike, credit: sel.credit }, { spot, supportPx: setup.sma50, dte: pick.dte });
  return {
    contractSymbol: sel.contract.contractSymbol || null,
    strike: sel.contract.strike,
    expiry: new Date(pick.ts * 1000).toISOString().slice(0, 10),
    dte: pick.dte, inWindow: pick.inWindow,
    bid: sel.contract.bid ?? null, ask: sel.contract.ask ?? null,
    openInterest: sel.oi, volume: sel.contract.volume ?? null,
    credit: sel.credit, spreadPct: sel.spreadPct, proxyDelta: sel.proxyDelta,
    atmIV, spot: +Number(spot).toFixed(2),
    economics: econ, management,
    isRealContract: true,
  };
}

async function universeFromCache() {
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const seen = new Set();
  const out = [];
  for (const scope of SCOPES) {
    const doc = await loadCandleCache(scope);
    if (!doc || !doc.data) continue;
    for (const ticker of Object.keys(doc.data)) {
      const tk = ticker.toUpperCase();
      if (seen.has(tk)) continue;
      const entry = cacheGet(doc, ticker);
      if (!entry || !entry.candles || entry.candles.length < 200) continue;
      seen.add(tk);
      out.push({ ticker: tk, company: entry.meta.shortName || entry.meta.longName || tk, candles: entry.candles });
    }
  }
  return out;
}

async function runPutSell(req, res) {
  const universe = await universeFromCache().catch(() => []);

  // ── Stage 1: full-universe price-action put-sell setups ──
  let scanned = universe.length;
  const setups = [];
  for (const u of universe) {
    const s = analyzePutSetup(u.candles);
    if (s) setups.push({ ...s, ticker: u.ticker, company: u.company });
  }
  setups.sort((a, b) => b.score - a.score);
  const shortlist = setups.slice(0, STAGE2_MAX);

  // ── Stage 2: attach a REAL listed put contract (25-45 DTE, liquid, below support) +
  // earnings + IV. No synthetic strikes: a setup with no qualifying real contract shows
  // no trade. Earnings-crossing contracts are excluded unless eventRisk=1 is passed. ──
  const { fetchEarningsInfo } = require('./fundamentals');
  const allowEarnings = req.query.eventRisk === '1';
  const t0 = Date.now();
  let i = 0;
  const worker = async () => {
    while (i < shortlist.length) {
      const s = shortlist[i++];
      if (Date.now() - t0 > SCAN_BUDGET_MS) { s.realPut = { contract: null, reason: 'scan-budget' }; continue; }
      const earn = await fetchEarningsInfo(s.ticker).catch(() => null);
      s.earningsInDays = earn && earn.earningsInDays != null ? earn.earningsInDays : null;
      const real = await pickRealPut(s, { allowEarnings }).catch(() => ({ contract: null, reason: 'error' }));
      s.realPut = real;
      // Keep the IV/earnings grade inputs in sync with what the real chain reported.
      Object.assign(s, finalizePutSell(s, { atmIV: real && real.atmIV, contracts: null, earningsInDays: s.earningsInDays }));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  // Grade each setup (price-action quality × premium/IV), rank by it, number them.
  for (const s of shortlist) Object.assign(s, gradePutSell(s));
  const ranked = shortlist.sort((a, b) => b.rankScore - a.rankScore).map((p, i) => ({ rank: i + 1, ...p }));
  // A "pick" is only tradeable when it has a REAL listed contract; everything else is a
  // setup with no qualifying contract (shown honestly as "no tradeable put right now").
  const picks = ranked.filter(p => p.realPut && p.realPut.isRealContract);
  const noContract = ranked.filter(p => !(p.realPut && p.realPut.isRealContract))
    .map(p => ({ ticker: p.ticker, company: p.company, tier: p.tier, reason: p.realPut ? p.realPut.reason : 'no-contract', earningsExcluded: !!(p.realPut && p.realPut.earningsExcluded) }));

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    picks,
    noContract,
    scanned,
    qualified: setups.length,
    eventRiskEnabled: allowEarnings,
    generatedAt: new Date().toISOString(),
    note: 'Cash-secured PUT-SELLING on REAL listed contracts: the price-action screen finds quality uptrends pulled back to support across the whole universe; each shortlisted name is matched to an ACTUAL liquid listed put (25-45 DTE, below support, acceptable spread/OI) with a conservative bid-based credit and full economics (cash required, breakeven, return on cash, annualized yield, assignment). Delta is a LABELED moneyness+IV proxy — free chains carry no greeks. Setups with no qualifying real contract show no trade (never a synthetic strike). Earnings-crossing contracts are excluded by default (eventRisk=1 to include). Educational — not financial advice; selling puts obligates you to buy the stock at the strike.',
  });
}

module.exports = { runPutSell, universeFromCache, pickRealPut, atmIvFromChain };
