// INDEPENDENT SWING-HORIZON READ (≈2–12 weeks / 10–63 sessions).
//
// This is a NEW, self-contained horizon that sits BETWEEN the intraday 5-minute
// read (lib/signal.js buildLiveSignal) and the long-term ~1y trend read
// (lib/longterm.js). It is NOT an average of those two — it is computed directly
// from ~1–2 years of split-adjusted DAILY bars, and it emphasizes state CHANGES
// relevant to the next 10–63 sessions (breakouts, reclaims, first pullbacks,
// relative-strength inflections) rather than a static level.
//
// Design rules (honest by construction):
//   • Deterministic + pure. No Date.now / Math.random / network. Same inputs →
//     byte-identical output. `asOf`/`now` come from the caller so tests pin them.
//   • Point-in-time. Only bars up to the decision index are read; no future bar
//     can influence the result (the caller may pass a forming/incomplete last
//     bar — we down-weight its volume, never treat it as confirmation).
//   • Interpretable families. Correlated indicators are grouped into families and
//     averaged WITHIN a family before the families are blended, so five momentum
//     indicators that say the same thing count roughly once, not five times.
//   • "evidenceStrength", never "probability". There is NO calibrated model here
//     (calibrated:false, always). The 0–10 number is signed-evidence magnitude.
//   • A swing SELL means the multi-week setup is bearish / damaged / an
//     exit-or-avoid condition (and a possible short candidate). It does NOT
//     instruct a long-only user to short.

const VERSION = 'swing-v1';
const HORIZON_LABEL = '2–12 weeks';

// ── Tunables (named constants, no magic numbers) ────────────────────────────
const MIN_BARS = 55;                 // fewer than this → we can't read a swing trend
const PREFERRED_BARS = 150;          // enough for a stable 50-DMA slope + RS
const BUY_THRESH = 0.22;             // signed-score gate for a BUY
const SELL_THRESH = -0.22;           // signed-score gate for a SELL
const RS_DEADBAND = 2;               // % — ignore stock-minus-benchmark noise inside this
const EXT_SEVERE_ATR = 4.0;          // px this many daily-ATRs above the 20-DMA = "don't chase"
const EXT_HIGH_ATR = 2.5;            // elevated extension (a caution, not yet a veto)
const LIQ_WARN_USD = 3e6;            // < $3M/day median dollar-volume → thin
const LIQ_VETO_USD = 5e5;            // < $500k/day → too illiquid to action a BUY
const LOW_PRICE = 5;                 // sub-$5 → structural-risk warning
const TRANSITION_LOOKBACK = 10;      // sessions to look back for a fresh 20/50 cross / reclaim
const FAMILY_WEIGHTS = { trend: 0.45, rs: 0.35, participation: 0.20 };

// ── Small pure helpers ──────────────────────────────────────────────────────
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (v, d = 2) => (v == null ? null : +v.toFixed(d));
function sma(vals, n, end) {
  const e = end == null ? vals.length : end + 1;
  if (e < n) return null;
  return mean(vals.slice(e - n, e));
}
// Simple n-session return (fraction) ending at the last element.
function retN(closes, n) {
  if (!closes || closes.length <= n) return null;
  const past = closes[closes.length - 1 - n], last = closes[closes.length - 1];
  if (!past) return null;
  return (last - past) / past;
}

// Wilder ATR over daily candles; returns the latest ATR value (absolute $).
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  let a = mean(tr.slice(1, period + 1));
  for (let i = period + 1; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

// Align two candle series by DATE (not bar index) so a security with missing
// sessions is never compared against a mismatched benchmark bar. Returns the
// closes of both, over the intersection of dates, in chronological order.
function alignByDate(stock, bench) {
  if (!bench || !bench.length) return null;
  const bm = new Map(bench.map(c => [c.date, c.close]));
  const s = [], b = [];
  for (const c of stock) {
    const bc = bm.get(c.date);
    if (bc != null) { s.push(c.close); b.push(bc); }
  }
  return s.length >= 30 ? { stock: s, bench: b } : null;
}

// Excess return vs an aligned benchmark over n sessions, in percentage points.
function excessPct(aligned, n) {
  if (!aligned) return null;
  const s = retN(aligned.stock, n), b = retN(aligned.bench, n);
  if (s == null || b == null) return null;
  return (s - b) * 100;
}

// Position within the last n-session high/low range, 0 (at low) … 1 (at high).
function rangePos(candles, n) {
  const slice = candles.slice(-n);
  if (slice.length < 5) return null;
  const hi = Math.max(...slice.map(c => c.high));
  const lo = Math.min(...slice.map(c => c.low));
  if (hi <= lo) return null;
  return (candles[candles.length - 1].close - lo) / (hi - lo);
}

// ── State detection (the "what just happened" layer) ────────────────────────
// Uses only completed prior bars for the pivot so the current bar's own high
// can't define the level it is supposed to break.
function detectState(candles) {
  const n = candles.length;
  const last = candles[n - 1];
  const priorHigh20 = Math.max(...candles.slice(-21, -1).map(c => c.high));
  const priorLow20  = Math.min(...candles.slice(-21, -1).map(c => c.low));
  const closes = candles.map(c => c.close);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);

  // Fresh 20/50 cross within the lookback window (a transition, not a static level).
  let bullCross = false, bearCross = false;
  for (let k = Math.max(50, n - TRANSITION_LOOKBACK); k < n; k++) {
    const a = sma(closes, 20, k), b = sma(closes, 50, k);
    const pa = sma(closes, 20, k - 1), pb = sma(closes, 50, k - 1);
    if (a != null && b != null && pa != null && pb != null) {
      if (pa <= pb && a > b) bullCross = true;
      if (pa >= pb && a < b) bearCross = true;
    }
  }
  // Recent reclaim of / breakdown through the 50-DMA.
  let reclaim50 = false, lose50 = false;
  if (sma50 != null) {
    for (let k = Math.max(50, n - TRANSITION_LOOKBACK); k < n; k++) {
      const s = sma(closes, 50, k);
      if (s == null) continue;
      if (closes[k - 1] <= s && closes[k] > s) reclaim50 = true;
      if (closes[k - 1] >= s && closes[k] < s) lose50 = true;
    }
  }
  const breakout  = last.close > priorHigh20;
  const breakdown = last.close < priorLow20;
  // Failed breakout: poked above the 20-day pivot in the last 4 sessions but the
  // latest close is back below it. Symmetric for a failed breakdown.
  let failedBreakout = false, failedBreakdown = false;
  const recent = candles.slice(-5, -1);
  if (recent.some(c => c.high > priorHigh20) && last.close < priorHigh20) failedBreakout = true;
  if (recent.some(c => c.low < priorLow20) && last.close > priorLow20) failedBreakdown = true;
  // First pullback: above a rising 20-DMA, off the highs, not breaking down.
  const firstPullback = sma20 != null && last.close > sma20 &&
    (rangePos(candles, 20) ?? 1) < 0.6 && !breakdown;

  return {
    breakout, breakdown, failedBreakout, failedBreakdown, firstPullback,
    bullCross, bearCross, reclaim50, lose50,
    priorHigh20: round(priorHigh20), priorLow20: round(priorLow20),
  };
}

// ── Feature families ────────────────────────────────────────────────────────
// Each family returns { signals: {k:signed}, notes:{pos:[],neg:[]}, facts:{} }.
function trendFamily(candles, state) {
  const closes = candles.map(c => c.close);
  const px = closes[closes.length - 1];
  const s10 = sma(closes, 10), s20 = sma(closes, 20), s50 = sma(closes, 50);
  const signals = {}, pos = [], neg = [], facts = {};

  if (s10 != null && s20 != null && s50 != null) {
    if (px > s10 && s10 > s20 && s20 > s50) { signals.stack = 1; pos.push('Price above a rising 10>20>50-day stack'); }
    else if (px < s10 && s10 < s20 && s20 < s50) { signals.stack = -1; neg.push('Price below a falling 10<20<50-day stack'); }
    else signals.stack = 0;
  }
  if (s50 != null) { signals.px50 = px > s50 ? 1 : -1; (px > s50 ? pos : neg).push(px > s50 ? 'Holding above the 50-day' : 'Trading below the 50-day'); }
  if (s20 != null && s50 != null) signals.ma2050 = s20 > s50 ? 1 : -1;

  // Slopes (over ~10 sessions) and acceleration of the 20-day.
  const s20prev = sma(closes, 20, closes.length - 11);
  const s20prev2 = sma(closes, 20, closes.length - 21);
  if (s20 != null && s20prev != null) {
    const slope = (s20 - s20prev) / s20prev * 100;
    facts.sma20SlopePct = round(slope, 1);
    signals.slope20 = slope > 0.5 ? 1 : slope < -0.5 ? -1 : 0;
    if (signals.slope20 > 0) pos.push('20-day trend rising'); else if (signals.slope20 < 0) neg.push('20-day trend rolling over');
    if (s20prev2 != null) {
      const prevSlope = (s20prev - s20prev2) / s20prev2 * 100;
      signals.accel20 = slope > prevSlope + 0.2 ? 1 : slope < prevSlope - 0.2 ? -1 : 0;
    }
  }
  const s50prev = sma(closes, 50, closes.length - 11);
  if (s50 != null && s50prev != null) {
    const slope = (s50 - s50prev) / s50prev * 100;
    facts.sma50SlopePct = round(slope, 1);
    signals.slope50 = slope > 0.3 ? 1 : slope < -0.3 ? -1 : 0;
  }
  // State transitions carry extra weight — they're the "next 10–63 sessions" signal.
  if (state.bullCross || state.reclaim50) { signals.transition = 1; pos.push(state.bullCross ? 'Fresh 20/50-day bullish cross' : 'Recent reclaim of the 50-day'); }
  else if (state.bearCross || state.lose50) { signals.transition = -1; neg.push(state.bearCross ? 'Fresh 20/50-day bearish cross' : 'Recently lost the 50-day'); }
  // Range position (63-session).
  const rp = rangePos(candles, 63);
  if (rp != null) { facts.rangePos63 = round(rp, 2); signals.range63 = rp > 0.6 ? 1 : rp < 0.4 ? -1 : 0; }

  return { signals, pos, neg, facts };
}

function rsFamily(aligned, sectorAligned) {
  const signals = {}, pos = [], neg = [], facts = {};
  const ex21 = excessPct(aligned, 21), ex63 = excessPct(aligned, 63), ex42 = excessPct(aligned, 42);
  if (ex63 != null) {
    facts.excess63Pct = round(ex63, 1);
    signals.rs63 = ex63 > RS_DEADBAND ? 1 : ex63 < -RS_DEADBAND ? -1 : 0;
    if (signals.rs63 > 0) pos.push(`Outperforming the market over ~3mo (+${ex63.toFixed(0)}pts)`);
    else if (signals.rs63 < 0) neg.push(`Lagging the market over ~3mo (${ex63.toFixed(0)}pts)`);
  }
  if (ex21 != null) {
    facts.excess21Pct = round(ex21, 1);
    signals.rs21 = ex21 > RS_DEADBAND ? 1 : ex21 < -RS_DEADBAND ? -1 : 0;
  }
  // RS acceleration: is the shorter-window excess improving on the longer window?
  if (ex21 != null && ex63 != null) {
    const accel = ex21 - ex63 / 3; // 63-session excess normalized to a 21-session pace
    signals.rsAccel = accel > 1 ? 1 : accel < -1 ? -1 : 0;
    if (signals.rsAccel > 0) pos.push('Relative strength improving'); else if (signals.rsAccel < 0) neg.push('Relative strength deteriorating');
  }
  if (sectorAligned) {
    const sx = excessPct(sectorAligned, 63);
    if (sx != null) { facts.sectorExcess63Pct = round(sx, 1); signals.rsSector = sx > RS_DEADBAND ? 1 : sx < -RS_DEADBAND ? -1 : 0; }
  }
  return { signals, pos, neg, facts, ex21, ex63, ex42 };
}

function participationFamily(candles) {
  const signals = {}, pos = [], neg = [], facts = {};
  const n = candles.length;
  // Use the prior COMPLETED 20 sessions (exclude the current, possibly-forming bar)
  // as the volume baseline so an incomplete daily bar can't fake a volume verdict.
  const prior20 = candles.slice(-21, -1);
  const baseVol = mean(prior20.map(c => c.volume || 0));
  let up = 0, down = 0;
  for (const c of prior20) { if (c.close >= c.open) up += c.volume || 0; else down += c.volume || 0; }
  if (up + down > 0) {
    const ratio = up / (down || 1);
    facts.upDownVol = round(ratio, 2);
    signals.upvol = ratio > 1.15 ? 1 : ratio < 0.85 ? -1 : 0;
    if (signals.upvol > 0) pos.push('Up-volume dominates the last month'); else if (signals.upvol < 0) neg.push('Down-volume dominates the last month');
  }
  // Breakout/breakdown confirmation on the latest completed bar's volume.
  const last = candles[n - 1];
  if (baseVol > 0 && last.volume) {
    const rvol = last.volume / baseVol;
    facts.rvol = round(rvol, 2);
    // Only a directional confirmation, not a standalone signal.
    if (rvol > 1.5 && last.close > last.open) { signals.breakoutVol = 1; pos.push('Above-average volume on an up day'); }
    else if (rvol > 1.5 && last.close < last.open) { signals.breakoutVol = -1; neg.push('Above-average volume on a down day'); }
    else signals.breakoutVol = 0;
  }
  // Volatility contraction → controlled expansion (a coil releasing the right way).
  const aNow = atr(candles.slice(-40), 14);
  const aPrev = atr(candles.slice(-60, -20), 14);
  if (aNow != null && aPrev != null && aPrev > 0) {
    const contracted = aPrev / mean(candles.slice(-60, -20).map(c => c.close)) < 0.03; // was quiet
    facts.atrNowPrev = round(aNow / aPrev, 2);
    if (contracted && aNow > aPrev && last.close >= last.open) { signals.coil = 1; pos.push('Volatility expanding out of a quiet base'); }
  }
  return { signals, pos, neg, facts, baseVol };
}

// Family composite: average the present signed signals, then blend by family weight.
function familyComposite(fams) {
  let num = 0, den = 0;
  for (const [name, w] of Object.entries(FAMILY_WEIGHTS)) {
    const sigs = Object.values(fams[name].signals).filter(v => v != null);
    if (!sigs.length) continue;
    num += w * mean(sigs); den += w;
  }
  return den > 0 ? num / den : 0;
}

// ── Risk / entry-quality layer (gates + warnings, not score inflation) ──────
function riskLayer(candles, state) {
  const closes = candles.map(c => c.close);
  const px = closes[closes.length - 1];
  const s20 = sma(closes, 20);
  const a = atr(candles, 14);
  const risks = [];
  const facts = {};

  let extensionATR = null;
  if (s20 != null && a && a > 0) {
    extensionATR = (px - s20) / a;
    facts.extensionATR = round(extensionATR, 1);
    if (extensionATR > EXT_SEVERE_ATR) risks.push(`Stretched ${extensionATR.toFixed(1)} ATR above the 20-day — chasing risk`);
    else if (extensionATR > EXT_HIGH_ATR) risks.push(`Extended ${extensionATR.toFixed(1)} ATR above the 20-day`);
  }
  facts.atr = round(a, 2);
  facts.atrPct = a && px ? round(a / px * 100, 1) : null;

  // Median dollar-volume over the prior completed 20 sessions.
  const prior20 = candles.slice(-21, -1);
  const dv = prior20.map(c => (c.close || 0) * (c.volume || 0)).sort((x, y) => x - y);
  const medDollarVol = dv.length ? dv[Math.floor(dv.length / 2)] : 0;
  facts.medDollarVol = Math.round(medDollarVol);
  if (medDollarVol < LIQ_VETO_USD) risks.push('Very thin liquidity — hard to execute a swing');
  else if (medDollarVol < LIQ_WARN_USD) risks.push('Below-average liquidity');
  if (px < LOW_PRICE) risks.push(`Sub-$${LOW_PRICE} price — wider spreads and gap risk`);

  // Recent gap risk (any >6% overnight gap in the last 5 sessions).
  const gaps = candles.slice(-5).map((c, i, arr) => i === 0 ? 0 : Math.abs(c.open - arr[i - 1].close) / arr[i - 1].close);
  const maxGap = Math.max(0, ...gaps);
  facts.maxRecentGapPct = round(maxGap * 100, 1);
  if (maxGap > 0.06) risks.push(`Recent ${(maxGap * 100).toFixed(0)}% gap — elevated volatility`);
  if (state.failedBreakout) risks.push('Failed breakout in the last few sessions — rejection risk');

  return {
    risks, facts,
    extensionATR,
    severeExtension: extensionATR != null && extensionATR > EXT_SEVERE_ATR,
    liquidityVeto: medDollarVol < LIQ_VETO_USD,
    thinLiquidity: medDollarVol < LIQ_WARN_USD,
    atr: a,
  };
}

// ── Swing trade plan (daily-bar geometry; NEVER intraday ATR) ───────────────
// Long:    objective > trigger > invalidation
// Bearish: invalidation > trigger > objective
function buildPlan(action, candles, state, risk) {
  const a = risk.atr;
  if (!a || a <= 0) return null;
  const closes = candles.map(c => c.close);
  const px = closes[closes.length - 1];
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const swingLow = Math.min(...candles.slice(-10).map(c => c.low));
  const swingHigh = Math.max(...candles.slice(-10).map(c => c.high));

  if (action === 'BUY') {
    let setupType, trigger;
    if (state.breakout) { setupType = 'breakout-hold'; trigger = round(Math.max(px, state.priorHigh20)); }
    else if (state.firstPullback || state.reclaim50) { setupType = 'pullback-reclaim'; trigger = round(Math.max(px, swingHigh)); }
    else { setupType = 'trend-continuation'; trigger = round(Math.max(px, state.priorHigh20)); }
    // Invalidation below structure (swing low or 50-DMA), padded by 1 ATR.
    const structure = s50 != null ? Math.min(swingLow, s50) : swingLow;
    let invalidation = round(Math.min(structure - 0.25 * a, trigger - 1.5 * a));
    let objective = round(trigger + 3 * a);
    if (!(objective > trigger && trigger > invalidation)) return null;
    return {
      side: 'long', setupType, trigger, invalidation, objective,
      window: HORIZON_LABEL,
      expiry: `Setup void if the trigger ($${trigger}) is not reclaimed within ~15 sessions`,
      note: 'Objective is a risk-management reference (≈3 ATR), not a forecast.',
    };
  }
  if (action === 'SELL') {
    const setupType = state.breakdown ? 'breakdown' : state.failedBreakout ? 'failed-breakout' : 'trend-breakdown';
    const trigger = round(Math.min(px, state.priorLow20));
    const structure = s50 != null ? Math.max(swingHigh, s50) : swingHigh;
    const invalidation = round(Math.max(structure + 0.25 * a, trigger + 1.5 * a));
    const objective = round(trigger - 3 * a);
    if (!(invalidation > trigger && trigger > objective)) return null;
    return {
      side: 'bearish', setupType, trigger, invalidation, objective,
      window: HORIZON_LABEL,
      expiry: `Setup void if price reclaims $${invalidation} first`,
      note: 'Bearish setup = exit/avoid (or short candidate). Objective is a reference, not a forecast.',
    };
  }
  return null;
}

// ── Public entry point ───────────────────────────────────────────────────────
/**
 * @param {Array} dailyCandles split-adjusted daily bars {date,open,high,low,close,volume}
 * @param {Array|null} spyCandles benchmark daily bars (same shape) or null
 * @param {Object} [opts] { sectorCandles, asOf, lastBarIncomplete }
 * @returns {Object} swing horizon read (see module header for the contract)
 */
function swingRead(dailyCandles, spyCandles, opts = {}) {
  const base = {
    version: VERSION, horizon: HORIZON_LABEL, calibrated: false,
    dataAsOf: null, available: false,
  };
  if (!Array.isArray(dailyCandles) || dailyCandles.length === 0) {
    return { ...base, action: 'UNAVAILABLE', evidenceStrength: 0, signedScore: 0,
      reasons: ['Daily price feed unavailable.'], counter: [], risks: [], factors: {}, plan: null };
  }
  const dataAsOf = opts.asOf || dailyCandles[dailyCandles.length - 1].date;
  if (dailyCandles.length < MIN_BARS) {
    return { ...base, available: true, dataAsOf, action: 'WAIT', insufficient: true,
      evidenceStrength: 0, signedScore: 0,
      reasons: [`Only ${dailyCandles.length} daily bars — not enough history for a swing read.`],
      counter: [], risks: ['Insufficient history'], factors: { bars: dailyCandles.length }, plan: null };
  }

  const closes = dailyCandles.map(c => c.close);
  const px = closes[closes.length - 1];
  const aligned = alignByDate(dailyCandles, spyCandles);
  const sectorAligned = opts.sectorCandles ? alignByDate(dailyCandles, opts.sectorCandles) : null;

  const state = detectState(dailyCandles);
  const trend = trendFamily(dailyCandles, state);
  const rs = rsFamily(aligned, sectorAligned);
  const part = participationFamily(dailyCandles);
  const risk = riskLayer(dailyCandles, state);

  const fams = { trend, rs, participation: part };
  const signedScore = familyComposite(fams);

  // Directional gates.
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const trendUp = s50 != null && px > s50 && (s20 == null || s20 >= s50);
  const trendDown = s50 != null && px < s50 && (s20 == null || s20 <= s50);
  const bullTransition = state.bullCross || state.reclaim50;
  const rsPositive = rs.ex63 != null ? rs.ex63 >= -RS_DEADBAND && (rs.ex21 == null || rs.ex21 >= -RS_DEADBAND) : trendUp;
  const rsNegative = (rs.ex63 != null && rs.ex63 < -RS_DEADBAND) && (rs.ex21 == null || rs.ex21 < 0);

  const pos = [...trend.pos, ...rs.pos, ...part.pos];
  const neg = [...trend.neg, ...rs.neg, ...part.neg];

  // Deterioration evidence must be MORE than one red bar: count independent damages.
  const damages = [trendDown, state.breakdown, rsNegative, (trend.signals.slope50 === -1), state.lose50 || state.bearCross]
    .filter(Boolean).length;

  let action, setup;
  if (signedScore >= BUY_THRESH && (trendUp || bullTransition) && rsPositive && !risk.liquidityVeto) {
    if (risk.severeExtension) { action = 'WAIT'; setup = 'wait-pullback'; }
    else { action = 'BUY'; setup = state.breakout ? 'breakout' : bullTransition ? 'reclaim' : 'trend-continuation'; }
  } else if (signedScore <= SELL_THRESH && (trendDown || state.breakdown || rsNegative) && damages >= 2) {
    action = 'SELL'; setup = state.breakdown ? 'breakdown' : state.failedBreakout ? 'failed-breakout' : 'trend-breakdown';
  } else {
    action = 'WAIT';
    setup = risk.severeExtension ? 'wait-pullback'
      : (state.failedBreakout || state.failedBreakdown) ? 'failed-attempt'
      : Math.abs(signedScore) < 0.1 ? 'range' : 'no-trigger';
  }
  // Liquidity veto downgrades a would-be SELL to an avoid-style WAIT too.
  if (risk.liquidityVeto && action === 'SELL') { action = 'WAIT'; setup = 'illiquid-avoid'; }

  const plan = buildPlan(action, dailyCandles, state, risk);
  // A BUY/SELL with no geometrically-valid plan is not actionable → WAIT.
  if ((action === 'BUY' || action === 'SELL') && !plan) { action = 'WAIT'; setup = 'no-structure'; }

  // evidenceStrength: signed magnitude, boosted when families agree, capped 0–10.
  const famSigns = Object.values(fams).map(f => {
    const s = Object.values(f.signals).filter(v => v != null);
    return s.length ? Math.sign(mean(s)) : 0;
  });
  const agree = famSigns.filter(s => s !== 0 && s === Math.sign(signedScore)).length;
  const evidenceStrength = Math.max(0, Math.min(10, Math.round(Math.abs(signedScore) * 10 + agree)));

  const dominant = signedScore >= 0 ? pos : neg;
  const opposing = signedScore >= 0 ? neg : pos;

  return {
    ...base,
    available: true,
    dataAsOf,
    action,
    setup,
    evidenceStrength,
    signedScore: round(signedScore, 3),
    reasons: dominant.slice(0, 4),
    counter: opposing.slice(0, 3),
    risks: risk.risks.slice(0, 4),
    factors: {
      price: round(px), ...trend.facts, ...rs.facts, ...part.facts, ...risk.facts,
      state: Object.keys(state).filter(k => state[k] === true),
    },
    families: {
      trend: round(mean(Object.values(trend.signals).filter(v => v != null)) || 0, 2),
      relativeStrength: aligned ? round(mean(Object.values(rs.signals).filter(v => v != null)) || 0, 2) : null,
      participation: round(mean(Object.values(part.signals).filter(v => v != null)) || 0, 2),
    },
    benchmarkAvailable: !!aligned,
    sectorAvailable: !!sectorAligned,
    plan,
  };
}

module.exports = {
  swingRead, VERSION, HORIZON_LABEL,
  // exported for tests / reuse
  alignByDate, excessPct, detectState, atr, sma, rangePos, buildPlan,
  MIN_BARS, BUY_THRESH, SELL_THRESH,
};
