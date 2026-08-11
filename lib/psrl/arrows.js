'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — arrow states, entry/action state, hysteresis. PURE.
//
// Four independent arrow families (price trend, vs-market, vs-sector,
// trajectory) plus an entry state. Hysteresis rules: ordinary upgrades need
// two consecutive qualifying closes; ordinary downgrades need two weak
// observations; hard invalidation downgrades IMMEDIATELY; trajectory arrows
// need a material score change. No arrow moves on one noisy session.
// ═══════════════════════════════════════════════════════════════════════════

const { HYSTERESIS, EXTENSION } = require('./config');

const LEVELS = Object.freeze(['DOWN2', 'DOWN', 'FLAT', 'UP', 'UP2']);
const GLYPH = Object.freeze({ DOWN2: '↓↓', DOWN: '↓', FLAT: '→', UP: '↑', UP2: '↑↑', ALERT: '⚠' });

const ENTRY_STATES = Object.freeze([
  'BUY_ZONE', 'BUY_ON_CONFIRMATION', 'WAIT_FOR_PULLBACK', 'WATCH',
  'DEFENSIVE_WATCH', 'DEPRIORITIZE', 'AVOID', 'INSUFFICIENT_EVIDENCE',
]);

const isNum = (x) => Number.isFinite(x);
const idx = (lvl) => LEVELS.indexOf(lvl);

// ── Raw arrows (pre-hysteresis) ─────────────────────────────────────────────

function priceArrowRaw({ trend, absPath }) {
  const f63 = trend.byHorizon?.[63], f21 = trend.byHorizon?.[21];
  if (!f21?.available) return 'FLAT';
  const state = absPath?.state;
  if (state === 'TREND_BROKEN') return 'DOWN2';
  if (state === 'EXHAUSTED' || state === 'DECELERATING') return 'DOWN';
  if (state === 'ORDERLY_PAUSE' || state === 'JUMP_HOLDING') return 'FLAT';
  const persistent = f63?.available && f63.totalReturn > 0 && (f63.fit ?? 0) > 0.6
    && (trend.structure?.higherLowPct ?? 0) > 0.55;
  if (persistent && f21.totalReturn > 0) return 'UP2';
  if (f21.totalReturn > 0 && (f63?.totalReturn ?? 0) > 0) return 'UP';
  if (f21.totalReturn > 0 || (f63?.totalReturn ?? 0) > 0) return 'FLAT';
  return 'DOWN';
}

function relativeArrowRaw(byHorizon, field) {
  const v21 = byHorizon?.[21]?.[field], v63 = byHorizon?.[63]?.[field], v5 = byHorizon?.[5]?.[field];
  if (!isNum(v21) && !isNum(v63)) return null;                    // UNKNOWN — render as missing
  const mid = isNum(v21) ? v21 : v63;
  const slow = isNum(v63) ? v63 : v21;
  if (mid > 0.03 && slow > 0.05) return 'UP2';
  if (mid > 0 && slow > 0) return 'UP';
  if (mid < -0.03 && slow < -0.05) return 'DOWN2';
  if (mid < 0) return 'DOWN';
  if (isNum(v5) && v5 < -0.01 && mid <= 0.005) return 'DOWN';
  return 'FLAT';
}

/** Trajectory vs stored previous evidence (needs prev snapshot). */
function trajectoryRaw({ combined, prevCombined, alert }) {
  if (alert) return 'ALERT';
  if (!isNum(combined) || !isNum(prevCombined)) return 'FLAT';
  const d = combined - prevCombined;
  if (Math.abs(d) < HYSTERESIS.minTrajectoryDelta) return 'FLAT';
  return d > 0 ? 'UP' : 'DOWN';
}

// ── Entry state ─────────────────────────────────────────────────────────────

function entryState({ quadrant, absPath, support, extensionAtr, distSma20Atr, arrows }) {
  const reasons = [];
  if (support?.abstain) return { state: 'INSUFFICIENT_EVIDENCE', reasons: support.reasons || [] };
  if (quadrant === 'DEFENSIVE_LEADER') {
    // Fell less than the market ≠ a buy — and a defensive name's absolute path
    // is usually "broken" by construction, so this check precedes AVOID.
    return { state: 'DEFENSIVE_WATCH', reasons: ['HOLDING_UP_BUT_NOT_ADVANCING'] };
  }
  if (quadrant === 'AVOID' || absPath?.state === 'TREND_BROKEN') {
    return { state: 'AVOID', reasons: ['TREND_BROKEN_OR_WEAK'] };
  }
  if (quadrant === 'MARKET_CARRIED_LAGGARD') {
    return { state: 'DEPRIORITIZE', reasons: ['RISING_WITH_MARKET_NOT_LEADING'] };
  }
  if (absPath?.state === 'JUMP_PLATEAU') {
    return { state: 'DEPRIORITIZE', reasons: ['JUMP_PLATEAU'] };
  }
  // TRUE_LEADER paths.
  if (isNum(extensionAtr) && extensionAtr > EXTENSION.warnAtr) {
    reasons.push(`EXTENDED_${extensionAtr.toFixed(1)}_ATR_ABOVE_SMA20`);
    return { state: 'WAIT_FOR_PULLBACK', reasons };
  }
  if (absPath?.state === 'ORDERLY_PAUSE' || absPath?.state === 'JUMP_HOLDING') {
    reasons.push('CONSTRUCTIVE_CONSOLIDATION');
    return { state: 'BUY_ON_CONFIRMATION', reasons };
  }
  if (isNum(distSma20Atr) && Math.abs(distSma20Atr) <= 1.5 && arrows?.price !== 'DOWN' && arrows?.price !== 'DOWN2') {
    reasons.push('NEAR_RISING_SUPPORT');
    return { state: 'BUY_ZONE', reasons };
  }
  return { state: 'WATCH', reasons: ['LEADER_NOT_AT_ENTRY'] };
}

// ── Hysteresis ──────────────────────────────────────────────────────────────

/**
 * Apply streak-gated hysteresis to one arrow family.
 * prev = { level, upStreak, downStreak }. Hard invalidation (raw DOWN2)
 * passes through immediately.
 */
function applyArrowHysteresis(raw, prev) {
  if (raw == null) return { level: null, upStreak: 0, downStreak: 0 };
  if (!prev || prev.level == null || !LEVELS.includes(prev.level)) {
    return { level: raw, upStreak: 0, downStreak: 0 };
  }
  const cur = idx(prev.level), next = idx(raw);
  if (next === cur) return { level: prev.level, upStreak: 0, downStreak: 0 };
  if (next < cur) {
    if (raw === 'DOWN2' && HYSTERESIS.hardInvalidationImmediate) {
      return { level: raw, upStreak: 0, downStreak: 0 };            // hard break: immediate
    }
    const downStreak = (prev.downStreak || 0) + 1;
    if (downStreak >= HYSTERESIS.downgradeStreak) return { level: raw, upStreak: 0, downStreak: 0 };
    return { level: prev.level, upStreak: 0, downStreak };
  }
  const upStreak = (prev.upStreak || 0) + 1;
  if (upStreak >= HYSTERESIS.upgradeStreak) return { level: raw, upStreak: 0, downStreak: 0 };
  return { level: prev.level, upStreak, downStreak: 0 };
}

/**
 * Full arrow block for a card. prevState is the stored per-name hysteresis
 * state from the previous snapshot (or null on first sight).
 */
function arrowsFor({ trend, absPath, residualByHorizon, combined, prevState, alert }) {
  const raw = {
    price: priceArrowRaw({ trend, absPath }),
    vsMarket: relativeArrowRaw(residualByHorizon, 'marketRel'),
    vsSector: relativeArrowRaw(residualByHorizon, 'sectorRel'),
  };
  const prev = prevState?.arrowState || {};
  const next = {};
  const state = {};
  for (const fam of ['price', 'vsMarket', 'vsSector']) {
    const applied = applyArrowHysteresis(raw[fam], prev[fam]);
    next[fam] = applied.level;
    state[fam] = applied;
  }
  const trajectory = trajectoryRaw({ combined, prevCombined: prevState?.combined, alert });
  return {
    arrows: { ...next, trajectory },
    raw,
    arrowState: state,
    glyphs: Object.fromEntries(
      Object.entries({ ...next, trajectory }).map(([k, v]) => [k, v == null ? '·' : GLYPH[v] || '→']),
    ),
  };
}

module.exports = {
  LEVELS, GLYPH, ENTRY_STATES,
  priceArrowRaw, relativeArrowRaw, trajectoryRaw, entryState,
  applyArrowHysteresis, arrowsFor,
};
