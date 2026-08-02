'use strict';
// 🕸 PEER PROPAGATION — engine orchestrator (pure).
//
// One call turns a raw universe (rows with candles) plus benchmarks into a frozen,
// PIT-safe propagation snapshot:
//
//   rows → buildPeerUniverse (rlt-universe: sector×band groups, fail-closed
//   eligibility) → per-name residual daily series (atlasx-residual betas via
//   rlt-residual, as-of sliced) → directed leader graph per group → peer-index
//   features + stage per name → ranked candidates.
//
// HARD RULES, tested:
//   • PIT — nothing dated after `asOf` can influence any output (bars are sliced
//     before every computation; a future bar appended to the input changes nothing);
//   • quarantine — rows failing eligibility or timestamp checks are reported in
//     `excluded`/`invalid` with stable reasons, never silently dropped or imputed;
//   • no fabricated probabilities — `probabilities` stays null-with-reason until
//     empirical out-of-fold calibration reaches CALIBRATION.minSamplesForPercent;
//   • observer-only — the snapshot carries affectsLiveRank:false and every
//     consumer treats it as annotation (weight 0) until promotion gates pass.
//
// Pure & deterministic: no I/O, no clocks, no randomness.

const crypto = require('node:crypto');
const { VERSIONS, GRAPH_POLICY, FEATURE_POLICY, CALIBRATION, NETWORKS } = require('./config');
const { buildDirectedGraph } = require('./graph');
const { stockPeerFeatures } = require('./features');
const { residualBundle, residualDailySeries } = require('../rlt-residual');
const { buildPeerUniverse } = require('../rlt-universe');

const isFin = Number.isFinite;

// The one honest probability block this engine may emit today.
function nullProbabilities() {
  return Object.freeze({
    p5: null, p21: null, p63: null, severeLoss: null,
    reason: 'insufficient-calibration-sample',
    minSamplesForPercent: CALIBRATION.minSamplesForPercent,
    basis: 'probabilities require empirical out-of-fold calibration on matured outcomes; none exist yet',
  });
}

/**
 * Run the engine.
 *
 * @param rows          [{ticker, sector, sectorEtf?, price, dollarVol, capGroup,
 *                        bars|raw, scope?}] — candle-cache-shaped universe rows
 * @param spyBars       SPY candles (any candle shape atlasx-residual accepts)
 * @param sectorBarsFor (sectorName) => candles[] | null — sector ETF lookup
 * @param asOf          'YYYY-MM-DD' data cutoff (inclusive)
 * @param decisionTs    ISO timestamp of the decision (provenance)
 * @returns frozen snapshot — see bottom of file.
 */
/**
 * The PIT residual panel: eligibility-gated universe + per-name residual daily
 * series with as-of fitted betas. Shared by the live engine and the walk-forward
 * (which needs the panel to run falsification variants on the same data).
 */
function buildResidualPanel({ rows = [], spyBars = [], sectorBarsFor = () => null, asOf = null, decisionTs = null, graphPolicy = GRAPH_POLICY } = {}) {
  const RES = require('../atlasx-residual');
  const spy = RES.asOfSlice(RES.toBars(spyBars), asOf);
  const calendarDates = spy.map(b => b.date);

  const universe = buildPeerUniverse({ rows, asOf, calendarDates, decisionTs });
  const eligible = universe.rows.filter(r => r.eligible);
  const excluded = universe.rows.filter(r => !r.eligible)
    .map(r => ({ ticker: r.ticker, reasons: r.exclusions }));

  const seriesByTicker = {};
  const rankOf = {};
  const invalid = [];
  const sectorBarsCache = new Map();
  const sectorBarsOf = (sector) => {
    if (!sector) return [];
    if (!sectorBarsCache.has(sector)) sectorBarsCache.set(sector, sectorBarsFor(sector) || []);
    return sectorBarsCache.get(sector);
  };

  for (const r of eligible) {
    const secBars = sectorBarsOf(r.sector);
    const bundle = residualBundle({ bars: r.bars, spyBars: spy, sectorBars: secBars, asOf });
    if (!bundle || bundle.degenerate || !isFin(bundle.beta)) {
      invalid.push({ ticker: r.ticker, reason: 'residualization-degenerate' });
      continue;
    }
    const series = residualDailySeries({
      bars: r.bars, spyBars: spy, sectorBars: secBars, asOf,
      beta: bundle.beta, sectorLoading: bundle.sectorLoading, sectorBetaMkt: bundle.sectorBetaMkt,
      window: graphPolicy.window,
    });
    if (!series.length) { invalid.push({ ticker: r.ticker, reason: 'no-aligned-residual-series' }); continue; }
    seriesByTicker[r.ticker] = series;
    rankOf[r.ticker] = isFin(r.dollarVol) ? r.dollarVol : 0;
  }

  return { universe, eligible, excluded, invalid, seriesByTicker, rankOf, spy };
}

function runPeerPropagation({ rows = [], spyBars = [], sectorBarsFor = () => null, asOf = null, decisionTs = null,
  graphPolicy = GRAPH_POLICY, featurePolicy = FEATURE_POLICY } = {}) {
  const panel = buildResidualPanel({ rows, spyBars, sectorBarsFor, asOf, decisionTs, graphPolicy });
  const { universe, eligible, excluded, invalid, seriesByTicker, rankOf } = panel;

  // ── Directed leader→follower graph within peer groups ─────────────────────
  const graph = buildDirectedGraph({ seriesByTicker, groups: universe.groups, rankOf, policy: graphPolicy });

  // ── Per-name peer features + stage ────────────────────────────────────────
  const membersOf = new Map();
  for (const r of eligible) {
    if (!membersOf.has(r.peerGroupId)) membersOf.set(r.peerGroupId, []);
    membersOf.get(r.peerGroupId).push(r.ticker);
  }

  const candidates = [];
  for (const r of eligible) {
    const own = seriesByTicker[r.ticker];
    if (!own) continue;
    const groupTickers = (membersOf.get(r.peerGroupId) || []).filter(t => t !== r.ticker);
    const groupSeries = groupTickers.map(t => seriesByTicker[t]).filter(Boolean);
    const f = stockPeerFeatures({ ticker: r.ticker, ownSeries: own, groupSeries, graph, seriesByTicker, policy: featurePolicy });

    const supporting = [];
    const contradicting = [];
    if (isFin(f.peerStrengthZ) && f.peerStrengthZ > 0.5) supporting.push(`peer group strong (z ${f.peerStrengthZ})`);
    if (f.leadersConfirming >= 2) supporting.push(`${f.leadersConfirming} historical leaders confirming`);
    if (isFin(f.unreflectedPeerStrength) && f.unreflectedPeerStrength > 0.5) supporting.push('own price has not yet reflected peer strength');
    if (isFin(f.peerBreadthImproving) && f.peerBreadthImproving >= 0.6) supporting.push(`${Math.round(f.peerBreadthImproving * 100)}% of peers improving`);
    if (f.stage === 'LATE') contradicting.push('own move already large — late entry risk');
    if (isFin(f.peerStrengthZ) && f.peerStrengthZ < 0) contradicting.push('peer group is weak, not strong');
    if (f.propagationDecay != null && f.propagationDecay < 0.3) contradicting.push('leader impulse is old — propagation likely decayed');
    if (f.dataQuality < 0.6) contradicting.push('thin peer/leader data');

    candidates.push({
      ticker: r.ticker,
      sector: r.sector,
      sectorEtf: r.sectorEtf,
      peerGroupId: r.peerGroupId,
      groupingLevel: r.groupingLevel,
      price: r.price,
      dollarVol: r.dollarVol,
      band: r.band,
      features: f,
      stage: f.stage,
      score: f.score,
      dataQuality: f.dataQuality,
      supporting: supporting.slice(0, 4),
      contradicting: contradicting.slice(0, 4),
      probabilities: nullProbabilities(),
      featureObservedAt: asOf,
      decisionTime: decisionTs,
    });
  }
  candidates.sort((a, b) => b.score - a.score || (a.ticker < b.ticker ? -1 : 1));

  const basis = `${VERSIONS.engine}|${asOf}|${candidates.map(c => c.ticker).join(',')}`;
  const snapshotId = 'pp-' + crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);

  return Object.freeze({
    version: VERSIONS.engine,
    graphVersion: graph.version,
    snapshotId,
    asOf,
    decisionTs,
    universe: {
      snapshotId: universe.universeSnapshotId,
      total: universe.coverage.total,
      eligible: universe.coverage.eligible,
      excluded: universe.coverage.excluded,
      groups: Object.keys(universe.groups).length,
    },
    networks: NETWORKS,
    graphStats: graph.stats,
    graphEdges: graph.edges,
    candidates: Object.freeze(candidates),
    excluded: Object.freeze(excluded),
    invalid: Object.freeze(invalid),
    caveats: Object.freeze([
      'survivorship-unsafe: universe and sector map are present-day; no PIT constituents',
      'sector map is static (lib/universe SECTOR_OF) — historical reclassifications not modeled',
      'probabilities withheld until empirical out-of-fold calibration matures',
    ]),
    affectsLiveRank: false,
  });
}

module.exports = { runPeerPropagation, buildResidualPanel, nullProbabilities };
