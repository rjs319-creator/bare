'use strict';
// MODEL REGISTRY, MANIFESTS & LINEAGE (forecast-registry-v1)
//
// Every training or inference run emits a MANIFEST: what code, what config, what data, what
// folds, what packages, what checkpoints, what seeds, what costs — enough for another developer
// to reproduce the run, and enough for the system to REFUSE an incompatible artifact.
//
// Artifact compatibility is checked, not assumed. An artifact may be reused only when its
// feature schema, target definition, target version, horizon, config hash and model revision all
// match the consumer's, and its training cutoff is not later than the consumer's data cutoff.
// `checkCompatibility` returns every mismatch, so a refusal explains itself.
//
// Nothing here writes a model checkpoint into the application database; artifacts live on the
// filesystem/blob under `cfg.artifactDir` and the registry stores only their identity + hash.

const crypto = require('crypto');
const { stableStringify } = require('./config');

const REGISTRY_VERSION = 'forecast-registry-v1';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Package/runtime versions actually present, for the manifest. Never invented. */
function runtimeFingerprint(caps) {
  return Object.freeze({
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    sidecar: caps ? Object.freeze({ ...caps.sidecar }) : null,
    packages: caps ? Object.freeze(Object.fromEntries(Object.entries(caps.components).map(([k, v]) => [k, v.packageVersion || null]))) : null,
  });
}

/**
 * Build a run manifest. `content` is hashed so two runs with identical inputs share a
 * `manifestHash` — the reproducibility check.
 */
function makeManifest({ runType, cfg, caps, universe = null, folds = null, dataCutoff = null, codeVersions = {}, costs = null, notes = [] }) {
  const content = {
    runType,                       // 'train' | 'walk-forward' | 'inference' | 'backtest'
    configHash: cfg.configHash,
    seed: cfg.seed,
    horizons: [...cfg.horizons],
    quantiles: [...cfg.quantiles],
    featureVersion: cfg.features.version,
    targetVersion: cfg.target.version,
    targetDefinition: cfg.target.definition,
    execution: { ...cfg.execution },
    universe: universe ? { policy: universe.policy, size: universe.size, decisionDate: universe.decisionDate, survivorshipSafe: universe.survivorshipSafe } : null,
    folds: folds ? folds.map((f) => ({ id: f.id, trainStart: f.trainStart, trainEnd: f.trainEnd, testStart: f.testStart, testEnd: f.testEnd, embargoSessions: f.embargoSessions })) : null,
    dataCutoff,
    codeVersions,
    capabilities: caps ? { tier: caps.tier, tierLabel: caps.tierLabel, baseModels: [...caps.baseModels], metaBackend: caps.metaBackend, degraded: [...caps.degraded] } : null,
    costs: costs || { model: cfg.costs.model, stressMultipliers: [...cfg.costs.stressMultipliers] },
  };
  return Object.freeze({
    schema: 'ForecastManifest', version: REGISTRY_VERSION,
    generatedAt: new Date().toISOString(),
    manifestHash: sha256(stableStringify(content)).slice(0, 16),
    runtime: runtimeFingerprint(caps),
    notes: Object.freeze([...notes]),
    ...content,
  });
}

/** Identity of a persisted artifact (a fitted model, a scaler, a calibrator). */
function makeArtifactRecord({ kind, model, horizon, cfg, trainCutoff, dataCutoff, featureKeys, revision = null, path = null, bytes = null, extra = {} }) {
  const identity = {
    kind, model, horizon,
    featureVersion: cfg.features.version,
    featureSchemaHash: sha256(stableStringify(featureKeys || [])).slice(0, 16),
    targetVersion: cfg.target.version,
    targetDefinition: cfg.target.definition,
    configHash: cfg.configHash,
    revision, trainCutoff, dataCutoff,
  };
  return Object.freeze({
    schema: 'ForecastArtifact', version: REGISTRY_VERSION,
    artifactId: sha256(stableStringify(identity)).slice(0, 20),
    createdAt: new Date().toISOString(),
    path, bytes,
    ...identity,
    ...extra,
  });
}

/**
 * May `artifact` be used by a consumer with this config/cutoff?
 * Returns { compatible, mismatches:[...] } — a refusal always names every reason.
 */
function checkCompatibility(artifact, { cfg, horizon, featureKeys, dataCutoff = null, revision = undefined }) {
  const mismatches = [];
  if (!artifact) return { compatible: false, mismatches: ['no artifact'] };
  if (artifact.configHash !== cfg.configHash) mismatches.push(`configHash ${artifact.configHash} != ${cfg.configHash}`);
  if (artifact.featureVersion !== cfg.features.version) mismatches.push(`featureVersion ${artifact.featureVersion} != ${cfg.features.version}`);
  if (artifact.targetVersion !== cfg.target.version) mismatches.push(`targetVersion ${artifact.targetVersion} != ${cfg.target.version}`);
  if (artifact.targetDefinition !== cfg.target.definition) mismatches.push(`targetDefinition ${artifact.targetDefinition} != ${cfg.target.definition}`);
  if (horizon != null && artifact.horizon !== horizon) mismatches.push(`horizon ${artifact.horizon} != ${horizon}`);
  if (featureKeys) {
    const h = sha256(stableStringify(featureKeys)).slice(0, 16);
    if (artifact.featureSchemaHash !== h) mismatches.push('feature schema hash differs — the column set changed');
  }
  if (revision !== undefined && artifact.revision !== revision) mismatches.push(`model revision ${artifact.revision} != ${revision}`);
  // An artifact trained THROUGH a date later than the consumer's data cutoff would leak.
  if (dataCutoff && artifact.trainCutoff && artifact.trainCutoff > dataCutoff) {
    mismatches.push(`artifact trainCutoff ${artifact.trainCutoff} is later than the consumer's dataCutoff ${dataCutoff} — reusing it would leak future information`);
  }
  return { compatible: mismatches.length === 0, mismatches };
}

/** Lineage record attached to a prediction row so a reader can trace it end to end. */
function lineageFor({ manifest, fold, models, weights, calibrators, scoreMapping }) {
  return Object.freeze({
    manifestHash: manifest ? manifest.manifestHash : null,
    configHash: manifest ? manifest.configHash : null,
    fold: fold || null,
    models: Object.freeze(Object.fromEntries(Object.entries(models || {}).map(([k, v]) => [k, v && v.artifactId ? v.artifactId : (v && v.revision) || null]))),
    ensembleWeights: weights ? Object.freeze({ ...weights.weights, _status: weights.status, _asOf: weights.asOf }) : null,
    calibrators: Object.freeze(Object.fromEntries(Object.entries(calibrators || {}).map(([k, c]) => [k, c ? { status: c.status, method: c.method, n: c.n, through: c.fittedThroughDate } : null]))),
    scoreMapping: scoreMapping ? { n: scoreMapping.n } : null,
  });
}

module.exports = { REGISTRY_VERSION, sha256, runtimeFingerprint, makeManifest, makeArtifactRecord, checkCompatibility, lineageFor };
