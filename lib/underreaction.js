'use strict';
// 📰 NEWS UNDERREACTION (underreaction-v1) — prospective-only drift candidate states.
//
// For each structured evidence event (lib/evidence-schema) that carries a REAL
// publish timestamp, compare what the news semantically implies with how much the
// market has actually repriced since publication:
//
//   underreactionGap = normalized semantic economic impact
//                    − normalized market/sector-adjusted price reaction so far
//
// A large positive gap on fresh, novel, well-sourced news is a positive-
// underreaction candidate; a reaction far beyond the semantic impact is a possible
// overreaction. The LLM NEVER emits a probability of price appreciation — its
// structured fields (direction, materiality, novelty, source quality) become
// features here, and any future probability must come from a model trained on
// MATURED prospective outcomes, gated by the standard calibration display gates.
//
// PROSPECTIVE-ONLY, enforced structurally:
//   • an event without publishedAt → INSUFFICIENT_DATA (never an age guessed from
//     detectedAt);
//   • publishedAt after the asOf close → NOT_YET_OBSERVABLE (the reaction window
//     hasn't opened; retroactive incorporation is impossible);
//   • there is NO backfill path — states exist only for events ingested live, and
//     every record carries researchOnly:true plus the extractor model/prompt
//     version so cross-version rows can be excluded from any future training.
//
// Pure & deterministic: no I/O, no LLM, no clocks — `asOf` is an input.

const UNDERREACTION_VERSION = 'underreaction-v1';

const STATES = Object.freeze([
  'FRESH_POSITIVE_UNDERREACTION', 'FRESH_NEGATIVE_UNDERREACTION',
  'FULLY_PRICED', 'POSSIBLE_OVERREACTION', 'STALE_REPEATED',
  'AMBIGUOUS', 'INSUFFICIENT_DATA', 'NOT_YET_OBSERVABLE',
]);

const POLICY = Object.freeze({
  freshMaxSessions: 5,      // beyond this the drift window is no longer "fresh"
  staleLookbackDays: 7,     // same-event fingerprint seen within this window → repeated
  minMateriality: 0.35,     // below this the event can't ground a candidate state
  gapThreshold: 0.35,       // |gap| needed to call under/overreaction
  reactionScaleZ: 2,        // z-units of residual move treated as "fully reflects" max impact
  minBarsForVol: 30,
});

const isFin = Number.isFinite;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round4 = v => (isFin(v) ? +v.toFixed(4) : null);

/**
 * Normalized semantic economic impact in [−1, 1], from LLM-structured fields the
 * normalizer already bounded. Signed by direction; scaled by materiality with
 * novelty and source quality as multipliers. `mixed`/`neutral` direction → 0.
 */
function semanticImpact(event) {
  if (!event) return null;
  const sign = event.direction === 'positive' ? 1 : event.direction === 'negative' ? -1 : 0;
  if (sign === 0) return 0;
  const mat = isFin(event.materialityScore) ? event.materialityScore : 0.5;
  const nov = isFin(event.noveltyScore) ? event.noveltyScore : 0.5;
  const src = isFin(event.sourceQualityScore) ? event.sourceQualityScore : 0.35;
  return round4(clamp(sign * mat * (0.6 + 0.3 * nov + 0.1 * src), -1, 1));
}

/** First bar index with date >= the publish date (the availability session). */
function availabilityIndex(bars, publishedAt) {
  if (!publishedAt) return -1;
  const pubDate = String(publishedAt).slice(0, 10);
  for (let i = 0; i < bars.length; i++) if (bars[i].date >= pubDate) return i;
  return -1;
}

/**
 * Market/sector-adjusted cumulative reaction since publication, in bounded
 * normalized units comparable to semanticImpact. Adjustment: stock return minus
 * sector (fallback market) return over the same bars; normalized by the stock's
 * trailing daily volatility × √sessions, then squashed so reactionScaleZ z-units
 * map to ±1.
 */
function priceReaction({ bars = [], benchBars = [], sectorBars = [], publishedAt = null, asOf = null } = {}) {
  const RES = require('./atlasx-residual');
  const s = RES.asOfSlice(RES.toBars(bars), asOf);
  if (s.length < POLICY.minBarsForVol) return { ok: false, reason: 'insufficient-price-history' };
  const startIdx = availabilityIndex(s, publishedAt);
  if (startIdx < 0) return { ok: false, reason: 'publish-date-after-asof' };
  if (startIdx === 0) return { ok: false, reason: 'publish-date-before-history' };

  const p0 = s[startIdx - 1].c;                      // last close BEFORE availability
  const p1 = s[s.length - 1].c;
  if (!(p0 > 0) || !(p1 > 0)) return { ok: false, reason: 'bad-prices' };
  const rawRet = p1 / p0 - 1;

  const benchRet = windowRet(RES.asOfSlice(RES.toBars(sectorBars.length ? sectorBars : benchBars), asOf), s[startIdx - 1].date, s[s.length - 1].date);
  const adjRet = benchRet == null ? rawRet : rawRet - benchRet;
  const adjBasis = benchRet == null ? 'raw (no benchmark bars)' : (sectorBars.length ? 'sector-adjusted' : 'market-adjusted');

  // Trailing daily vol from the pre-publication window (never post-event vol).
  const pre = s.slice(0, startIdx);
  const rets = [];
  for (let i = 1; i < pre.length; i++) if (pre[i - 1].c > 0) rets.push(pre[i].c / pre[i - 1].c - 1);
  if (rets.length < 20) return { ok: false, reason: 'insufficient-pre-event-history' };
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
  if (!(vol > 0)) return { ok: false, reason: 'zero-volatility' };

  const sessions = s.length - startIdx;
  const z = adjRet / (vol * Math.sqrt(Math.max(1, sessions)));
  return {
    ok: true,
    sessionsSincePublish: sessions,
    rawReturnPct: round4(rawRet * 100),
    adjReturnPct: round4(adjRet * 100),
    adjBasis,
    reactionZ: round4(z),
    reactionNorm: round4(clamp(z / POLICY.reactionScaleZ, -1, 1)),
  };
}

function windowRet(bars, fromDate, toDate) {
  if (!bars || bars.length < 2) return null;
  let a = null, b = null;
  for (const bar of bars) {
    if (bar.date <= fromDate) a = bar;
    if (bar.date <= toDate) b = bar;
  }
  if (!a || !b || !(a.c > 0) || !(b.c > 0) || a.date === b.date) return a && b && a.date === b.date ? 0 : (a && b ? b.c / a.c - 1 : null);
  return b.c / a.c - 1;
}

/**
 * Classify one event into a candidate state.
 *
 * @param event      normalized evidence event (must carry publishedAt to be usable)
 * @param reaction   output of priceReaction()
 * @param opts       { isRepeated } — fingerprint seen in recent prior snapshots
 */
function classifyUnderreaction(event, reaction, { isRepeated = false } = {}) {
  const impact = semanticImpact(event);
  const base = {
    version: UNDERREACTION_VERSION,
    ticker: event ? event.ticker : null,
    publishedAt: event ? event.publishedAt || null : null,
    semanticImpact: impact,
    researchOnly: true,
    extractor: (event && event.extractor) || null,
  };

  if (!event || !event.publishedAt) {
    return { ...base, state: 'INSUFFICIENT_DATA', reason: 'no-publish-timestamp', gap: null, reaction: null };
  }
  if (!reaction || !reaction.ok) {
    const reason = reaction ? reaction.reason : 'no-price-data';
    return { ...base, state: reason === 'publish-date-after-asof' ? 'NOT_YET_OBSERVABLE' : 'INSUFFICIENT_DATA', reason, gap: null, reaction: null };
  }
  if (isRepeated) {
    return { ...base, state: 'STALE_REPEATED', reason: 'same-event-fingerprint-seen-recently', gap: null, reaction };
  }
  if (impact == null || Math.abs(impact) < 1e-9 || (event.materialityScore || 0) < POLICY.minMateriality) {
    return { ...base, state: 'AMBIGUOUS', reason: impact === 0 ? 'direction-neutral-or-mixed' : 'below-materiality-floor', gap: null, reaction };
  }

  const gap = round4(impact - reaction.reactionNorm);
  const fresh = reaction.sessionsSincePublish <= POLICY.freshMaxSessions;
  let state = 'FULLY_PRICED';
  // Overreaction: the market moved well BEYOND the semantic impact, same direction.
  if (Math.abs(reaction.reactionNorm) > Math.abs(impact) + POLICY.gapThreshold
      && Math.sign(reaction.reactionNorm) === Math.sign(impact)) {
    state = 'POSSIBLE_OVERREACTION';
  } else if (gap >= POLICY.gapThreshold && impact > 0) {
    state = fresh ? 'FRESH_POSITIVE_UNDERREACTION' : 'FULLY_PRICED';
  } else if (gap <= -POLICY.gapThreshold && impact < 0) {
    state = fresh ? 'FRESH_NEGATIVE_UNDERREACTION' : 'FULLY_PRICED';
  }
  if (!fresh && (state === 'FULLY_PRICED') && Math.abs(gap) >= POLICY.gapThreshold) {
    // The gap persisted past the fresh window — informative but no longer a fresh candidate.
    state = 'AMBIGUOUS';
  }

  return { ...base, state, reason: null, gap, fresh, reaction };
}

/** Stable fingerprint for cross-day repeat detection (mirrors evidence-cluster). */
function eventFingerprint(event) {
  if (!event) return null;
  const bucket = event.publishedAt ? String(event.publishedAt).slice(0, 10) : (event.catalystDate || '');
  return `${event.ticker}|${event.eventType}|${bucket}|${event.direction}`;
}

module.exports = {
  UNDERREACTION_VERSION, STATES, POLICY,
  semanticImpact, priceReaction, classifyUnderreaction,
  availabilityIndex, eventFingerprint,
};
