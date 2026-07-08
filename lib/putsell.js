// OPTIONS MOVES — module 1: cash-secured PUT-SELLING setups, defined the way an
// experienced options seller reads price action.
//
// The put seller's edge is selling insurance on stocks they'd be happy to OWN, into
// a pullback within an uptrend, at a strike below support, with an out-of-the-money
// cushion — collecting elevated premium without chasing. Bad setups: downtrends
// (falling knives), overbought names at highs (thin premium, no pullback), and
// strikes with no real support beneath them.
//
// So the price-action screen is:
//   1. QUALITY UPTREND      — above a rising 200-day, 50 > 200 (you'd own it)
//   2. HEALTHY PULLBACK      — off the recent high, RSI cooled to ~40-55 (not
//                              overbought, not a crash) — richer premium, better entry
//   3. STRIKE BELOW SUPPORT  — put strike under the 50-day / recent-low support with
//                              a cushion of at least ~1 ATR
// IV richness, earnings proximity and liquidity are layered on afterward (route).
//
// Pure: candles in → setup out (or null if not a candidate). Testable.

const { calcRSI, calcATR } = require('./signal');

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sma = (closes, n) => (closes.length >= n ? avg(closes.slice(-n)) : null);
const lastOf = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
const clamp01 = v => Math.max(0, Math.min(1, v));

// Round DOWN to a sensible option strike for the price range.
function strikeStep(px) { return px < 25 ? 0.5 : px < 100 ? 1 : px < 250 ? 2.5 : 5; }
function niceStrike(x, px) { const s = strikeStep(px); return +(Math.floor(x / s) * s).toFixed(2); }

// Analyze one name's daily candles for a put-selling setup. Returns the setup or
// null if it isn't a candidate (not in an uptrend, no cushion, etc.).
function analyzePutSetup(candles) {
  if (!candles || candles.length < 200) return null;
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high ?? c.close);
  const lows = candles.map(c => c.low ?? c.close);
  const px = closes[closes.length - 1];
  const sma50 = sma(closes, 50), sma200 = sma(closes, 200);
  if (sma50 == null || sma200 == null || px <= sma200) return null;   // must be a long-term uptrend

  const rsi = lastOf(calcRSI(closes, 14));
  const atr = lastOf(calcATR(candles, 14)) || (px * 0.02);
  const sma200Prev = closes.length >= 220 ? avg(closes.slice(-220, -20)) : sma200;
  const sma200Rising = sma200 > sma200Prev;
  const high20 = Math.max(...highs.slice(-20));
  const low20 = Math.min(...lows.slice(-20));
  const pctFromHigh = ((px - high20) / high20) * 100;   // ≤ 0
  const pctFrom50 = ((px - sma50) / sma50) * 100;

  // ── Trend quality (you'd want to own it) ──
  const trendScore = clamp01(0.6 + (sma50 > sma200 ? 0.2 : 0) + (sma200Rising ? 0.2 : 0));

  // ── Entry quality: the pullback sweet spot ──
  const rsiScore = rsi == null ? 0.4 : clamp01(1 - Math.abs(rsi - 45) / 25);           // peaks ~45
  const pullbackScore = pctFromHigh >= -14 && pctFromHigh <= -2 ? 1                     // a real but orderly dip
    : pctFromHigh > -2 ? 0.35                                                            // still at highs — thin premium
    : clamp01(1 + (pctFromHigh + 14) / 12);                                              // deeper than -14% → fading
  const nearSupport = px >= sma50 * 0.97 ? clamp01(1 - Math.abs(pctFrom50) / 8) : 0.45;  // near/above the 50-day
  const entryScore = rsiScore * 0.45 + pullbackScore * 0.3 + nearSupport * 0.25;

  // ── Strike below support with an ATR cushion ──
  const supports = [sma50, low20, sma200].filter(s => s != null && s < px - 0.4 * atr);
  const support = supports.length ? Math.max(...supports) : px - 1.5 * atr;
  const supportBasis = support === sma50 ? '50-day' : support === low20 ? '20-day low' : support === sma200 ? '200-day' : 'ATR band';
  const strike = niceStrike(Math.min(support, px - atr), px);
  const bufferPct = ((px - strike) / px) * 100;
  const atrCushion = +((px - strike) / atr).toFixed(1);
  const bufferScore = bufferPct >= 4 && bufferPct <= 14 ? 1 : bufferPct < 2 ? 0.25 : bufferPct < 4 ? 0.6 : 0.6;

  const qualifies = px > sma200 && (rsi == null || rsi < 66) && bufferPct >= 2 && strike > 0;
  const score = +(trendScore * 0.45 + entryScore * 0.4 + bufferScore * 0.15).toFixed(3);
  const tier = !qualifies ? null : score >= 0.7 ? 'PRIME' : score >= 0.55 ? 'SOLID' : 'WATCH';
  if (!qualifies) return null;

  const reasons = [
    `Uptrend — above the ${sma200Rising ? 'rising ' : ''}200-day${sma50 > sma200 ? ', 50 > 200' : ''}`,
    pctFromHigh <= -2 ? `Pulled back ${Math.abs(pctFromHigh).toFixed(0)}% from the recent high` : 'Consolidating near highs',
    rsi != null ? `RSI ${Math.round(rsi)} (${rsi < 55 ? 'cooled off, room to run' : 'still firm'})` : null,
    `Sell the $${strike} put — ${bufferPct.toFixed(0)}% below spot at ${supportBasis} support (${atrCushion} ATR cushion)`,
  ].filter(Boolean);

  const cautions = [];
  if (rsi != null && rsi < 32) cautions.push('Deeply oversold — wait for it to stop falling before selling puts.');
  if (px < sma50) cautions.push('Below the 50-day — support is weaker here.');
  if (bufferPct < 4) cautions.push('Thin cushion — the strike sits close to spot.');

  return {
    price: +px.toFixed(2), tier, score,
    rsi: rsi != null ? Math.round(rsi) : null,
    sma50: +sma50.toFixed(2), sma200: +sma200.toFixed(2),
    pctFromHigh: +pctFromHigh.toFixed(1),
    strike, bufferPct: +bufferPct.toFixed(1), atrCushion, supportBasis,
    reasons, cautions,
  };
}

// Layer IV richness, earnings proximity, and liquidity onto a setup (route calls
// this for the shortlist after fetching options + earnings). Pure, non-mutating.
function finalizePutSell(setup, { atmIV, earningsInDays, contracts } = {}) {
  const out = { ...setup, atmIV: atmIV != null ? atmIV : null, earningsInDays: earningsInDays != null ? earningsInDays : null };
  if (atmIV != null) {
    out.ivLevel = atmIV >= 0.5 ? 'high' : atmIV >= 0.3 ? 'moderate' : 'low';
    out.ivNote = out.ivLevel === 'high' ? 'High IV — rich put premium' : out.ivLevel === 'moderate' ? 'Moderate IV' : 'Low IV — thinner premium';
  }
  const cautions = [...(setup.cautions || [])];
  if (earningsInDays != null && earningsInDays >= 0 && earningsInDays <= 35) {
    out.earningsSoon = true;
    cautions.push(`Earnings in ${earningsInDays}d (before a typical monthly expiry) — premium is fatter but adds binary risk.`);
  }
  if (contracts != null && contracts < 20) cautions.push('Thin options — check the bid/ask spread before selling.');
  out.cautions = cautions;
  return out;
}

module.exports = { analyzePutSetup, finalizePutSell, niceStrike };
