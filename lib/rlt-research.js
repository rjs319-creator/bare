'use strict';
// RLT research — purged walk-forward validation over the SHARED harness.
//
// REUSES lib/research/harness.runExperiment (chronological expanding folds,
// exact label-end purge, trading-session embargo, uniqueness weighting,
// date-clustered block-bootstrap CIs) — one harness, not two.
//
// Fold-local residualization: every event's features are computed AT its
// decision date from data ≤ that date (buildPeerUniverse/buildLeadership slice
// PIT internally), so no residual fit ever sees a forward observation and no
// full-dataset residualization precedes the fold split.
//
// The mandatory baseline ladder (a fitted model must beat the simple ones out
// of sample or it has no reason to exist):
//   control-random · rank-level · rank-acceleration · residual-momentum ·
//   fixed-transition (deterministic RLT baseline) · rlt-ridge (fitted)
// Coil/Ghost/ATLAS-X comparisons require their scores on the same events —
// available only in the server walk-forward op where those engines can run;
// pass them via opts.extraRankers.
//
// HONESTY: cache-derived candles are survivorship-UNSAFE and the sector map is
// present-day — every result here is stamped productionEligible:false. A
// negative or inconclusive experiment is a valid result.

const { runExperiment } = require('./research/harness');
const { randomRanker } = require('./research/baseline-ranker');
const { labelEvent } = require('./evolve-labels');
const { buildPeerUniverse } = require('./rlt-universe');
const { buildLeadership } = require('./rlt-leadership');
const { computeRltFeatures } = require('./rlt-features');
const { buildSectorStates } = require('./rlt-sector-state');
const { flattenFeatures, fitStageA, scoreStageA, BASELINES } = require('./rlt-stage-a');
const { VERSIONS } = require('./rlt-config');
const RES = require('./atlasx-residual');
const crypto = require('node:crypto');

const RESEARCH_VERSION = 'rlt-research-v1';
const SURVIVORSHIP_REASON = 'cache-derived present-day universe + present-day sector map (no validFrom/validTo) — survivorship/reclassification unsafe by construction';

function isFin(v) { return Number.isFinite(v); }

// evolve-labels walks OBJECT candles ({date, open, high, low, close}); accept
// any candle format here and normalize through the shared toBars.
function toLabelCandles(candles) {
  return RES.toBars(candles).map(b => ({ date: b.date, open: b.o, high: b.h, low: b.l, close: b.c }));
}

// ── event construction (cross-sectional per decision date) ───────────────────
/**
 * Build labeled harness rows: for each decision date run the FULL RLT
 * cross-section (peer universe → leadership → features), then label each
 * eligible name with the realistic triple-barrier next-open outcome.
 *
 * @param rowsFor    (date) → universe input rows (ticker, sector, price, dollarVol, capGroup, bars)
 *                   — bars may extend past the date; everything slices PIT internally.
 * @param spyCandles SPY candles (calendar + market leg)
 * @param sectorBarsFor (sector) → sector-ETF candles
 * @param decisionDates ascending 'YYYY-MM-DD' decision dates
 * @param horizon    evolve label horizon ('fast'=5, 'swing'=21) — default 'swing'
 */
function buildRltEvents({ rowsFor, spyCandles = [], sectorBarsFor = () => [], decisionDates = [], horizon = 'swing' } = {}) {
  const events = [];
  const spyBars = RES.toBars(spyCandles);
  for (const date of [...new Set(decisionDates)].sort()) {
    const rows = rowsFor(date) || [];
    const calendarDates = RES.asOfSlice(spyBars, date).map(b => b.date);
    const universe = buildPeerUniverse({ rows, asOf: date, calendarDates, decisionTs: date });
    const leadership = buildLeadership({ universe, spyBars: spyCandles, sectorBarsFor });
    const sectorStates = buildSectorStates({ universe, leadership, sectorBarsFor, spyBars: spyCandles });

    for (const r of universe.rows) {
      if (!r.eligible) continue;
      const lead = leadership.byTicker[r.ticker];
      if (!lead) continue;
      const features = computeRltFeatures({
        bars: r.bars, series: leadership.seriesByTicker[r.ticker] || [],
      });
      const sectorState = r.sector ? sectorStates.states[r.sector] || null : null;
      const flat = flattenFeatures({ leadership: lead, features, sectorState });

      // Raw (unsliced) candles for the FORWARD label leg.
      const raw = rows.find(x => x.ticker === r.ticker);
      const rawCandles = raw ? (raw.bars || raw.raw || []) : [];
      const fullBars = RES.toBars(rawCandles);
      const forward = fullBars.filter(b => b.date > date);
      if (!forward.length) continue;
      const entryBar = forward[0];
      const entry = entryBar.o > 0 ? entryBar.o : entryBar.c;
      if (!(entry > 0)) continue;

      const label = labelEvent({
        entry, candles: toLabelCandles(rawCandles), predDate: date, horizon,
        spyCandles: toLabelCandles(spyCandles),
        sectorCandles: r.sector ? toLabelCandles(sectorBarsFor(r.sector)) : null,
      });
      if (!label || !label.resolved) continue;   // censored — never a negative

      // Graded on the SECTOR-relative return when the sector leg exists,
      // market-relative otherwise (labeled via outcomeBasis).
      const outcome = label.sectorRelReturn != null ? label.sectorRelReturn
        : label.spyRelReturn != null ? label.spyRelReturn : label.terminalReturn;
      if (!isFin(outcome)) continue;

      events.push(Object.freeze({
        securityId: `cache:${r.ticker}`,
        ticker: r.ticker,
        decisionTs: date,
        eligibleEntryTs: entryBar.date,
        labelEndDate: label.labelEndDate,
        predDate: date,
        horizon,
        features: flat,
        score: null,
        outcome,
        outcomeBasis: label.sectorRelReturn != null ? 'sector-relative'
          : label.spyRelReturn != null ? 'market-relative' : 'raw',
        won: !!label.won,
        barrier: label.barrier,
        terminalReturn: label.terminalReturn,
        entry,
        peerGroupId: r.peerGroupId,
        groupingLevel: r.groupingLevel,
      }));
    }
  }
  return Object.freeze(events);
}

// ── the ranker ladder ────────────────────────────────────────────────────────
const baselineRanker = (name, key) => ({
  name,
  fit: () => ({}),
  score: (m, row) => {
    const v = BASELINES[key](row.features || {});
    return v == null ? 0 : v;
  },
});

const rltRidgeRanker = {
  name: 'rlt-ridge',
  fit: (trainRows) => fitStageA(trainRows.map(r => ({ features: r.features, y: r.won ? 1 : 0 }))),
  score: (model, row) => {
    const s = scoreStageA(model, row.features);
    return s == null ? 0 : s;
  },
};

const DEFAULT_RANKERS = Object.freeze([
  randomRanker,                                        // null control
  baselineRanker('rank-level', 'rank-level'),          // current sector-relative rank
  baselineRanker('rank-acceleration', 'rank-acceleration'),
  baselineRanker('residual-momentum', 'residual-momentum'),
  baselineRanker('fixed-transition', 'fixed-transition'),
  rltRidgeRanker,                                      // fitted — must beat ALL of the above OOS
]);

function hashEvents(rows) {
  const basis = rows.map(r => `${r.ticker}|${r.decisionTs}|${r.outcome}`).join(';');
  return 'rltd-' + crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

// ── comparison (shared harness, identical folds for every ranker) ────────────
function runRltComparison(events, opts = {}) {
  const rankers = [
    ...DEFAULT_RANKERS,
    ...(Array.isArray(opts.extraRankers) ? opts.extraRankers : []),
  ];
  const rows = (events || []).filter(e => e && e.decisionTs && isFin(e.outcome));

  const meta = {
    experimentId: opts.experimentId || 'rlt-ranker-comparison-swing',
    experimentFamilyId: 'rlt-ranker-comparison',
    datasetHash: opts.datasetHash || hashEvents(rows),
    universePolicy: VERSIONS.universe + ' over present-day cached universe (survivorship-unsafe)',
    primaryMetric: 'mean-daily-rank-IC (OOS, purged, sector-relative outcome)',
    survivorshipSafe: false,
    survivorshipReason: SURVIVORSHIP_REASON,
    relatedExperimentsAttempted: rankers.length,
    seed: 12345,
  };

  const exp = runExperiment(rows, rankers, { folds: opts.folds, embargo: opts.embargo }, meta);
  const perRankerIC = exp.result.perRanker;
  const baseRate = rows.length ? +(rows.filter(r => r.won).length / rows.length).toFixed(3) : null;

  // The fitted model "wins" ONLY if it beats every simple baseline's mean IC
  // out of sample — otherwise it merely recreates momentum/rank and is
  // recorded as such (a rejected hypothesis, not rediscovered later as new).
  const ridge = perRankerIC['rlt-ridge'] || {};
  const simpleNames = ['rank-level', 'rank-acceleration', 'residual-momentum', 'fixed-transition'];
  const beatenBaselines = simpleNames.filter(n => {
    const b = perRankerIC[n] || {};
    return isFin(ridge.meanIC) && isFin(b.meanIC) && ridge.meanIC > b.meanIC;
  });
  const fittedBeatsAllSimple = beatenBaselines.length === simpleNames.length && isFin(ridge.meanIC);

  const verdict = Object.freeze({
    survivorshipSafe: false,
    survivorshipReason: SURVIVORSHIP_REASON,
    productionEligible: false,                 // fail-closed regardless of IC
    fittedBeatsAllSimple,
    beatenBaselines: Object.freeze(beatenBaselines),
    summary: exp.verdict,
    champion: exp.champion,
    note: 'Rank-IC measures RANKING QUALITY only. Survivorship-unsafe data + present-day sector map → no result here can promote RLT; a negative or inconclusive experiment is a valid result.',
  });

  return Object.freeze({
    version: RESEARCH_VERSION,
    rankers: Object.freeze(rankers.map(r => r.name)),
    events: rows.length,
    distinctDates: exp.result.distinctDates,
    uniqueness: exp.result.uniqueness,
    baseRate,
    champion: exp.champion,
    perRankerIC,
    foldReport: exp.result.foldReport,
    verdict,
    manifest: exp.manifest,
  });
}

module.exports = {
  RESEARCH_VERSION, SURVIVORSHIP_REASON,
  buildRltEvents, runRltComparison, DEFAULT_RANKERS, rltRidgeRanker, hashEvents,
};
