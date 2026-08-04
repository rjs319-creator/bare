'use strict';
// AUTHENTICATED MODEL OPERATIONS — the runtime workflow the registry was missing.
//
//   op=modeltrain        (privileged) train a candidate on the accrued PIT dataset, save an
//                        immutable artifact with a COMPLETE model card + gate result
//   op=modelpromote      (privileged) gate-checked promotion of a saved artifact → SHADOW
//   op=modelchallenger   (privileged) register a shadow CHALLENGER beside the champion
//   op=modelpromotelive  (privileged) explicit live promotion — requires passed-gates card
//                        AND the accrued minimum prospective shadow window
//   op=modelrollback     (privileged) one-call restore of the previous champion pointer
//   op=modelstatus       (public read) champion/challenger/shadow-window/rollback state
//
// Every mutating op is routed through api/tracker's PRIVILEGED_OPS (bearer CRON_SECRET,
// fail-closed in production) and stamps an ACTOR + reason into the pointer history, so
// promotion is authenticated, attributable and auditable. There is NO automatic live
// promotion anywhere: modeltrain never touches a pointer, modelpromote lands in shadow,
// and modelpromotelive is a separate explicit human-invoked decision.

const registry = require('./model-registry');

const actorOf = req => (req.query.actor && String(req.query.actor).slice(0, 60)) || 'authenticated-operator';

// Standard, honest limitation list stamped on every trained candidate.
const STANDARD_LIMITATIONS = Object.freeze([
  'trained on prospectively-accrued intraday data only (no historical intraday depth exists on current feeds)',
  'costs are MODELED from liquidity tiers (no observed bid/ask on current feeds)',
  'outputs are uncalibrated for display until the nested OOF calibration gate passes',
  'no microstructure features (provider not configured)',
  'universe limited to the liquid discovery universe (≈2,500 names, liquidity-core + rotation)',
]);

async function runModelTrain(req, res) {
  const { listDatasetDates } = require('./intraday-backlog');
  const { loadTrainingDays, evaluateDatasetSurvival, recordTrial, EMBARGO_DAYS, PRIMARY_BARRIER } = require('./intraday-training');
  const { trainLogistic } = require('./survival-model');
  const { DATASET_FEATURES } = require('./intraday-schema');
  const { DATASET_VERSION } = require('./intraday-dataset');
  const { LABEL_VERSION } = require('./intraday-labels');
  const { POLICY_VERSION } = require('./daytrade-decision-policy');

  const dates = await listDatasetDates();
  const { rows, skipped } = await loadTrainingDays(dates);
  const clean = rows.filter(r => r && r.features && r.date
    && (r.labelTarget === 0 || r.labelTarget === 1) && (r.labelStop === 0 || r.labelStop === 1));
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  const joinLossRatio = clean.length + skippedTotal > 0 ? +(skippedTotal / (clean.length + skippedTotal)).toFixed(4) : null;

  const trial = await recordTrial(
    { op: 'modeltrain', features: DATASET_FEATURES, primaryBarrier: PRIMARY_BARRIER, labelVersion: LABEL_VERSION, datasetVersion: DATASET_VERSION, wf: { embargoDays: EMBARGO_DAYS } },
    { dates: dates.length, rows: clean.length },
  );
  const shadow = await registry.shadowStats();
  const evalResult = evaluateDatasetSurvival(rows, {
    context: { joinLossRatio, trials: trial.trials, shadowDays: shadow.shadowDays, shadowEpisodes: shadow.shadowEpisodes },
  });
  if (evalResult.status !== 'evaluated') {
    return res.status(200).json({ ok: false, reason: 'insufficient-data', evaluation: evalResult });
  }

  // Fit the FULL-window artifact (all clean rows — the walk-forward already produced the
  // honest OOS estimate; the artifact is what shadow-scores prospectively from here).
  const mTarget = trainLogistic(clean, DATASET_FEATURES, r => r.labelTarget, { weighted: true });
  const mStop = trainLogistic(clean, DATASET_FEATURES, r => r.labelStop, { weighted: true });
  const hazardRows = clean.filter(r => r.labelHazard === 0 || r.labelHazard === 1);
  const mHazard = hazardRows.length ? trainLogistic(hazardRows, DATASET_FEATURES, r => r.labelHazard, { weighted: true }) : null;
  if (!mTarget || !mStop) return res.status(200).json({ ok: false, reason: 'full-window-fit-failed' });

  const sortedDates = [...new Set(clean.map(r => r.date))].sort();
  const version = (req.query.version && String(req.query.version)) || `dutil-v2-${sortedDates[sortedDates.length - 1]}`;
  const saved = await registry.saveCandidate({
    model: { target: mTarget, stop: mStop, hazard: mHazard },
    meta: {
      version,
      trainedAt: new Date().toISOString(),
      dataWindow: { firstDate: sortedDates[0], lastDate: sortedDates[sortedDates.length - 1], rows: clean.length, episodes: evalResult.episodes },
      features: DATASET_FEATURES,
      exclusions: { ...skipped, joinLossRatio },
      metrics: {
        weighted: evalResult.metrics.weighted, policy: evalResult.metrics.policy, hazard: evalResult.metrics.hazard,
        folds: evalResult.folds, testEpisodes: evalResult.testEpisodes,
        datasetVersion: DATASET_VERSION, labelVersion: LABEL_VERSION, policyVersion: POLICY_VERSION,
      },
      limitations: [...STANDARD_LIMITATIONS],
      gate: evalResult.promotion,
    },
  });
  return res.status(200).json({
    ok: saved.ok === true, saved, gate: evalResult.promotion,
    evaluationSummary: { episodes: evalResult.episodes, testEpisodes: evalResult.testEpisodes, folds: evalResult.folds, policy: evalResult.metrics.policy },
    note: 'Artifact saved (immutable). NOTHING was promoted — promotion is a separate authenticated decision (op=modelpromote → shadow; op=modelpromotelive → live after the prospective shadow window).',
  });
}

async function runModelPromote(req, res) {
  const version = req.query.version;
  if (!version) return res.status(400).json({ ok: false, error: 'version required' });
  const artifact = await registry.loadArtifact(version);
  if (!artifact) return res.status(404).json({ ok: false, error: 'artifact-not-found' });
  const out = await registry.promote(version, {
    gate: artifact.gate, actor: actorOf(req), reason: req.query.reason || null,
  });
  return res.status(out.ok ? 200 : 409).json({ ...out, mode: out.ok ? 'shadow' : undefined });
}

async function runModelChallenger(req, res) {
  const version = req.query.version;
  if (!version) return res.status(400).json({ ok: false, error: 'version required' });
  const out = await registry.setShadowChallenger(version, { actor: actorOf(req), reason: req.query.reason || null });
  return res.status(out.ok ? 200 : 409).json(out);
}

async function runModelPromoteLive(req, res) {
  const version = req.query.version;
  if (!version) return res.status(400).json({ ok: false, error: 'version required' });
  const out = await registry.promoteLive(version, { actor: actorOf(req), reason: req.query.reason || null });
  return res.status(out.ok ? 200 : 409).json(out);
}

async function runModelRollback(req, res) {
  const out = await registry.rollback();
  return res.status(out.ok ? 200 : 409).json({ ...out, actor: actorOf(req) });
}

// Public read: active champion/challenger/shadow-window state — the versions every live
// response references, without exposing coefficients.
async function runModelStatus(req, res) {
  const champ = await registry.getChampion();
  const challenger = await registry.getShadowChallenger();
  const shadow = await registry.shadowStats();
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.json({
    ok: true,
    champion: champ.artifact
      ? { version: champ.version, mode: champ.mode, promotedAt: champ.promotedAt, card: champ.artifact.card }
      : { ...champ },
    challenger: challenger ? { version: challenger.version, mode: challenger.mode, promotedAt: challenger.promotedAt } : null,
    shadowWindow: shadow,
    policyVersion: require('./daytrade-decision-policy').POLICY_VERSION,
    costModelVersion: require('./intraday-costs').COST_MODEL_VERSION,
  });
}

function runModelOps(req, res) {
  switch (req.query.op) {
    case 'modeltrain': return runModelTrain(req, res);
    case 'modelpromote': return runModelPromote(req, res);
    case 'modelchallenger': return runModelChallenger(req, res);
    case 'modelpromotelive': return runModelPromoteLive(req, res);
    case 'modelrollback': return runModelRollback(req, res);
    case 'modelstatus': return runModelStatus(req, res);
    default: return res.status(400).json({ ok: false, error: `unknown model op ${req.query.op}` });
  }
}

module.exports = { runModelOps, runModelTrain, runModelPromote, runModelPromoteLive, runModelRollback, runModelStatus, STANDARD_LIMITATIONS };
