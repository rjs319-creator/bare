// COIL RADAR — pre-explosion detector. Unlike the momentum/breakout screens (which
// flag names already MOVING), this flags QUIET, COILED names before an abnormal move.
//
// WHY THIS EXISTS (evidence, not folklore): a point-in-time study over ~2y of the
// small+large universe (see test/coil.test.js + research/COIL-RADAR.md) measured which
// setups precede an ABNORMAL upside break — a forward 10-session gain ≥ 2.5× the name's
// own trailing daily volatility (so a big number a high-vol name hits by noise does NOT
// count; only a genuine regime-break does). Findings:
//   • Compression predicts abnormal breaks; recent momentum (already-run-up) does NOT
//     (~0.9 lift) — the signal is orthogonal to "already running."
//   • Of 11 expert variants backtested out-of-sample (walk-forward, 3 folds), the winner
//     was the BOLLINGER-SQUEEZE-RANK model: score names by how compressed they are vs
//     their OWN history (BandWidth percentile + realized-vol percentile) rather than
//     cross-sectionally. It tied the best data-fit model on IC while being a fixed,
//     parameter-free formula (top-decile break lift ~2.0×, monotone, OOS-stable).
// The probability we emit is the EMPIRICAL break rate of the matching coil-score
// decile — an honest single-digit-to-low-teens number, never a fabricated "85%".

const COIL_HORIZON = 10;         // forward sessions the calibration was measured over
const COIL_SIGMA = 2.5;          // "abnormal break" = forward max gain ≥ this × own 10d vol
const BB_LOOKBACK = 126;         // ~6mo window for the BandWidth-percentile "squeeze rank"
const HV_LOOKBACK = 252;         // ~1y window for the realized-vol-percentile compression

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const stdev = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
const smaAt = (c, i, n) => { if (i - n + 1 < 0) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += c[k].close; return s / n; };
function atrAt(c, i, n) {
  if (i - n < 0) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const tr = Math.max(c[k].high - c[k].low, Math.abs(c[k].high - c[k - 1].close), Math.abs(c[k].low - c[k - 1].close));
    s += tr;
  }
  return s / n;
}
// Percentile rank (0..1) of the LAST value within a series — how the current reading
// compares to the name's own recent history. Low = tightest it's been in the window.
function pctileOfLast(series) {
  if (!series.length) return 0.5;
  const last = series[series.length - 1];
  let below = 0; for (const x of series) if (x < last) below++;
  return below / series.length;
}
const bbWidthAt = (c, i) => { const s = smaAt(c, i, 20); if (!s) return null; return (4 * stdev(c.slice(i - 19, i + 1).map(x => x.close))) / s; };

// Point-in-time compression features at bar i (defaults to the latest bar). Uses only
// candles[0..i]. Returns null when there isn't enough history to be meaningful.
// The SCORE uses bbPctile / hvPctile / rangeTight (the backtest winner); the remaining
// fields are descriptive, for the UI reasons and display.
function coilFeatures(candles, i = candles.length - 1) {
  if (!Array.isArray(candles) || i < 60) return null;
  const px = candles[i].close;
  if (!(px > 0)) return null;
  const atr10 = atrAt(candles, i, 10), atr50 = atrAt(candles, i, 50);
  const sma20 = smaAt(candles, i, 20), sma50 = smaAt(candles, i, 50);
  const sma200 = i >= 200 ? smaAt(candles, i, 200) : null;
  const win20 = candles.slice(i - 19, i + 1);
  const hi20 = Math.max(...win20.map(x => x.high));
  const lo20 = Math.min(...win20.map(x => x.low));
  const vol5 = mean(candles.slice(i - 4, i + 1).map(x => x.volume));
  const vol50 = mean(candles.slice(i - 49, i + 1).map(x => x.volume));
  const bbWidth = bbWidthAt(candles, i);
  // Bollinger "Squeeze rank": BandWidth percentile vs its own last ~126 sessions.
  const bbHist = []; const bbStart = Math.max(20, i - BB_LOOKBACK + 1);
  for (let k = bbStart; k <= i; k++) { const w = bbWidthAt(candles, k); if (w != null) bbHist.push(w); }
  const bbPctile = bbHist.length > 20 ? pctileOfLast(bbHist) : 0.5;
  // Realized-vol compression: 20d realized-vol percentile vs its own last ~252 sessions.
  const rets = []; const rStart = Math.max(1, i - HV_LOOKBACK);
  for (let k = rStart; k <= i; k++) rets.push(candles[k].close / candles[k - 1].close - 1);
  const rv = []; for (let k = 20; k < rets.length; k++) rv.push(stdev(rets.slice(k - 20, k)));
  const hvPctile = rv.length > 20 ? pctileOfLast(rv) : 0.5;
  // Descriptive-only (not scored): accumulation + extension for the UI.
  let obv = 0; const obvArr = [];
  for (let k = i - 20; k <= i; k++) { if (k > 0) obv += (candles[k].close > candles[k - 1].close ? 1 : candles[k].close < candles[k - 1].close ? -1 : 0) * candles[k].volume; obvArr.push(obv); }
  const obvSlope = obvArr.length > 5 ? (obvArr[obvArr.length - 1] - obvArr[0]) / (Math.abs(obvArr[0]) + vol50 * 20 + 1) : 0;
  return Object.freeze({
    bbPctile,                                                  // ★ scored — low = tightest squeeze vs own history
    hvPctile,                                                  // ★ scored — low = realized vol compressed vs own year
    rangeTight: (hi20 - lo20) / px,                            // ★ scored — tight 20d base
    atrRatio: atr10 != null && atr50 ? atr10 / atr50 : null,   // descriptive: <1 = vol contracting
    bbWidth,                                                   // descriptive: raw Bollinger width
    vdu: vol50 ? vol5 / vol50 : null,                          // descriptive: <1 = volume dry-up
    nearHigh20: (hi20 - px) / px,                              // descriptive: coiled under resistance
    obvSlope,                                                  // descriptive: accumulation
    ret20: candles[i - 20] ? px / candles[i - 20].close - 1 : 0,
    aboveSma200: sma200 != null && px > sma200,
    price: +px.toFixed(2),
  });
}

function zColumn(vals) {
  const clean = vals.filter(v => v != null && isFinite(v));
  if (clean.length < 2) return () => 0;
  const m = mean(clean), s = stdev(clean) || 1;
  return v => (v == null || !isFinite(v)) ? 0 : (v - m) / s;
}

// Cross-sectional coil score (higher = more coiled). WINNER of the 11-variant OOS
// backtest — "Bollinger-Squeeze-Rank": weight how compressed each name is vs its OWN
// history. All three drivers are "low = coiled" so their z-scores are negated.
const W_BBP = 1.2, W_HVP = 1.0, W_RT = 0.5;
function scoreCohort(featuresArr) {
  const zBbP = zColumn(featuresArr.map(f => f && f.bbPctile));
  const zHvP = zColumn(featuresArr.map(f => f && f.hvPctile));
  const zRt = zColumn(featuresArr.map(f => f && f.rangeTight));
  return featuresArr.map(f => {
    if (!f) return -Infinity;
    return -W_BBP * zBbP(f.bbPctile) - W_HVP * zHvP(f.hvPctile) - W_RT * zRt(f.rangeTight);
  });
}

// ── CALIBRATION ────────────────────────────────────────────────────────────
// Per-scope, isotonic (monotonic) empirical break rates by coil-score DECILE, re-baked
// for the winning BB-squeeze-rank model (~2y, 5-session step). Index 0 = weakest coil
// decile, 9 = strongest. `p25` = P(forward 10d gain ≥ 2.5× own vol); `p30` = the ≥3×
// tier. Top-decile lift ≈ 2.0× base. Micro-caps share the 'small' table (pooled).
const CALIBRATION = Object.freeze({
  small: {
    base25: 6.4, base30: 4.2,
    p25: [2.6, 2.8, 5.0, 5.4, 5.9, 5.9, 6.7, 8.1, 9.1, 12.6],
    p30: [1.8, 1.8, 2.8, 3.2, 3.6, 3.6, 4.7, 5.1, 6.6, 8.7],
  },
  large: {
    base25: 3.7, base30: 2.0,
    p25: [1.4, 1.7, 2.2, 3.0, 3.1, 3.6, 4.3, 5.0, 5.3, 7.6],
    p30: [0.6, 0.6, 1.2, 1.5, 1.5, 1.9, 2.5, 2.7, 3.2, 4.1],
  },
});
function calibScope(scope) { return scope === 'large' ? CALIBRATION.large : CALIBRATION.small; }

// Map a cohort-relative percentile (0..1) to the honest, calibrated break probability.
// Returns nulls for an out-of-range input rather than guessing.
function explodeProbability(scope, percentile) {
  if (percentile == null || !isFinite(percentile)) return null;
  const cal = calibScope(scope);
  const d = Math.max(0, Math.min(9, Math.floor(percentile * 10)));
  const p25 = cal.p25[d], p30 = cal.p30[d];
  const lift = +(p25 / cal.base25).toFixed(2);
  const band = d >= 8 ? 'high' : d >= 5 ? 'elevated' : d >= 3 ? 'normal' : 'quiet';
  return Object.freeze({
    pct: p25,          // headline: % chance of an abnormal upside break in ~10 sessions
    pctMajor: p30,     // stricter ≥3σ break
    decile: d + 1,     // 1..10 (10 = most coiled)
    lift,              // vs the universe base rate (>1 = concentrates breaks)
    band,
    horizonDays: COIL_HORIZON,
  });
}

// Rank a cohort of {ticker, candles} and attach coil scores + calibrated probability.
// Pure: returns a new sorted array, does not mutate inputs. `scope` picks the table.
function rankCoil(cohort, scope = 'small') {
  const rows = cohort
    .map(x => ({ ticker: x.ticker, meta: x.meta || null, candles: x.candles, feats: coilFeatures(x.candles) }))
    .filter(x => x.feats);
  if (!rows.length) return [];
  const scores = scoreCohort(rows.map(r => r.feats));
  const withScore = rows.map((r, j) => ({ ...r, score: scores[j] }));
  const asc = [...withScore].sort((a, b) => a.score - b.score);
  const rankOf = new Map(asc.map((r, i) => [r.ticker, i]));
  return withScore
    .map(r => {
      const pctile = rankOf.get(r.ticker) / Math.max(1, asc.length - 1);
      return { ...r, percentile: +pctile.toFixed(3), prob: explodeProbability(scope, pctile) };
    })
    .sort((a, b) => b.score - a.score);
}

// ── LEDGER RESOLUTION (self-validation) ─────────────────────────────────────
// Trailing daily-return volatility at bar i (the same 20d vol the calibration used to
// define an "abnormal" break). Returned so a logged pick can be resolved reproducibly.
function trailingDailyVol(candles, i) {
  if (!Array.isArray(candles)) return null;
  if (i == null) i = candles.length - 1;
  if (i < 20) return null;
  const rets = [];
  for (let k = i - 19; k <= i; k++) if (candles[k] && candles[k - 1]) rets.push(candles[k].close / candles[k - 1].close - 1);
  const v = stdev(rets);
  return v > 0 ? v : null;
}

// Resolve a logged pick against fresh candles: did it make an abnormal upside break
// (forward `horizon`-session max gain ≥ COIL_SIGMA × its entry-time `horizon`-day vol)
// within `horizon` sessions of `entryDate`? Returns null until it has fully matured.
//   { matured:true, broke, brokeMajor, mfePct, thresholdPct, exitDate }
function resolveBreak(candles, entryDate, dailyVol, horizon = COIL_HORIZON, sigma = COIL_SIGMA) {
  if (!Array.isArray(candles) || !(dailyVol > 0)) return null;
  let ei = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date >= entryDate) { ei = k; break; } }
  if (ei < 0) return null;
  const entry = candles[ei].close;
  if (!(entry > 0)) return null;
  if (ei + horizon >= candles.length) return null;            // not matured yet
  let mx = 0;
  for (let k = ei + 1; k <= ei + horizon && k < candles.length; k++) mx = Math.max(mx, candles[k].close / entry - 1);
  const sig10 = dailyVol * Math.sqrt(horizon);                // move (in return space) implied by its own vol
  const z = mx / sig10;                                       // how many "own-vol units" it broke
  return Object.freeze({
    matured: true,
    broke: z >= sigma,
    brokeMajor: z >= 3.0,
    mfePct: +(mx * 100).toFixed(1),
    thresholdPct: +(sigma * sig10 * 100).toFixed(1),
    z: +z.toFixed(2),
    exitDate: candles[ei + horizon].date,
  });
}

module.exports = {
  coilFeatures, scoreCohort, zColumn, rankCoil, explodeProbability, CALIBRATION,
  trailingDailyVol, resolveBreak, COIL_HORIZON, COIL_SIGMA,
};
