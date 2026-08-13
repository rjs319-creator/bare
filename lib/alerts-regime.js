'use strict';
// SIDE-AWARE REGIME — a risk-off tape is a HEADWIND for longs and a TAILWIND for shorts.
//
// THE P0 DEFECT THIS REPLACES: the score applied one scalar `regimeFrac` (0.15 when
// risk-off, 1.0 when supportive) and a `regime.riskOff` WAIT veto to BOTH sides. A valid
// short thesis was therefore vetoed by exactly the tape that supports it, and a long got
// full credit in the tape most likely to break it. Regime is directional evidence; it
// must be evaluated against the side being proposed.
//
// Sector regime works the same way: a sector leading the market helps a long in that
// sector and hurts a short in it.
//
// Pure; every input is injected. Unavailable regime data yields UNKNOWN — never a
// neutral pass and never a veto (absence of evidence is not evidence of a headwind).

const ALIGNMENT = Object.freeze({
  TAILWIND: 'TAILWIND',
  NEUTRAL: 'NEUTRAL',
  HEADWIND: 'HEADWIND',
  UNKNOWN: 'UNKNOWN',
});

// Credit fraction per alignment. HEADWIND is not zero — a headwind is a reason to be
// smaller and more patient, not proof the thesis is wrong.
const CREDIT = Object.freeze({ TAILWIND: 1, NEUTRAL: 0.6, HEADWIND: 0.15, UNKNOWN: 0 });

const SECTOR_LEAD_PCT = 0.3;    // sector day-return vs SPY beyond ±this = a real tilt

const VERSION = 'alerts-regime-v1';

const flip = a => (a === ALIGNMENT.TAILWIND ? ALIGNMENT.HEADWIND : a === ALIGNMENT.HEADWIND ? ALIGNMENT.TAILWIND : a);

/**
 * Market-regime alignment for one side. Pure.
 * `market` is the deterministic SPY read: { riskOff, supportive, label, available }.
 */
function marketAlignmentFor(market, side) {
  const m = market || {};
  if (m.available === false || (!m.label && !m.riskOff && !m.supportive)) {
    // `readRegime` returns label 'unknown' when SPY history is too short.
    if (m.label === 'unknown' || m.available === false) {
      return { alignment: ALIGNMENT.UNKNOWN, reason: 'market regime unavailable (insufficient index history)' };
    }
  }
  if (m.label === 'unknown') return { alignment: ALIGNMENT.UNKNOWN, reason: 'market regime unavailable (insufficient index history)' };
  if (!side) return { alignment: ALIGNMENT.UNKNOWN, reason: 'no side claimed — regime cannot be oriented' };

  // The LONG-relative reading, then mirrored for a short.
  const longView = m.riskOff ? ALIGNMENT.HEADWIND : m.supportive ? ALIGNMENT.TAILWIND : ALIGNMENT.NEUTRAL;
  const alignment = side === 'short' ? flip(longView) : longView;
  const tape = m.riskOff ? 'risk-off' : m.supportive ? 'supportive' : 'neutral';
  return {
    alignment,
    reason: `${tape} tape is a ${alignment.toLowerCase()} for a ${side}`,
    tape,
  };
}

/**
 * Sector-regime alignment for one side. `sector` is { vsSpyPct, sector } or null.
 */
function sectorAlignmentFor(sector, side) {
  const s = sector || {};
  if (s.vsSpyPct == null || !Number.isFinite(s.vsSpyPct)) {
    return { alignment: ALIGNMENT.UNKNOWN, reason: 'no sector relative-strength read available' };
  }
  if (!side) return { alignment: ALIGNMENT.UNKNOWN, reason: 'no side claimed — sector regime cannot be oriented' };
  const longView = s.vsSpyPct >= SECTOR_LEAD_PCT ? ALIGNMENT.TAILWIND
    : s.vsSpyPct <= -SECTOR_LEAD_PCT ? ALIGNMENT.HEADWIND
      : ALIGNMENT.NEUTRAL;
  const alignment = side === 'short' ? flip(longView) : longView;
  return {
    alignment,
    reason: `${s.sector || 'sector'} ${s.vsSpyPct >= 0 ? '+' : ''}${s.vsSpyPct}% vs SPY — ${alignment.toLowerCase()} for a ${side}`,
    vsSpyPct: s.vsSpyPct,
  };
}

const RANK = { TAILWIND: 3, NEUTRAL: 2, HEADWIND: 1, UNKNOWN: 0 };

/**
 * Combine market + sector into a single side-aware regime fit. Pure.
 *
 * @param {object} p
 * @param {object} p.market  { riskOff, supportive, label } from the deterministic index read
 * @param {object} p.sector  { vsSpyPct, sector } (optional)
 * @param {'long'|'short'|null} p.side
 * @returns {{alignment, creditFraction, market, sector, vetoes, reasons, version}}
 */
function assessRegimeFit({ market = null, sector = null, side = null } = {}) {
  const mk = marketAlignmentFor(market, side);
  const sc = sectorAlignmentFor(sector, side);

  // The overall read is the WEAKER of the two known alignments (a headwind anywhere is a
  // headwind), with UNKNOWN treated as "no information" rather than as agreement.
  const known = [mk.alignment, sc.alignment].filter(a => a !== ALIGNMENT.UNKNOWN);
  const alignment = known.length
    ? known.reduce((worst, a) => (RANK[a] < RANK[worst] ? a : worst), ALIGNMENT.TAILWIND)
    : ALIGNMENT.UNKNOWN;

  // Only a HEADWIND for THIS side is a veto. Risk-off can no longer veto a short.
  const vetoes = [];
  if (mk.alignment === ALIGNMENT.HEADWIND) vetoes.push({ source: 'market', reason: mk.reason });
  if (sc.alignment === ALIGNMENT.HEADWIND) vetoes.push({ source: 'sector', reason: sc.reason });

  return {
    version: VERSION,
    side: side || null,
    alignment,
    creditFraction: CREDIT[alignment],
    market: mk,
    sector: sc,
    vetoes,
    coverage: +((known.length / 2)).toFixed(2),
    reasons: [mk.reason, sc.reason].filter(Boolean),
  };
}

module.exports = { ALIGNMENT, CREDIT, SECTOR_LEAD_PCT, VERSION, assessRegimeFit, marketAlignmentFor, sectorAlignmentFor };
