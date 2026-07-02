// TIMING LIGHT — a 1-10 entry-quality gauge for a pick, RIGHT NOW (10 = 🟢 optimal moment
// to buy, 1 = 🔴 worst). It answers "is this a good MOMENT/PRICE to enter a name the
// screener already likes?" — NOT "will it go up" (the app never fabricates a return
// prediction). It is mechanical and explainable, built only from factors that genuinely
// bear on intraday entry timing:
//
//   • R:R remaining   — how much room to the target vs risk to the stop from the current
//                        price (buying near support = better; near target = worse).
//   • Extension        — distance above VWAP + position in the day's range (buying extended
//                        / chasing the high = worse; holding just above VWAP = ideal).
//   • Trend            — are buyers in control (price above VWAP, green day)?
//   • Participation    — intraday relative volume (a move on real volume is more tradeable;
//                        but huge volume WHILE extended = climax risk, softened).
//   • Trigger freshness— for breakout picks, being right at the trigger (fresh) beats being
//                        far extended past it (missed).
//
// Pure: snapshot + levels in → grade out. The Yahoo intraday fetch lives in
// fetchTimingSnapshot (below) and is not part of the scored math (so the math is testable).

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const lerp = (x, x0, x1, y0, y1) => y0 + (y1 - y0) * clamp((x - x0) / (x1 - x0), 0, 1);

// R:R remaining from the current price. Below the stop = don't buy; past target = no upside.
function rrScore(price, stop, target) {
  if (stop == null || target == null || !(target > stop)) return null;
  if (price <= stop) return 0.0;                       // below invalidation
  if (price >= target) return 0.1;                     // target reached — upside gone
  const rr = (target - price) / (price - stop);        // reward : risk from here
  return { s: clamp(lerp(rr, 0.5, 2.5, 0.15, 1.0), 0, 1), rr: +rr.toFixed(2) };
}

// Not-extended: closeness to VWAP (from above is ideal) blended with position in the range.
function extensionScore(pctVsVwap, posInRange) {
  let vwapPart;
  if (pctVsVwap >= 0 && pctVsVwap <= 0.01) vwapPart = 1.0;                 // holding just above VWAP
  else if (pctVsVwap > 0.01) vwapPart = lerp(pctVsVwap, 0.01, 0.05, 1.0, 0.15);  // extended above
  else if (pctVsVwap >= -0.02) vwapPart = 0.8;                            // mild pullback below VWAP
  else vwapPart = lerp(pctVsVwap, -0.02, -0.06, 0.5, 0.25);              // weak, well below VWAP
  const rangePart = posInRange <= 0.6 ? 1.0 : lerp(posInRange, 0.6, 0.9, 1.0, 0.25); // chasing HOD = bad
  return clamp(0.6 * vwapPart + 0.4 * rangePart, 0, 1);
}

// Buyers in control: above VWAP and green is best.
function trendScore(aboveVwap, dayChangePct) {
  if (aboveVwap) return dayChangePct >= 0 ? 1.0 : 0.6;
  return dayChangePct >= 0 ? 0.5 : 0.25;
}

// Participation: real intraday relative volume confirms the move; a climax (huge rvol WHILE
// extended) is softened.
function rvolScore(rvol, extended) {
  if (rvol == null) return null;
  if (rvol < 0.7) return 0.3;
  if (rvol < 1.2) return 0.6;
  if (rvol <= 3) return 1.0;
  return extended ? 0.5 : 0.85;                        // >3× : climax risk if also extended
}

// Trigger freshness for breakout picks: right at the trigger = prime; far past = missed.
function triggerScore(price, trigger) {
  if (trigger == null || !(trigger > 0)) return null;
  const dist = (price - trigger) / trigger;
  if (dist < -0.01) return 0.4;                        // not triggered yet — wait for the break
  if (dist <= 0.01) return 1.0;                        // fresh break — prime
  return clamp(lerp(dist, 0.01, 0.04, 1.0, 0.35), 0.35, 1.0);
}

const LIGHT = s => (s >= 7 ? { light: 'green', emoji: '🟢' } : s >= 4 ? { light: 'amber', emoji: '🟡' } : { light: 'red', emoji: '🔴' });
const LABEL = s => (s >= 9 ? 'Optimal' : s >= 7 ? 'Good' : s >= 5 ? 'Fair' : s >= 3 ? 'Poor' : 'Avoid');

// Grade the current entry timing. `snapshot` = live intraday state; `levels` = the pick's
// own stop/target/trigger + avgVol (all optional). Returns a 1-10 grade + a light + human
// reasons, or a null-score "market closed / no data" object.
// Default factor weights (validated near-optimal, research/35 — re-weighting did not beat
// these OOS). The live adaptive tuner (op=timingtune) may promote learned weights that
// scoreTiming receives via the 3rd arg; absent that, these ship.
const DEFAULT_WEIGHTS = { rr: 0.32, extension: 0.24, trend: 0.16, rvol: 0.16, trigger: 0.12 };

function scoreTiming(snapshot, levels = {}, weights = DEFAULT_WEIGHTS) {
  if (!snapshot) return { score: null, light: 'grey', emoji: '⚪', label: 'No data', reasons: ['No live data'] };
  const { price, dayOpen, dayHigh, dayLow, prevClose, vwap, rvol, marketState } = snapshot;
  if (!(price > 0)) return { score: null, light: 'grey', emoji: '⚪', label: 'No data', reasons: ['No live price'] };
  if (marketState === 'CLOSED') {
    return { score: null, light: 'grey', emoji: '⚪', label: 'Market closed', marketState,
      reasons: ['Market closed — timing grades during market hours'] };
  }

  const posInRange = dayHigh > dayLow ? clamp((price - dayLow) / (dayHigh - dayLow), 0, 1) : 0.5;
  const pctVsVwap = vwap > 0 ? (price - vwap) / vwap : 0;
  const dayChangePct = prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0;
  const extended = pctVsVwap > 0.03 || posInRange > 0.9;

  const rrR = rrScore(price, levels.stop, levels.target);
  const factors = {
    rr: rrR ? rrR.s : null,
    extension: extensionScore(pctVsVwap, posInRange),
    trend: trendScore(price >= vwap, dayChangePct),
    rvol: rvolScore(rvol, extended),
    trigger: triggerScore(price, levels.trigger),
  };
  // Weight only the factors we have; renormalize. Weights are configurable (learned tuner).
  const W = weights || DEFAULT_WEIGHTS;
  let num = 0, den = 0;
  for (const k of Object.keys(DEFAULT_WEIGHTS)) if (factors[k] != null && W[k] != null) { num += W[k] * factors[k]; den += W[k]; }
  const composite = den > 0 ? num / den : 0.4;
  let score = clamp(Math.round(composite * 9 + 1), 1, 10);
  // Reality gates — a nominally good R:R near the stop is a knife-catch if the name isn't
  // holding. You don't get a "green/optimal" light while price is below VWAP (buyers not in
  // control), and being below the stop is an outright avoid.
  if (levels.stop != null && price <= levels.stop) score = Math.min(score, 2);
  else if (price < vwap) score = Math.min(score, dayChangePct < 0 ? 4 : 6);

  // Human reasons — the 2-3 most decisive factors, phrased for the buy-side.
  const reasons = [];
  if (rrR && rrR.rr != null) reasons.push(rrR.rr >= 2 ? `Strong R:R from here (${rrR.rr}:1)` : rrR.rr >= 1 ? `Fair R:R (${rrR.rr}:1)` : `Poor R:R — close to target (${rrR.rr}:1)`);
  else if (rrR === null) { /* no levels */ }
  if (price <= (levels.stop ?? -Infinity)) reasons.push('Below the stop — invalidated');
  if (pctVsVwap > 0.03) reasons.push(`Extended +${(pctVsVwap * 100).toFixed(1)}% above VWAP — chasing`);
  else if (price >= vwap) reasons.push('Above VWAP — buyers in control');
  else reasons.push(`Below VWAP (${(pctVsVwap * 100).toFixed(1)}%) — wait for reclaim`);
  if (posInRange > 0.9) reasons.push('At the day\'s high — extended');
  else if (posInRange < 0.35) reasons.push('Near the day\'s low — better entry zone');
  if (rvol != null) reasons.push(rvol >= 1.2 ? `Heavy volume (${rvol.toFixed(1)}× normal)${extended ? ' — watch for climax' : ' confirms the move'}` : `Light volume (${rvol.toFixed(1)}× normal)`);
  if (factors.trigger != null && factors.trigger >= 0.9) reasons.push('Right at the breakout trigger — fresh');

  return { score, ...LIGHT(score), label: LABEL(score), factors, reasons: reasons.slice(0, 4),
    marketState: marketState || 'REGULAR', price: +price.toFixed(2), vwap: vwap > 0 ? +vwap.toFixed(2) : null,
    posInRange: +posInRange.toFixed(2), pctVsVwap: +(pctVsVwap * 100).toFixed(2), rvol: rvol != null ? +rvol.toFixed(2) : null };
}

// Fetch today's intraday snapshot for one ticker from Yahoo's 1d/5m chart (the same source
// api/price uses). Returns the snapshot scoreTiming expects, or null. `avgVol` (the pick's
// 20-day average daily volume) enables the intraday relative-volume factor.
async function fetchTimingSnapshot(ticker, avgVol = null) {
  const sym = ticker.toUpperCase();
  const path = `/v8/finance/chart/${sym}?range=1d&interval=5m`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}${path}`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (!r.ok) continue;
      const result = (await r.json())?.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta) continue;
      const ts = result.timestamp || [];
      const q = result.indicators?.quote?.[0] || {};
      const reg = meta.currentTradingPeriod?.regular;
      let cumPV = 0, cumV = 0, hi = -Infinity, lo = Infinity, lastClose = null, firstOpen = null, nBars = 0;
      for (let i = 0; i < ts.length; i++) {
        const c = q.close?.[i], h = q.high?.[i], l = q.low?.[i], o = q.open?.[i], v = q.volume?.[i] || 0;
        if (c == null) continue;
        if (reg && (ts[i] < reg.start || ts[i] >= reg.end)) continue;   // regular session only
        if (firstOpen == null) firstOpen = o ?? c;
        lastClose = c; nBars++;
        if (h != null && h > hi) hi = h;
        if (l != null && l < lo) lo = l;
        cumPV += ((h ?? c) + (l ?? c) + c) / 3 * v; cumV += v;
      }
      const price = lastClose ?? meta.regularMarketPrice;
      if (!(price > 0)) continue;
      const now = ts.length ? ts[ts.length - 1] : meta.regularMarketTime;
      let marketState = 'REGULAR';
      if (reg) { if (now >= reg.end) marketState = 'CLOSED'; else if (now < reg.start) marketState = 'PRE'; }
      const elapsedFrac = clamp(nBars / 78, 0.05, 1);                    // 78 5-min bars in a 6.5h session
      const rvol = (avgVol > 0 && elapsedFrac > 0) ? cumV / (avgVol * elapsedFrac) : null;
      return {
        price, dayOpen: firstOpen ?? meta.regularMarketOpen ?? price,
        dayHigh: hi > -Infinity ? hi : (meta.regularMarketDayHigh ?? price),
        dayLow: lo < Infinity ? lo : (meta.regularMarketDayLow ?? price),
        prevClose: meta.previousClose ?? meta.chartPreviousClose ?? price,   // previousClose = yesterday's close; chartPreviousClose is window-relative
        vwap: cumV > 0 ? cumPV / cumV : price, rvol, marketState,
      };
    } catch { /* try next host */ }
  }
  return null;
}

module.exports = { scoreTiming, fetchTimingSnapshot, rrScore, extensionScore, trendScore, rvolScore, triggerScore, DEFAULT_WEIGHTS };
