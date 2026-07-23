'use strict';
// ATLAS-X — central configuration, versions and tunable constants.
//
// One module so every layer stamps the SAME immutable version strings onto its
// output (governance/provenance depend on this) and so promotion is a reviewable
// data change, never scattered magic numbers. ATLAS-X = Adaptive Transition,
// Liquidity, Allocation and Survival swing engine. It is a SHADOW challenger:
// nothing here grants live-trade eligibility — that is enforced centrally by
// lib/strategy-gate.js from the registry `maturity` field.

const STRATEGY_ID = 'atlasx';

// Versions — bump when the math of a layer changes so old episodes stay honest
// about which engine produced them (never rewrite a prior prediction).
const VERSIONS = Object.freeze({
  strategy: 'atlasx-v1',
  residual: 'atlasx-residual-v1',
  transition: 'atlasx-transition-v1',
  path: 'atlasx-path-v1',
  experts: 'atlasx-experts-v1',
  router: 'atlasx-router-v1',
  ranking: 'atlasx-ranking-v1',
  survival: 'atlasx-survival-v1',
  prosecutor: 'atlasx-prosecutor-v1',
  entry: 'atlasx-entry-v1',
  utility: 'atlasx-utility-v1',
  portfolio: 'atlasx-portfolio-v1',
  execution: 'exec-v1',            // reused from lib/execution-policy.js
  contract: 'atlasx-contract-v1',
});

// Residual horizons (completed sessions) over which we measure residual return.
const RESIDUAL_HORIZONS = Object.freeze([1, 3, 5, 10, 20, 63]);

// Barrier geometry DEFAULTS. Per-expert overrides live in atlasx-experts.js —
// a compression breakout, catalyst drift and first pullback must NOT be forced
// into identical geometry. ATR-relative so a volatile name gets wider barriers.
const BARRIERS = Object.freeze({
  targetAtr: 1.5,     // +1.5 ATR default target
  stopAtr: 1.0,       // -1.0 ATR default stop (or structural invalidation, whichever binds)
  timeoutSessions: 10, // matches MAX_AGE_BARS.swing in evolve-labels.js
});

// Default holding window (completed sessions) for a swing episode.
const HOLDING_WINDOW = 10;

// Gap that is too large to chase at next open (fraction of prior close).
const MAX_CHASE_GAP = 0.05;

// Actionability hurdles. A candidate becomes actionable ONLY when its
// conservative lower bound clears these — otherwise ATLAS-X abstains (shows
// nothing rather than a weak pick).
const HURDLES = Object.freeze({
  minRemainingRR: 1.2,        // remaining reward-to-risk must exceed this
  minNetUtilityBps: 25,       // expected net residual utility (bps) lower bound
  maxFailureScore: 0.65,      // prosecutor failure score above this → not actionable
  minExpertApplicability: 0.4,
  maxDataStaleSessions: 2,    // freshness: no older than N sessions
  minLiquidityDollarVol: 2_000_000, // tradeable $ volume floor (matches universe floor)
});

// Portfolio construction caps (shadow book — never trades real money).
const PORTFOLIO = Object.freeze({
  maxPositions: 12,
  maxPerSector: 3,
  maxPerExpert: 4,
  maxCorrelationCluster: 3,
  minWeight: 0.0,             // WEIGHT-0: shadow. Enforced by strategy-gate, asserted here.
});

// Regimes ATLAS-X permits each expert to operate in. Red-tape reversal is
// disabled outside a documented red/risk-off regime (validated-only).
const PERMITTED = Object.freeze({
  redTapeRequiresRiskOff: true,
});

// Model-health lifecycle states (drift monitor). A degrading SHADOW model stays
// shadow; these never auto-promote and never aggressively self-retrain.
const HEALTH_STATES = Object.freeze(
  ['BUILDING', 'HEALTHY', 'DEGRADING', 'BROKEN', 'INSUFFICIENT_DATA']);

// Calibration gate — until an out-of-fold calibration artifact clears this, every
// probability-like number is surfaced as an "experimental score" or qualitative
// band, NEVER a percentage. Consumed by atlasx-contracts + the UI.
const CALIBRATION = Object.freeze({
  minSamplesForBands: 30,
  minSamplesForPercent: 200,   // never display % below this AND without a passing artifact
});

// Storage namespace — its OWN prefix so ATLAS-X never collides with the live
// swing supervisor's `swing/*` store. Reuses the same engine, separate namespace.
const STORE = Object.freeze({
  ns: 'atlasx',
  latest: 'atlasx/latest.json',
  episodes: 'atlasx/episodes.json',
  board: 'atlasx/board.json',
  resolved: 'atlasx/resolved.json',
  capture: 'atlasx/capture.json',
  predictions: 'atlasx/predictions.json',
  health: 'atlasx/health.json',
  calibration: 'atlasx/calibration.json',
  ledgerStream: 'atlasx',        // immutable-ledger stream name → ledger/atlasx/*
});

module.exports = {
  STRATEGY_ID,
  VERSIONS,
  RESIDUAL_HORIZONS,
  BARRIERS,
  HOLDING_WINDOW,
  MAX_CHASE_GAP,
  HURDLES,
  PORTFOLIO,
  PERMITTED,
  HEALTH_STATES,
  CALIBRATION,
  STORE,
};
