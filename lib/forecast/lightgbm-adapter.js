'use strict';
// LIGHTGBM ADAPTER (forecast-lightgbm-adapter-v1)
//
// Bridges Node to the LightGBM sidecar. Design matrices cross the boundary as raw
// little-endian float32/int32 FILES in a temp directory, not as JSON — encoding a
// 200k x 75 matrix as JSON costs more than the training does.
//
// Contract with the caller:
//   * `available(caps)` is the ONLY way to ask whether LightGBM can run; nothing here probes.
//   * A failed job returns { ok:false, reason } and NEVER a vector of zeros. The caller falls
//     back explicitly (lib/forecast/meta-ranker.js), so a degraded run is always visible.
//   * Temp files are removed on the way out, including on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sidecar = require('./sidecar');

const LIGHTGBM_ADAPTER_VERSION = 'forecast-lightgbm-adapter-v1';

const available = (caps) => !!(caps && caps.components && caps.components.lightgbm.available);

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `cfr-lgbm-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a row-major Float32 matrix built from `rows` × `featureKeys`. Missing → NaN (LightGBM handles it natively). */
function writeMatrix(file, rows, featureKeys) {
  const p = featureKeys.length;
  const buf = Buffer.allocUnsafe(rows.length * p * 4);
  let o = 0;
  for (const r of rows) {
    const f = r.features || {};
    for (let i = 0; i < p; i++) {
      const v = f[featureKeys[i]];
      buf.writeFloatLE(Number.isFinite(v) ? v : NaN, o);
      o += 4;
    }
  }
  fs.writeFileSync(file, buf);
  return { rows: rows.length, cols: p };
}

function writeF32(file, values) {
  const buf = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i++) buf.writeFloatLE(Number.isFinite(values[i]) ? values[i] : NaN, i * 4);
  fs.writeFileSync(file, buf);
  return values.length;
}

function writeI32(file, values) {
  const buf = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i++) buf.writeInt32LE(values[i], i * 4);
  fs.writeFileSync(file, buf);
  return values.length;
}

function readF32(file, n) {
  const buf = fs.readFileSync(file);
  if (buf.length !== n * 4) throw new Error(`prediction file ${file}: expected ${n * 4} bytes, got ${buf.length}`);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/**
 * Group sizes for a date-grouped ranking objective. Rows MUST already be sorted by date;
 * an out-of-order row would silently merge two dates into one ranking group, which is exactly
 * the "compare unrelated dates" failure the spec forbids — so this throws instead.
 */
function groupSizes(rows) {
  const sizes = [];
  let cur = null, n = 0;
  const seen = new Set();
  for (const r of rows) {
    if (r.decisionDate !== cur) {
      if (cur !== null) { sizes.push(n); seen.add(cur); }
      if (seen.has(r.decisionDate)) throw new Error(`rows are not sorted by decisionDate: ${r.decisionDate} reappears`);
      cur = r.decisionDate; n = 0;
    }
    n++;
  }
  if (cur !== null) sizes.push(n);
  return sizes;
}

/**
 * Run one or more fit+predict jobs in a single sidecar process.
 *   jobs: [{ id, objective, params, numRounds, featureKeys,
 *            trainRows, trainLabels, trainWeights?, grouped, predictRows }]
 * Returns { ok, results: { id -> { predictions, importance, bestIteration } }, meta } or
 *         { ok:false, reason }.
 */
function fitPredict(jobs, { timeoutMs = 900000 } = {}) {
  if (!jobs || !jobs.length) return { ok: true, results: {}, meta: null };
  const dir = makeTempDir();
  try {
    const payload = { jobs: [] };
    const bookkeeping = new Map();

    for (const job of jobs) {
      const base = path.join(dir, String(job.id).replace(/[^A-Za-z0-9._-]/g, '_'));
      const trainX = `${base}.trX`, trainY = `${base}.trY`, predX = `${base}.pX`, predOut = `${base}.pOut`;
      const shape = writeMatrix(trainX, job.trainRows, job.featureKeys);
      writeF32(trainY, job.trainLabels);
      const spec = {
        id: job.id,
        objective: job.objective,
        params: job.params,
        numRounds: job.numRounds,
        featureNames: job.featureKeys,
        train: { x: trainX, y: trainY, rows: shape.rows, cols: shape.cols },
      };
      if (job.trainWeights) { const wf = `${base}.trW`; writeF32(wf, job.trainWeights); spec.train.weight = wf; }
      if (job.grouped) {
        const gf = `${base}.trG`;
        const g = groupSizes(job.trainRows);
        writeI32(gf, g);
        spec.train.group = gf; spec.train.groups = g.length;
      }
      // Optional chronological validation block -> enables early stopping in the sidecar. The
      // caller is responsible for making it chronologically LATER than the training block and
      // purged against it; this adapter only marshals what it is given.
      if (job.validRows && job.validRows.length) {
        const vX = `${base}.vaX`, vY = `${base}.vaY`;
        const vshape = writeMatrix(vX, job.validRows, job.featureKeys);
        writeF32(vY, job.validLabels);
        spec.valid = { x: vX, y: vY, rows: vshape.rows, cols: vshape.cols };
        if (job.grouped) {
          const vg = `${base}.vaG`;
          const g = groupSizes(job.validRows);
          writeI32(vg, g);
          spec.valid.group = vg; spec.valid.groups = g.length;
        }
        spec.earlyStoppingRounds = job.earlyStoppingRounds || 30;
        // The RAW ranking target for the validation block, plus its group sizes, so the sidecar
        // can pick the iteration count that maximizes mean per-group Spearman — the metric this
        // system is judged by — instead of LightGBM's own loss.
        if (job.validRankTarget && job.validRankTarget.length === job.validRows.length) {
          const vr = `${base}.vaR`;
          writeF32(vr, job.validRankTarget);
          spec.valid.rankTarget = vr;
          if (!spec.valid.group) {
            const vg = `${base}.vaGr`;
            const g = groupSizes(job.validRows);
            writeI32(vg, g);
            spec.valid.group = vg; spec.valid.groups = g.length;
          }
          spec.rankIcStep = job.rankIcStep || 10;
        }
      }
      const pshape = writeMatrix(predX, job.predictRows, job.featureKeys);
      spec.predict = { x: predX, rows: pshape.rows, cols: pshape.cols, out: predOut };
      payload.jobs.push(spec);
      bookkeeping.set(job.id, { predOut, predRows: pshape.rows });
    }

    const r = sidecar.runScript('lightgbm_rank.py', payload, { timeoutMs });
    if (!r.ok) return { ok: false, reason: r.error, stderr: r.stderr || null };

    const results = {};
    for (const res of r.data.results || []) {
      if (!res.ok) { results[res.id] = { ok: false, reason: res.error }; continue; }
      const bk = bookkeeping.get(res.id);
      results[res.id] = {
        ok: true,
        predictions: readF32(bk.predOut, bk.predRows),
        importance: res.importance || {},
        bestIteration: res.bestIteration,
        bestIterationByRankIC: res.bestIterationByRankIC ?? null,
        validRankIC: res.validRankIC ?? null,
        rankIcByIteration: res.rankIcByIteration || null,
        numTrees: res.numTrees,
        trainRows: res.trainRows,
      };
    }
    return {
      ok: true, results,
      meta: { lightgbmVersion: r.data.lightgbmVersion, numpyVersion: r.data.numpyVersion, elapsedMs: r.elapsedMs, python: r.python },
    };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir already gone */ }
  }
}

module.exports = { LIGHTGBM_ADAPTER_VERSION, available, fitPredict, groupSizes, writeMatrix, writeF32, writeI32, readF32 };
