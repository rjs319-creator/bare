'use strict';
// ── Evidence-negative lanes (2026-09-09 alpha pass) ─────────────────────────
// Derives, from the persisted Scoreboard summary, the section:tier:scope lanes whose
// realized cost-net record is proven negative — so user-facing candidate surfaces
// (Quick Hit, Opportunities, section tabs) can label them "excluded control" instead
// of printing a trade plan. Never a hardcoded list: the ledger decides, and a lane
// leaves the set the moment its record stops meeting every gate.
//
// Gates (all must hold, at the strategy's OWN contract horizon — never the worst of 7):
//   1. long-side contract (a short-side section's negative long-basis record is its design);
//   2. date-level cost-net CI95 entirely below zero;
//   3. ≥ MIN_EFFECTIVE_DATES autocorrelation-adjusted independent decision dates
//      (the 2026-09-09 BH-FDR survivors all carried ≥14; 8 is where the rank tilt
//      starts acting, this is a stricter bar because the consequence is exclusion);
//   4. ≤ MAX_POSITIVE_BLOCKS of 4 chronological blocks positive (not one bad month);
//   5. at least one ADJACENT horizon (the neighbour on either side) is also CI-negative
//      over ≥ MIN_ADJACENT_DATES — a single-bar artefact cannot exclude a lane.
//
// Pure: no I/O, no mutation. Consumers join on laneKey(section, tier, scope).
const SC = require('./strategy-contracts');

const HORIZON_ORDER = Object.freeze(['1d', '3d', '5d', '10d', '20d', '1m', '3m']);
const MIN_EFFECTIVE_DATES = 15;
const MIN_ADJACENT_DATES = 8;
const MAX_POSITIVE_BLOCKS = 1;
const DEFAULT_METRIC = '5d';

function laneKey(section, tier, scope) {
  return `${section || ''}:${tier || ''}:${scope || ''}`;
}

function contractMetric(section) {
  const c = SC.contractForSection(section);
  if (c && c.metric) return { metric: c.metric, basis: 'contract', side: c.side || 'long' };
  return { metric: DEFAULT_METRIC, basis: 'generic-fallback (no contract)', side: 'long' };
}

function dateStats(h) {
  const d = h && h.dateNet;
  if (!d || !d.ci95 || !Number.isFinite(d.ci95.lo) || !Number.isFinite(d.ci95.hi)) return null;
  const effectiveN = Number.isFinite(d.effectiveN) ? d.effectiveN : (Number.isFinite(d.n) ? d.n : null);
  if (effectiveN == null) return null;
  const bs = d.blockStability;
  const positiveBlocks = bs && bs.usable && Number.isFinite(bs.positive) ? bs.positive : null;
  return { lo: d.ci95.lo, hi: d.ci95.hi, effectiveN, positiveBlocks, avg: Number.isFinite(d.avg) ? d.avg : null };
}

function adjacentKeys(metric) {
  const i = HORIZON_ORDER.indexOf(metric);
  if (i < 0) return [];
  return [HORIZON_ORDER[i - 1], HORIZON_ORDER[i + 1]].filter(Boolean);
}

function evaluateLane(group, opts) {
  const { metric, basis, side } = contractMetric(group.section);
  if (side === 'short') return null;
  const h = group.horizons && group.horizons[metric];
  const ds = dateStats(h);
  if (!ds) return null;
  if (!(ds.hi < 0)) return null;
  if (ds.effectiveN < opts.minEffectiveDates) return null;
  if (ds.positiveBlocks != null && ds.positiveBlocks > opts.maxPositiveBlocks) return null;
  const adjacentNegative = adjacentKeys(metric).filter((k) => {
    const a = dateStats(group.horizons[k]);
    return !!(a && a.hi < 0 && a.effectiveN >= opts.minAdjacentDates);
  });
  if (!adjacentNegative.length) return null;
  const key = laneKey(group.section, group.tier, group.scope);
  const avgNetExcess = Number.isFinite(h.avgNetExcess) ? h.avgNetExcess : null;
  return {
    key, section: group.section, tier: group.tier, scope: group.scope || null,
    metric, metricBasis: basis,
    avgNetExcess, dateAvg: ds.avg, ci95: { lo: ds.lo, hi: ds.hi },
    effectiveDates: ds.effectiveN, positiveBlocks: ds.positiveBlocks, adjacentNegative,
    reason: `${key}: date-level cost-net CI95 [${ds.lo}, ${ds.hi}] at the ${metric} contract over ${ds.effectiveN} independent dates`
      + (ds.positiveBlocks != null ? `, ${ds.positiveBlocks}/4 positive blocks` : '')
      + `; ${adjacentNegative.join('/')} also CI-negative — evidence-negative lane, excluded control`,
  };
}

// → array of lane records (sorted by key for stable output). Empty when nothing qualifies.
function negativeLanes(summary, overrides = {}) {
  const opts = {
    minEffectiveDates: MIN_EFFECTIVE_DATES, minAdjacentDates: MIN_ADJACENT_DATES,
    maxPositiveBlocks: MAX_POSITIVE_BLOCKS, ...overrides,
  };
  const groups = (summary && Array.isArray(summary.groups)) ? summary.groups : [];
  return groups
    .filter(g => g && g.section && g.tier && g.horizons)
    .map(g => evaluateLane(g, opts))
    .filter(Boolean)
    .sort((a, b) => a.key.localeCompare(b.key));
}

function findLane(lanes, section, tier, scope) {
  if (!Array.isArray(lanes)) return null;
  const key = laneKey(section, tier, scope);
  return lanes.find(l => l && l.key === key) || null;
}

module.exports = {
  HORIZON_ORDER, MIN_EFFECTIVE_DATES, MIN_ADJACENT_DATES, MAX_POSITIVE_BLOCKS,
  laneKey, negativeLanes, findLane,
};
