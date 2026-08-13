'use strict';
// ALERT FRESHNESS + TTL — evaluated on EVERY decision build, not only at episode folding.
//
// THE P0 DEFECT THIS REPLACES: staleness existed only inside `foldEpisodes` (an episode
// not re-seen for >6 days expired). Nothing between folds re-checked age, so a decision
// card built from an episode last corroborated five days ago rendered with no visible age
// and full actionability. Age was invisible and TTL was unenforced at decision time.
//
// Here every decision carries: the age of the ORIGINATING alert, the age of the LAST
// corroboration, the age of the PRICE the decision was built on, an explicit TTL, an
// expiry timestamp, and a state. STALE and EXPIRED are never actionable.
//
// Pure; `now` is injected.

const STATE = Object.freeze({
  FRESH: 'FRESH',
  AGING: 'AGING',
  STALE: 'STALE',
  EXPIRED: 'EXPIRED',
  UNKNOWN: 'UNKNOWN',   // no usable timestamp — fails closed, never actionable
});

// Horizon-scaled TTLs in hours. These are explicit hypotheses, not calibrated constants.
const TTL = Object.freeze({
  intraday: { fresh: 2, aging: 6, stale: 24 },
  swing: { fresh: 24, aging: 72, stale: 168 },        // 1d / 3d / 7d
  investor: { fresh: 168, aging: 504, stale: 1080 },  // 7d / 21d / 45d
});
const DEFAULT_HORIZON = 'swing';

// The price a decision is built on has its own, much tighter clock than the thesis.
const PRICE_FRESH_HOURS = 24;
const PRICE_STALE_HOURS = 96;

const VERSION = 'alerts-freshness-v1';

const HOUR_MS = 3_600_000;

function parseMs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v);
  // A bare YYYY-MM-DD is a trading DATE, not an instant — anchor it to the UTC day start.
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(ms) ? null : ms;
}

const hoursBetween = (fromMs, nowMs) => (fromMs == null || nowMs == null ? null : Math.max(0, (nowMs - fromMs) / HOUR_MS));

function ttlFor(horizon) {
  const key = String(horizon || '').toLowerCase();
  return TTL[key] || TTL[DEFAULT_HORIZON];
}

/** Normalize the many horizon spellings the parser can emit into a TTL bucket. Pure. */
function horizonBucket(horizon) {
  const h = String(horizon || '').toLowerCase();
  if (!h) return DEFAULT_HORIZON;
  if (/(day ?trade|intraday|scalp|today|hour)/.test(h)) return 'intraday';
  if (/(invest|long ?term|position|month|year)/.test(h)) return 'investor';
  return DEFAULT_HORIZON;
}

function stateFor(ageHours, t) {
  if (ageHours == null) return STATE.UNKNOWN;
  if (ageHours <= t.fresh) return STATE.FRESH;
  if (ageHours <= t.aging) return STATE.AGING;
  if (ageHours <= t.stale) return STATE.STALE;
  return STATE.EXPIRED;
}

/**
 * Assess the freshness of one alert/episode at decision-build time. Pure.
 *
 * @param {object} p
 * @param {string} p.firstSeenAt   ISO instant the thesis was first captured
 * @param {string} p.lastSeenAt    ISO instant of the most recent corroboration
 * @param {string} p.priceAsOf     provider timestamp of the price the decision uses
 * @param {string} p.horizon       intended horizon (any spelling)
 * @param {number|Date} p.now
 * @returns {object} freshness record; `actionable:false` means the card cannot be actioned
 */
function assessFreshness({ firstSeenAt = null, lastSeenAt = null, priceAsOf = null, horizon = null, now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : parseMs(now));
  const bucket = horizonBucket(horizon);
  const t = ttlFor(bucket);

  const firstMs = parseMs(firstSeenAt);
  const lastMs = parseMs(lastSeenAt) ?? firstMs;
  const priceMs = parseMs(priceAsOf);

  const alertAgeHours = hoursBetween(firstMs, nowMs);
  const corroborationAgeHours = hoursBetween(lastMs, nowMs);
  const priceAgeHours = hoursBetween(priceMs, nowMs);

  // The thesis clock runs off the LAST corroboration (a re-confirmed idea is not stale),
  // but a thesis whose originating alert is past the hard TTL expires regardless.
  const corroborationState = stateFor(corroborationAgeHours, t);
  const originState = stateFor(alertAgeHours, { fresh: t.fresh, aging: t.aging, stale: t.stale * 2 });
  const RANK = { FRESH: 4, AGING: 3, STALE: 2, EXPIRED: 1, UNKNOWN: 0 };
  const state = RANK[originState] < RANK[corroborationState] ? originState : corroborationState;

  const priceState = priceAgeHours == null ? STATE.UNKNOWN
    : priceAgeHours <= PRICE_FRESH_HOURS ? STATE.FRESH
      : priceAgeHours <= PRICE_STALE_HOURS ? STATE.AGING
        : STATE.STALE;

  const expiresAtMs = lastMs != null ? lastMs + t.stale * HOUR_MS : null;
  const hoursToExpiry = expiresAtMs != null && nowMs != null ? +((expiresAtMs - nowMs) / HOUR_MS).toFixed(1) : null;

  const reasons = [];
  if (state === STATE.UNKNOWN) reasons.push('no usable alert timestamp — age cannot be established, so the alert is not actionable');
  if (state === STATE.STALE) reasons.push(`last corroborated ${corroborationAgeHours.toFixed(0)}h ago — past the ${t.aging}h ${bucket} freshness window`);
  if (state === STATE.EXPIRED) reasons.push(`past the ${t.stale}h ${bucket} TTL — expired`);
  if (priceState === STATE.STALE) reasons.push(`the price this decision is built on is ${priceAgeHours.toFixed(0)}h old`);
  if (priceState === STATE.UNKNOWN) reasons.push('no provider timestamp on the decision price — price freshness unverifiable');

  const actionable = (state === STATE.FRESH || state === STATE.AGING)
    && priceState !== STATE.STALE && priceState !== STATE.UNKNOWN;

  return {
    version: VERSION,
    state,
    horizonBucket: bucket,
    ttlHours: t,
    alertAgeHours: alertAgeHours == null ? null : +alertAgeHours.toFixed(1),
    corroborationAgeHours: corroborationAgeHours == null ? null : +corroborationAgeHours.toFixed(1),
    priceAgeHours: priceAgeHours == null ? null : +priceAgeHours.toFixed(1),
    priceState,
    expiresAt: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : null,
    hoursToExpiry,
    actionable,
    reasons,
    // Human-readable age for the card — the mission requires it be VISIBLE.
    ageLabel: corroborationAgeHours == null ? 'age unknown'
      : corroborationAgeHours < 1 ? '<1h old'
        : corroborationAgeHours < 48 ? `${Math.round(corroborationAgeHours)}h old`
          : `${Math.round(corroborationAgeHours / 24)}d old`,
  };
}

module.exports = { STATE, TTL, VERSION, PRICE_FRESH_HOURS, PRICE_STALE_HOURS, assessFreshness, horizonBucket, ttlFor };
