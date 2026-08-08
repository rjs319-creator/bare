'use strict';
// 📡 MARKET PULSE v2 — DIRECTION-AWARE PRICE REACTION + CATALYST REACTION MATRIX.
//
// v1's priceConfirms() checked "price up AND volume up" with no knowledge of the
// narrative's direction — a bearish story could be "confirmed" by a rally, and a
// bearish story that sold off exactly as expected failed to confirm. v2 receives the
// narrative direction explicitly and reverses every directional test for bearish
// theses. Mixed / non-directional / unknown narratives stay context: they can NEVER
// become a directional trade candidate.
//
// Pure: features in → states out. No network, no LLM.

const DIRECTIONS = Object.freeze(['BULLISH', 'BEARISH', 'MIXED', 'NON_DIRECTIONAL', 'UNKNOWN']);

const REACTION_STATES = Object.freeze([
  'UNREACTED',            // no measurable move since the narrative appeared
  'REACTING_AS_EXPECTED', // moving with the thesis but not yet confirmed
  'PRICE_CONFIRMED',      // direction + participation + structure agree, on fresh data
  'CONTRADICTED',         // price moving materially AGAINST the thesis
  'EXTENDED',             // moved with the thesis but too far — chase risk
  'FAILED',               // was confirming, then broke its structure
  'INSUFFICIENT_DATA',
]);

// Thresholds (kept explicit and versioned — these are hypotheses, not proven alpha).
const T = Object.freeze({
  REACT_MIN_RESIDUAL_PCT: 0.75,   // |residual move| this big = a real reaction is underway
  CONTRA_MIN_RESIDUAL_PCT: 1.0,   // residual move this far AGAINST the thesis = contradiction
  CONFIRM_MIN_RELVOL: 1.3,        // same-time-of-day participation needed to confirm
  EXTENDED_ATR: 2.5,              // ATR extension beyond which entry quality is gone
  STRETCHED_ATR: 1.5,
  MATERIAL_MOVE_PCT: 3.0,         // |move| that counts as a measurable reaction at all
});

const sign = dir => (dir === 'BULLISH' ? 1 : dir === 'BEARISH' ? -1 : 0);

function isDirectional(direction) { return direction === 'BULLISH' || direction === 'BEARISH'; }

/** Sanitize a raw direction string (LLM or config) into the v2 enum. Pure. */
function sanitizeDirection(d) {
  const up = String(d || '').toUpperCase();
  if (DIRECTIONS.includes(up)) return up;
  if (up === 'BULL' || up === 'LONG' || up === 'POSITIVE') return 'BULLISH';
  if (up === 'BEAR' || up === 'SHORT' || up === 'NEGATIVE') return 'BEARISH';
  return 'UNKNOWN';
}

/**
 * Direction-aware reaction assessment. PURE.
 *
 * @param {object} p
 * @param {string}  p.direction       one of DIRECTIONS
 * @param {object|null} p.features    measured features for the instrument:
 *   { residualPct,        // return since detection net of benchmark (signed %)
 *     rawPct,             // raw return since detection (signed %)
 *     vsVWAP,             // price vs VWAP in % (intraday) or null
 *     sameTimeRelVol,     // cumulative same-time-of-day relative volume, or null
 *     atrExt,             // signed ATR-extension from the 20-session mean, or null
 *     sectorConfirms,     // boolean|null — sector moving the same way
 *     brokeStructure }    // boolean|null — failed breakout/breakdown after confirming
 * @param {boolean} p.dataFresh       market data fresh enough to judge a reaction
 * @returns {{reaction:string, why:string[]}}
 */
function assessReaction({ direction, features, dataFresh = false } = {}) {
  const why = [];
  const dir = sanitizeDirection(direction);
  if (!features || !dataFresh) {
    return { reaction: 'INSUFFICIENT_DATA', why: [!features ? 'no measured features' : 'market data not fresh enough'] };
  }
  const s = sign(dir);
  const resid = Number.isFinite(features.residualPct) ? features.residualPct : null;
  const raw = Number.isFinite(features.rawPct) ? features.rawPct : null;
  const move = resid != null ? resid : raw;
  if (move == null) return { reaction: 'INSUFFICIENT_DATA', why: ['no return since detection'] };

  // Non-directional narratives can only report magnitude, never confirmation.
  if (!isDirectional(dir)) {
    if (Math.abs(move) < T.REACT_MIN_RESIDUAL_PCT) return { reaction: 'UNREACTED', why: ['no directional thesis; move small'] };
    return { reaction: 'REACTING_AS_EXPECTED', why: ['price moving, but narrative declared no direction — context only'] };
  }

  const withThesis = move * s;              // >0 means moving the way the thesis expects
  const atr = Number.isFinite(features.atrExt) ? features.atrExt * s : null;  // thesis-aligned extension

  if (features.brokeStructure === true) {
    return { reaction: 'FAILED', why: ['structure that confirmed the move has broken'] };
  }
  if (withThesis <= -T.CONTRA_MIN_RESIDUAL_PCT) {
    why.push(`residual ${move.toFixed(2)}% against a ${dir.toLowerCase()} thesis`);
    return { reaction: 'CONTRADICTED', why };
  }
  if (Math.abs(withThesis) < T.REACT_MIN_RESIDUAL_PCT) {
    return { reaction: 'UNREACTED', why: ['no material reaction yet'] };
  }
  // Moving with the thesis from here on.
  if (atr != null && atr >= T.EXTENDED_ATR) {
    why.push(`already ${Math.abs(features.atrExt).toFixed(1)} ATR ${s > 0 ? 'above' : 'below'} its mean`);
    return { reaction: 'EXTENDED', why };
  }
  // Confirmation needs participation + intraday structure agreement (direction-flipped).
  const participation = Number.isFinite(features.sameTimeRelVol) && features.sameTimeRelVol >= T.CONFIRM_MIN_RELVOL;
  const vwapOk = features.vsVWAP == null ? null : (features.vsVWAP * s > 0);
  const sectorOk = features.sectorConfirms !== false;   // null (unknown) does not veto
  if (participation && vwapOk !== false && sectorOk) {
    why.push('direction, participation and structure agree');
    return { reaction: 'PRICE_CONFIRMED', why };
  }
  why.push(participation ? 'structure not yet aligned' : 'participation below confirmation threshold');
  return { reaction: 'REACTING_AS_EXPECTED', why };
}

// ── Catalyst reaction matrix ────────────────────────────────────────────────
const MATRIX_CELLS = Object.freeze([
  'VERIFIED_POSITIVE_UNREACTED', 'VERIFIED_POSITIVE_CONFIRMING', 'VERIFIED_POSITIVE_EXTENDED',
  'VERIFIED_NEGATIVE_UNREACTED', 'VERIFIED_NEGATIVE_CONFIRMING', 'VERIFIED_NEGATIVE_EXTENDED',
  'UNVERIFIED_LARGE_REACTION', 'CONFLICTED_VOLATILE_REACTION', 'STALE_REPEATED_INFORMATION',
  'NO_MEASURABLE_REACTION', 'INSUFFICIENT_DATA',
]);

const MATRIX_READS = Object.freeze({
  VERIFIED_POSITIVE_UNREACTED: 'Verified positive with little reaction — possible underreaction; investigate, do not buy on this alone.',
  VERIFIED_POSITIVE_CONFIRMING: 'Verified positive with constructive confirmation — possible momentum/swing candidate.',
  VERIFIED_POSITIVE_EXTENDED: 'Valid story but the move is extended — poor current entry.',
  VERIFIED_NEGATIVE_UNREACTED: 'Verified negative with little reaction — latent downside risk.',
  VERIFIED_NEGATIVE_CONFIRMING: 'Verified negative confirming lower — downside thesis playing out.',
  VERIFIED_NEGATIVE_EXTENDED: 'Downside move already extended — poor entry for new shorts.',
  UNVERIFIED_LARGE_REACTION: 'Unverified story with a large move — hype/fade risk until evidence lands.',
  CONFLICTED_VOLATILE_REACTION: 'Sources conflict and price is volatile — avoid until evidence resolves.',
  STALE_REPEATED_INFORMATION: 'Repeated stale story with no new reaction — suppressed.',
  NO_MEASURABLE_REACTION: 'No measurable price reaction.',
  INSUFFICIENT_DATA: 'Not enough data to classify the reaction.',
});

/**
 * Deterministic matrix classification combining evidence status + reaction. PURE.
 * @param {object} p
 * @param {string} p.evidence   rollup: VERIFIED | SUPPORTED | SINGLE_SOURCE | CONFLICTED | UNVERIFIED | STALE
 * @param {string} p.direction  DIRECTIONS member
 * @param {string} p.reaction   REACTION_STATES member
 * @param {boolean} p.isRepeat  story previously seen with no new information
 * @param {number|null} p.movePct  |move| since detection (for the unverified-large gate)
 */
function catalystMatrixCell({ evidence, direction, reaction, isRepeat = false, movePct = null } = {}) {
  const dir = sanitizeDirection(direction);
  if (reaction === 'INSUFFICIENT_DATA') return 'INSUFFICIENT_DATA';
  if (isRepeat && (reaction === 'UNREACTED' || reaction === 'NO_MEASURABLE_REACTION')) return 'STALE_REPEATED_INFORMATION';
  if (evidence === 'CONFLICTED') {
    return (reaction === 'UNREACTED') ? 'NO_MEASURABLE_REACTION' : 'CONFLICTED_VOLATILE_REACTION';
  }
  const verified = evidence === 'VERIFIED' || evidence === 'SUPPORTED';
  if (!verified) {
    const big = movePct != null && Math.abs(movePct) >= T.MATERIAL_MOVE_PCT;
    if (big || reaction === 'EXTENDED' || reaction === 'PRICE_CONFIRMED') return 'UNVERIFIED_LARGE_REACTION';
    return 'NO_MEASURABLE_REACTION';
  }
  if (!isDirectional(dir)) return reaction === 'UNREACTED' ? 'NO_MEASURABLE_REACTION' : 'INSUFFICIENT_DATA';
  const side = dir === 'BULLISH' ? 'POSITIVE' : 'NEGATIVE';
  if (reaction === 'UNREACTED') return `VERIFIED_${side}_UNREACTED`;
  if (reaction === 'EXTENDED') return `VERIFIED_${side}_EXTENDED`;
  if (reaction === 'PRICE_CONFIRMED' || reaction === 'REACTING_AS_EXPECTED') return `VERIFIED_${side}_CONFIRMING`;
  if (reaction === 'CONTRADICTED' || reaction === 'FAILED') return 'NO_MEASURABLE_REACTION';
  return 'INSUFFICIENT_DATA';
}

module.exports = {
  DIRECTIONS, REACTION_STATES, MATRIX_CELLS, MATRIX_READS, T,
  sanitizeDirection, isDirectional, assessReaction, catalystMatrixCell,
};
