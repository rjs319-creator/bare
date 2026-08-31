'use strict';
// CROSS-SECTIONAL META-RANKER (forecast-meta-ranker-v1)
//
// The final ranker. LightGBM when it is available; a ridge cross-sectional ranker when it is
// not. It NEVER trains on in-sample base predictions — its only permitted training input is the
// cross-fitted frame produced by lib/forecast/crossfit.js, and `fit` refuses a frame set that
// fails `assertNoInSampleStacking`.
//
// RANKING GROUPS ARE DECISION DATES. With `lambdarank`, rows are grouped by decision date and
// the label is that date's within-cross-section relevance bucket, so the model is never asked to
// compare a name on one date with a name on another — the comparison the spec forbids. Rows are
// sorted by date before grouping, and the adapter throws if that ordering is violated.
//
// OBJECTIVE — WHY `regression` IS THE DEFAULT. The evaluation metric is a FULL-cross-section
// Spearman IC. `lambdarank` with a truncation level optimizes NDCG@k, i.e. only the head of each
// date, and measurably does not fit the rest: on a real fold its own IN-SAMPLE full-cross-section
// rank IC was 0.003, and the features it actually learned were vol63 / atrPct14 / dollar volume —
// it ranked by VOLATILITY, because volatile names populate the extreme relevance bucket. Through
// the low-volatility anomaly that made it reliably ANTI-predictive out of sample (rank IC -0.02
// to -0.04 at every horizon). `regression` on the within-date z-scored residual is the loss the
// metric actually is, and it fits: 0.31 in-sample, 0.035 on an inner held-out block.
// `lambdarank` is retained as a configured alternative, with its truncation level raised so NDCG
// covers the whole group rather than a 30-name head.
//
// TUNING GOES THROUGH CHRONOLOGICAL INNER VALIDATION, NEVER THE TEST BLOCK. The cross-fitted
// frames are split chronologically with an exact label-end purge; the number of boosting rounds
// is chosen by early stopping on that inner validation block, and `objective: 'auto'` selects
// between the two objectives on the same block. The model is then refitted on the full
// cross-fitted history for the chosen number of rounds. Nothing here can see an outer test fold.

const LGBM = require('./lightgbm-adapter');
const RIDGE = require('./ridge');
const { assertNoInSampleStacking } = require('./crossfit');
const { percentileRanks } = require('./xsection');
const { weightedPoint } = require('./ensemble');
const { informationCoefficient } = require('./metrics');

const META_RANKER_VERSION = 'forecast-meta-ranker-v1';

const isFin = Number.isFinite;

/** Per-base-model summary features plus cross-model agreement. Order is deterministic. */
function metaFeatureKeys(baseNames, featureKeys) {
  const keys = [...featureKeys];
  for (const n of baseNames) keys.push(`${n}_point`, `${n}_iw80`, `${n}_down`, `${n}_up`, `${n}_sigma`, `${n}_avail`);
  keys.push('base_count', 'base_disagreement', 'base_spread', 'ens_point', 'ens_rank', 'reliability_best');
  return Object.freeze(keys);
}

/**
 * Build the meta-feature row for one frame.
 * `ensemblePoint` is the dynamically weighted base forecast (an interpretable comparison model
 * in its own right, and an input here); `reliability` is trailing OOS reliability KNOWN AT the
 * frame's as-of date — never a forward-looking score.
 */
function metaFeaturesFor(frame, baseNames, featureKeys, { ensemblePoint = null, reliability = null } = {}) {
  const f = { ...frame.features };
  const points = [];
  for (const n of baseNames) {
    const b = frame.base[n];
    const usable = b && (b.availability === 'ok' || b.availability === 'degraded');
    f[`${n}_point`] = usable && isFin(b.point) ? b.point : null;
    f[`${n}_iw80`] = usable && isFin(b.intervalWidth80) ? b.intervalWidth80 : null;
    f[`${n}_down`] = usable && isFin(b.downsideTail) ? b.downsideTail : null;
    f[`${n}_up`] = usable && isFin(b.upsideTail) ? b.upsideTail : null;
    f[`${n}_sigma`] = usable && isFin(b.sigma) ? b.sigma : null;
    f[`${n}_avail`] = usable ? 1 : 0;
    if (usable && isFin(b.point)) points.push(b.point);
  }
  f.base_count = points.length;
  if (points.length >= 2) {
    const m = points.reduce((a, b) => a + b, 0) / points.length;
    f.base_disagreement = Math.sqrt(points.reduce((a, b) => a + (b - m) * (b - m), 0) / (points.length - 1));
    f.base_spread = Math.max(...points) - Math.min(...points);
  } else {
    f.base_disagreement = null;
    f.base_spread = null;
  }
  f.ens_point = isFin(ensemblePoint) ? ensemblePoint : null;
  f.ens_rank = null;                                   // filled in per date by buildMatrix
  f.reliability_best = reliability && isFin(reliability.best) ? reliability.best : null;
  return { ...frame, features: f };
}

/** Rows sorted by (date, ticker), with the within-date rank of the ensemble point filled in. */
function prepareRows(frames, baseNames, featureKeys, opts) {
  const rows = frames.map((fr) => metaFeaturesFor(fr, baseNames, featureKeys, {
    ensemblePoint: opts.ensemblePointOf ? opts.ensemblePointOf(fr) : null,
    reliability: opts.reliability || null,
  }));
  rows.sort((a, b) => (a.decisionDate < b.decisionDate ? -1 : a.decisionDate > b.decisionDate ? 1 : (a.ticker < b.ticker ? -1 : 1)));
  // ens_rank: within-date percentile of the ensemble point.
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].decisionDate === rows[i].decisionDate) j++;
    const slice = rows.slice(i, j + 1);
    const pr = percentileRanks(slice.map((r) => r.features.ens_point));
    for (let k = 0; k < slice.length; k++) slice[k].features.ens_rank = pr[k];
    i = j + 1;
  }
  return rows;
}

/** Within-date relevance buckets (0..B-1) for lambdarank, from the realized residual return. */
function relevanceLabels(rows, buckets) {
  const labels = new Array(rows.length).fill(0);
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].decisionDate === rows[i].decisionDate) j++;
    const idx = [];
    for (let k = i; k <= j; k++) if (rows[k].label && isFin(rows[k].label.residualReturn)) idx.push(k);
    idx.sort((a, b) => rows[a].label.residualReturn - rows[b].label.residualReturn);
    for (let p = 0; p < idx.length; p++) {
      labels[idx[p]] = Math.min(buckets - 1, Math.floor((p / Math.max(1, idx.length)) * buckets));
    }
    i = j + 1;
  }
  return labels;
}

/** Within-date z-scored residual return, the regression objective's label. */
function zLabels(rows) {
  const labels = new Array(rows.length).fill(0);
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].decisionDate === rows[i].decisionDate) j++;
    const vals = [];
    for (let k = i; k <= j; k++) vals.push(rows[k].label && isFin(rows[k].label.residualReturn) ? rows[k].label.residualReturn : null);
    const fin = vals.filter(isFin);
    const m = fin.length ? fin.reduce((a, b) => a + b, 0) / fin.length : 0;
    const s = fin.length > 1 ? Math.sqrt(fin.reduce((a, b) => a + (b - m) * (b - m), 0) / (fin.length - 1)) : 1;
    for (let k = i; k <= j; k++) labels[k] = isFin(vals[k - i]) && s > 0 ? (vals[k - i] - m) / s : 0;
    i = j + 1;
  }
  return labels;
}

/**
 * Split cross-fitted frames into a chronological inner train/validation pair ending at
 * `endFraction` of the history, purged by EXACT label end: a training row survives only when its
 * label closed strictly before the validation block opens, so an overlapping label cannot leak
 * across the inner boundary either. Returns null when the history is too short to split honestly.
 */
function innerValidationSplit(rows, { validFraction = 0.25, endFraction = 1, minTrainDates = 20, minValidDates = 8 } = {}) {
  const dates = [...new Set(rows.map((r) => r.decisionDate))].sort();
  const endIdx = Math.min(dates.length, Math.max(1, Math.floor(dates.length * endFraction)));
  const nValid = Math.max(minValidDates, Math.floor(dates.length * validFraction));
  const validStartIdx = endIdx - nValid;
  if (validStartIdx < minTrainDates) return null;
  const validStart = dates[validStartIdx];
  const validEnd = dates[endIdx - 1];
  const train = rows.filter((r) => r.decisionDate < validStart && r.label && r.label.labelEnd && r.label.labelEnd < validStart);
  const valid = rows.filter((r) => r.decisionDate >= validStart && r.decisionDate <= validEnd);
  if (!train.length || !valid.length) return null;
  return { train, valid, validStart, validEnd, trainDates: validStartIdx, validDates: valid.length ? new Set(valid.map((r) => r.decisionDate)).size : 0 };
}

/**
 * SEVERAL chronological inner validation blocks, not one.
 *
 * A single trailing block of ~20 decision dates gives a rank-IC estimate with a standard error
 * comparable to the effect being measured — it picked `lambdarank` in two folds at h=1 and both
 * generalized badly. Evaluating every candidate on k expanding-window blocks and averaging is the
 * same idea as the outer walk-forward, applied one level down.
 */
function innerValidationSplits(rows, cfg) {
  const k = Math.max(1, cfg.metaRanker.innerValidBlocks);
  const out = [];
  for (let i = 0; i < k; i++) {
    const endFraction = 1 - (k - 1 - i) * cfg.metaRanker.innerValidFraction;
    if (endFraction <= 0) continue;
    const s = innerValidationSplit(rows, { validFraction: cfg.metaRanker.innerValidFraction, endFraction });
    if (s) out.push({ ...s, block: `iv${i}` });
  }
  return out;
}

/** LightGBM parameters for one objective, from config. */
function paramsFor(cfg, objective, groupSizeHint) {
  const p = {
    num_leaves: cfg.metaRanker.numLeaves,
    learning_rate: cfg.metaRanker.learningRate,
    min_data_in_leaf: cfg.metaRanker.minDataInLeaf,
    feature_fraction: cfg.metaRanker.featureFraction,
    bagging_fraction: cfg.metaRanker.baggingFraction,
    bagging_freq: cfg.metaRanker.baggingFreq,
    lambda_l1: cfg.metaRanker.lambdaL1,
    lambda_l2: cfg.metaRanker.lambdaL2,
    seed: cfg.metaRanker.seed,
    num_threads: cfg.metaRanker.numThreads,
    monotone_constraints: cfg.metaRanker.monotoneConstraints,
  };
  if (objective === 'lambdarank') {
    // Cover the whole group: a truncated NDCG optimizes only the head, which is the defect this
    // module's header documents.
    p.lambdarank_truncation_level = Math.max(30, Math.ceil(groupSizeHint || 0));
  }
  return p;
}

const labelsFor = (objective, rows, cfg) => (objective === 'lambdarank' ? relevanceLabels(rows, cfg.metaRanker.relevanceBuckets) : zLabels(rows));

/** Rank IC of a score vector against the realized residual, per date then averaged. */
function rankICOf(rows, scores) {
  const pairs = rows.map((r, i) => ({ decisionDate: r.decisionDate, score: scores[i], actual: r.label && r.label.residualReturn }));
  const ic = informationCoefficient(pairs);
  return Number.isFinite(ic.meanRankIC) ? ic.meanRankIC : null;
}

/**
 * Fit the meta-ranker on CROSS-FITTED frames and score `predictFrames`.
 * Returns { ok, backend, scores: Map(rowKey -> score), importance, diagnostics }.
 * A LightGBM failure falls back to the ridge cross-sectional ranker and SAYS SO in `backend`.
 */
function fitAndScore({ trainFrames, predictFrames, baseNames, featureKeys, cfg, caps, id = 'meta', ensembleWeights = null, reliability = null }) {
  const guard = assertNoInSampleStacking(trainFrames);
  if (!guard.ok) {
    return { ok: false, backend: null, reason: `refusing to train the meta-ranker on ${guard.violations.length} in-sample stacking frame(s)`, violations: guard.violations.slice(0, 5) };
  }
  const keys = metaFeatureKeys(baseNames, featureKeys);
  // The dynamically weighted ensemble point is an INPUT to the meta-ranker (and its within-date
  // rank alongside it). Both are computed from weights derived only from matured prior-fold OOS
  // results, and `reliability` is likewise known at the as-of date — neither can see this fold's
  // outcomes. When no weights are supplied the columns stay null rather than silently becoming 0.
  const opts = {
    ensemblePointOf: ensembleWeights ? (f) => weightedPoint(f, ensembleWeights).point : null,
    reliability,
  };
  const train = prepareRows(trainFrames.filter((f) => f.label && isFin(f.label.residualReturn)), baseNames, featureKeys, opts);
  const score = prepareRows(predictFrames, baseNames, featureKeys, opts);
  if (!train.length || !score.length) return { ok: false, backend: null, reason: 'no usable training or scoring rows' };

  const wantLightgbm = LGBM.available(caps) && cfg.metaRanker.backend !== 'ridge-xs';
  if (wantLightgbm) {
    const lgbm = fitLightgbm({ train, score, keys, cfg, id });
    if (lgbm.ok) return lgbm;
    // ABSTENTION is a decision, not a failure: the model showed no ranking value on inner
    // validation, so it stands down and the caller uses the dynamic ensemble. Swapping in a
    // different learner here would just relitigate the same question with a different model.
    if (lgbm.abstained) return { ok: false, abstained: true, backend: null, reason: lgbm.reason, innerValidation: lgbm.innerValidation };
    // A genuine failure degrades visibly to the sanctioned fallback — never a silent zero vector.
    const fb = ridgeCrossSectional({ train, score, keys, cfg });
    return { ...fb, backend: 'ridge-xs', degradedFrom: 'lightgbm', degradeReason: lgbm.reason };
  }

  const fb = ridgeCrossSectional({ train, score, keys, cfg });
  return { ...fb, backend: 'ridge-xs', degradedFrom: LGBM.available(caps) ? null : 'lightgbm-unavailable', degradeReason: caps && caps.components ? caps.components.lightgbm.reason : null };
}

/**
 * LightGBM path with chronological inner validation.
 *
 *   1. split the cross-fitted frames into an inner train/validation pair, purged by label end;
 *   2. fit each candidate objective on the inner train, early-stopping on the inner validation;
 *   3. SELECT the objective by rank IC on the inner validation block (never on the test block);
 *   4. refit on the FULL cross-fitted history for the selected number of rounds and score.
 *
 * When the history is too short to split, it falls back to a single fixed-round fit and records
 * `innerValidation: null` so the diagnostic says the tuning did not happen.
 */
function fitLightgbm({ train, score, keys, cfg, id }) {
  const candidates = cfg.metaRanker.objective === 'auto'
    ? ['regression', 'lambdarank']
    : [cfg.metaRanker.objective === 'lambdarank' ? 'lambdarank' : 'regression'];
  const groupHint = train.length / Math.max(1, new Set(train.map((r) => r.decisionDate)).size);
  const blocks = innerValidationSplits(train, cfg);

  let chosen = candidates[0];
  let rounds = cfg.metaRanker.numRounds;
  let selection = null;

  if (blocks.length) {
    const jobs = [];
    for (const b of blocks) {
      for (const objective of candidates) {
        jobs.push({
          id: `${id}.${objective}.${b.block}`,
          objective,
          params: paramsFor(cfg, objective, groupHint),
          numRounds: cfg.metaRanker.numRounds,
          earlyStoppingRounds: cfg.metaRanker.earlyStoppingRounds,
          featureKeys: keys,
          trainRows: b.train, trainLabels: labelsFor(objective, b.train, cfg),
          grouped: objective === 'lambdarank',
          validRows: b.valid, validLabels: labelsFor(objective, b.valid, cfg),
          // The RAW residual return is the ranking target the sidecar sweeps iterations against,
          // so the round count is chosen by the metric this system reports, not by LightGBM's loss.
          validRankTarget: b.valid.map((r) => (r.label && Number.isFinite(r.label.residualReturn) ? r.label.residualReturn : NaN)),
          rankIcStep: cfg.metaRanker.rankIcStep,
          predictRows: b.valid,
        });
      }
    }
    const iv = LGBM.fitPredict(jobs);
    if (!iv.ok) {
      selection = { error: iv.reason, blocks: blocks.length };
    } else {
      const perCandidate = candidates.map((objective) => {
        const per = blocks.map((b) => {
          const r = iv.results[`${id}.${objective}.${b.block}`];
          if (!r || !r.ok) return { block: b.block, rankIC: null, rounds: null, error: r && r.reason };
          return Number.isFinite(r.validRankIC) && r.bestIterationByRankIC
            ? { block: b.block, rankIC: r.validRankIC, rounds: r.bestIterationByRankIC, selectedBy: 'rank-ic-sweep' }
            : { block: b.block, rankIC: rankICOf(b.valid, r.predictions), rounds: r.bestIteration, selectedBy: 'final-iteration' };
        });
        const ics = per.map((x) => x.rankIC).filter(Number.isFinite);
        const rds = per.map((x) => x.rounds).filter(Number.isFinite).sort((a, b) => a - b);
        // ROUNDS COME FROM THE LAST BLOCK, not the median. Selection uses all blocks (robustness),
        // but the number of boosting rounds is a capacity choice that should match the amount of
        // data the FINAL refit sees — and the last block, trained on the most history, is the
        // closest analogue. The earliest block trains on ~40% of the history and systematically
        // wants fewer rounds than the refit needs.
        const lastUsable = [...per].reverse().find((x) => Number.isFinite(x.rounds));
        return {
          objective, blocks: per,
          meanRankIC: ics.length ? ics.reduce((a, b) => a + b, 0) / ics.length : null,
          positiveBlocks: ics.filter((v) => v > 0).length,
          usableBlocks: ics.length,
          medianRounds: rds.length ? rds[rds.length >> 1] : null,
          rounds: lastUsable ? lastUsable.rounds : null,
        };
      });
      const usable = perCandidate.filter((c) => Number.isFinite(c.meanRankIC));
      const best = usable.length ? usable.reduce((a, b) => (b.meanRankIC > a.meanRankIC ? b : a)) : null;

      // THE BASELINE, MEASURED ON THE SAME INNER BLOCKS — free, because the cross-fitted frames
      // already carry the baseline's out-of-fold prediction for exactly these rows. No refit.
      const baselinePer = blocks.map((b) => ({
        block: b.block,
        rankIC: rankICOf(b.valid, b.valid.map((r) => {
          const p = r.features && r.features.ens_point;
          if (Number.isFinite(p)) return p;
          const rb = r.base && r.base.ridge;
          return rb && Number.isFinite(rb.point) ? rb.point : NaN;
        })),
      }));
      const bIcs = baselinePer.map((x) => x.rankIC).filter(Number.isFinite);
      const baselineMean = bIcs.length ? bIcs.reduce((a, b) => a + b, 0) / bIcs.length : null;
      const edge = (best && Number.isFinite(baselineMean)) ? best.meanRankIC - baselineMean : null;

      // ABSTENTION GATE. The meta-ranker must show INCREMENTAL value over the permanent baseline
      // on chronological inner validation before it is allowed to rank — being merely positive is
      // not enough, because the baseline is already positive. Measured: ungated, the model beat
      // the baseline at h=5 (+0.034 vs +0.016) and lost to it at h=1 (+0.019 vs +0.025), so the
      // honest behaviour is to run where it earns its place and stand down where it does not.
      // Standing down hands the fold to the dynamic ensemble — the fallback that already exists.
      const gate = {
        minMeanRankIC: cfg.metaRanker.minInnerRankIC,
        minEdgeOverBaseline: cfg.metaRanker.minInnerEdgeOverBaseline,
        minPositiveBlocks: cfg.metaRanker.minInnerPositiveBlocks,
        baselineMeanRankIC: baselineMean,
        baselineBlocks: baselinePer,
        candidateMeanRankIC: best && best.meanRankIC,
        edgeOverBaseline: edge,
        passed: !!best
          && best.meanRankIC > cfg.metaRanker.minInnerRankIC
          && best.positiveBlocks >= Math.min(cfg.metaRanker.minInnerPositiveBlocks, best.usableBlocks)
          && (baselineMean === null || edge > cfg.metaRanker.minInnerEdgeOverBaseline),
      };
      selection = { blocks: blocks.map((b) => ({ block: b.block, validStart: b.validStart, validEnd: b.validEnd, validDates: b.validDates, trainDates: b.trainDates })), candidates: perCandidate, chosen: best && best.objective, gate };
      if (!gate.passed) {
        return {
          ok: false, abstained: true, innerValidation: selection,
          reason: best
            ? `inner validation did not show incremental value over the baseline (best ${best.objective} mean rank IC ${best.meanRankIC.toFixed(4)} vs baseline ${baselineMean === null ? 'n/a' : baselineMean.toFixed(4)}, edge ${edge === null ? 'n/a' : edge.toFixed(4)}, ${best.positiveBlocks}/${best.usableBlocks} blocks positive)`
            : 'inner validation produced no usable candidate',
        };
      }
      chosen = best.objective;
      rounds = Math.max(cfg.metaRanker.minRounds, best.medianRounds || cfg.metaRanker.numRounds);
    }
  }

  const finalId = `${id}.final`;
  const r = LGBM.fitPredict([{
    id: finalId,
    objective: chosen,
    params: paramsFor(cfg, chosen, groupHint),
    numRounds: rounds,
    featureKeys: keys,
    trainRows: train, trainLabels: labelsFor(chosen, train, cfg),
    grouped: chosen === 'lambdarank',
    predictRows: score,
  }]);
  const res = r.ok ? r.results[finalId] : null;
  if (!r.ok || !res || !res.ok) return { ok: false, reason: r.ok ? (res ? res.reason : 'no result returned') : r.reason };

  const scores = new Map();
  score.forEach((row, i) => scores.set(row.rowKey, res.predictions[i]));
  return {
    ok: true, backend: 'lightgbm', objective: chosen, scores,
    importance: res.importance, bestIteration: res.bestIteration, rounds,
    featureKeys: keys, trainRows: train.length,
    innerValidation: selection,
    diagnostics: { lightgbmVersion: r.meta && r.meta.lightgbmVersion, elapsedMs: r.meta && r.meta.elapsedMs },
  };
}

/** The sanctioned fallback: a ridge regression over the meta-features, ranked within date. */
function ridgeCrossSectional({ train, score, keys, cfg }) {
  const labels = zLabels(train);
  const trainRows = train.map((r, i) => ({ ...r, label: { residualReturn: labels[i] } }));
  const model = RIDGE.fitRidge(trainRows, keys, cfg, { horizon: train[0] && train[0].horizon });
  if (!model.fitted) return { ok: false, reason: `ridge-xs fallback could not fit: ${model.reason}`, scores: new Map(), featureKeys: keys };
  const scores = new Map();
  for (const row of score) scores.set(row.rowKey, RIDGE.predictPoint(model, row));
  return { ok: true, scores, importance: null, featureKeys: keys, trainRows: train.length, objective: 'regression-z' };
}

module.exports = { META_RANKER_VERSION, metaFeatureKeys, metaFeaturesFor, prepareRows, relevanceLabels, zLabels, fitAndScore, ridgeCrossSectional, innerValidationSplit, innerValidationSplits, fitLightgbm, paramsFor };
