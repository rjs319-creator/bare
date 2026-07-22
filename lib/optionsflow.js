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

const oc = require('./options-classify');

const CONTRACT_MULT = 100;

// Thresholds (a contract must clear premium + volume to be "unusual").
const MIN_PREMIUM = 50_000;     // matches the UI "Large Premium (> $50k)" filter
const MIN_VOLUME = 150;
const VOLOI_NEW = 1.0;          // vol ≥ OI = positioning opened today, not legacy
const BLOCK_PREMIUM = 1_000_000; // single-strike institutional size ($1M+ print)
const SWEEP_VOLOI = 3.0;        // aggressive accumulation vs standing OI

// The liquid-options universe to scan (deep, tradeable option markets). Kept broad
// enough to surface genuinely unusual flow, but bounded so the (now multi-expiry)
// per-chain scan stays within the serverless budget at concurrency.
const LIQUID_OPTIONS = [
  // Mega-cap / core tech
  'NVDA', 'TSLA', 'AAPL', 'AMD', 'META', 'AMZN', 'MSFT', 'GOOGL', 'NFLX', 'AVGO',
  'PLTR', 'COIN', 'MSTR', 'SMCI', 'MU', 'ARM', 'BABA', 'INTC', 'CRM', 'ORCL',
  'MRVL', 'QCOM', 'ADBE', 'TSM', 'ASML', 'DELL', 'ON', 'MARA', 'RIVN', 'SOFI',
  // High-flow momentum / retail-favorite single names
  'HOOD', 'SNAP', 'DKNG', 'AFRM', 'CVNA', 'RDDT', 'APP', 'CELH', 'GME', 'AMC',
  'IONQ', 'RGTI', 'SHOP', 'ABNB', 'PYPL', 'UBER', 'LULU', 'CMG', 'HIMS', 'PANW',
  // Financials / industrials / energy / healthcare / consumer
  'JPM', 'BAC', 'GS', 'WFC', 'C', 'XOM', 'CVX', 'BA', 'DIS', 'WMT', 'LLY', 'UNH',
  // Broad ETFs & rate/metal proxies (flagged as index/hedge flow separately)
  'SPY', 'QQQ', 'IWM', 'GLD', 'SLV', 'TLT', 'SMH',
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

// Breakeven price of a long option (the most actionable single number: where the
// underlying must be at expiry for the bet to pay). Call = strike + premium/share;
// put = strike − premium/share. Returns null if inputs missing.
function breakevenOf(side, strike, lastPrice) {
  if (strike == null || lastPrice == null) return null;
  return side === 'call' ? round(strike + lastPrice, 2) : round(strike - lastPrice, 2);
}

// The favorable % move the underlying must make FROM SPOT to reach breakeven by
// expiry (always positive in the bet's direction). This is "what has to happen for
// this to work" — concrete for a beginner, the implied bar for a pro.
function moveToBreakevenPct(side, breakeven, underlying) {
  if (breakeven == null || underlying == null || underlying <= 0) return null;
  const move = side === 'call' ? (breakeven - underlying) / underlying : (underlying - breakeven) / underlying;
  return round(move * 100, 1);
}

function dteOf(expiryMs) {
  if (!expiryMs) return null;
  return Math.max(0, Math.round((expiryMs * 1000 - Date.now()) / 86_400_000));
}

// Aggressor of the LAST print, inferred from where lastPrice landed in the bid–ask
// spread: near the ask (≥60% of the way up) = the buyer lifted the offer
// (buyer-initiated, 'ask'); near the bid (≤40%) = the seller hit the bid ('bid');
// in between = 'mid'. Returns null without a usable two-sided quote. HONEST SCOPE:
// this reads the single last trade, not the whole day's volume — a directional
// tell, not a full order-flow tape. Buying an option at the ask CONFIRMS its
// call=bullish / put=bearish lean; selling at the bid FADES it (writing/closing).
function aggressorOf(bid, ask, last) {
  if (bid == null || ask == null || last == null || ask <= bid) return null;
  const frac = (last - bid) / (ask - bid);   // clamps naturally: >1 → ask, <0 → bid
  if (frac >= 0.6) return 'ask';
  if (frac <= 0.4) return 'bid';
  return 'mid';
}

// Composite rank score: premium is the anchor, boosted by aggressive vol/OI and a
// small OTM kicker (OTM = more purely directional/speculative).
function scoreSignal(sig) {
  const premScore = Math.log10(Math.max(1, sig.premium)) * 10;     // ~50 at $100k, ~60 at $1M
  // ZERO-OI FIX: never let Infinity/null reach scoring. Prefer the bounded vol/OI
  // (volOiBounded, set in scanChain) which preserves "new positioning on zero OI" as a
  // real capped value instead of silently scoring it 0. Fall back to the legacy field.
  const vo = sig.volOiBounded != null ? sig.volOiBounded
    : (sig.volOi === Infinity ? 5 : (Number.isFinite(sig.volOi) ? sig.volOi : 0));
  const voScore = Math.min(vo, 10) * 2;
  const otmKick = sig.moneyness === 'OTM' ? 6 : sig.moneyness === 'ATM' ? 3 : 0;
  return round(premScore + voScore + otmKick, 1);
}

// Build unusual-flow signals from one chain result. `result` = the Yahoo
// optionChain result[0] (has .quote, .options[]). We iterate EVERY expiry chain
// present in result.options — a single-expiry fetch has one entry (unchanged
// behavior); the multi-expiry fetch carries the nearest weekly PLUS a swing
// expiry, so short-dated gamma bets and further-out positioning both surface.
// Returns [] if none.
function scanChain(ticker, result, opts = {}) {
  const minPrem = opts.minPremium != null ? opts.minPremium : MIN_PREMIUM;
  const minVol = opts.minVolume != null ? opts.minVolume : MIN_VOLUME;
  const chains = result && Array.isArray(result.options) ? result.options : [];
  if (!chains.length) return [];
  const underlying = result.quote && result.quote.regularMarketPrice != null
    ? result.quote.regularMarketPrice : null;
  const undChgPct = result.quote && result.quote.regularMarketChangePercent != null
    ? round(result.quote.regularMarketChangePercent, 2) : null;
  const out = [];
  for (const chain of chains) {
    if (!chain) continue;
    const sides = [['call', chain.calls || []], ['put', chain.puts || []]];
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
          // The listed OCC contract symbol — the stable cross-day key that lets the
          // next session's snapshot confirm whether this activity became real
          // open interest (lib/options-snapshot.js). Null when the feed omits it.
          contractSymbol: c.contractSymbol || null,
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
          undChgPct,
          moneyness: moneyness(c, underlying, side),
          kind: classify(c),
          // Bid/ask + last-print aggressor (buyer- vs seller-initiated) and the last
          // trade time — all straight from the chain, no extra fetch.
          bid: c.bid != null ? round(c.bid, 2) : null,
          ask: c.ask != null ? round(c.ask, 2) : null,
          aggressor: aggressorOf(c.bid, c.ask, c.lastPrice),
          lastTradeTs: c.lastTradeDate || null,
        };
        // Actionability: where the underlying must be at expiry, and the move required.
        sig.breakeven = breakevenOf(side, sig.strike, sig.lastPrice);
        sig.moveToBePct = moveToBreakevenPct(side, sig.breakeven, sig.underlying);
        out.push(sig);
      }
    }
  }
  return enrichHonest(out, opts.dataTs || null);
}

// Attach the HONEST, normalized read to each per-contract signal, additively (existing
// keys — sentiment/kind/volOi — are preserved for back-compat; the honest fields are the
// source of truth downstream). Runs per-ticker multi-leg detection so suspected spreads
// are marked ambiguous (DIRECTION_UNKNOWN) rather than forced bullish/bearish. Also sets
// volOiBounded, which scoreSignal now consumes (zero-OI fix), so we re-score here.
function enrichHonest(signals, dataTs) {
  const byTicker = new Map();
  for (const s of signals) (byTicker.get(s.ticker) || byTicker.set(s.ticker, []).get(s.ticker)).push(s);
  for (const group of byTicker.values()) {
    const flagged = oc.detectMultiLeg(group);
    for (const s of group) {
      const obs = oc.normalizeObservation(s, { dataTs, ambiguous: flagged.has(s) });
      s.volOiBounded = obs.volOiBounded;
      s.newOnZeroOi = obs.newOnZeroOi;
      s.spreadPct = obs.spreadPct;
      s.aggressorReliable = obs.aggressorReliable;
      s.directionState = obs.directionState;
      s.directionLabel = obs.directionLabel;
      s.dteBucket = obs.dteBucket;
      s.kindLabel = obs.kindLabel;
      s.ambiguityFlags = obs.ambiguityFlags;
      s.suspectedMultiLeg = flagged.has(s);
      s.dataDelayed = true;
      s.score = scoreSignal(s);   // re-score with the bounded vol/OI in place
    }
  }
  return signals;
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

// BULL/BEAR GRADE for a set of contracts: a -100..+100 options-sentiment score
// from the call-vs-put premium skew, weighting AGGRESSIVE OTM directional bets
// more (an OTM call sweep signals more conviction than an ITM block). Returns the
// score + a plain label, so "how bullish/bearish is X's options activity" is one
// number a novice can read.
const GRADE_BANDS = [
  [60, 'Very Bullish'], [25, 'Bullish'], [8, 'Slightly Bullish'],
  [-7, 'Neutral'], [-24, 'Slightly Bearish'], [-59, 'Bearish'], [-100, 'Very Bearish'],
];
function flowGrade(contracts) {
  let bull = 0, bear = 0, tot = 0;
  for (const c of (contracts || [])) {
    const w = (c.premium || 0) * (1 + (c.kind === 'sweep' ? 0.25 : 0) + (c.moneyness === 'OTM' ? 0.15 : 0));
    if (c.side === 'call') bull += w; else bear += w;
    tot += w;
  }
  const score = tot > 0 ? Math.round(((bull - bear) / tot) * 100) : 0;
  let label = 'Neutral';
  for (const [thr, lbl] of GRADE_BANDS) { if (score >= thr) { label = lbl; break; } }
  return { score, label };
}

// Aggregate per-contract signals into one row per ticker: net call vs put premium
// (the real directional read), contract mix, and the standout contract. Sorted by
// total unusual premium. This is the organizing layer — a trader reads tickers,
// not 120 contracts.
function rollupByTicker(signals) {
  const m = new Map();
  for (const s of signals) {
    let r = m.get(s.ticker);
    if (!r) r = m.set(s.ticker, { ticker: s.ticker, underlying: s.underlying, isIndex: INDEX_ETFS.has(s.ticker), callPremium: 0, putPremium: 0, _contracts: [], sweep: 0, block: 0, large: 0, topContract: null }).get(s.ticker);
    if (s.side === 'call') r.callPremium += s.premium; else r.putPremium += s.premium;
    r._contracts.push(s);
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
    const g = flowGrade(r._contracts);
    r.score = g.score; r.grade = g.label;
    // HONEST aggregate read (source of truth): MIXED/UNKNOWN emerge from the per-contract
    // provisional states, not from raw call/put premium skew (which equates calls=bullish).
    const agg = oc.aggregateDirection(r._contracts.map(c => oc.normalizeObservation(c)));
    r.directionState = agg.state;
    r.directionLabel = oc.DIRECTION_LABEL[agg.state];
    r.unknownShare = agg.unknownShare;
    r.suspectedMultiLeg = r._contracts.filter(c => c.suspectedMultiLeg).length;
    // EARNINGS PRESERVATION: carry the strongest earnings-before-expiry read from the
    // contracts up to the ticker row so a client-side reaggregation can reuse it and the
    // ⚠ warning can never silently disappear (it's derived here, not only in the route).
    let erDays = null, erBefore = false;
    for (const c of r._contracts) {
      if (c.earningsBeforeExpiry) erBefore = true;
      if (c.earningsInDays != null && (erDays == null || c.earningsInDays < erDays)) erDays = c.earningsInDays;
    }
    if (erBefore) r.earningsBeforeExpiry = true;
    if (erDays != null) r.earningsInDays = erDays;
    r.contracts = r._contracts.length;
    delete r._contracts;
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
  const g = flowGrade(signals);
  return {
    totalPremium: round(total), callPremium: round(call), putPremium: round(put),
    bullishPct: total > 0 ? Math.round((100 * call) / total) : 50,
    lean: total > 0 ? (call >= put ? 'bullish' : 'bearish') : 'neutral',
    score: g.score, grade: g.label,
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
  breakevenOf, moveToBreakevenPct, aggressorOf,
  scanChain, scanOptionsFlow, flowOutcome,
  INDEX_ETFS, rollupByTicker, flowSummary, flowGrade,
};
