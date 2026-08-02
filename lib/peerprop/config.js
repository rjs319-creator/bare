'use strict';
// 🕸 PEER PROPAGATION — configuration and versions.
//
// The engine models each stock as a node in point-in-time peer networks and asks
// whether information has begun propagating from related names toward it BEFORE its
// own tape makes that obvious. Two networks ship in v1 (no premium data required):
//   1. sector × liquidity-band peers (reuses lib/rlt-universe.buildPeerUniverse)
//   2. a statistical directed leader→follower graph estimated ONLY from past
//      market/sector-residual returns (lib/peerprop/graph.js)
// Customer–supplier, shared-analyst-coverage and 13F-similarity networks need
// point-in-time relationship data this repo does not have; they are declared as
// disabled feature flags here rather than simulated.
//
// Everything is shadow-only: the engine never touches live ranks, and its
// probabilities stay null until empirical out-of-fold calibration has the sample
// (CALIBRATION.minSamplesForPercent) — a hand-written score→probability map is
// exactly the failure mode this system exists to avoid.

const VERSIONS = Object.freeze({
  engine: 'peerprop-v1',
  graph: 'peerprop-graph-v1',
  features: 'peerprop-features-v1',
});

// Directed-graph estimation policy. Edges are estimated within peer groups only
// (never all-to-all across the market) from residual daily returns, with
// Fisher-z shrinkage toward zero so a short overlapping sample cannot mint a
// strong edge. Both thresholds act on the SHRUNK statistic.
const GRAPH_POLICY = Object.freeze({
  window: 150,          // trailing sessions of residual returns per name (cache holds ~300)
  maxLag: 3,            // leader leads by 1..maxLag sessions
  minObs: 60,           // aligned return pairs required before an edge may exist
  shrinkK: 60,          // z-shrink factor: z * n/(n+shrinkK)
  minLeadCorr: 0.12,    // shrunk lead correlation floor for a candidate edge
  minAntisym: 0.06,     // directed (lead − follow) component floor — the alpha-relevant part
  maxEdgesPerFollower: 8,   // keep only the strongest confirmed leaders per follower
  maxGroupSize: 60,     // cap pairwise estimation per group (by dollar volume)
});

// Peer-feature policy. Aggregation is robust (median / MAD) so one extreme peer
// cannot dominate a group read, and a group below minPeers yields nulls rather
// than false-precision aggregates.
const FEATURE_POLICY = Object.freeze({
  minPeers: 5,
  momentumHorizons: Object.freeze([5, 21, 63]),
  impulseWindow: 10,    // sessions over which a leader "impulse" is measured
  lateOwnMovePct: 8,    // own 21d residual move beyond which the signal is LATE
  reactionScale: 2,     // z-units of own move treated as "fully reacted"
});

// Empirical-calibration gates — mirrors rlt-config.CALIBRATION conventions.
// Below minSamplesForPercent the engine refuses to display any probability.
const CALIBRATION = Object.freeze({
  minSamplesForBands: 30,
  minSamplesForPercent: 200,
});

// Premium-dependent networks: declared, flagged, DISABLED. The engine reports
// these as unavailable instead of substituting fabricated relationships.
const NETWORKS = Object.freeze({
  sectorBandPeers: { enabled: true, source: 'lib/rlt-universe (curated sector map, present-day)' },
  statisticalLeaders: { enabled: true, source: 'lib/peerprop/graph (residual lead/lag, PIT)' },
  customerSupplier: { enabled: false, reason: 'no point-in-time supply-chain relationship feed' },
  sharedAnalystCoverage: { enabled: false, reason: 'historical analyst coverage not available on current data tier' },
  institutionalHoldings: { enabled: false, reason: '13F history is Ultimate-tier gated (see FMP tier probe)' },
});

const STORE = Object.freeze({
  latest: 'peerprop/latest.json',          // excluded from the daily-ledger regex on purpose
  ledgerPrefix: 'peerprop/',               // peerprop/YYYY-MM-DD.json pick ledger
});

const STRATEGY_ID = 'peerlab';
const SECTION = 'PeerProp';

module.exports = {
  VERSIONS, GRAPH_POLICY, FEATURE_POLICY, CALIBRATION, NETWORKS, STORE,
  STRATEGY_ID, SECTION,
};
