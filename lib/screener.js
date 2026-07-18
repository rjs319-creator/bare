// Breakout / accumulation screener engine — operates on DAILY history.
// Detects names that are (1) emerging from a tight accumulation base,
// (2) breaking key resistance, (3) on unusual volume, and (5) still early
// in the move (not extended). Criterion (4) strong fundamentals/narrative is
// layered on in api/screener.js via the LLM.
const { calcRSI, calcATR } = require('./signal');
const { SECTOR_OF, exchangeName } = require('./universe');
const { tradeLevels } = require('./levels');
const { logWarn } = require('./log');
const { fetchWithTimeout, classifyStatus, classifyError } = require('./http');

function smaAt(arr, period, idx) {
  if (idx + 1 < period) return null;
  let s = 0;
  for (let k = idx - period + 1; k <= idx; k++) s += arr[k];
  return s / period;
}

// RS line = price / benchmark. Returns a boolean[] of "RS line at a new
// `win`-day high" (Minervini: RS line in new high ground leads price).
function rsHighArray(closes, dates, spyByDate, win = 40) {
  const n = closes.length, out = new Array(n).fill(false);
  const rs = closes.map((c, k) => { const sp = spyByDate[dates[k]]; return sp > 0 ? c / sp : null; });
  for (let i = win; i < n; i++) {
    if (rs[i] == null) continue;
    let mx = -Infinity, ok = true;
    for (let k = i - win; k <= i; k++) { if (rs[k] == null) { ok = false; break; } if (rs[k] > mx) mx = rs[k]; }
    if (ok) out[i] = rs[i] >= mx * 0.999;
  }
  return out;
}

// Parse Yahoo's corporate-action events into sorted, typed arrays. Yahoo's `quote` OHLC is
// already SPLIT-adjusted, so these are metadata (for validation + total-return), not a signal
// that the price series needs re-adjusting.
function parseCorporateActions(events) {
  const iso = (u) => new Date(u * 1000).toISOString().slice(0, 10);
  const splits = [], dividends = [];
  const sp = events && events.splits;
  if (sp) for (const k in sp) { const s = sp[k]; if (s && s.date) splits.push({ date: iso(s.date), numerator: s.numerator, denominator: s.denominator, ratio: (s.numerator && s.denominator) ? s.numerator / s.denominator : null, label: s.splitRatio || null }); }
  const dv = events && events.dividends;
  if (dv) for (const k in dv) { const d = dv[k]; if (d && d.date != null) dividends.push({ date: iso(d.date), amount: d.amount }); }
  splits.sort((a, b) => a.date < b.date ? -1 : 1);
  dividends.sort((a, b) => a.date < b.date ? -1 : 1);
  return { splits, dividends };
}

async function fetchDailyHistory(ticker, range = '1y') {
  const sym = ticker.toUpperCase();
  const path = `/v8/finance/chart/${sym}?range=${range}&interval=1d&events=div,splits`;
  let lastCategory = 'empty';   // why the last host attempt didn't yield data
  // No retry here on purpose: this runs behind a ~515-wide pool, so a retry storm
  // would hammer Yahoo. The timeout is the fix — a hung socket can't stall the scan.
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetchWithTimeout(`https://${host}${path}`, {
        timeoutMs: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
      });
      if (!r.ok) { lastCategory = classifyStatus(r); continue; }
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (!result) continue;
      const ts = result.timestamp || [];
      const q  = result.indicators?.quote?.[0] || {};
      const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
      const meta = result.meta || {};
      const candles = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
        if (o == null || h == null || l == null || c == null || c <= 0) continue;
        const ac = adj[i];
        // Raw OHLCV is Yahoo's already-split-adjusted quote (unchanged, the execution truth).
        // adjClose adds the dividend leg for optional total-return; null when not supplied.
        candles.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), open: o, high: h, low: l, close: c, volume: v || 0, adjClose: (ac != null && ac > 0) ? +ac : null });
      }
      if (candles.length < 60) continue;
      return {
        candles, meta,
        corporateActions: parseCorporateActions(result.events),
        priceBasis: 'split-adjusted',                              // Yahoo quote is split-adjusted, not dividend-adjusted
        adjustment: adj.length ? 'yahoo-adjclose' : 'unknown',     // never fabricated — 'unknown' when the provider omits it
      };
    } catch (e) { lastCategory = classifyError(e); /* try next host */ }
  }
  // Log WHY it failed (timeout / rate_limited / auth / empty) so a provider outage
  // is distinguishable from a genuinely dataless ticker in the logs.
  logWarn('screener.fetchDailyHistory', 'no daily data', { ticker: sym, range, category: lastCategory });
  return null;
}

// Replay the FULL (elite) screen "as of" bar i — used by rotation history and
// the strategy backtest. Returns the tier (Breakout / Setup / Early). `obv` is
// the precomputed On-Balance-Volume array for the whole series.
function evalSetupAt(closes, highs, lows, vols, obv, rsiArr, i, o = {}) {
  if (i < 55) return { status: null, include: false, qualifies: false };
  const baseMax = o.baseMax ?? 0.35, setupBelow = o.setupBelow ?? 0.06, earlyAbove = o.earlyAbove ?? 0.10,
        moveMax = o.moveMax ?? 0.50, setupHighGate = o.setupHighGate ?? 0.25, setupMaGate = o.setupMaGate ?? 0.95;
  const price = closes[i];
  const sma50 = smaAt(closes, 50, i);
  const sma200 = smaAt(closes, 200, i);
  const avgVol50 = smaAt(vols, 50, i) || 1;
  const win = Math.min(252, i + 1); let hi52 = -Infinity, lo52 = Infinity;
  for (let k = i - win + 1; k <= i; k++) { if (highs[k] > hi52) hi52 = highs[k]; if (lows[k] < lo52) lo52 = lows[k]; }
  const be = Math.max(1, i - 3), bs = Math.max(0, be - 45);
  let pivotHigh = -Infinity, baseLow = Infinity;
  for (let k = bs; k <= be; k++) { if (highs[k] > pivotHigh) pivotHigh = highs[k]; if (lows[k] < baseLow) baseLow = lows[k]; }
  let upVol = 0, downVol = 0;
  for (let k = bs + 1; k <= be; k++) { if (closes[k] >= closes[k - 1]) upVol += vols[k]; else downVol += vols[k]; }
  const accumRatio = downVol > 0 ? upVol / downVol : (upVol > 0 ? 3 : 1);
  const TW = 20, ts0 = Math.max(0, be - TW + 1); let tHigh = -Infinity, tLow = Infinity;
  for (let k = ts0; k <= be; k++) { if (highs[k] > tHigh) tHigh = highs[k]; if (lows[k] < tLow) tLow = lows[k]; }
  const tightPct = tLow > 0 ? (tHigh - tLow) / tLow : 1;
  const broke = price > pivotHigh;
  let bIdx = -1; for (let k = be + 1; k <= i; k++) { if (closes[k] > pivotHigh) { bIdx = k; break; } }
  const barsSince = bIdx >= 0 ? i - bIdx : 99;
  const pctAbovePivot = (price - pivotHigh) / pivotHigh;
  const recentVol = Math.max(vols[i], vols[i - 1] || 0, bIdx >= 0 ? vols[bIdx] : 0);
  const volSurge = avgVol50 ? recentVol / avgVol50 : 1;
  const extAboveSma50 = sma50 ? (price - sma50) / sma50 : 0;
  const moveFromBaseLow = (price - baseLow) / baseLow;
  const pctFrom52wHigh = (hi52 - price) / hi52;
  const pctBelowPivot = (pivotHigh - price) / pivotHigh;
  const rsi = rsiArr[i];

  const obvBaseRising = obv[be] > obv[bs];
  let up50 = 0, dn50 = 0;
  for (let k = Math.max(1, i - 49); k <= i; k++) { if (closes[k] > closes[k - 1]) up50 += vols[k]; else if (closes[k] < closes[k - 1]) dn50 += vols[k]; }
  const udVol = dn50 > 0 ? up50 / dn50 : (up50 > 0 ? 3 : 1);
  let pocketPivot = false;
  for (let k = i; k >= Math.max(11, i - 10); k--) {
    if (closes[k] <= closes[k - 1]) continue;
    let mdv = 0; for (let j = k - 10; j < k; j++) if (j >= 1 && closes[j] < closes[j - 1]) mdv = Math.max(mdv, vols[j]);
    const s10 = smaAt(closes, 10, k);
    if (mdv > 0 && vols[k] > mdv && s10 && closes[k] >= s10 * 0.95) { pocketPivot = true; break; }
  }
  let rv = 0, rc = 0; for (let k = Math.max(0, i - 4); k <= i; k++) { rv += vols[k]; rc++; }
  const vdu = avgVol50 ? (rv / rc) / avgVol50 : 1;
  const volDryUp = vdu <= 0.7;
  const segLen = Math.max(4, Math.floor((be - bs) / 3));
  const segRange = (a, b) => { let h = -Infinity, l = Infinity; for (let k = a; k <= b; k++) { if (highs[k] > h) h = highs[k]; if (lows[k] < l) l = lows[k]; } return l > 0 ? (h - l) / l : 1; };
  const segVol = (a, b) => { let s = 0, c = 0; for (let k = a; k <= b; k++) { s += vols[k]; c++; } return c ? s / c : 0; };
  const r1 = segRange(bs, bs + segLen), r2 = segRange(bs + segLen, bs + 2 * segLen), r3 = segRange(bs + 2 * segLen, be);
  let contractions = 0; if (r2 < r1 * 0.92) contractions++; if (r3 < r2 * 0.92) contractions++;
  const volContract = segVol(bs + 2 * segLen, be) < segVol(bs, bs + segLen) * 0.95;
  const isVCP = contractions >= 1 && (volContract || volDryUp) && r3 <= baseMax * 1.3;
  const accumSignals = (obvBaseRising ? 1 : 0) + (udVol >= 1.1 ? 1 : 0) + (pocketPivot ? 1 : 0) + (accumRatio >= 1.1 ? 1 : 0);

  const c_acc = tightPct <= baseMax && accumRatio >= 1.0 && (accumSignals >= 1 || isVCP);
  const c_res = broke && barsSince <= 6;
  const c_vol = volSurge >= 1.5;
  const c_early = broke && pctAbovePivot <= earlyAbove && (rsi == null || rsi < 72) && extAboveSma50 <= 0.30 && moveFromBaseLow <= moveMax;
  const c_setup = !broke && pctBelowPivot <= setupBelow && c_acc && (sma50 != null && price >= sma50 * setupMaGate) && (rsi == null || (rsi >= 45 && rsi <= 72)) && pctFrom52wHigh <= setupHighGate;
  const breakout = c_res && c_early && (c_vol || c_acc);
  const earlyAccum = !broke && isVCP && (obvBaseRising || pocketPivot) && (volDryUp || volContract) &&
                     (sma50 != null && price >= sma50 * 0.92) && pctFrom52wHigh <= Math.max(0.30, setupHighGate) &&
                     (rsi == null || (rsi >= 40 && rsi <= 70)) && pctBelowPivot <= Math.max(0.18, setupBelow + 0.06);
  const status = breakout ? 'Breakout' : (c_setup ? 'Setup' : (earlyAccum ? 'Early' : null));
  const longBase = Math.round((be - bs) / 5) >= 7;
  const rsHigh = !!(o.rsHighArr && o.rsHighArr[i]);
  return {
    status, include: !!status, qualifies: breakout,
    feat: status ? { vcp: isVCP, pocketPivot, obvRising: obvBaseRising, volDryUp, udStrong: udVol >= 1.3, contractions, trendUp: sma200 != null && price > sma200, longBase, rsHigh } : null,
  };
}

// Emerging-Leader signal — early momentum-emergence detector. Pure so it can be
// unit-tested in isolation. Fires at the START of a confirmed-strength leg using
// only the factors this project validated (RS, short-term momentum, accumulation);
// the "not extended" gate (≤15% above the 50-DMA) keeps it EARLY, not chasing.
// All inputs may be null (treated as "unknown" → fails). See the call site in
// screenTicker for the full rationale + the RKLB/FCEL historical grounding.
function emergingLeaderSignal({ aboveSmas, rsVsSpy63, mom21, accumRatio, extAbove50, rsi }) {
  return !!aboveSmas
    && rsVsSpy63 != null && rsVsSpy63 > 0
    && mom21 != null && mom21 > 0
    && accumRatio != null && accumRatio >= 1.3
    && extAbove50 != null && extAbove50 <= 0.15
    && (rsi == null || rsi < 75);
}

// Score one ticker. Returns null if not enough data.
// opts let small/micro caps use looser, volatility-appropriate thresholds.
// opts.history = [dayOffsets] adds a replayed include/qualify series for rotation.
function screenTicker(candles, meta = {}, opts = {}) {
  const baseMax       = opts.baseMax ?? 0.35;   // max coil range to count as accumulation
  const setupBelow    = opts.setupBelow ?? 0.06; // how far under pivot still "coiling"
  const earlyAbove    = opts.earlyAbove ?? 0.10; // max % above pivot to still be "early"
  const moveMax       = opts.moveMax ?? 0.50;    // max run off base low to still be early
  const setupHighGate = opts.setupHighGate ?? 0.25; // max % off 52wk high for a setup
  const setupMaGate   = opts.setupMaGate ?? 0.95;   // min price vs 50-day MA for a setup

  const n = candles.length;
  if (n < 60) return null;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const vols   = candles.map(c => c.volume);
  const last   = n - 1;
  const price  = closes[last];

  const rsiArr = calcRSI(closes, 14);
  const rsi = rsiArr[last];
  const atr = calcATR(candles, 14)[last];

  const sma50  = smaAt(closes, 50, last);
  const sma150 = smaAt(closes, 150, last);
  const sma200 = smaAt(closes, 200, last);
  const sma50prior = smaAt(closes, 50, Math.max(0, last - 10));
  const avgVol50 = smaAt(vols, 50, last) || (vols.slice(-Math.min(50, n)).reduce((a, b) => a + b, 0) / Math.min(50, n));

  // 52-week range
  const win = Math.min(252, n);
  const hi52 = Math.max(...highs.slice(n - win));
  const lo52 = Math.min(...lows.slice(n - win));

  // Base window (consolidation before the recent breakout)
  const RB = 3, LB = 45;
  const be = Math.max(1, last - RB);
  const bs = Math.max(0, be - LB);
  let pivotHigh = -Infinity, baseLow = Infinity;
  for (let k = bs; k <= be; k++) { pivotHigh = Math.max(pivotHigh, highs[k]); baseLow = Math.min(baseLow, lows[k]); }
  const baseRangePct = (pivotHigh - baseLow) / baseLow;

  // Accumulation: up-volume vs down-volume across the base
  let upVol = 0, downVol = 0;
  for (let k = bs + 1; k <= be; k++) {
    if (closes[k] >= closes[k - 1]) upVol += vols[k]; else downVol += vols[k];
  }
  const accumRatio = downVol > 0 ? upVol / downVol : (upVol > 0 ? 3 : 1);

  // Tightness = volatility contraction over the recent ~4wk coil before any
  // breakout pop (the essence of accumulation; robust for volatile names).
  const TW = 20, ts0 = Math.max(0, be - TW + 1);
  let tHigh = -Infinity, tLow = Infinity;
  for (let k = ts0; k <= be; k++) { tHigh = Math.max(tHigh, highs[k]); tLow = Math.min(tLow, lows[k]); }
  const tightPct = tLow > 0 ? (tHigh - tLow) / tLow : 1;

  // Breakout detection + recency
  const broke = price > pivotHigh;
  let breakoutIdx = -1;
  for (let k = be + 1; k <= last; k++) { if (closes[k] > pivotHigh) { breakoutIdx = k; break; } }
  const barsSinceBreakout = breakoutIdx >= 0 ? last - breakoutIdx : 99;
  const pctAbovePivot = (price - pivotHigh) / pivotHigh;

  // Volume surge around the breakout
  const recentVol = Math.max(vols[last], vols[last - 1] || 0, breakoutIdx >= 0 ? vols[breakoutIdx] : 0);
  const volSurge = avgVol50 ? recentVol / avgVol50 : 1;

  // Extension / "early in the move" measures
  const extAboveSma50 = sma50 ? (price - sma50) / sma50 : 0;
  const moveFromBaseLow = (price - baseLow) / baseLow;
  const pctFrom52wHigh = (hi52 - price) / hi52;
  const pctFrom52wLow = (price - lo52) / lo52;

  // ── Elite-trader accumulation / volatility-contraction signals ──
  // OBV (Granville/Wyckoff): OBV rising through a flat base = quiet accumulation.
  const obv = new Array(n).fill(0);
  for (let k = 1; k < n; k++) obv[k] = obv[k - 1] + (closes[k] > closes[k - 1] ? vols[k] : closes[k] < closes[k - 1] ? -vols[k] : 0);
  const obvBaseRising = obv[be] > obv[bs];

  // O'Neil up/down volume ratio (50d): >1 accumulation, >1.5 strong.
  let up50 = 0, dn50 = 0;
  for (let k = Math.max(1, n - 50); k < n; k++) { if (closes[k] > closes[k - 1]) up50 += vols[k]; else if (closes[k] < closes[k - 1]) dn50 += vols[k]; }
  const udVol = dn50 > 0 ? up50 / dn50 : (up50 > 0 ? 3 : 1);

  // Pocket pivot (Morales/Kacher): up-day volume > largest down-day volume of
  // the prior 10 days while holding the 10-day MA — an institutional footprint.
  let pocketPivot = false, ppBarsAgo = 99;
  for (let k = n - 1; k >= Math.max(11, n - 10); k--) {
    if (closes[k] <= closes[k - 1]) continue;
    let maxDownVol = 0;
    for (let j = k - 10; j < k; j++) if (j >= 1 && closes[j] < closes[j - 1]) maxDownVol = Math.max(maxDownVol, vols[j]);
    const sma10k = smaAt(closes, 10, k);
    if (maxDownVol > 0 && vols[k] > maxDownVol && sma10k && closes[k] >= sma10k * 0.95) { pocketPivot = true; ppBarsAgo = last - k; break; }
  }

  // Volume dry-up (Minervini VDU): recent volume far below base average = coiled.
  const recentVolAvg = vols.slice(Math.max(0, n - 5)).reduce((a, b) => a + b, 0) / Math.min(5, n);
  const vdu = avgVol50 ? recentVolAvg / avgVol50 : 1;
  const volDryUp = vdu <= 0.7;

  // VCP (Minervini): progressive range + volume contraction across the base.
  const segLen = Math.max(4, Math.floor((be - bs) / 3));
  const segRange = (a, b) => { let hi = -Infinity, lo = Infinity; for (let k = a; k <= b; k++) { hi = Math.max(hi, highs[k]); lo = Math.min(lo, lows[k]); } return lo > 0 ? (hi - lo) / lo : 1; };
  const segVol = (a, b) => { let s = 0, c = 0; for (let k = a; k <= b; k++) { s += vols[k]; c++; } return c ? s / c : 0; };
  const r1 = segRange(bs, bs + segLen), r2 = segRange(bs + segLen, bs + 2 * segLen), r3 = segRange(bs + 2 * segLen, be);
  let contractions = 0; if (r2 < r1 * 0.92) contractions++; if (r3 < r2 * 0.92) contractions++;
  const volContract = segVol(bs + 2 * segLen, be) < segVol(bs, bs + segLen) * 0.95;
  const isVCP = contractions >= 1 && (volContract || volDryUp) && r3 <= baseMax * 1.3;

  // How many distinct accumulation footprints are present
  const accumSignals = (obvBaseRising ? 1 : 0) + (udVol >= 1.1 ? 1 : 0) + (pocketPivot ? 1 : 0) + (accumRatio >= 1.1 ? 1 : 0);

  // ── Criteria flags ──
  // Accumulation now requires a real footprint (OBV / U-D / pocket pivot / VCP),
  // not just a tight range — so we catch quiet institutional buying early.
  const c_accumulation = tightPct <= baseMax && accumRatio >= 1.0 && (accumSignals >= 1 || isVCP);
  const c_vcp = isVCP;
  const c_resistance   = broke && barsSinceBreakout <= 6;
  const c_volume       = volSurge >= 1.5;
  const c_early        = broke && pctAbovePivot <= earlyAbove &&
                         (rsi == null || rsi < 72) &&
                         extAboveSma50 <= 0.30 && moveFromBaseLow <= moveMax;
  const c_trend        = (sma50 != null && price > sma50) &&
                         (sma200 == null || (price > sma200 && sma50 > sma200)) &&
                         (sma50prior == null || sma50 >= sma50prior) &&
                         pctFrom52wHigh <= 0.18 && pctFrom52wLow >= 0.25;

  // "Setup" — coiling in tight accumulation just under resistance, not yet
  // broken out (still emerging / early). Surfaces candidates in weak tapes too.
  const pctBelowPivot = (pivotHigh - price) / pivotHigh;
  const c_setup = !broke && pctBelowPivot <= setupBelow && c_accumulation &&
                  (sma50 != null && price >= sma50 * setupMaGate) &&
                  (rsi == null || (rsi >= 45 && rsi <= 72)) &&
                  pctFrom52wHigh <= setupHighGate;

  const breakout = c_resistance && c_early && (c_volume || c_accumulation);

  // "Early" — a confirmed VCP base with accumulation + volume dry-up that is NOT
  // yet near a breakout. This is the earliest, pre-run stage (Minervini/O'Neil).
  const earlyAccum = !broke && isVCP && (obvBaseRising || pocketPivot) && (volDryUp || volContract) &&
                     (sma50 != null && price >= sma50 * 0.92) &&
                     pctFrom52wHigh <= Math.max(0.30, setupHighGate) &&
                     (rsi == null || (rsi >= 40 && rsi <= 70)) &&
                     pctBelowPivot <= Math.max(0.18, setupBelow + 0.06);

  // ── Four required breakout-quality filters (every surfaced name must pass) ──
  // (a) Prior consolidation ≥4 weeks with daily range contracting.
  // Measure the *actual* base length: walk back from the base end while price
  // stays inside a contained band (a real sideways base, not the fixed window).
  let consoStart = be, cHi = highs[be], cLo = lows[be];
  for (let k = be - 1; k >= Math.max(0, be - 120); k--) {
    const nHi = Math.max(cHi, highs[k]), nLo = Math.min(cLo, lows[k]);
    if (nLo <= 0 || (nHi - nLo) / nLo > baseMax) break; // band widened → base started after k
    cHi = nHi; cLo = nLo; consoStart = k;
  }
  const consoWeeks = Math.round((be - consoStart + 1) / 5);
  // "Daily range contracting": average daily (high-low) range in the back half
  // of the base is tighter than the front half.
  const adrOver = (a, b) => { let s = 0, c = 0; for (let k = a; k <= b; k++) if (lows[k] > 0) { s += (highs[k] - lows[k]) / lows[k]; c++; } return c ? s / c : null; };
  const cMid = Math.floor((consoStart + be) / 2);
  const adrEarly = adrOver(consoStart, cMid), adrLate = adrOver(cMid + 1, be);
  const rangeContracting = adrEarly != null && adrLate != null && adrLate < adrEarly * 0.9;
  const f_consolidation = consoWeeks >= 4 && rangeContracting;
  // (b) Breakout volume ≥1.5× the 50-day average (same metric as c_volume).
  const f_volume = volSurge >= 1.5;
  // (c) Relative strength vs SPY positive over the last 3 months (63 sessions).
  const stockRet63 = (last - 63 >= 0 && closes[last - 63] > 0) ? price / closes[last - 63] - 1 : null;
  let spyRet63 = null, rsVsSpy63 = null;
  if (opts.spyByDate && stockRet63 != null) {
    const spyNow = opts.spyByDate[candles[last].date], spyThen = opts.spyByDate[candles[last - 63].date];
    if (spyNow > 0 && spyThen > 0) { spyRet63 = spyNow / spyThen - 1; rsVsSpy63 = stockRet63 - spyRet63; }
  }
  const f_rs = rsVsSpy63 != null && rsVsSpy63 > 0;
  // (d) Price above both the 50- and 200-day SMA.
  const f_aboveSmas = sma50 != null && price > sma50 && sma200 != null && price > sma200;

  const passesAll4 = f_consolidation && f_volume && f_rs && f_aboveSmas;

  // Gating mode (opts.gate). STRICT keeps all four hard filters — the classic
  // breakout-from-a-tight-base on a volume spike. RELAXED (default) drops the two
  // filters this project's own edge research found to be DEAD — volume-surge
  // (rank-IC ≈ −0.004) and base-contraction/VCP — so names surface on the factors
  // that actually carry signal (RS vs SPY + trend). Volume & base still feed the
  // SCORE and cross-sectional percentiles; they're just no longer a binary GATE.
  // This is why a calm, trending, low-volume tape returned zero picks under strict.
  const gate = opts.gate === 'strict' ? 'strict' : 'relaxed';
  const passesGate = gate === 'strict' ? passesAll4 : (f_rs && f_aboveSmas);

  const rawStatus = breakout ? 'Breakout' : (c_setup ? 'Setup' : (earlyAccum ? 'Early' : null));
  const status = passesGate ? rawStatus : null;

  // ── Setup-PATTERN score (out of 80; LLM narrative adds up to 20) ──
  // NB: this grades how textbook the breakout PATTERN looks — it is dominated by
  // factors this project's research found DEAD for forward returns (accumulation
  // tightness, volume-surge, VCP). It is a descriptive setup label, NOT a
  // predictive rank; do not treat it as edge or use it to order selection. The
  // validated selection ranker is the momentum/accumulation `quant` composite
  // (see DEFAULT_WEIGHTS in api/screener.js). Rebuilding this into a predictive
  // score would need a walk-forward backtest first (the project's standing rule).
  let tech = 0;
  if (c_accumulation) tech += 20; else if (tightPct <= baseMax * 1.3 && accumRatio >= 0.9) tech += 10;
  if (c_resistance) tech += 22; else if (broke) tech += 10;
  if (volSurge >= 1.5) tech += 16; else if (volSurge >= 1.2) tech += 8;
  if (c_early) tech += 16; else if (broke && pctAbovePivot <= 0.18) tech += 8;
  if (c_trend) tech += 6; else if (sma50 != null && price > sma50) tech += 3;
  if (isVCP) tech += 8;

  // ── Quant factors (raw; cross-sectional percentiles computed in the API) ──
  const retK = k => (last - k >= 0 && closes[last - k] > 0) ? (price / closes[last - k] - 1) : null;
  const mom21 = retK(21), mom63 = retK(63), mom126 = retK(126);

  // ── Emerging Leader — early-mover detection ────────────────────────────────
  // Goal: flag names at the START of a momentum-emergence leg (RKLB-style), the
  // ONE pre-breakout archetype that is catchable on free EOD data. Grounded in a
  // historical study of RKLB/FCEL: every RKLB +50-106% leg from 2024 launched
  // from CONFIRMED strength (above both MAs, RS+, accumulation), and this exact
  // predicate fired at $5-6 in mid-2024 — before the run to $68. Built ONLY on the
  // factors this project validated (RS, short-term momentum, accumulation); the
  // dead ones (volSurge/base/VCP) are deliberately excluded. The "not extended"
  // gate keeps it EARLY in the leg, not chasing a name that already ran.
  //
  // HONEST LIMIT: this canNOT catch the oversold-bounce / low-float-squeeze
  // archetype (FCEL-style) — those launch from WEAKNESS (below MAs, negative RS),
  // indistinguishable from a falling knife on EOD data. The detector correctly
  // stays silent on them rather than firing noise (FCEL: 0/4 fires preceded a move).
  const extAbove50 = sma50 != null && sma50 > 0 ? price / sma50 - 1 : null;
  const emergingLeader = emergingLeaderSignal({ aboveSmas: f_aboveSmas, rsVsSpy63, mom21, accumRatio, extAbove50, rsi });

  let vol = null;
  {
    const w = Math.min(63, n - 1); const rets = [];
    for (let k = last - w + 1; k <= last; k++) { if (closes[k - 1] > 0) rets.push(closes[k] / closes[k - 1] - 1); }
    if (rets.length > 5) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
      vol = Math.sqrt(varr) * Math.sqrt(252);
    }
  }
  const volAdjMom = (mom63 != null && vol) ? mom63 / vol : null;

  // Minervini-style trend template (fraction of applicable conditions met)
  let tt = 0, ttApp = 0;
  const tAdd = (cond, app = true) => { if (app) { ttApp++; if (cond) tt++; } };
  const sma200prior = smaAt(closes, 200, Math.max(0, last - 20));
  tAdd(price > sma50, sma50 != null);
  tAdd(price > sma150, sma150 != null);
  tAdd(price > sma200, sma200 != null);
  tAdd(sma50 > sma150, sma50 != null && sma150 != null);
  tAdd(sma150 > sma200, sma150 != null && sma200 != null);
  tAdd(sma200 > sma200prior, sma200 != null && sma200prior != null);
  tAdd(pctFrom52wLow >= 0.25, true);
  tAdd(pctFrom52wHigh <= 0.25, true);
  const trendTemplate = ttApp ? tt / ttApp : 0;

  const dollarVol = price * (avgVol50 || 0);
  const proximity = Math.max(0, Math.min(1, 1 - pctFrom52wHigh));
  // Base quality is now an "elite setup" composite: VCP contractions, volume
  // contraction/dry-up, OBV accumulation, up/down volume, pocket pivot.
  let aq = 0;
  aq += Math.min(1, contractions / 2) * 0.28;
  aq += (volContract ? 0.14 : 0);
  aq += (volDryUp ? 0.14 : 0);
  aq += (obvBaseRising ? 0.16 : 0);
  aq += Math.min(1, Math.max(0, (udVol - 0.8) / 0.7)) * 0.16;
  aq += (pocketPivot ? 0.12 : 0);
  const baseQuality = Math.max(0, Math.min(1, aq));

  const reasons = [];
  if (c_accumulation) reasons.push(`Tight 4-wk coil (${(tightPct * 100).toFixed(0)}% range) with accumulation (${accumRatio.toFixed(1)}× up/down vol)`);
  if (c_resistance) reasons.push(`Broke pivot $${pivotHigh.toFixed(2)} ${barsSinceBreakout === 0 ? 'today' : barsSinceBreakout + ' bar(s) ago'}`);
  else if (c_setup) reasons.push(`Coiling ${(pctBelowPivot * 100).toFixed(1)}% under pivot $${pivotHigh.toFixed(2)} — ready to break`);
  if (c_volume) reasons.push(`Volume ${volSurge.toFixed(1)}× the 50-day average`);
  if (isVCP) reasons.push(`VCP: ${contractions + 1} tightening contractions${volContract ? ' on shrinking volume' : ''}`);
  if (pocketPivot) reasons.push(`Pocket pivot ${ppBarsAgo === 0 ? 'today' : ppBarsAgo + ' bar(s) ago'} — institutional buy print`);
  if (volDryUp) reasons.push(`Volume dry-up to ${(vdu * 100).toFixed(0)}% of avg — coiled spring`);
  if (obvBaseRising) reasons.push('OBV rising through the base — quiet accumulation');
  if (udVol >= 1.3) reasons.push(`Up/down volume ${udVol.toFixed(1)}× (institutional accumulation)`);
  if (c_early) reasons.push(`Only ${(pctAbovePivot * 100).toFixed(1)}% above pivot — early, not extended`);
  if (c_trend) reasons.push(`Uptrend intact, ${(pctFrom52wHigh * 100).toFixed(0)}% off 52-wk high`);
  if (f_rs) reasons.push(`RS vs SPY +${(rsVsSpy63 * 100).toFixed(0)}% over 3 months (outperforming)`);
  if (f_aboveSmas) reasons.push('Above both the 50- and 200-day SMA');
  if (emergingLeader) reasons.unshift(`🌱 Emerging leader — fresh RS leadership + accumulation, only ${(extAbove50 * 100).toFixed(0)}% above the 50-DMA (early in the move, not chasing)`);

  // Actionable levels — for setups, entry triggers on the pivot break.
  const trigger = breakout ? price : pivotHigh;
  // Swing-structure stop / risk / target / reward:risk. Breakouts stop below the
  // cleared pivot and target a measured move (they've already cleared resistance,
  // so the next swing high would understate reward); setups stop below the recent
  // swing low and target the next overhead resistance.
  const tl = tradeLevels(candles, trigger, {
    bullish: true,
    pivot: breakout ? pivotHigh : undefined,
    targetMode: breakout ? 'measured' : 'resistance',
    baseHeight: pivotHigh - baseLow,
    atr,
  });
  const stop = tl ? tl.stop : Math.max(pivotHigh - 1.0 * (atr || price * 0.03), baseLow * 0.99);
  const target = tl ? tl.resistance : trigger + 2.5 * (atr || price * 0.04);
  const risk = tl ? tl.risk : +(trigger - stop).toFixed(2);
  const rr = tl ? tl.rr : (risk > 0 ? +((target - trigger) / risk).toFixed(2) : null);

  // ── Tier-4 leading / quality signals ──
  let rsHighArr = null, rsNewHigh = false;
  if (opts.spyByDate) { rsHighArr = rsHighArray(closes, candles.map(c => c.date), opts.spyByDate); rsNewHigh = !!rsHighArr[last]; }
  let adrSum = 0, adrC = 0;
  for (let k = Math.max(1, last - 19); k <= last; k++) { if (lows[k] > 0) { adrSum += highs[k] / lows[k] - 1; adrC++; } }
  const adrPct = adrC ? +((adrSum / adrC) * 100).toFixed(1) : null;
  const longBaseLive = Math.round((be - bs) / 5) >= 7;
  if (rsNewHigh) reasons.push('RS line at new high — leading the market (Minervini)');
  if (longBaseLive) reasons.push(`${Math.round((be - bs) / 5)}-week base — longer bases fuel bigger moves`);

  const sym = (meta.symbol || '').toUpperCase();
  const result = {
    ticker: sym || undefined,
    company: meta.shortName || meta.longName || null,
    sector: SECTOR_OF[sym] || 'Other',
    exchange: exchangeName(meta.exchangeName),
    aboveSma200: sma200 != null && price > sma200,
    above50: sma50 != null && price > sma50,
    price: +price.toFixed(2),
    changePct: closes[last - 1] ? +(((price - closes[last - 1]) / closes[last - 1]) * 100).toFixed(2) : null,
    status,
    include: !!status,
    qualifies: breakout && passesAll4,
    passesAll4,          // meets ALL four strict filters (regardless of gate mode)
    emergingLeader,      // early momentum-emergence leg (RKLB-style early mover)
    gate,                // 'strict' | 'relaxed' — which gate let this name through
    techScore: Math.round(tech),
    criteria: {
      accumulation: c_accumulation,
      vcp: c_vcp,
      resistance: c_resistance,
      volume: c_volume,
      early: c_early,
    },
    // The four required breakout-quality filters, with the figure behind each so
    // the UI can show exactly what every candidate passed (or would have failed).
    filters: {
      consolidation: f_consolidation,
      volume:        f_volume,
      rsVsSpy:       f_rs,
      aboveSmas:     f_aboveSmas,
    },
    metrics: {
      pivot: +pivotHigh.toFixed(2),
      pctAbovePivot: +(pctAbovePivot * 100).toFixed(1),
      volSurge: +volSurge.toFixed(1),
      rsi: rsi != null ? +rsi.toFixed(0) : null,
      baseWeeks: Math.round((be - bs) / 5),
      consoWeeks,
      baseRangePct: +(tightPct * 100).toFixed(0),
      accumRatio: +accumRatio.toFixed(1),
      pctFrom52wHigh: +(pctFrom52wHigh * 100).toFixed(0),
      pctBelowPivot: +(pctBelowPivot * 100).toFixed(1),
      barsSinceBreakout,
      vcpContractions: contractions + 1,
      udVol: +udVol.toFixed(1),
      pocketPivot,
      vdu: +(vdu * 100).toFixed(0),
      obvRising: obvBaseRising,
      rsNewHigh,
      longBase: longBaseLive,
      adrPct,
      rsVsSpy63: rsVsSpy63 != null ? +(rsVsSpy63 * 100).toFixed(1) : null,
      spyRet63:  spyRet63 != null ? +(spyRet63 * 100).toFixed(1) : null,
    },
    levels: {
      entry: +trigger.toFixed(2),
      stop: +stop.toFixed(2),
      target: +target.toFixed(2),
      resistance: +target.toFixed(2),
      risk,
      rr,
      targetType: tl ? tl.targetType : 'resistance',
      stopBasis: tl ? tl.stopBasis : 'pivot/base',
      blueSky: tl ? tl.blueSky : false,
    },
    factors: {
      mom21:  mom21 != null ? +(mom21 * 100).toFixed(1) : null,
      mom63:  mom63 != null ? +(mom63 * 100).toFixed(1) : null,
      mom126: mom126 != null ? +(mom126 * 100).toFixed(1) : null,
      vol:    vol != null ? +(vol * 100).toFixed(1) : null,
      volAdjMom: volAdjMom != null ? +volAdjMom.toFixed(2) : null,
      trendTemplate: +trendTemplate.toFixed(2),
      dollarVol: Math.round(dollarVol),
      atr: atr != null ? +atr.toFixed(2) : null,
      proximity: +proximity.toFixed(2),
      baseQuality: +baseQuality.toFixed(2),
      volSurge: +volSurge.toFixed(1),
    },
    reasons: reasons.slice(0, 6),
  };

  if (Array.isArray(opts.history)) {
    const o = { baseMax, setupBelow, earlyAbove, moveMax, setupHighGate, setupMaGate, rsHighArr };
    result.history = opts.history.map(off => {
      const i = last - off;
      const e = i >= 55 ? evalSetupAt(closes, highs, lows, vols, obv, rsiArr, i, o) : { include: false, qualifies: false };
      return { off, date: (i >= 0 && candles[i]) ? candles[i].date : null, include: e.include, qualifies: e.qualifies };
    });
  }

  return result;
}

module.exports = { fetchDailyHistory, screenTicker, smaAt, evalSetupAt, rsHighArray, emergingLeaderSignal };
