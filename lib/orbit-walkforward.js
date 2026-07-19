// ORBIT nested walk-forward validation (orbit-wf-v1).
//
// Chronological, leakage-controlled evaluation:
//   - OUTER folds: contiguous date blocks used ONLY for final OOS performance.
//   - INNER split : inside each outer fold's training window, a time-ordered
//                   fit/calibration split so the calibrator is chosen out-of-fold.
//   - PURGE       : a training event is dropped unless its label fully closes
//                   (actual labelEndDate + embargo) BEFORE the outer block starts.
//   - EMBARGO     : extra calendar buffer around the boundary (overlapping 21/63-day
//                   labels otherwise leak across the split).
//   - Grouping    : candidates are grouped by decision date; per-date rank-IC is
//                   averaged (ICIR) so repeated tickers don't dominate.
//
// We deliberately report the PURGED result AND a LEAKY (no-purge) result side by
// side — the gap is the leakage-inflation diagnostic. A good purged result is the
// only one that counts. Reuses lib/orbit-model, lib/orbit-calibration,
// lib/rankquality. Survivorship validity is passed through, never assumed.

const Mod = require('./orbit-model');
const Cal = require('./orbit-calibration');
const RQ = require('./rankquality');
const M = require('./orbit-math');

const WF_VERSION = 'orbit-wf-v1';

function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// Flatten samples → per-horizon rows. Each row: {decisionDate, labelEndDate, ticker, features, label, net, outcome}.
function horizonRows(samples, horizon, labelField) {
  const rows = [];
  for (const s of samples) {
    const h = s.horizons && s.horizons[horizon];
    if (!h || !h.resolved) continue;
    const label = h[labelField];
    if (label !== 0 && label !== 1) continue;
    rows.push({
      decisionDate: s.decisionDate, labelEndDate: h.exitDate || addDays(s.decisionDate, 90),
      ticker: s.ticker, features: s.features,
      label, raw: h.positiveRaw, resid: h.positiveResidual, severe: h.severeLoss,
      outcome: h.barrier, net: h.netReturn,
    });
  }
  return rows.sort((a, b) => a.decisionDate < b.decisionDate ? -1 : a.decisionDate > b.decisionDate ? 1 : 0);
}

// Split distinct decision dates into `k` contiguous blocks (as equal as possible).
function dateBlocks(rows, k) {
  const dates = [...new Set(rows.map(r => r.decisionDate))].sort();
  const per = Math.ceil(dates.length / k);
  const blocks = [];
  for (let i = 0; i < dates.length; i += per) blocks.push(dates.slice(i, i + per));
  return blocks.filter(b => b.length);
}

// Per-date rank-IC (Spearman of score vs realized net) averaged over dates → {ic, icir, posFrac, nDates}.
function groupedIC(preds) {
  const byDate = new Map();
  for (const p of preds) { if (!byDate.has(p.date)) byDate.set(p.date, []); byDate.get(p.date).push(p); }
  const ics = [];
  for (const [, arr] of byDate) {
    if (arr.length < 3) continue;
    const r = RQ.informationCoefficient(arr.map(x => ({ score: x.score, outcome: x.net })));
    if (r && r.ic != null) ics.push(r.ic);
  }
  if (!ics.length) return { ic: null, icir: null, posFrac: null, nDates: 0 };
  const mean = M.mean(ics), sd = M.std(ics);
  return {
    ic: +mean.toFixed(4),
    icir: sd && sd > M.EPS ? +(mean / sd).toFixed(3) : null,
    posFrac: +(ics.filter(x => x > 0).length / ics.length).toFixed(3),
    nDates: ics.length,
  };
}

// Metrics for a set of frozen-model predictions on an outer block.
function blockMetrics(preds) {
  const g = groupedIC(preds);
  const withCal = preds.filter(p => p.calUp != null);
  const brier = withCal.length >= 20 ? M.brier(withCal.map(p => p.calUp), withCal.map(p => p.label)) : null;
  const ll = withCal.length >= 20 ? M.logLoss(withCal.map(p => p.calUp), withCal.map(p => p.label)) : null;
  // Top-decile / top-K net return (per-date top pick), directional accuracy.
  const sorted = [...preds].sort((a, b) => b.score - a.score);
  const decileN = Math.max(1, Math.floor(sorted.length / 10));
  const topDecileNet = M.mean(sorted.slice(0, decileN).map(p => p.net));
  const dirAcc = M.mean(preds.map(p => (p.score >= 0.5 ? 1 : 0) === p.label ? 1 : 0));
  const severeRate = M.mean(preds.map(p => p.severe == null ? null : p.severe).filter(x => x != null));
  return {
    n: preds.length, ...g,
    brier: brier == null ? null : +brier.toFixed(4),
    logLoss: ll == null ? null : +ll.toFixed(4),
    topDecileNet: topDecileNet == null ? null : +topDecileNet.toFixed(4),
    directionalAccuracy: dirAcc == null ? null : +dirAcc.toFixed(4),
    severeRate: severeRate == null ? null : +severeRate.toFixed(4),
    calibratedN: withCal.length,
  };
}

// Train a frozen model + OOF-selected calibrator on a training row set.
function trainFrozen(trainRows, opts) {
  const model = Mod.fitOrbitModel(trainRows, { horizon: opts.horizon, lambda: opts.lambda, features: opts.features });
  // Inner time split for out-of-fold calibration.
  const dates = [...new Set(trainRows.map(r => r.decisionDate))].sort();
  const cut = dates[Math.floor(dates.length * 0.8)] || dates[dates.length - 1];
  const innerTrain = trainRows.filter(r => r.decisionDate < cut);
  const innerValid = trainRows.filter(r => r.decisionDate >= cut);
  let calibrator = { calibrated: false, reason: 'no inner split' };
  if (innerTrain.length >= 40 && innerValid.length >= 20) {
    const innerModel = Mod.fitOrbitModel(innerTrain, { horizon: opts.horizon, lambda: opts.lambda, features: opts.features });
    if (innerModel.trained) {
      const pairs = innerValid.map(r => { const s = Mod.scoreOrbit(innerModel, r.features); return s ? { p: s.rawUp, won: r.label } : null; }).filter(Boolean);
      // Split the OOF pairs into calibrator-fit / calibrator-validate halves.
      const half = Math.floor(pairs.length / 2);
      calibrator = Cal.selectCalibrator(pairs.slice(0, half), pairs.slice(half), { minN: opts.minCalibN || 40 });
    }
  }
  return { model, calibrator };
}

// Score an outer block with a frozen model + calibrator.
function scoreBlock(rows, frozen) {
  const out = [];
  for (const r of rows) {
    const s = Mod.scoreOrbit(frozen.model, r.features);
    if (!s) continue;
    const calUp = frozen.calibrator.calibrated ? Cal.calibrate(frozen.calibrator, s.rawUp) : null;
    out.push({ date: r.decisionDate, ticker: r.ticker, score: s.rankScore, rawUp: s.rawUp, calUp, label: r.label, net: r.net, severe: r.severe });
  }
  return out;
}

// Run the nested walk-forward for one horizon.
//   opts: { horizon='days21', labelField='positiveResidual', outerBlocks=8,
//           embargoDays=null, lambda, minTrain=150, researchValidity }
function walkForward(samples, opts = {}) {
  const horizon = opts.horizon || 'days21';
  const labelField = opts.labelField || 'positiveResidual';
  const outerBlocks = opts.outerBlocks || 8;
  const horizonDays = { days5: 5, days21: 21, days63: 63 }[horizon] || 21;
  const embargoDays = opts.embargoDays != null ? opts.embargoDays : Math.ceil(horizonDays * 1.5 * 7 / 5); // calendar
  const minTrain = opts.minTrain || 150;

  const rows = horizonRows(samples, horizon, labelField);
  if (rows.length < minTrain + 50) {
    return { version: WF_VERSION, horizon, ok: false, reason: `too few resolved rows (${rows.length})`, nRows: rows.length,
      researchValidity: validity(opts) };
  }
  const blocks = dateBlocks(rows, outerBlocks);

  const runOne = (purge) => {
    const foldMetrics = [], allPreds = [];
    for (let b = 1; b < blocks.length; b++) {
      const blockStart = blocks[b][0];
      const blockRows = rows.filter(r => blocks[b].includes(r.decisionDate));
      const trainRows = rows.filter(r => {
        if (purge) return r.labelEndDate < addDays(blockStart, -embargoDays);
        return r.decisionDate < blockStart;   // leaky: only decision-date ordering
      });
      if (trainRows.length < minTrain) continue;
      const frozen = trainFrozen(trainRows, { horizon, lambda: opts.lambda, features: opts.features, minCalibN: opts.minCalibN });
      if (!frozen.model.trained) continue;
      const preds = scoreBlock(blockRows, frozen);
      if (!preds.length) continue;
      foldMetrics.push({ block: b, start: blockStart, end: blocks[b][blocks[b].length - 1], trainN: trainRows.length, calibrated: frozen.calibrator.calibrated, ...blockMetrics(preds) });
      allPreds.push(...preds);
    }
    return { foldMetrics, overall: allPreds.length ? blockMetrics(allPreds) : null, nOuter: foldMetrics.length };
  };

  const purged = runOne(true);
  const leaky = runOne(false);

  return {
    version: WF_VERSION, horizon, labelField, ok: true,
    nRows: rows.length, nBlocks: blocks.length, embargoDays, minTrain,
    purged, leaky,
    leakageInflation: (purged.overall && leaky.overall && purged.overall.ic != null && leaky.overall.ic != null)
      ? +(leaky.overall.ic - purged.overall.ic).toFixed(4) : null,
    researchValidity: validity(opts),
  };
}

function validity(opts) {
  const v = opts.researchValidity || {};
  return {
    productionGrade: false,
    survivorshipSafe: v.survivorshipSafe === true,
    pointInTimeUniverse: v.pointInTimeUniverse === true,
    reason: v.reason || 'Historical universe uses current survivors or lacks delisted securities; walk-forward is a research diagnostic, not a production-grade claim.',
  };
}

module.exports = { WF_VERSION, walkForward, horizonRows, dateBlocks, groupedIC, blockMetrics, addDays };
