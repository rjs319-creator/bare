'use strict';
// SCOPED EVIDENCE IDENTITY (swing defect #5 — scope-contaminated track records).
//
// THE DEFECT THIS CLOSES. Large-, small- and micro-cap Setup/Breakout/Early rows
// were pooled under one `section:tier` Scoreboard group, and expectancyFor joined
// signals to that pooled record — so a strong LARGE-cap Breakout history silently
// raised (or a weak micro history depressed) a SMALL-cap candidate's rank. Those
// are different strategies on different populations; their evidence must not pool.
//
// THE CONTRACT. Realized-outcome evidence is keyed by the full evidence identity:
//   strategyId          — the registry id / Scoreboard section that produced it
//   scoringVersion      — evidence resets when scoring changes (governance rule)
//   universeScope       — large | small | micro | expanded | biotech | null
//   setupTier           — Breakout/Setup/Early/GHOST/… (the outcome-relevant tier)
//   horizon             — resolved per-metric (5d/1m/…), carried by the metric axis
//   side                — long | short
//   executionPolicyVersion / labelVersion — stamped at the summary level (all
//   records in one summary share one execution + label contract version)
// Human-readable `section`/`tier` remain DISPLAY labels; this key is the join.
//
// POOLING RULE. Scopes may only pool when a formally validated hierarchical model
// earns it — no such model exists, so `mayPool` is hard false and shipped as data
// (a wording edit can never turn pooling on).
//
// MIGRATION. Summaries written before this module carry no `evidenceKeyVersion`;
// consumers treat those as LEGACY: they may be displayed as historical context,
// but a scoped lookup against a legacy summary returns buildingEvidence (neutral
// tilt) rather than silently borrowing the pooled record.

const EVIDENCE_KEY_VERSION = 'scoped-v1';
const EVIDENCE_KEY_FIELDS = Object.freeze([
  'strategyId', 'scoringVersion', 'universeScope', 'setupTier', 'horizon', 'side',
  'executionPolicyVersion', 'labelVersion',
]);
const MAY_POOL_SCOPES = false;   // requires a validated hierarchical model — none exists

// Canonical group key for realized-outcome aggregation. Horizon is intentionally
// NOT in the group key — each group carries a per-horizon metric axis, and the
// lookup selects the exact horizon metric (strict, no substitution).
function evidenceGroupKey({ strategyId, tier, scope, side } = {}) {
  return [
    strategyId || '',
    tier || '',
    scope || '',                       // '' = the record predates scoping (legacy)
    side === 'short' ? 'short' : 'long',
  ].join('|');
}

// Does a live signal's identity match an aggregated group's identity?
// Scope semantics: both null → match (scope-less strategies like momentum);
// signal scoped + group scoped → exact match; any scoped/unscoped mix → NO match
// (legacy evidence must never tilt a scoped candidate, and vice versa).
function evidenceMatches(sig, group) {
  if (!sig || !group) return false;
  if ((sig.strategyId || '') !== (group.strategyId || '')) return false;
  if ((sig.tier || '') !== (group.tier || '')) return false;
  const sSide = sig.side === 'short' ? 'short' : 'long';
  const gSide = group.side === 'short' ? 'short' : 'long';
  if (sSide !== gSide) return false;
  return (sig.scope || null) === (group.scope || null);
}

module.exports = { EVIDENCE_KEY_VERSION, EVIDENCE_KEY_FIELDS, MAY_POOL_SCOPES, evidenceGroupKey, evidenceMatches };
