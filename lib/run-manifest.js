// Run manifest + latest-committed-run gating (manifest-v1).
//
// WHY: the app produces daily Blob artifacts (picks/<date>.json, apex/<date>.json,
// …) but nothing records WHICH CODE produced them or lets you prove a file hasn't
// been altered since. A run manifest closes that: for every daily run it captures
// the deploy's git SHA, the run's timing, and the CONTENT HASH of each output it
// wrote, then commits that manifest as one entry in the immutable, hash-chained
// `runs` ledger (lib/immutable-ledger.js). Two properties fall out:
//   1. Reproducibility — any artifact traces back to an exact commit + run.
//   2. Tamper-evidence by reference — because the manifest lives in a write-once
//      chain, re-hashing a mutable daily file and comparing to its manifested hash
//      detects post-hoc edits (verifyOutputs). "Latest-committed-run gating" =
//      trust the newest manifest whose chain verifies, and check its outputs match.
//
// The builder (buildManifest) is pure and unit-testable; the Blob-backed pieces
// (hashOutputs/commitRun/verifyOutputs/read) degrade to safe no-ops without a store.
const crypto = require('crypto');
const ledger = require('./immutable-ledger');

const MANIFEST_VERSION = 'manifest-v1';
const RUN_STREAM = 'runs';                 // the immutable-ledger stream manifests are appended to

function hasStore() { return !!process.env.BLOB_READ_WRITE_TOKEN; }

// The deploy identity available at runtime on Vercel. sha is null in local/dev — we
// record null rather than fabricate a version.
function codeVersion() {
  return {
    sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,
    env: process.env.VERCEL_ENV || 'dev',
  };
}

// Content hash of an arbitrary JSON value (stable key order → stable hash).
function hashContent(value) {
  return crypto.createHash('sha256').update(ledger.stableStringify(value)).digest('hex');
}

// Build a manifest object (pure). Normalises the inputs, stamps code version +
// duration, and defends every array field so a caller passing partial data can't
// produce a malformed manifest.
function buildManifest({ runId, trigger, startedAt, finishedAt, inputs, params, outputs, steps, note } = {}) {
  if (!runId) throw new Error('buildManifest: runId is required');
  const start = startedAt || null;
  const finish = finishedAt || new Date().toISOString();
  const durationMs = start ? Math.max(0, new Date(finish) - new Date(start)) : null;
  return {
    v: MANIFEST_VERSION,
    runId: String(runId),
    trigger: trigger || 'manual',
    code: codeVersion(),
    startedAt: start,
    finishedAt: finish,
    durationMs,
    inputs: Array.isArray(inputs) ? inputs : [],
    params: params && typeof params === 'object' ? params : {},
    steps: Array.isArray(steps) ? steps : [],
    outputs: Array.isArray(outputs) ? outputs : [],
    note: note || null,
  };
}

// Fetch each output Blob (by exact pathname) and record its content hash + size, so
// the manifest pins exactly what was written. A missing/unreadable key is recorded
// as present:false rather than skipped — absence is itself provenance.
async function hashOutputs(keys) {
  if (!hasStore()) return (keys || []).map(key => ({ key, present: false, hash: null, bytes: 0, reason: 'no-store' }));
  const { list } = require('@vercel/blob');
  const out = [];
  for (const key of keys || []) {
    try {
      const r = await list({ prefix: key, limit: 1 });
      const hit = (r.blobs || []).find(b => b.pathname === key);
      if (!hit) { out.push({ key, present: false, hash: null, bytes: 0 }); continue; }
      const res = await fetch(hit.url + (hit.url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) { out.push({ key, present: false, hash: null, bytes: 0, reason: `fetch ${res.status}` }); continue; }
      const text = await res.text();
      let count = null;
      try { const j = JSON.parse(text); count = Array.isArray(j.picks) ? j.picks.length : Array.isArray(j.signals) ? j.signals.length : null; } catch { /* not array-shaped */ }
      out.push({ key, present: true, hash: crypto.createHash('sha256').update(text).digest('hex'), bytes: text.length, count });
    } catch (e) {
      out.push({ key, present: false, hash: null, bytes: 0, reason: String(e && e.message || e) });
    }
  }
  return out;
}

// Commit a manifest to the immutable `runs` chain. Idempotent per (runId, sha):
// re-committing the same day on the same deploy is a no-op that returns the existing
// tip, so a chain re-run doesn't fork the history with duplicates.
async function commitRun(manifest) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const latest = await latestManifest();
  if (latest && latest.manifest && latest.manifest.runId === manifest.runId
      && (latest.manifest.code || {}).sha === (manifest.code || {}).sha) {
    return { committed: false, reason: 'duplicate-run', seq: latest.seq, hash: latest.hash, manifest: latest.manifest };
  }
  const entry = await ledger.append(RUN_STREAM, manifest);
  return { committed: true, seq: entry.seq, hash: entry.hash, manifest };
}

// The most recent committed manifest (the "latest committed run"), or null.
async function latestManifest() {
  const t = await ledger.tip(RUN_STREAM);
  if (!t) return null;
  const chain = await ledger.readChain(RUN_STREAM);
  const last = chain[chain.length - 1];
  return last ? { seq: last.seq, hash: last.hash, recordedAt: last.recordedAt, manifest: last.payload } : null;
}

// Recent manifests, newest first, with their ledger position.
async function readManifests(limit = 30) {
  const chain = await ledger.readChain(RUN_STREAM);
  return chain.slice(-limit).reverse().map(e => ({ seq: e.seq, hash: e.hash, recordedAt: e.recordedAt, manifest: e.payload }));
}

// Re-hash a manifest's outputs against their CURRENT Blob content and report drift.
// ok:false means an artifact changed since it was committed (tamper / partial rewrite
// / legitimate later overwrite — the manifest can't distinguish intent, only change).
async function verifyOutputs(manifest) {
  const recorded = (manifest && manifest.outputs) || [];
  const current = await hashOutputs(recorded.map(o => o.key));
  const currentBy = new Map(current.map(o => [o.key, o]));
  const checks = recorded.map(o => {
    const now = currentBy.get(o.key) || { present: false, hash: null };
    const match = o.present && now.present && o.hash === now.hash;
    return {
      key: o.key,
      recordedHash: o.hash,
      currentHash: now.hash,
      recordedPresent: !!o.present,
      currentPresent: !!now.present,
      ok: o.present ? match : !now.present,   // an output recorded absent is "ok" only if still absent
    };
  });
  return { ok: checks.every(c => c.ok), runId: manifest && manifest.runId, checks };
}

// Chain integrity of the whole runs ledger.
async function verifyRuns() { return ledger.verify(RUN_STREAM); }

module.exports = {
  MANIFEST_VERSION, RUN_STREAM,
  codeVersion, hashContent, buildManifest,        // pure
  hashOutputs, commitRun, latestManifest, readManifests, verifyOutputs, verifyRuns,  // Blob-backed
  hasStore,
};
