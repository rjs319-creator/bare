'use strict';
// STRATEGY PROMOTION GATE — the single, centrally-enforced authority on whether a
// strategy/signal class is allowed to influence LIVE recommendations (Today's Picks,
// Game Plan conviction, portfolio allocation).
//
// WHY THIS EXISTS: options flow, put-selling, and other overlays are research-grade
// until they earn their way out via leakage-resistant, prospective, cost-aware
// evidence. Historically the only thing stopping an unproven overlay from moving live
// trades was scattered wording in the UI and normalizers. Wording is not a control:
// renaming a card "confirmed" must NEVER promote a strategy. This module makes the
// decision from the registry's structured `maturity` field ONLY, so promotion is an
// explicit, reviewable data change — not a side effect of copy edits.
//
// STATUSES (registry `maturity`):
//   production   — validated; MAY create/boost live trades.
//   shadow       — runs live in shadow/confirmation mode; MUST NOT originate or boost
//                  a live trade. Graded prospectively; promoted only via PROMOTION_GATE.
//   experimental — Research-Lab-only; not wired into anything live.
//   rejected     — evaluated and found to add no leakage-resistant edge; kept off.
//
// Default when a registry entry omits `maturity`: 'production' (preserves the historic
// behavior of the backbone screeners, which are already validated/core). New overlays
// MUST be added with an explicit non-production maturity.

const { STRATEGY_REGISTRY } = require('./strategy-registry');

const STATUSES = ['production', 'shadow', 'experimental', 'rejected'];
const DEFAULT_STATUS = 'production';

// Build a lookup once. Kept as a function of the registry array so tests can pass a
// custom registry without touching module state.
function indexRegistry(registry = STRATEGY_REGISTRY) {
  const m = new Map();
  for (const e of registry || []) {
    if (e && e.id) m.set(e.id, e);
  }
  return m;
}

const _index = indexRegistry();

// Normalize/validate a maturity value. Unknown values fail CLOSED (treated as shadow)
// so a typo can never accidentally grant live-trade eligibility.
function normalizeStatus(raw) {
  if (raw == null) return DEFAULT_STATUS;
  const s = String(raw).toLowerCase();
  return STATUSES.includes(s) ? s : 'shadow';
}

// The strategy's maturity/status. Unknown id → 'shadow' (fail closed): a source that
// isn't registered cannot be assumed validated.
function statusOf(id, registry) {
  const idx = registry ? indexRegistry(registry) : _index;
  const e = idx.get(id);
  if (!e) return 'shadow';
  return normalizeStatus(e.maturity);
}

// THE GATE: may this strategy id create or boost a LIVE trade? True only for
// explicitly-production strategies. Everything else (shadow/experimental/rejected/
// unregistered) is blocked. This is what the decision normalizers consult.
function isTradeEligible(id, registry) {
  return statusOf(id, registry) === 'production';
}

// Promotion criteria — the predefined bar an overlay must clear to move from shadow to
// production. Documented here (not enforced by wording) so the record is auditable; a
// governance job flips `maturity` in the registry only after these are met on
// independent, prospective, cost-aware evidence.
const PROMOTION_GATE = Object.freeze({
  minResolvedEpisodes: 50,        // mature, independently-dated decision episodes
  minIndependentDates: 20,        // distinct decision dates (guards overlapping outcomes)
  incrementalExcessReturn: true,  // must beat the base price/momentum/sector/regime model
  calibrationBeatsBaseRate: true, // Brier + calibration error better than base-rate benchmark
  costAware: true,                // net of modeled transaction cost + slippage
  regimeRobust: true,             // not concentrated in a single regime
  confidenceInterval: true,       // reported CI excludes zero incremental value
});

module.exports = {
  STATUSES, DEFAULT_STATUS, PROMOTION_GATE,
  statusOf, isTradeEligible, normalizeStatus, indexRegistry,
};
