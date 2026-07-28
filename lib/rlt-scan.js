// ═══════════════════════════════════════════════════════════════════════════
// RLT scan — the pure cross-sectional pipeline, one call per decision session.
//
//   peer universe → leadership → per-name features → sector state
//   → Stage A rank → inventory states → utility/abstention → cross-section
//
// No I/O here: routes load candles/episodes and persist results. Determinism:
// same inputs ⇒ same output (no clocks, no RNG).
// ═══════════════════════════════════════════════════════════════════════════

const { VERSIONS, LIVE_VERSIONS, rltGate, resolveRltMode } = require('./rlt-config');
const { buildPeerUniverse } = require('./rlt-universe');
const { buildLeadership } = require('./rlt-leadership');
const { computeRltFeatures } = require('./rlt-features');
const { buildSectorStates } = require('./rlt-sector-state');
const { flattenFeatures, stageACrossSection } = require('./rlt-stage-a');
const { deriveInventoryState, deriveEpisodeState, STATES, NOVICE_ACTION, diffStates } = require('./rlt-states');
const { decideRlt } = require('./rlt-utility');
const { triggerFamilyFor } = require('./rlt-stage-b');
const { bandForScore } = require('./atlasx-contracts');

/**
 * Run the full shadow scan.
 *
 * @param rows          universe input rows (see rlt-universe.buildPeerUniverse)
 * @param spyBars       SPY candles (also the session calendar)
 * @param sectorBarsFor (sector) → sector-ETF candles
 * @param asOf          decision session date
 * @param decisionTs    ISO decision timestamp
 * @param episodesByTicker  open supervisor episodes keyed by ticker (post-trigger states)
 * @param stageBByTicker    optional Stage-B assessments keyed by ticker
 * @param model         optional fitted Stage-A model artifact (may be null)
 * @param prevStates    prior session's states map (for transition diffs)
 * @param mode          RLT_MODE override (default from env)
 * @param artifact      optional calibration artifact for the gate
 */
function runRltScan({
  rows = [], spyBars = [], sectorBarsFor = () => [],
  asOf = null, decisionTs = null,
  episodesByTicker = {}, stageBByTicker = {},
  model = null, prevStates = {}, mode = resolveRltMode(), artifact = null,
  resolvedCount = 0,
} = {}) {
  const gate = rltGate({ mode, artifact });
  const RES = require('./atlasx-residual');
  const calendarDates = RES.asOfSlice(RES.toBars(spyBars), asOf).map(b => b.date);

  // 1. Point-in-time peer universe (fail-closed eligibility, labeled fallbacks).
  const universe = buildPeerUniverse({ rows, asOf, calendarDates, decisionTs });

  // 2. Cross-sectional leadership.
  const leadership = buildLeadership({ universe, spyBars, sectorBarsFor });

  // 3. Sector states (continuous vector + label).
  const sectorStates = buildSectorStates({ universe, leadership, sectorBarsFor, spyBars });

  // 4. Per-name features + Stage-A vector.
  const candidates = [];
  for (const r of universe.rows) {
    if (!r.eligible) continue;
    const lead = leadership.byTicker[r.ticker];
    if (!lead) continue;
    const features = computeRltFeatures({
      bars: r.bars,
      series: leadership.seriesByTicker[r.ticker] || [],
      catalyst: r.catalystRecord || null,
    });
    const sectorState = r.sector ? sectorStates.states[r.sector] || null : null;
    candidates.push({
      ticker: r.ticker, row: r, lead, features, sectorState,
      features_flat: flattenFeatures({ leadership: lead, features, sectorState }),
    });
  }

  // 5. Stage-A cross-section (rank + band; probability only behind the gate).
  const stageARows = stageACrossSection(
    candidates.map(c => ({ ticker: c.ticker, features: c.features_flat })),
    model, gate, { resolvedCount },
  );
  const stageAByTicker = new Map(stageARows.map(r => [r.ticker, r]));

  // 6. States: episode-derived first (post-trigger), else inventory-derived.
  const states = {};
  const inventory = [];
  for (const c of candidates) {
    const episode = episodesByTicker[c.ticker] || null;
    const stageB = stageBByTicker[c.ticker] || null;
    const epState = episode ? deriveEpisodeState(episode, stageB) : null;
    const inv = deriveInventoryState({ leadership: c.lead, features: c.features, sectorState: c.sectorState });
    const state = epState || inv.state;
    if (!state) continue;
    const stageARow = stageAByTicker.get(c.ticker) || null;
    const decision = decideRlt({
      state, stageB, leadership: c.lead, features: c.features, stageARow, gate,
      staleSessions: c.row.staleSessions, dollarVol: c.row.dollarVol,
    });
    const entry = {
      ticker: c.ticker,
      company: c.row.company || null,
      sector: c.row.sector,
      sectorEtf: c.row.sectorEtf || null,
      sectorState: c.sectorState ? c.sectorState.state : null,
      peerGroupId: c.row.peerGroupId,
      groupingLevel: c.row.groupingLevel,
      groupingFallback: c.row.groupingFallback,
      peerGroupSize: c.row.peerGroupSize,
      state,
      stateSource: epState ? 'episode-lifecycle' : 'inventory',
      novice: NOVICE_ACTION[state] || 'watch',
      reasonCodes: epState ? ['LIFECYCLE_DERIVED'] : inv.reasonCodes,
      cautions: inv.cautions,
      price: c.row.price,
      residualRank: c.lead.pctile,
      residualRankBand: c.lead.pctile != null ? bandForScore(c.lead.pctile) : null,
      rankVel5: c.lead.rankVel5,
      rankAccel: c.lead.rankAccel,
      transitionRank: stageARow ? stageARow.transitionRank : null,
      evidenceBand: stageARow ? stageARow.evidenceBand : null,
      calibrationStatus: stageARow ? stageARow.calibrationStatus : 'unavailable',
      triggerFamily: triggerFamilyFor({ setup: c.features.setup, leadership: c.lead }),
      decision,
      leadership: c.lead,
      features: c.features,
      missing: c.features.missing,
      staleSessions: c.row.staleSessions,
      universeSnapshotId: c.row.universeSnapshotId,
    };
    inventory.push(entry);
    states[c.ticker] = {
      state, reasonCodes: entry.reasonCodes, price: entry.price,
      residualRank: entry.residualRank, sectorState: entry.sectorState,
      triggerState: stageB && stageB.trigger ? 'triggered' : null,
      fillState: stageB && stageB.state === 'NO_FILL' ? 'no-fill' : null,
      dataFreshSessions: c.row.staleSessions,
    };
  }

  // 7. Transitions vs the prior session (published names never silently vanish —
  //    a drop emits an explicit DROPPED transition with reasons).
  const transitions = diffStates({ prev: prevStates, next: states, session: asOf, at: decisionTs });

  // 8. The full capture cross-section: selected + eligible-unselected +
  //    excluded — the learning loop needs the WHOLE funnel, not just picks.
  const inventoryTickers = new Set(inventory.map(e => e.ticker));
  const observations = universe.rows.map(r => ({
    ticker: r.ticker,
    eligible: r.eligible,
    exclusions: r.exclusions,
    missing: r.missing,
    selectionState: !r.eligible ? 'excluded'
      : inventoryTickers.has(r.ticker) ? 'in-inventory' : 'eligible-not-selected',
    state: states[r.ticker] ? states[r.ticker].state : null,
    peerGroupId: r.peerGroupId || null,
    groupingLevel: r.groupingLevel || null,
    sector: r.sector,
    price: r.price,
    dollarVol: r.dollarVol,
    staleSessions: r.staleSessions,
  }));

  const order = [STATES.ACCEPTED, STATES.TRIGGERED, STATES.ARMED, STATES.PRIMED,
    STATES.EMERGING_LEADER, STATES.DISCOVERED, STATES.WEAKENING,
    STATES.INVALIDATED, STATES.EXPIRED, STATES.COMPLETED];
  inventory.sort((a, b) => {
    const d = order.indexOf(a.state) - order.indexOf(b.state);
    if (d !== 0) return d;
    return (b.transitionRank ?? 0) - (a.transitionRank ?? 0);
  });

  const byState = {};
  for (const s of order) byState[s] = inventory.filter(e => e.state === s).map(e => e.ticker);

  return Object.freeze({
    versions: { ...VERSIONS, live: LIVE_VERSIONS },
    asOf, decisionTs,
    mode: gate.mode,
    gate,
    universeSnapshotId: universe.universeSnapshotId,
    coverage: universe.coverage,
    sectorStates,
    inventory,
    byState,
    states,
    transitions,
    observations,
    counts: {
      inventory: inventory.length,
      byState: Object.fromEntries(order.map(s => [s, byState[s].length])),
      abstained: inventory.filter(e => e.decision.action === 'ABSTAIN').length,
      actionable: inventory.filter(e => e.decision.action === 'ACTIONABLE_CANDIDATE').length,
    },
    governanceStatus: 'shadow',
    weight: 0,
  });
}

/**
 * Compact per-ticker leadership snapshot for injection into the ATLAS-X engine
 * (ctx.rltLeadership). Small on purpose: the expert needs the rank evidence
 * and pivot geometry, not the whole feature record.
 */
function compactLeadershipSnapshot(scan) {
  if (!scan || !Array.isArray(scan.inventory)) return null;
  const byTicker = {};
  for (const e of scan.inventory) {
    const setup = e.features && e.features.setup ? e.features.setup : {};
    byTicker[e.ticker] = {
      pctile: e.leadership ? e.leadership.pctile : null,
      rankVel5: e.leadership ? e.leadership.rankVel5 : null,
      rankAccel: e.leadership ? e.leadership.rankAccel : null,
      crossHorizonAgreement: e.leadership ? e.leadership.crossHorizonAgreement : null,
      peerGroupSize: e.leadership ? e.leadership.peerGroupSize : null,
      groupingLevel: e.groupingLevel,
      leaderOnPeerWeaknessOnly: e.leadership ? e.leadership.leaderOnPeerWeaknessOnly : null,
      state: e.state,
      transitionRank: e.transitionRank,
      extensionState: setup.extensionState ?? null,
      pivot: setup.pivot ?? null,
      atr: setup.atr ?? null,
    };
  }
  return { version: scan.versions ? scan.versions.features : null, asOf: scan.asOf, byTicker };
}

module.exports = { runRltScan, compactLeadershipSnapshot };
