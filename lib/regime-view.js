'use strict';
// ONE REGIME VIEW FOR EVERY RENDER (site audit 2026-10-02 #6).
//
// The Today page contradicted itself: the header said "The market is RISK-ON" (op=tape →
// lib/macro.js, a VIX + credit read) while the board four lines below said "Risk-off · breadth
// 22%" (op=today → the screener's SPY-200DMA + breadth read). Both are legitimate, different
// measurements that were both labelled "regime". This module is the single composer every
// route serves and every render reads:
//
//   governing  the regime that actually GATES decisions — the screener's breadth read, because
//              it is what lib/decision rankSignals / eligibility consume to stand down longs
//              (regime.bearish / riskOn). Null when the caller has no breadth read (op=tape).
//   breadth    the screener read, with its server-latched trend component (`latched` = the
//              session-debounced SPY-200DMA state, `raw` = the same-day read).
//   macro      the VIX + credit read, labelled as MACRO RISK — never as "the regime".
//   agree      whether the two reads currently say the same thing; `note` spells out the
//              disagreement and which one governs.
//
// Pure. Label vocabulary lives here so a render can never invent its own.

const REGIME_VIEW_VERSION = 'regime-view-v1';

const LEVELS = Object.freeze(['risk-off', 'neutral', 'risk-on']);
const LABEL = Object.freeze({ 'risk-off': 'Risk-off', neutral: 'Neutral', 'risk-on': 'Risk-on' });
const BREADTH_LABEL = 'Breadth regime';
const BREADTH_BASIS = 'SPY vs 200-DMA + share of names above their 50-DMA (gates new longs)';
const MACRO_LABEL = 'Macro risk';
const MACRO_BASIS = 'VIX level/percentile + HYG/LQD credit trend (context, does not gate)';

const isObj = v => v && typeof v === 'object';
const levelOf = v => (LEVELS.includes(v) ? v : null);

// The screener regime block (lib/swing-screener-engine computeRegime) → level.
function breadthLevel(b) {
  if (!isObj(b)) return null;
  if (b.bearish === true || b.riskOff === true) return 'risk-off';
  if (b.riskOn === true) return 'risk-on';
  if (b.bearish === false || b.riskOn === false || b.breadthPct != null || b.indexAbove200 != null) return 'neutral';
  return null;
}

// Accepts a lib/macro state ({ regime, macroRisk, vix }), an op=tape payload ({ regime, macro })
// or a bare level string.
function macroOf(m) {
  if (typeof m === 'string') return levelOf(m) ? { regime: levelOf(m), macroRisk: null, vixLevel: null } : null;
  if (!isObj(m)) return null;
  const inner = isObj(m.macro) ? m.macro : m;
  const regime = levelOf(inner.regime) || levelOf(m.regime);
  if (!regime) return null;
  return {
    regime,
    macroRisk: Number.isFinite(inner.macroRisk) ? inner.macroRisk : null,
    vixLevel: isObj(inner.vix) && Number.isFinite(inner.vix.level) ? inner.vix.level : (Number.isFinite(inner.vixLevel) ? inner.vixLevel : null),
  };
}

const latchLevel = v => (v === 'RISK_OFF' ? 'risk-off' : v === 'RISK_ON' ? 'risk-on' : v === 'NEUTRAL' ? 'neutral' : null);

/**
 * composeRegimeView({ breadth, macro })
 *   breadth  screener regime block or null
 *   macro    lib/macro state, op=tape payload, or level string, or null
 */
function composeRegimeView({ breadth = null, macro = null } = {}) {
  const bLevel = breadthLevel(breadth);
  const m = macroOf(macro);
  const breadthBlock = bLevel ? {
    regime: bLevel, label: LABEL[bLevel], kind: BREADTH_LABEL, basis: BREADTH_BASIS,
    breadthPct: Number.isFinite(breadth.breadthPct) ? breadth.breadthPct : null,
    indexAbove200: typeof breadth.indexAbove200 === 'boolean' ? breadth.indexAbove200 : null,
    latched: latchLevel(breadth.active), raw: latchLevel(breadth.raw),
    condition: breadth.condition || null,
  } : null;
  const macroBlock = m ? { regime: m.regime, label: LABEL[m.regime], kind: MACRO_LABEL, basis: MACRO_BASIS, macroRisk: m.macroRisk, vixLevel: m.vixLevel } : null;
  const governing = breadthBlock
    ? { regime: bLevel, label: LABEL[bLevel], basis: 'breadth', why: 'the breadth regime is what the ranker and the eligibility gate consume to stand down new longs' }
    : null;
  const agree = breadthBlock && macroBlock ? breadthBlock.regime === macroBlock.regime : null;
  let note = null;
  if (agree === false) note = `${MACRO_LABEL} (VIX + credit) reads ${macroBlock.regime} while the breadth regime reads ${bLevel} — the breadth regime governs new longs; the macro read is context.`;
  else if (!breadthBlock && macroBlock) note = `${MACRO_LABEL} only — the breadth regime that gates entries is served by op=today.`;
  return { version: REGIME_VIEW_VERSION, governing, breadth: breadthBlock, macro: macroBlock, agree, note };
}

module.exports = { REGIME_VIEW_VERSION, LEVELS, LABEL, BREADTH_LABEL, MACRO_LABEL, composeRegimeView, breadthLevel, macroOf };
