'use strict';
// 🔊 VOLUME & CAPACITY FORECAST (volfc-v1) — expected activity, not direction.
//
// Forecasts NEXT-SESSION dollar volume, relative volume, the probability of an
// abnormal-volume session, and the liquidity/capacity band those imply. The point
// is execution and prioritization: which names can absorb a position, what the
// realistic cost tier is, which candidates deserve expensive deep analysis. A
// volume forecast is NEVER a bullish signal — this repo already measured raw
// volume-surge at rank-IC ≈ −0.004 (api/screener DEFAULT_WEIGHTS.vol = 0), and this
// module deliberately cannot leak direction:
//
//   INPUTS ARE VOLUME + CALENDAR ONLY. No returns, no gaps, no closes-vs-opens —
//   price enters solely as the multiplier that converts shares to dollars. A test
//   asserts the forecast is invariant to the SIGN of every future and past return.
//
// Estimation is log-space and robust (median/MAD): expected log-volume blends the
// recent level with a same-weekday seasonal offset; the abnormal-session
// probability is an EMPIRICAL conditional frequency (given today's volume-surprise
// bucket, how often was the next session ≥2 MAD above median historically), with a
// fail-closed fallback to the unconditional rate and to null below minObs.
//
// Every forecast carries { known:false, basis:'forecast' } — these are modeled
// numbers, not quotes, following costs.js borrowKnown:false labeling.
//
// Pure & deterministic: no I/O, no clocks, no randomness.

const { TIER_BY_DOLLAR_VOL } = require('./decision-costs');

const VOLUME_FORECAST_VERSION = 'volfc-v1';

// Estimation policy — named so tests and callers share one source of truth.
const POLICY = Object.freeze({
  minBars: 30,            // history floor below which no forecast exists
  levelWindow: 5,         // recent-level median window (sessions)
  baseWindow: 63,         // long median / MAD window
  seasonalOccurrences: 8, // same-weekday samples for the seasonal offset
  abnormalZ: 2,           // "abnormal session" = volume ≥ 2 robust-z above median
  minObsConditional: 40,  // observations needed for the CONDITIONAL abnormal rate
  minObsUnconditional: 20,
  participationCapPct: 1, // capacity heuristic: 1% of expected dollar volume
});

const isFin = Number.isFinite;

function median(xs) {
  const v = xs.filter(isFin).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function mad(xs) {
  const m = median(xs);
  if (m == null) return null;
  return median(xs.filter(isFin).map(x => Math.abs(x - m)));
}

/** Weekday index (0=Mon..4=Fri) of a YYYY-MM-DD date, UTC-stable. */
function weekdayOf(date) {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5 ? d - 1 : null;
}

/** Robust z of the last volume vs the trailing base window (median/MAD). */
function volumeSurpriseZ(vols, idx, baseWindow) {
  if (idx < 10) return null;
  const base = vols.slice(Math.max(0, idx - baseWindow), idx);
  const med = median(base), dev = mad(base);
  if (med == null || !(dev > 0) || !isFin(vols[idx])) return null;
  return (vols[idx] - med) / (1.4826 * dev);
}

// Bucket today's surprise for the conditional abnormal-probability table.
function surpriseBucket(z) {
  if (!isFin(z)) return 'unknown';
  if (z >= 2) return 'high';
  if (z >= 0.5) return 'elevated';
  if (z <= -1) return 'depressed';
  return 'normal';
}

/**
 * Forecast the session AFTER candles[asOfIdx]. Uses ONLY bars[0..asOfIdx].
 *
 * @param candles  ascending [{date, close, volume}] (screener candle shape)
 * @param opts     { asOfIdx = last bar, nextDate = null (for weekday seasonality) }
 * @returns frozen forecast | { available:false, reason }
 */
function forecastNextSession(candles, { asOfIdx = null, nextDate = null, policy = POLICY } = {}) {
  const bars = Array.isArray(candles) ? candles : [];
  const idx = asOfIdx == null ? bars.length - 1 : asOfIdx;
  const hist = bars.slice(0, idx + 1).filter(b => b && isFin(b.volume) && b.volume > 0 && isFin(b.close) && b.close > 0);
  if (hist.length < policy.minBars) {
    return Object.freeze({ version: VOLUME_FORECAST_VERSION, available: false, reason: `insufficient-history:${hist.length}<${policy.minBars}` });
  }

  const logDvol = hist.map(b => Math.log(b.close * b.volume));
  const base = logDvol.slice(-policy.baseWindow);
  const baseMed = median(base);
  const baseMad = mad(base) || 0.1;

  // Recent level: median log dollar volume of the last few sessions.
  const level = median(logDvol.slice(-policy.levelWindow));

  // Same-weekday seasonal offset vs the base median (log space, robust).
  let seasonal = 0;
  const wd = nextDate ? weekdayOf(nextDate) : null;
  if (wd != null) {
    const sameDay = [];
    for (let i = hist.length - 1; i >= 0 && sameDay.length < policy.seasonalOccurrences; i--) {
      if (weekdayOf(hist[i].date) === wd) sameDay.push(logDvol[i]);
    }
    if (sameDay.length >= 4) {
      const sMed = median(sameDay);
      if (sMed != null && baseMed != null) seasonal = sMed - baseMed;
    }
  }

  const expectedLog = (level != null ? 0.7 * level : 0) + (baseMed != null ? 0.3 * baseMed : 0) + seasonal;
  const expectedDollarVol = Math.exp(expectedLog);
  const band = Object.freeze({
    lo: Math.round(Math.exp(expectedLog - 1.4826 * baseMad)),
    hi: Math.round(Math.exp(expectedLog + 1.4826 * baseMad)),
  });
  const medianDollarVol = baseMed != null ? Math.exp(baseMed) : null;
  const expectedRelVol = medianDollarVol ? +(expectedDollarVol / medianDollarVol).toFixed(3) : null;

  // ── Empirical conditional abnormal-session probability ────────────────────
  const vols = hist.map(b => b.volume);
  const todayZ = volumeSurpriseZ(vols, vols.length - 1, policy.baseWindow);
  const bucket = surpriseBucket(todayZ);
  let condHits = 0, condN = 0, allHits = 0, allN = 0;
  for (let i = policy.minBarsScan || 15; i < vols.length - 1; i++) {
    const z = volumeSurpriseZ(vols, i, policy.baseWindow);
    const nextZ = volumeSurpriseZ(vols, i + 1, policy.baseWindow);
    if (nextZ == null) continue;
    const abnormalNext = nextZ >= policy.abnormalZ;
    allN++; if (abnormalNext) allHits++;
    if (surpriseBucket(z) === bucket) { condN++; if (abnormalNext) condHits++; }
  }
  let pAbnormal = null, pAbnormalBasis = null;
  if (condN >= policy.minObsConditional) {
    pAbnormal = +(condHits / condN).toFixed(3);
    pAbnormalBasis = `conditional:${bucket}:n=${condN}`;
  } else if (allN >= policy.minObsUnconditional) {
    pAbnormal = +(allHits / allN).toFixed(3);
    pAbnormalBasis = `unconditional-fallback:n=${allN}`;
  } else {
    pAbnormalBasis = `insufficient-observations:${allN}`;
  }

  // ── Capacity + cost-tier read from the FORECAST dollar volume ─────────────
  const tierRow = TIER_BY_DOLLAR_VOL.find(r => expectedDollarVol >= r.min) || TIER_BY_DOLLAR_VOL[TIER_BY_DOLLAR_VOL.length - 1];
  const capacityUsd = Math.round(expectedDollarVol * (policy.participationCapPct / 100));

  return Object.freeze({
    version: VOLUME_FORECAST_VERSION,
    available: true,
    known: false,                       // modeled, never a quote — costs.js precedent
    basis: 'forecast',
    asOfDate: hist[hist.length - 1].date,
    forDate: nextDate || null,
    expectedDollarVol: Math.round(expectedDollarVol),
    expectedRelVol,
    band,
    seasonalLogOffset: +seasonal.toFixed(4),
    todaySurpriseZ: todayZ == null ? null : +todayZ.toFixed(3),
    surpriseBucket: bucket,
    pAbnormal,
    pAbnormalBasis,
    forecastTier: tierRow.tier,
    capacityUsdAtParticipationCap: capacityUsd,
    participationCapPct: policy.participationCapPct,
    inputs: 'volume+calendar+price-level-only (no returns, no direction)',
    nObs: hist.length,
  });
}

/**
 * Deep-analysis / scan priority: expected opportunity × expected activation ×
 * cost acceptability. Direction-free on the volume side by construction — the
 * caller supplies `opportunity` (its own signal strength 0..1); this only scales
 * it by expected tradability. High expected volume with zero opportunity stays 0.
 */
function scanPriority({ opportunity = 0, forecast = null } = {}) {
  const opp = isFin(opportunity) ? Math.max(0, Math.min(1, opportunity)) : 0;
  if (!forecast || !forecast.available) return +(opp * 0.5).toFixed(4);   // unknown liquidity: dampen, don't zero
  const activation = Math.max(0.25, Math.min(1.5, forecast.expectedRelVol || 1));
  const costOk = forecast.forecastTier === 'liquid' ? 1 : forecast.forecastTier === 'small' ? 0.85 : 0.6;
  return +(opp * activation * costOk).toFixed(4);
}

module.exports = {
  VOLUME_FORECAST_VERSION, POLICY,
  forecastNextSession, scanPriority,
  volumeSurpriseZ, surpriseBucket, weekdayOf, median, mad,
};
