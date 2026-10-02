'use strict';
// PANEL → MODEL ROWS (forecast-dataset-v1)
//
// Turns the PIT panel into the (name, decision-date) rows every model consumes: universe
// membership, trailing features, within-date cross-sectional transforms, trailing betas and the
// residual labels for all four horizons.
//
// Ordering matters and is enforced: features are computed from bars at or before the decision
// date; cross-sectional transforms are then applied WITHIN that date; labels are computed from
// the forward window only and are attached last, so no label value can ever reach a feature.
//
// Every row carries `maxSourceDate` (the latest bar it touched) so lib/forecast/leakage.js can
// prove point-in-time correctness row by row.

const UNIV = require('./universe');
const TARGETS = require('./targets');
const { computeFeatures } = require('./features');
const { applyCrossSection, modelFeatureKeys } = require('./xsection');
const { makeQualityFlags, makePitStamps } = require('./contract');
const { dailyReturns } = require('./features');

const DATASET_VERSION = 'forecast-dataset-v1';

/** Dated daily returns for a proxy series, as a Map(date -> r), trailing only. */
function returnMapAsOf(candles, idx, lookback) {
  const m = new Map();
  for (const p of dailyReturns(candles, idx, lookback)) m.set(p.date, p.r);
  return m;
}

/**
 * Phase 1 of a decision date: the cross-section WITHOUT horizon rows — universe and features
 * (with the within-date transforms applied), computed once; `labelCache` holds each name's
 * trailing betas so the per-horizon label build below does not repeat the OLS.
 * Returns { date, universe, rows, labelCache, context, diagnostics }; `rows` is empty (with
 * `diagnostics.reason`) when the date has no benchmark bar or an empty universe.
 *
 * Split out of buildDate so the live inference can hold ONE copy of each date's features and
 * materialize the labelled rows one horizon at a time (lib/forecast/infer.js) — building all
 * four horizons' rows up front was the forecastshadow tick's ~0.5 GB transient.
 */
function buildDateFeatures({ panel, date, cfg, transforms = ['rank'], requireLabel = true }) {
  // `requireLabel` and `requireEntryBar` are the same question asked twice: a row that must
  // carry a label must be fillable, and a row being served for a future fill must not be.
  const universe = UNIV.buildUniverseSnapshot(panel, date, cfg, { recordExclusions: false, requireEntryBar: requireLabel });
  const bIdx = panel.bench.idx.get(date);
  const diagnostics = { members: universe.size, labelled: 0, unobservable: {} };
  if (bIdx == null || !universe.size) {
    return { date, universe, rows: [], labelCache: new Map(), context: null, diagnostics: { ...diagnostics, reason: bIdx == null ? 'no benchmark bar' : 'empty universe' }, panel, cfg };
  }

  const benchReturns = returnMapAsOf(panel.bench.candles, bIdx, 300);
  const sectorReturnCache = new Map();

  const featureRows = [];
  const labelCache = new Map();

  for (const m of universe.members) {
    const entry = panel.dataset.get(m.ticker);
    const idx = m.barIndex;
    const etf = panel.sectorEtfOf(m.ticker);
    const sectorEntry = etf ? panel.sectorSeries.get(etf) : null;
    const sIdx = sectorEntry ? (sectorEntry.idx.get(date) ?? -1) : -1;
    if (etf && sIdx >= 0 && !sectorReturnCache.has(etf)) sectorReturnCache.set(etf, returnMapAsOf(sectorEntry.candles, sIdx, 300));

    const betas = TARGETS.trailingBetas(entry.candles, idx, panel.bench.candles, bIdx, sectorEntry ? sectorEntry.candles : null, sIdx, cfg);
    const fv = computeFeatures(entry.candles, idx, {
      benchReturns,
      sectorReturns: etf ? sectorReturnCache.get(etf) || null : null,
      betaMarket: betas.betaMarket,
      betaSector: betas.betaSector,
      staleSessions: m.staleSessions,
    });

    featureRows.push({
      ticker: m.ticker, securityId: m.securityId, sector: m.sector, decisionDate: date,
      barIndex: idx, price: m.price, adv: m.adv,
      betaMarket: betas.betaMarket, betaSector: betas.betaSector, betaSectorMarket: betas.betaSectorMarket,
      sectorEtf: etf,
      features: fv.values,
      maxSourceDate: fv.maxSourceDate,
      quality: makeQualityFlags({
        featureCoverage: fv.coverage, missingFeatures: fv.missing,
        staleSessions: m.staleSessions, historySessions: m.historySessions,
        sectorKnown: !!m.sector, sectorBasisPointInTime: false, survivorshipSafe: false,
      }),
    });
    // Labels are NOT built here. A frozen 24-field ForecastLabel per name × date × horizon was
    // the largest retained allocation of the live inference (124 MB of a 324 MB working set,
    // measured on 517 names × 100 dates); rowsForHorizon builds ONE horizon's labels when that
    // horizon is materialized, reusing these betas, so only the horizon in flight is resident.
    labelCache.set(m.ticker, betas);
  }

  const { rows: withXs, context } = applyCrossSection(featureRows, cfg, { transforms });
  return { date, universe, rows: withXs, labelCache, context, diagnostics, panel, cfg };
}

/**
 * Phase 2: the labelled rows of ONE horizon for a date built by buildDateFeatures. Counts the
 * unobservable labels into `built.diagnostics` exactly as buildDate always did.
 */
function rowsForHorizon(built, h, { requireLabel = true } = {}) {
  const { date, rows: withXs, labelCache, diagnostics, panel, cfg } = built;
  const cfgH = { ...cfg, horizons: [h] };
  const rows = [];
  for (const r of withXs) {
      const lab = TARGETS.buildLabels({ panel, ticker: r.ticker, date, cfg: cfgH, betas: labelCache.get(r.ticker) || null });
      const label = lab && lab.labels[h];
      if (!label) {
        const reason = (lab && lab.unobservable[h]) || 'unknown';
        diagnostics.unobservable[reason] = (diagnostics.unobservable[reason] || 0) + 1;
        // SERVING MODE. At the latest decision date the forward window has not happened yet, so
        // a label is legitimately absent and the row is still predictable. Training/evaluation
        // callers keep requireLabel:true so an unlabelled row can never enter a fit.
        if (requireLabel) continue;
        rows.push({
          ...r, horizon: h, label: null, labelUnobservableReason: reason,
          pit: makePitStamps({ asOf: date, tradableAt: null, labelStart: null, labelEnd: null, maxSourceTs: r.maxSourceDate }),
        });
        continue;
      }
      rows.push({
        ...r,
        horizon: h,
        label,
        pit: makePitStamps({
          asOf: date, tradableAt: label.labelStart,
          labelStart: label.labelStart, labelEnd: label.labelEnd,
          maxSourceTs: r.maxSourceDate,
        }),
      });
  }
  diagnostics.labelled += rows.length;
  return rows;
}

/**
 * Build rows for ONE decision date.
 * Returns { date, universe, rowsByHorizon: Map(h -> rows), context, diagnostics }.
 */
function buildDate(args) {
  const built = buildDateFeatures(args);
  const rowsByHorizon = new Map(args.cfg.horizons.map((h) => [h, rowsForHorizon(built, h, { requireLabel: args.requireLabel !== false })]));
  return { date: built.date, universe: built.universe, rowsByHorizon, context: built.context, diagnostics: built.diagnostics };
}

/**
 * Build the whole study panel over a list of decision dates.
 * `onDate` is called per date so a caller can stream instead of holding everything.
 */
function buildPanelRows({ panel, dates, cfg, transforms = ['rank'], onDate = null, requireLabel = true }) {
  const byHorizon = new Map(cfg.horizons.map((h) => [h, []]));
  const universeSizes = [];
  const unobservable = {};
  let processed = 0;

  for (const date of dates) {
    const built = buildDate({ panel, date, cfg, transforms, requireLabel });
    universeSizes.push({ date, size: built.universe.size });
    for (const [k, v] of Object.entries(built.diagnostics.unobservable || {})) unobservable[k] = (unobservable[k] || 0) + v;
    for (const h of cfg.horizons) {
      const rows = built.rowsByHorizon.get(h) || [];
      if (onDate) onDate(date, h, rows, built);
      else byHorizon.get(h).push(...rows);
    }
    processed++;
  }

  return {
    version: DATASET_VERSION,
    rowsByHorizon: byHorizon,
    // The MODEL column set, not every column the row carries: date-constant columns are
    // excluded because they cannot change a within-date ordering (see xsection.modelFeatureKeys).
    featureKeys: modelFeatureKeys({ transforms, includeDateConstant: cfg.features.includeDateConstant }),
    universeSizes,
    unobservable,
    dates: processed,
  };
}

module.exports = { DATASET_VERSION, buildDate, buildDateFeatures, rowsForHorizon, buildPanelRows, returnMapAsOf };
