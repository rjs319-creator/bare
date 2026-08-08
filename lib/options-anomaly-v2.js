'use strict';
// OPTIONS ANOMALY DETECTION v2 — "unusual vs THIS name's own history", robustly.
//
// Replaces "large absolute volume = unusual" with a relative detector built on
// point-in-time baselines (lib/options-observe-v2 session docs). Statistics are
// ROBUST — median, MAD, winsorized percentiles, minimum sample requirements —
// never a naked mean/sd that one squeeze day can poison.
//
// The output separates three things that must never be conflated:
//   • anomalyScore (0-100)  — how UNUSUAL the activity is. Explicitly not a
//     probability, not a direction, not an edge.
//   • dataQuality (0-100)   — how trustworthy the observation is (delay, quote
//     coverage, baseline sample). Applied as a SEPARATE gate, never mixed into
//     unusualness.
//   • liquidityQuality (0-100) — whether the market in these options is tradeable.
//
// Admission into discovery has two doors (spec): exceptional RELATIVE abnormality,
// or exceptional ABSOLUTE size that also passes quality controls. Immature
// baselines therefore delay the relative door, not visibility of huge events.
//
// Pure functions; history docs are passed in. Config is versioned
// (lib/options-config-v2) and challenger weight-sets score in shadow.

const cfg = require('./options-config-v2');
const { totals } = require('./options-observe-v2');

const { ANOMALY_CONFIG, ACTIVITY_STATUS } = cfg;

// ── Robust statistics ────────────────────────────────────────────────────────
function sortedNums(arr) {
  return (arr || []).filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function winsorize(values, pct = ANOMALY_CONFIG.winsorPct) {
  const s = sortedNums(values);
  if (s.length < 3) return s;
  const lo = quantile(s, pct), hi = quantile(s, 1 - pct);
  return s.map(v => Math.min(hi, Math.max(lo, v)));
}
function robustStats(values, winsorPct = ANOMALY_CONFIG.winsorPct) {
  const w = winsorize(values, winsorPct);
  if (!w.length) return { n: 0, median: null, mad: null };
  const med = quantile(w, 0.5);
  const absDev = w.map(v => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = quantile(absDev, 0.5);
  return { n: w.length, median: med, mad, p25: quantile(w, 0.25), p75: quantile(w, 0.75), p90: quantile(w, 0.9), values: w };
}
// Robust z via MAD (1.4826 ≈ consistency constant for a normal). Bounded so a
// degenerate baseline (mad→0) can't produce ±Infinity.
function robustZ(x, stats) {
  if (x == null || !stats || stats.median == null) return null;
  const scale = stats.mad != null && stats.mad > 0 ? 1.4826 * stats.mad : Math.max(1e-9, Math.abs(stats.median) * 0.25);
  return Math.max(-10, Math.min(10, (x - stats.median) / scale));
}
// Midrank percentile of x against the winsorized baseline values (0-100). Ties
// count half so a value equal to a constant baseline reads ~50th, not 100th.
function percentileOf(x, stats) {
  if (x == null || !stats || !stats.values || !stats.values.length) return null;
  let below = 0, equal = 0;
  for (const v of stats.values) { if (v < x) below++; else if (v === x) equal++; }
  return Math.round(((below + equal / 2) / stats.values.length) * 100);
}

// ── Baseline construction (point-in-time: history docs STRICTLY BEFORE today) ─
// historyDocs: [{ session, tickers: { T: observation } }] in any order. Returns a
// per-ticker baseline of robust stats per side×bucket plus ticker-level series.
// Baselines contain ONLY information available before the scored session — the
// caller must not include the session being scored (asserted via `beforeSession`).
function buildBaselines(historyDocs, { beforeSession = null } = {}) {
  const days = (historyDocs || [])
    .filter(d => d && d.session && d.tickers && (!beforeSession || d.session < beforeSession))
    .sort((a, b) => (a.session < b.session ? -1 : 1));
  const perTicker = new Map();
  for (const day of days) {
    for (const [t, obs] of Object.entries(day.tickers)) {
      if (!obs || !obs.ok || !obs.aggregates) continue;
      let acc = perTicker.get(t);
      if (!acc) { acc = { sessions: 0, series: {}, tickerSeries: { vol: [], notional: [], volOi: [], optUndRatio: [], atmIV: [], skew: [], termSlope: [], activeStrikes: [] }, recent: [] }; perTicker.set(t, acc); }
      acc.sessions++;
      const tot = totals(obs);
      const oiTot = Object.values(obs.aggregates.byBucket).reduce((s, a) => s + a.callOI + a.putOI, 0);
      acc.tickerSeries.vol.push(tot.vol);
      acc.tickerSeries.notional.push(tot.notional);
      acc.tickerSeries.volOi.push(oiTot > 0 ? tot.vol / oiTot : null);
      acc.tickerSeries.optUndRatio.push(obs.underlyingDollarVolume > 0 ? tot.notional / obs.underlyingDollarVolume : null);
      const swing = obs.aggregates.byBucket['21-45'];
      acc.tickerSeries.atmIV.push(swing ? swing.atmIV : null);
      acc.tickerSeries.skew.push(obs.aggregates.skew);
      acc.tickerSeries.termSlope.push(obs.aggregates.termSlope);
      let strikes = 0;
      for (const [key, a] of Object.entries(obs.aggregates.byBucket)) {
        strikes += a.activeStrikes || 0;
        for (const side of ['call', 'put']) {
          const sk = `${side}:${key}`;
          (acc.series[sk] ??= { vol: [], notional: [], volOi: [] });
          const vol = side === 'call' ? a.callVol : a.putVol;
          const notional = side === 'call' ? a.callNotional : a.putNotional;
          const oi = side === 'call' ? a.callOI : a.putOI;
          acc.series[sk].vol.push(vol);
          acc.series[sk].notional.push(notional);
          acc.series[sk].volOi.push(oi > 0 ? vol / oi : null);
        }
      }
      acc.tickerSeries.activeStrikes.push(strikes);
      acc.recent.push({ session: day.session, vol: tot.vol, notional: tot.notional });
    }
  }
  const out = new Map();
  for (const [t, acc] of perTicker) {
    const stat = {};
    for (const [k, s] of Object.entries(acc.series)) {
      stat[k] = { vol: robustStats(s.vol), notional: robustStats(s.notional), volOi: robustStats(s.volOi) };
    }
    const ts = acc.tickerSeries;
    out.set(t, {
      sessions: acc.sessions,
      byKey: stat,
      ticker: {
        vol: robustStats(ts.vol), notional: robustStats(ts.notional), volOi: robustStats(ts.volOi),
        optUndRatio: robustStats(ts.optUndRatio), atmIV: robustStats(ts.atmIV),
        skew: robustStats(ts.skew), termSlope: robustStats(ts.termSlope),
        activeStrikes: robustStats(ts.activeStrikes),
      },
      recent: acc.recent.slice(-5),
    });
  }
  return { asOfExclusive: beforeSession, days: days.length, tickers: out };
}

// ── Feature extraction for one ticker-session ────────────────────────────────
// Session-fraction adjustment: an intraday snapshot's cumulative volume is scaled
// to a full-session equivalent before comparing with (full-session) baselines. A
// post-close snapshot has fraction 1 and is untouched.
function sessionAdjust(value, sessionFraction) {
  if (value == null) return null;
  const f = sessionFraction != null && sessionFraction > 0.1 ? Math.min(1, sessionFraction) : 1;
  return value / f;
}

const clamp01 = v => Math.max(0, Math.min(1, v));

// Strike/expiry concentration from the bounded contract rows: Herfindahl of
// volume shares. 1 = all volume in one contract (coherent bet), →0 = scattered.
function concentrationOf(contracts) {
  const rows = (contracts || []).filter(c => (c.volume || 0) > 0);
  const tot = rows.reduce((s, c) => s + c.volume, 0);
  if (!tot) return null;
  let hhi = 0;
  for (const c of rows) hhi += (c.volume / tot) ** 2;
  return +hhi.toFixed(3);
}

function featureSet(obs, baseline) {
  const tot = totals(obs);
  const byBucket = obs.aggregates ? obs.aggregates.byBucket : {};
  const oiTot = Object.values(byBucket).reduce((s, a) => s + a.callOI + a.putOI, 0);
  const adjVol = sessionAdjust(tot.vol, obs.sessionFraction);
  const adjNotional = sessionAdjust(tot.notional, obs.sessionFraction);
  const b = baseline || null;
  const bt = b && b.ticker;
  const volOiToday = oiTot > 0 ? tot.vol / oiTot : (tot.vol > 0 ? 10 : 0);
  const optUnd = obs.underlyingDollarVolume > 0 ? tot.notional / obs.underlyingDollarVolume : null;
  const swing = byBucket['21-45'];

  const f = {
    totalVolume: tot.vol,
    adjVolume: adjVol != null ? Math.round(adjVol) : null,
    totalNotional: tot.notional,
    volOi: +volOiToday.toFixed(2),
    optionsVsUnderlying: optUnd != null ? +optUnd.toFixed(4) : null,
    concentration: concentrationOf(obs.contracts),
    atmIV: swing ? swing.atmIV : null,
    skew: obs.aggregates ? obs.aggregates.skew : null,
    termSlope: obs.aggregates ? obs.aggregates.termSlope : null,
    activeStrikes: Object.values(byBucket).reduce((s, a) => s + (a.activeStrikes || 0), 0),
    // vs own baseline (null when unscoreable)
    volPercentile: bt ? percentileOf(adjVol, bt.vol) : null,
    volZ: bt ? robustZ(adjVol, bt.vol) : null,
    notionalPercentile: bt ? percentileOf(adjNotional, bt.notional) : null,
    volOiPercentile: bt ? percentileOf(volOiToday, bt.volOi) : null,
    optUndPercentile: bt ? percentileOf(optUnd, bt.optUndRatio) : null,
    ivChange: bt && bt.atmIV.median != null && swing && swing.atmIV != null ? +(swing.atmIV - bt.atmIV.median).toFixed(4) : null,
    skewChange: bt && bt.skew.median != null && obs.aggregates && obs.aggregates.skew != null ? +(obs.aggregates.skew - bt.skew.median).toFixed(4) : null,
    termChange: bt && bt.termSlope.median != null && obs.aggregates && obs.aggregates.termSlope != null ? +(obs.aggregates.termSlope - bt.termSlope.median).toFixed(4) : null,
    breadthPercentile: bt ? percentileOf(Object.values(byBucket).reduce((s, a) => s + (a.activeStrikes || 0), 0), bt.activeStrikes) : null,
  };

  // Persistence: of the last baseline sessions, how many ran ≥1.5× their median
  // volume; acceleration: today vs the most recent session.
  if (b && b.recent && b.recent.length && bt && bt.vol.median > 0) {
    const hot = b.recent.filter(r => r.vol >= bt.vol.median * 1.5).length;
    f.persistenceSessions = hot;
    const lastVol = b.recent[b.recent.length - 1].vol;
    f.acceleration = lastVol > 0 && adjVol != null ? +(adjVol / lastVol).toFixed(2) : null;
  } else {
    f.persistenceSessions = null;
    f.acceleration = null;
  }
  return f;
}

// ── Component scores (each 0-1) fed into the weighted composite ──────────────
function componentScores(f) {
  const pct = p => (p == null ? null : clamp01((p - 50) / 50));   // 50th→0, 100th→1
  const volComp = f.volPercentile != null
    ? clamp01(0.75 * pct(f.volPercentile) + 0.25 * clamp01((f.volZ || 0) / 6))
    : null;
  const notionalComp = f.notionalPercentile != null
    ? (f.optUndPercentile != null ? clamp01(0.5 * pct(f.notionalPercentile) + 0.5 * pct(f.optUndPercentile)) : pct(f.notionalPercentile))
    : null;
  const volOiComp = f.volOiPercentile != null ? pct(f.volOiPercentile) : null;
  // Concentration is meaningful on its own scale (no baseline needed): HHI ≥ 0.5
  // = one dominant contract; a mild breadth kicker rewards coherent clusters.
  const concComp = f.concentration != null
    ? clamp01(f.concentration * 1.4 + (f.breadthPercentile != null ? 0.2 * pct(f.breadthPercentile) : 0))
    : null;
  const ivComp = (f.ivChange != null || f.skewChange != null || f.termChange != null)
    ? clamp01((Math.abs(f.ivChange || 0) / 0.15) * 0.5 + (Math.abs(f.skewChange || 0) / 0.08) * 0.3 + (Math.abs(f.termChange || 0) / 0.15) * 0.2)
    : null;
  const persComp = f.persistenceSessions != null
    ? clamp01(f.persistenceSessions / 3 * 0.6 + (f.acceleration != null && f.acceleration > 1.5 ? 0.4 : 0))
    : null;
  return {
    volumePercentile: volComp,
    relNotionalPercentile: notionalComp,
    volOiPercentile: volOiComp,
    concentration: concComp,
    ivSkewChange: ivComp,
    persistence: persComp,
  };
}

// Weighted composite over AVAILABLE components (weights renormalized over the
// non-null set so missing features neither inflate nor sink the score).
function compositeScore(components, weights) {
  let num = 0, den = 0;
  for (const [k, w] of Object.entries(weights)) {
    const c = components[k];
    if (c == null) continue;
    num += w * c; den += w;
  }
  if (den <= 0) return null;
  return Math.round((num / den) * 100);
}

// ── Quality scores (separate axes — never blended into unusualness) ──────────
function dataQualityOf(obs, baselineSessions) {
  if (!obs || !obs.ok) return 0;
  let q = 100;
  const rows = obs.contracts || [];
  const quoted = rows.filter(c => c.bid != null && c.ask != null && c.ask > c.bid).length;
  const quoteCov = rows.length ? quoted / rows.length : 0;
  q -= Math.round((1 - quoteCov) * 30);                       // missing two-sided quotes
  if (obs.delayedByMin != null && obs.delayedByMin > 20) q -= 10;  // beyond standard delay
  if (obs.sessionFraction != null && obs.sessionFraction < 0.25) q -= 15; // very early partial session
  if (baselineSessions < ANOMALY_CONFIG.minBaselineSessions) q -= 20;    // relative read unavailable
  else if (baselineSessions < ANOMALY_CONFIG.fullBaselineSessions) q -= 10;
  if (obs.expiriesRequested != null && obs.expiriesReturned != null && obs.expiriesReturned < obs.expiriesRequested) {
    q -= Math.min(15, (obs.expiriesRequested - obs.expiriesReturned) * 5);
  }
  return Math.max(0, Math.min(100, q));
}

function liquidityQualityOf(obs) {
  const rows = (obs && obs.contracts) || [];
  if (!rows.length) return 0;
  const spreads = rows
    .map(c => (c.bid != null && c.ask != null && c.ask > c.bid && (c.bid + c.ask) > 0 ? ((c.ask - c.bid) / ((c.bid + c.ask) / 2)) * 100 : null))
    .filter(v => v != null);
  const medSpread = spreads.length ? quantile(sortedNums(spreads), 0.5) : null;
  let q = 100;
  if (medSpread == null) q -= 40;
  else if (medSpread > 40) q -= 60;
  else if (medSpread > 25) q -= 40;
  else if (medSpread > 12) q -= 20;
  const oiDepth = rows.reduce((s, c) => s + (c.openInterest || 0), 0);
  if (oiDepth < 500) q -= 20;
  else if (oiDepth < 2000) q -= 10;
  if (obs.underlyingDollarVolume != null && obs.underlyingDollarVolume < 5_000_000) q -= 20;
  return Math.max(0, Math.min(100, q));
}

// ── Activity status: the two admission doors ─────────────────────────────────
function activityStatusOf({ anomalyScore, dataQuality, absTier, baselineScored }) {
  const th = ANOMALY_CONFIG.thresholds;
  const tiers = ANOMALY_CONFIG.absoluteTiers.map(t => t.key);
  const tierRank = k => tiers.indexOf(k);   // lower index = bigger
  const absAdmit = absTier != null
    && tierRank(absTier) <= tierRank(ANOMALY_CONFIG.absoluteAdmitTier)
    && dataQuality >= ANOMALY_CONFIG.absoluteAdmitMinQuality;

  const relLevel = baselineScored && anomalyScore != null
    ? (anomalyScore >= th.exceptional ? 3 : anomalyScore >= th.highlyUnusual ? 2 : anomalyScore >= th.unusual ? 1 : 0)
    : 0;
  if (relLevel === 0 && !absAdmit) return ACTIVITY_STATUS.NORMAL;
  if (relLevel >= 1 && dataQuality < ANOMALY_CONFIG.minDataQuality) return ACTIVITY_STATUS.UNUSUAL_LOW_QUALITY;
  if (relLevel === 3) return ACTIVITY_STATUS.EXCEPTIONAL;
  if (relLevel === 2) return ACTIVITY_STATUS.HIGHLY_UNUSUAL;
  if (relLevel === 1) return ACTIVITY_STATUS.UNUSUAL;
  // Absolute-door admission with an immature/quiet relative read.
  return ACTIVITY_STATUS.UNUSUAL;
}

// ── Score one ticker observation ─────────────────────────────────────────────
function scoreTicker(obs, baseline, { config = ANOMALY_CONFIG, challengers = cfg.ANOMALY_CHALLENGERS } = {}) {
  const baselineSessions = baseline ? baseline.sessions : 0;
  const baselineScored = baselineSessions >= config.minBaselineSessions;
  const features = featureSet(obs, baselineScored ? baseline : null);
  const components = componentScores(features);
  const anomalyScore = compositeScore(components, config.weights);
  const dataQuality = dataQualityOf(obs, baselineSessions);
  const liquidityQuality = liquidityQualityOf(obs);
  const absTier = cfg.absoluteSizeTier(features.totalNotional);
  const status = activityStatusOf({ anomalyScore, dataQuality, absTier, baselineScored });

  const reasons = [], warnings = [];
  if (features.volPercentile != null && features.volPercentile >= 90) reasons.push(`Option volume at the ${features.volPercentile}th percentile of its own ${baselineSessions}-session history`);
  if (features.volOiPercentile != null && features.volOiPercentile >= 90) reasons.push('Volume far above standing open interest vs its own norm');
  if (features.concentration != null && features.concentration >= 0.4) reasons.push('Activity concentrated in few strikes (coherent, not scattered)');
  if (features.persistenceSessions != null && features.persistenceSessions >= 2) reasons.push(`Elevated activity persisted ${features.persistenceSessions} of the last ${baseline && baseline.recent ? baseline.recent.length : 0} sessions`);
  if (features.ivChange != null && Math.abs(features.ivChange) >= 0.05) reasons.push(`ATM IV ${features.ivChange > 0 ? 'up' : 'down'} ${(Math.abs(features.ivChange) * 100).toFixed(0)} pts vs its norm`);
  if (!baselineScored) warnings.push(`Baseline immature (${baselineSessions}/${config.minBaselineSessions} sessions) — relative read unavailable; admitted on absolute size only if large enough`);
  if (dataQuality < config.minDataQuality) warnings.push('Low data quality — treat with caution');
  if (liquidityQuality < 50) warnings.push('Illiquid options market — wide quotes / thin OI');

  return {
    modelVersion: config.version || cfg.MODEL_VERSION,
    configId: config.id,
    anomalyScore,                                  // 0-100 UNUSUALNESS — never a probability
    anomalyPercentile: features.volPercentile,     // today's (time-adjusted) volume vs own history
    absoluteSizeTier: absTier,
    activityStatus: status,
    activityLabel: cfg.ACTIVITY_LABEL[status],
    dataQuality, liquidityQuality,
    baselineSampleSize: baselineSessions,
    baselineScored,
    features, components,
    reasons, warnings,
    challengerScores: (challengers || []).map(c => ({ id: c.id, score: compositeScore(components, c.weights) })),
  };
}

// ── Ranking fairness ─────────────────────────────────────────────────────────
// 1) score contracts within a ticker, 2) retain the best N per ticker, 3) the
// caller aggregates tickers into events and ranks EVENTS globally. One ticker can
// never consume the global cap because caps apply after per-ticker retention.
function rankContractsWithinTicker(contracts, { max = cfg.RANKING.maxContractsPerTicker } = {}) {
  const scored = (contracts || []).map(c => {
    const spread = c.bid != null && c.ask != null && c.ask > c.bid && (c.bid + c.ask) > 0
      ? ((c.ask - c.bid) / ((c.bid + c.ask) / 2)) : null;
    const oi = c.openInterest || 0;
    const voRaw = oi > 0 ? (c.volume || 0) / oi : ((c.volume || 0) > 0 ? 10 : 0);
    const vo = Math.min(voRaw, 50);
    const notionalScore = Math.log10(Math.max(1, c.estNotional || 0)) * 10;
    const voScore = Math.min(vo, 10) * 3;
    const qualityPenalty = spread == null ? 15 : spread > 0.25 ? 10 : 0;
    return { ...c, contractScore: +(notionalScore + voScore - qualityPenalty).toFixed(1), volOiBounded: +vo.toFixed(2), spreadFrac: spread };
  });
  scored.sort((a, b) => b.contractScore - a.contractScore);
  return scored.slice(0, max);
}

module.exports = {
  buildBaselines, featureSet, componentScores, compositeScore,
  robustStats, robustZ, percentileOf, winsorize, quantile,
  dataQualityOf, liquidityQualityOf, activityStatusOf, scoreTicker,
  rankContractsWithinTicker, sessionAdjust, concentrationOf,
};
