'use strict';
// NOVEL SIGNAL LAB — shared contract (nsl-v1).
//
// This module is the single source of truth for the Novel Signal Lab: the standard
// signal envelope every engine returns, the signal registry (the nine research
// hypotheses), and the provider registry (what external data each engine needs and
// whether this deployment can lawfully obtain it).
//
// CRITICAL HONESTY RULE (acceptance criterion): a missing provider yields an
// UNAVAILABLE envelope with score:null — NEVER a neutral zero. A zero is a claim
// ("no signal"); UNAVAILABLE is the truth ("we cannot see"). Callers must treat the
// two differently. This module is pure, deterministic, dependency-free (no network,
// no clock, no store); the as-of timestamp is always supplied by the caller.

const NSL_VERSION = 'nsl-v1';

// Usability of a produced signal.
const STATUS = Object.freeze({
  USABLE: 'usable',            // real data present, score is meaningful
  UNAVAILABLE: 'unavailable',  // required provider absent — score is null, do NOT treat as zero
  EXPERIMENTAL: 'experimental',// runs, but incremental value is unproven; shadow-only, never gates
});

// Directions are signed; 0 = neutral/undetermined. Sign is "expected effect on the
// equity over the signal's horizon" (positive = bullish), NOT the raw metric sign.
const DIRECTION = Object.freeze({ LONG: 1, NEUTRAL: 0, SHORT: -1 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const orNull = (v) => (v === undefined ? null : v);
const clamp01 = (v) => (isNum(v) ? Math.max(0, Math.min(1, v)) : null);

// ── The standard signal envelope ────────────────────────────────────────────
// Every engine returns exactly this shape (frozen). The fields mirror the spec's
// "standard envelope" list so the panel and evaluators can consume any signal
// uniformly without knowing which engine produced it.
function makeEnvelope(input = {}) {
  const status = input.status || STATUS.USABLE;
  const usable = status === STATUS.USABLE;
  const env = {
    schema: 'NslSignal',
    version: NSL_VERSION,
    signal: orNull(input.signal),               // signal name, e.g. 'informed_short_pressure'
    signalVersion: input.signalVersion || null, // engine version, e.g. 'short-pressure-v1'
    engine: orNull(input.engine),               // engine number 1..9
    securityId: orNull(input.securityId),
    ticker: orNull(input.ticker),
    asOf: orNull(input.asOf),                    // decision timestamp (caller-supplied)
    // Provenance: raw inputs and the publication timestamp of each source used.
    inputs: input.inputs && typeof input.inputs === 'object' ? input.inputs : {},
    sourceTimestamps: input.sourceTimestamps && typeof input.sourceTimestamps === 'object' ? input.sourceTimestamps : {},
    // Measurement.
    score: usable ? orNull(input.score) : null,           // null unless usable
    direction: isNum(input.direction) ? Math.sign(input.direction) : DIRECTION.NEUTRAL,
    confidence: clamp01(input.confidence),                // 0..1, null if unknown
    coverage: clamp01(input.coverage),                    // fraction of required inputs present
    staleness: orNull(input.staleness),                   // { ageDays, publishedTs } — how old the freshest input is
    expectedDecay: orNull(input.expectedDecay),           // { halfLifeDays, reversal } — how fast the edge fades
    historicalSupport: orNull(input.historicalSupport),   // { n, note } — how many analogous states exist
    // Honesty metadata.
    warnings: Array.isArray(input.warnings) ? input.warnings.slice() : [],
    restrictions: orNull(input.restrictions),             // provider/license restriction note
    status,                                                // usable | unavailable | experimental
  };
  // Deep-freeze the leaf containers so a downstream consumer cannot mutate provenance.
  Object.freeze(env.inputs); Object.freeze(env.sourceTimestamps); Object.freeze(env.warnings);
  return Object.freeze(env);
}

// Convenience: an UNAVAILABLE envelope. Score is null by construction.
function unavailable(signal, { engine, ticker, securityId, asOf, reason, provider, restrictions } = {}) {
  return makeEnvelope({
    signal, engine, ticker, securityId, asOf,
    status: STATUS.UNAVAILABLE,
    coverage: 0,
    warnings: [reason || 'required data unavailable'].concat(provider ? [`provider:${provider}`] : []),
    restrictions: restrictions || (provider ? `requires provider ${provider}` : null),
  });
}

// ── Signal registry: the nine engines ───────────────────────────────────────
// `providers` lists the provider ids (see PROVIDER_REGISTRY) an engine needs; an
// engine is at best only as available as its providers. `feasible` records whether
// ANY real data path exists on the free/serverless stack (documentation, not a gate).
const SIGNAL_REGISTRY = Object.freeze([
  { engine: 1, key: 'short_pressure', version: 'short-pressure-v1',
    title: 'Securities-lending & short-pressure', family: 'positioning',
    providers: ['finra_si', 'sec_ftd', 'borrow_fee'], feasible: 'partial',
    signals: ['informed_short_pressure', 'short_crowding', 'squeeze_probability', 'covering_intensity', 'borrow_constraint', 'short_signal_age', 'short_data_quality', 'short_signal_confidence'] },
  { engine: 2, key: 'insider_conviction', version: 'insider-conviction-v1',
    title: 'Opportunistic insider conviction', family: 'insider',
    providers: ['sec_form4'], feasible: 'full',
    signals: ['insider_conviction', 'opportunistic_purchase_probability', 'cluster_buy_strength', 'routine_trade_probability', 'insider_signal_conflict', 'insider_signal_age', 'insider_data_quality'] },
  { engine: 3, key: 'mechanical_flow', version: 'mechanical-flow-v1',
    title: 'Predictable mechanical flow', family: 'flow',
    providers: ['dividend_cal', 'ipo_lockup', 'index_recon', 'buyback_window'], feasible: 'partial',
    signals: ['mechanical_demand', 'mechanical_supply', 'flow_pressure_ratio', 'flow_peak_time', 'flow_decay', 'reversal_probability', 'flow_capacity', 'flow_data_quality'] },
  { engine: 4, key: 'operating_nowcast', version: 'operating-nowcast-v1',
    title: 'Real-time operating-activity nowcast', family: 'altdata',
    providers: ['jobs_feed', 'app_rank', 'web_traffic'], feasible: 'none',
    signals: ['operating_acceleration', 'hiring_impulse', 'demand_nowcast', 'operating_inflection', 'nowcast_surprise', 'nowcast_staleness', 'nowcast_coverage', 'nowcast_quality'] },
  { engine: 5, key: 'capital_structure', version: 'capital-structure-v1',
    title: 'Capital-structure divergence', family: 'cross-asset',
    providers: ['bond_spread', 'cds_spread', 'credit_rating'], feasible: 'none',
    signals: ['credit_equity_divergence', 'credit_lead_signal', 'refinancing_pressure', 'capital_structure_stress', 'credit_improvement', 'cross_asset_consistency', 'capital_structure_coverage', 'capital_structure_confidence'] },
  { engine: 6, key: 'accounting_forensics', version: 'accounting-forensics-v1',
    title: 'Structured accounting-transition forensics', family: 'accounting',
    providers: ['sec_xbrl'], feasible: 'full',
    signals: ['accrual_transition', 'working_capital_stress', 'revenue_quality_change', 'cash_conversion_change', 'capitalization_anomaly', 'share_dilution_pressure', 'structured_reporting_anomaly', 'accounting_transition_confidence'] },
  { engine: 7, key: 'representation', version: 'representation-v1',
    title: 'Chronological self-supervised representation', family: 'ml',
    providers: [], feasible: 'experimental',
    signals: ['representation_version', 'pretraining_cutoff', 'pretraining_dataset_hash', 'representation_drift', 'representation_coverage', 'representation_quality'] },
  { engine: 8, key: 'historical_twin', version: 'historical-twin-v1',
    title: 'Counterfactual historical-twin estimation', family: 'analog',
    providers: [], feasible: 'full',
    signals: ['twin_count', 'twin_median_outcome', 'twin_upside_q', 'twin_downside_q', 'twin_similarity', 'twin_out_of_support', 'twin_balance', 'twin_sensitivity'] },
  { engine: 9, key: 'invariance', version: 'invariance-v1',
    title: 'Invariant-mechanism selector', family: 'meta',
    providers: [], feasible: 'full',
    signals: ['invariance_score', 'environment_coverage', 'effect_direction_consistency', 'effect_heterogeneity', 'mechanism_confidence', 'fragility_score'] },
]);

function signalMeta(engineOrKey) {
  return SIGNAL_REGISTRY.find(s => s.engine === engineOrKey || s.key === engineOrKey) || null;
}

module.exports = {
  NSL_VERSION, STATUS, DIRECTION,
  makeEnvelope, unavailable,
  SIGNAL_REGISTRY, signalMeta,
  clamp01, isNum,
};
