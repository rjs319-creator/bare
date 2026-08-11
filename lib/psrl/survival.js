'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL addendum — discrete-time trend-life survival with competing risks.
// PURE: estimates come only from the episode ledger passed in.
//
// Method: discrete-time hazard by trend-age bucket (life-table / Kaplan-Meier
// style). RIGHT-CENSORED episodes contribute exposure up to their last
// observation and NO terminal event — never counted as success or failure.
// Competing risks are tallied as cause-specific hazards over the same risk
// sets. Below MIN_EPISODES resolved episodes every probability is null with
// reason 'INSUFFICIENT_SAMPLE' (prediction-contract discipline): the honest
// output of a young ledger is an accrual report, not a curve.
// ═══════════════════════════════════════════════════════════════════════════

const { VERSIONS } = require('./config');

const SURVIVAL_VERSION = 'psrl-survival-v1';
const MIN_EPISODES = 30;        // resolved (uncensored) episodes before ANY estimate
const MIN_RISKSET = 8;          // bucket risk set below which the bucket hazard is null
const AGE_BUCKETS = Object.freeze([5, 10, 21, 42, 63, 126, 252]); // upper edges, sessions

// Terminal events grouped into competing-risk families.
const RISK_FAMILY = Object.freeze({
  ACCELERATION: 'favorable', RESUMED_ADVANCE: 'favorable', ORDERLY_PAUSE: 'favorable',
  PLATEAU: 'stagnation', STAGNATION: 'stagnation', HORIZON_EXPIRED: 'stagnation',
  RELATIVE_LEADERSHIP_LOSS: 'leadership_loss',
  ABSOLUTE_TREND_BREAK: 'breakdown', STOP_OR_INVALIDATION: 'breakdown',
  BINARY_EVENT_DISCONTINUITY: 'discontinuity',
  LIQUIDITY_FAILURE: 'data', DATA_FAILURE: 'data',
  RIGHT_CENSORED: null,
});

function bucketOf(age) {
  for (const edge of AGE_BUCKETS) if (age <= edge) return edge;
  return Infinity;
}

/** Episode duration in observed sessions and its outcome family. */
function episodeSpan(ep) {
  const sessions = Array.isArray(ep.observations) ? ep.observations.length : 0;
  const censored = ep.rightCensored !== false || !ep.terminalEvent || ep.terminalEvent === 'RIGHT_CENSORED';
  return {
    sessions: Math.max(1, sessions),
    censored,
    family: censored ? null : (RISK_FAMILY[ep.terminalEvent] ?? 'other'),
    terminalEvent: censored ? null : ep.terminalEvent,
  };
}

/**
 * Fit the life table from a ledger. Returns hazards by age bucket, overall
 * survival at 5/21/63 sessions, cause-specific shares, and censoring stats.
 */
function fitTrendLife(ledger) {
  const eps = [...Object.values(ledger?.episodes || {}), ...(ledger?.closed || [])];
  const spans = eps.map(episodeSpan);
  const resolved = spans.filter((s) => !s.censored);
  const base = {
    version: SURVIVAL_VERSION, episodesVersion: VERSIONS.episodes,
    episodes: spans.length, resolved: resolved.length,
    censored: spans.length - resolved.length,
    minEpisodesRequired: MIN_EPISODES,
  };
  if (resolved.length < MIN_EPISODES) {
    return {
      ...base, available: false, reason: 'INSUFFICIENT_SAMPLE',
      note: `trend-life estimates abstain until ≥${MIN_EPISODES} resolved (uncensored) episodes accrue; censored episodes contribute exposure only`,
      survival: { h5: null, h21: null, h63: null },
      expectedRemaining: null, medianRemaining: null, byCause: null, hazards: null,
    };
  }

  // Discrete hazard per session, aggregated to buckets.
  const hazards = {};
  for (const edge of [...AGE_BUCKETS, Infinity]) hazards[edge] = { events: 0, exposure: 0, byFamily: {} };
  for (const s of spans) {
    for (let t = 1; t <= s.sessions; t++) hazards[bucketOf(t)].exposure += 1;
    if (!s.censored) {
      const b = hazards[bucketOf(s.sessions)];
      b.events += 1;
      b.byFamily[s.family] = (b.byFamily[s.family] || 0) + 1;
    }
  }
  const bucketHazard = {};
  for (const [edge, b] of Object.entries(hazards)) {
    bucketHazard[edge] = b.exposure >= MIN_RISKSET ? b.events / b.exposure : null;
  }

  // Survival to horizon h from age 0 (product of per-session survival using
  // each session's bucket hazard; null bucket ⇒ null survival from there on).
  const survivalTo = (h) => {
    let surv = 1;
    for (let t = 1; t <= h; t++) {
      const hz = bucketHazard[bucketOf(t)];
      if (hz == null) return null;
      surv *= 1 - hz;
    }
    return surv;
  };

  // Expected/median remaining duration from age 0 (capped at 252 sessions).
  let expected = 0, median = null, surv = 1;
  for (let t = 1; t <= 252; t++) {
    const hz = bucketHazard[bucketOf(t)];
    if (hz == null) { expected = null; break; }
    surv *= 1 - hz;
    expected += surv;
    if (median == null && surv <= 0.5) median = t;
  }

  const causeTotals = {};
  for (const s of resolved) causeTotals[s.family] = (causeTotals[s.family] || 0) + 1;

  return {
    ...base, available: true,
    calibrationStatus: 'uncalibrated',
    basis: 'empirical life-table over the shadow episode ledger — sample-conditional, not a trained model',
    survival: { h5: survivalTo(5), h21: survivalTo(21), h63: survivalTo(63) },
    expectedRemaining: expected, medianRemaining: median,
    byCause: Object.fromEntries(Object.entries(causeTotals).map(([k, v]) => [k, { count: v, share: v / resolved.length }])),
    hazards: bucketHazard,
  };
}

/**
 * Per-card trend-life projection given a fitted table and the card's current
 * trend age. All-null with reason when the table abstains.
 */
function trendLifeFor(fit, trendAge) {
  if (!fit?.available) {
    return {
      available: false, reason: fit?.reason || 'INSUFFICIENT_SAMPLE',
      pSurvive5: null, pSurvive21: null, pSurvive63: null,
      expectedRemaining: null, medianRemaining: null,
    };
  }
  const age = Number.isFinite(trendAge) ? Math.max(1, trendAge) : 1;
  const condSurv = (h) => {
    let surv = 1;
    for (let t = age + 1; t <= age + h; t++) {
      const hz = fit.hazards[bucketOf(t)];
      if (hz == null) return null;
      surv *= 1 - hz;
    }
    return surv;
  };
  let expected = 0, median = null, surv = 1;
  for (let t = age + 1; t <= age + 252; t++) {
    const hz = fit.hazards[bucketOf(t)];
    if (hz == null) { expected = null; break; }
    surv *= 1 - hz;
    expected += surv;
    if (median == null && surv <= 0.5) median = t - age;
  }
  return {
    available: true, calibrationStatus: 'uncalibrated', basis: fit.basis,
    ageConditional: true, trendAge: age,
    pSurvive5: condSurv(5), pSurvive21: condSurv(21), pSurvive63: condSurv(63),
    expectedRemaining: expected, medianRemaining: median,
  };
}

module.exports = { SURVIVAL_VERSION, MIN_EPISODES, AGE_BUCKETS, RISK_FAMILY, fitTrendLife, trendLifeFor, episodeSpan };
