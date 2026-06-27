// UNUSUAL OPTIONS FLOW — quantitative, derived from Yahoo option chains (the same
// free feed lib/options-baseline.js uses), scanned at the PER-CONTRACT level.
//
// HONEST SCOPE: real "sweep vs block" tape needs a paid time-&-sales feed we don't
// have. From EOD/delayed chain data we CAN flag genuinely unusual activity:
//   • large estimated premium  (volume × lastPrice × 100)
//   • volume ≫ open interest    (vol/OI — NEW positioning, not existing books)
//   • call/put skew             (directional lean)
// We label the derived class plainly ('block' = big single-strike size, 'sweep' =
// aggressive vol-over-OI, 'large' = big premium) and never claim live tick tape.
//
// Pure functions (premiumUsd / volOiRatio / classify / sentimentOf / scoreSignal /
// scanChain) are unit-tested; the network scan injects a chain-fetcher for testing.

const CONTRACT_MULT = 100;

// Thresholds (a contract must clear premium + volume to be "unusual").
const MIN_PREMIUM = 50_000;     // matches the UI "Large Premium (> $50k)" filter
const MIN_VOLUME = 150;
const VOLOI_NEW = 1.0;          // vol ≥ OI = positioning opened today, not legacy
const BLOCK_PREMIUM = 1_000_000; // single-strike institutional size ($1M+ print)
const SWEEP_VOLOI = 3.0;        // aggressive accumulation vs standing OI

// The liquid-options universe to scan (deep, tradeable option markets). Kept tight
// so the per-chain scan stays within the serverless budget.
const LIQUID_OPTIONS = [
  'NVDA', 'TSLA', 'AAPL', 'AMD', 'META', 'AMZN', 'MSFT', 'GOOGL', 'NFLX', 'AVGO',
  'PLTR', 'COIN', 'MSTR', 'SMCI', 'MU', 'ARM', 'BABA', 'INTC', 'CRM', 'ORCL',
  'JPM', 'BAC', 'XOM', 'CVX', 'BA', 'DIS', 'UBER', 'SOFI', 'RIVN', 'MARA',
  'SPY', 'QQQ', 'IWM',
];

const round = (x, d = 0) => { const p = 10 ** d; return Math.round((x || 0) * p) / p; };

// Estimated dollar premium that traded in a contract today.
function premiumUsd(c) {
  const px = c.lastPrice != null ? c.lastPrice : c.ask;   // mark fallback
  return (c.volume || 0) * (px || 0) * CONTRACT_MULT;
}

// Volume relative to standing open interest. Infinity = volume on zero OI (brand-new).
function volOiRatio(c) {
  const oi = c.openInterest || 0;
  if (oi > 0) return (c.volume || 0) / oi;
  return (c.volume || 0) > 0 ? Infinity : 0;
}

// Derived class from chain data (NOT live tape — labeled honestly in the UI).
function classify(c) {
  const prem = premiumUsd(c);
  const vo = volOiRatio(c);
  // Sweep is defined by aggressive turnover (volume far over standing OI), which
  // is the clearest thing we CAN derive from chain data — so it takes priority
  // over raw size. A large print with only modest turnover reads as a block.
  if (vo >= SWEEP_VOLOI) return 'sweep';
  if (prem >= BLOCK_PREMIUM) return 'block';
  return 'large';
}

// Directional lean. We can't see buy/sell side on free data, so calls = bullish,
// puts = bearish (the standard simplification; surfaced as a "lean", not a fact).
function sentimentOf(side) {
  return side === 'call' ? 'bullish' : 'bearish';
}

function moneyness(c, underlying, side) {
  if (underlying == null || c.strike == null) return 'ATM';
  const diff = (c.strike - underlying) / underlying;
  if (Math.abs(diff) <= 0.02) return 'ATM';
  if (side === 'call') return diff > 0 ? 'OTM' : 'ITM';
  return diff < 0 ? 'OTM' : 'ITM';
}

function dteOf(expiryMs) {
  if (!expiryMs) return null;
  return Math.max(0, Math.round((expiryMs * 1000 - Date.now()) / 86_400_000));
}

// Composite rank score: premium is the anchor, boosted by aggressive vol/OI and a
// small OTM kicker (OTM = more purely directional/speculative).
function scoreSignal(sig) {
  const premScore = Math.log10(Math.max(1, sig.premium)) * 10;     // ~50 at $100k, ~60 at $1M
  const voScore = Math.min(sig.volOi === Infinity ? 5 : sig.volOi, 10) * 2;
  const otmKick = sig.moneyness === 'OTM' ? 6 : sig.moneyness === 'ATM' ? 3 : 0;
  return round(premScore + voScore + otmKick, 1);
}

// Build unusual-flow signals from one chain result. `chain` = the Yahoo
// optionChain result[0] (has .quote, .options[0].calls/puts). Returns [] if none.
function scanChain(ticker, result, opts = {}) {
  const minPrem = opts.minPremium != null ? opts.minPremium : MIN_PREMIUM;
  const minVol = opts.minVolume != null ? opts.minVolume : MIN_VOLUME;
  const chain = result && result.options && result.options[0];
  if (!chain) return [];
  const underlying = result.quote && result.quote.regularMarketPrice != null
    ? result.quote.regularMarketPrice : null;
  const sides = [['call', chain.calls || []], ['put', chain.puts || []]];
  const out = [];
  for (const [side, list] of sides) {
    for (const c of list) {
      const premium = premiumUsd(c);
      if (premium < minPrem || (c.volume || 0) < minVol) continue;
      const vo = volOiRatio(c);
      // Admit a contract if it's NEW positioning (vol ≥ OI) OR a block-size print
      // (huge premium even against existing OI — that's exactly what a block is).
      // Without the block carve-out the vol/OI gate silently excludes all blocks.
      if (vo < VOLOI_NEW && premium < BLOCK_PREMIUM) continue;
      const sig = {
        ticker, side, type: side === 'call' ? 'C' : 'P',
        sentiment: sentimentOf(side),
        strike: c.strike != null ? round(c.strike, 2) : null,
        expiry: c.expiration ? new Date(c.expiration * 1000).toISOString().slice(0, 10) : null,
        dte: dteOf(c.expiration),
        volume: c.volume || 0,
        openInterest: c.openInterest || 0,
        volOi: vo === Infinity ? null : round(vo, 2),
        lastPrice: c.lastPrice != null ? round(c.lastPrice, 2) : null,
        premium: round(premium),
        iv: c.impliedVolatility != null ? round(c.impliedVolatility * 100, 1) : null,
        underlying: underlying != null ? round(underlying, 2) : null,
        moneyness: moneyness(c, underlying, side),
        kind: classify(c),
      };
      sig.score = scoreSignal(sig);
      out.push(sig);
    }
  }
  return out;
}

// Scan a universe. fetchChain(ticker) -> Yahoo optionChain result[0] (injected so
// the scan is testable / reusable). Returns the flattened, score-sorted top signals.
async function scanOptionsFlow(tickers, fetchChain, opts = {}) {
  const limit = opts.concurrency || 6;
  const cap = opts.cap || 40;
  const all = [];
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try {
        const result = await fetchChain(t);
        if (result) all.push(...scanChain(t, result, opts));
      } catch { /* skip a bad chain */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tickers.length) }, worker));
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, cap);
}

// Index/ETF tickers — their flow is usually hedging, not single-stock conviction,
// so we surface them separately (they dominate raw premium but mean something else).
const INDEX_ETFS = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VIX', 'VXX', 'UVXY', 'TLT', 'HYG', 'GLD', 'SLV', 'XLF', 'XLE', 'XLK', 'SMH']);

// Aggregate per-contract signals into one row per ticker: net call vs put premium
// (the real directional read), contract mix, and the standout contract. Sorted by
// total unusual premium. This is the organizing layer — a trader reads tickers,
// not 120 contracts.
function rollupByTicker(signals) {
  const m = new Map();
  for (const s of signals) {
    let r = m.get(s.ticker);
    if (!r) r = m.set(s.ticker, { ticker: s.ticker, underlying: s.underlying, isIndex: INDEX_ETFS.has(s.ticker), callPremium: 0, putPremium: 0, contracts: 0, sweep: 0, block: 0, large: 0, topContract: null }).get(s.ticker);
    if (s.side === 'call') r.callPremium += s.premium; else r.putPremium += s.premium;
    r.contracts++;
    r[s.kind] = (r[s.kind] || 0) + 1;
    if (!r.topContract || s.premium > r.topContract.premium) r.topContract = s;
  }
  const out = [];
  for (const r of m.values()) {
    r.totalPremium = round(r.callPremium + r.putPremium);
    r.callPremium = round(r.callPremium);
    r.putPremium = round(r.putPremium);
    r.bullishPct = r.totalPremium > 0 ? Math.round((100 * r.callPremium) / r.totalPremium) : 50;
    r.net = r.bullishPct >= 60 ? 'bullish' : r.bullishPct <= 40 ? 'bearish' : 'mixed';
    out.push(r);
  }
  out.sort((a, b) => b.totalPremium - a.totalPremium);
  return out;
}

// Market-wide read across all signals: total premium and the bullish/bearish
// split of dollars (calls vs puts) — a one-glance gauge of the unusual-flow tape.
function flowSummary(signals) {
  let call = 0, put = 0;
  for (const s of signals) { if (s.side === 'call') call += s.premium; else put += s.premium; }
  const total = call + put;
  return {
    totalPremium: round(total), callPremium: round(call), putPremium: round(put),
    bullishPct: total > 0 ? Math.round((100 * call) / total) : 50,
    lean: total > 0 ? (call >= put ? 'bullish' : 'bearish') : 'neutral',
    signalCount: signals.length,
    tickerCount: new Set(signals.map(s => s.ticker)).size,
  };
}

// Forward-return outcome for a logged signal: bullish wins when the underlying
// rises, bearish wins when it falls. Returns the directional return (signed so
// positive = the flow's lean was right), or null if not enough history.
function flowOutcome(entry, future, sentiment) {
  if (entry == null || future == null || entry <= 0) return null;
  const ret = (future - entry) / entry;
  return sentiment === 'bearish' ? -ret : ret;
}

module.exports = {
  LIQUID_OPTIONS, MIN_PREMIUM, MIN_VOLUME, BLOCK_PREMIUM, SWEEP_VOLOI,
  premiumUsd, volOiRatio, classify, sentimentOf, moneyness, dteOf, scoreSignal,
  scanChain, scanOptionsFlow, flowOutcome,
  INDEX_ETFS, rollupByTicker, flowSummary,
};
