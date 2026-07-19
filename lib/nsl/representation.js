'use strict';
// NOVEL SIGNAL LAB — Engine 7: chronological self-supervised representation (representation-v1).
//
// An EXPERIMENTAL, shadow-only representation learner: it compresses historical market-state
// feature vectors into a compact latent WITHOUT using any future-return label, then freezes.
// The pretext task is reconstruction — a linear autoencoder (top-k principal components of the
// standardized pre-cutoff feature covariance), the deterministic, dependency-free stand-in for
// the masked-reconstruction objective in the spec. It is invariant to per-feature scaling
// (features are standardized) and never sees security identity (no ticker embedding), so it
// cannot memorise per-name average returns.
//
// SAFETY (acceptance criteria): the encoder is fit ONLY on rows dated ≤ `cutoff`; it is FROZEN
// (mean/sd/components are fixed) before any downstream use; a dataset hash + cutoff are stamped
// so a fold cannot silently pretrain on its own future. Reconstruction drift on post-cutoff rows
// is reported. This module never claims incremental value — that is the evaluator's job. Pure.

const { hashContent } = require('../run-manifest');
const { makeEnvelope, STATUS, DIRECTION } = require('./registry');

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = (a, m) => { if (a.length < 2) return 1; const mu = m == null ? mean(a) : m; return Math.sqrt(a.reduce((s, v) => s + (v - mu) ** 2, 0) / (a.length - 1)) || 1; };

// Deterministic top-k eigenvectors of a symmetric matrix via power iteration + deflation.
function topEigenvectors(cov, k, iters = 100) {
  const d = cov.length; const vecs = [];
  let M = cov.map(row => row.slice());
  for (let c = 0; c < k; c++) {
    let v = new Array(d).fill(0).map((_, i) => (i === c % d ? 1 : 0.001 * ((i % 7) - 3))); // fixed deterministic seed
    for (let it = 0; it < iters; it++) {
      const mv = new Array(d).fill(0);
      for (let i = 0; i < d; i++) { let s = 0; for (let j = 0; j < d; j++) s += M[i][j] * v[j]; mv[i] = s; }
      const norm = Math.sqrt(mv.reduce((s, x) => s + x * x, 0)) || 1;
      v = mv.map(x => x / norm);
    }
    // Rayleigh quotient = eigenvalue.
    let lambda = 0; for (let i = 0; i < d; i++) { let s = 0; for (let j = 0; j < d; j++) s += M[i][j] * v[j]; lambda += v[i] * s; }
    vecs.push({ vec: v, lambda });
    // Deflate.
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) M[i][j] -= lambda * v[i] * v[j];
  }
  return vecs;
}

// Fit the frozen encoder on rows dated ≤ cutoff. rows = [{ date, features:{...} }].
function fitRepresentation(rows, featureKeys, cutoff, { k = 4 } = {}) {
  const train = (rows || []).filter(r => r && r.date && r.date <= cutoff && r.features);
  if (train.length < Math.max(30, featureKeys.length * 5)) return { insufficient: true, n: train.length };
  const cols = featureKeys.map(key => train.map(r => (Number.isFinite(r.features[key]) ? r.features[key] : null)));
  const stat = featureKeys.map((_, c) => { const vals = cols[c].filter(Number.isFinite); const m = mean(vals); return { mu: m, sd: sd(vals, m) }; });
  const Z = train.map(r => featureKeys.map((key, c) => (Number.isFinite(r.features[key]) ? (r.features[key] - stat[c].mu) / stat[c].sd : 0)));
  // Covariance (features × features).
  const d = featureKeys.length; const cov = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const z of Z) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) cov[i][j] += z[i] * z[j] / Z.length;
  const kEff = Math.min(k, d);
  const eig = topEigenvectors(cov, kEff);
  const components = eig.map(e => e.vec);
  const model = Object.freeze({
    version: 'representation-v1', featureKeys: featureKeys.slice(), cutoff,
    stat, components, k: kEff,
    datasetHash: hashContent(JSON.stringify({ n: train.length, cutoff, featureKeys, firstDate: train[0].date })),
    trainReconError: reconError(Z, components),
  });
  return { insufficient: false, model };
}

function encodeRow(model, features) {
  if (!model || model.insufficient) return null;
  const z = model.featureKeys.map((key, c) => (Number.isFinite(features[key]) ? (features[key] - model.stat[c].mu) / model.stat[c].sd : 0));
  return model.components.map(comp => comp.reduce((s, w, i) => s + w * z[i], 0));
}

function reconError(Z, components) {
  let err = 0;
  for (const z of Z) {
    const lat = components.map(comp => comp.reduce((s, w, i) => s + w * z[i], 0));
    const recon = z.map((_, i) => components.reduce((s, comp, c) => s + comp[i] * lat[c], 0));
    err += z.reduce((s, v, i) => s + (v - recon[i]) ** 2, 0) / z.length;
  }
  return +(err / Z.length).toFixed(4);
}

// Drift: mean reconstruction error on post-cutoff rows vs the training error.
function representationDrift(model, rows) {
  const post = (rows || []).filter(r => r && r.date && r.date > model.cutoff && r.features);
  if (!post.length) return null;
  const Z = post.map(r => model.featureKeys.map((key, c) => (Number.isFinite(r.features[key]) ? (r.features[key] - model.stat[c].mu) / model.stat[c].sd : 0)));
  const postErr = reconError(Z, model.components);
  return { postReconError: postErr, ratio: model.trainReconError > 0 ? +(postErr / model.trainReconError).toFixed(3) : null, n: post.length };
}

// Envelope for one row's latent (experimental — carries provenance, not a tradeable score).
function toEnvelope(model, row, drift, { ticker, securityId, asOf } = {}) {
  const latent = model && !model.insufficient ? encodeRow(model, row.features || {}) : null;
  return makeEnvelope({
    engine: 7, signal: 'representation', signalVersion: 'representation-v1', ticker, securityId, asOf,
    status: STATUS.EXPERIMENTAL,
    score: null, // a latent vector is not a directional score
    direction: DIRECTION.NEUTRAL,
    coverage: latent ? 1 : 0,
    warnings: ['experimental representation — no proven incremental value; latent is frozen & label-free'],
    inputs: {
      representation_version: model && !model.insufficient ? model.version : null,
      pretraining_cutoff: model && !model.insufficient ? model.cutoff : null,
      pretraining_dataset_hash: model && !model.insufficient ? model.datasetHash : null,
      representation_drift: drift ? drift.ratio : null,
      representation_coverage: latent ? 1 : 0,
      representation_quality: model && !model.insufficient ? +(1 / (1 + model.trainReconError)).toFixed(3) : null,
      latent: latent ? latent.map(v => +v.toFixed(4)) : null,
    },
  });
}

module.exports = { fitRepresentation, encodeRow, representationDrift, reconError, topEigenvectors, toEnvelope };
