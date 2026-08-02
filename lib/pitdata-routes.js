'use strict';
// op=pitdata — the pit-data-v2 shadow system's HTTP surface.
//
//   view=status     (public)      collector cursor, counts, probe summary
//   view=resolve    (public)      the five PIT interfaces over the shadow store
//   view=probe      (PRIVILEGED)  FMP capability probe (writes pitdata/probe.json)
//   view=collect    (PRIVILEGED)  one bounded, resumable collect step (warm cron)
//   view=reconcile  (PRIVILEGED)  dual-read report vs the v1 production master
//
// Shadow contract: nothing here is consumed by live ranking; reconciliation gates
// must pass before a consumer switch can even be proposed. No secrets in any payload.

const { requireTrusted } = require('./auth');
const { readJSON, writeJSON } = require('./store');
const { fetchWithTimeout } = require('./http');
const { redactSecrets } = require('./redact');
const S = require('./pitdata/schema');
const C = require('./pitdata/collector');
const R = require('./pitdata/resolve');
const REC = require('./pitdata/reconcile');

const PROBE_PATH = 'pitdata/probe.json';
const SHARD_KEYS = ['0', ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))];

async function fetchJson(url) {
  const r = await fetchWithTimeout(url, { timeoutMs: 12_000 });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { ok: r.ok, status: r.status, body };
}

const deps = { fetchJson, readJSON, writeJSON, now: Date.now };

async function loadShards({ symbol = null } = {}) {
  // Bounded: a symbol-scoped read touches one shard; full loads (universe/reconcile)
  // read all 27 — acceptable for privileged/diagnostic calls only.
  const keys = symbol ? [S.shardKeyFor(symbol)] : SHARD_KEYS;
  const shards = {};
  await Promise.all(keys.map(async (k) => {
    const doc = await readJSON(C.shardPath(k), null);
    if (doc) shards[k] = doc;
  }));
  return shards;
}

async function runPitData(req, res) {
  const view = String(req.query.view || 'status');
  try {
    if (view === 'status') {
      const [state, probe] = await Promise.all([readJSON(C.STATE_PATH, null), readJSON(PROBE_PATH, null)]);
      res.setHeader('Cache-Control', 's-maxage=300');
      return res.json({
        ok: true, version: S.PITDATA_VERSION, shadow: true,
        state: state || { note: 'collector has not run yet' },
        probe: probe || { note: 'capability probe has not run yet' },
        note: 'pit-data-v2 is a SHADOW identity store: no live consumer reads it, survivorshipSafe stays false until reconciliation gates pass.',
      });
    }
    if (view === 'resolve') {
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
      const securityId = req.query.securityId ? String(req.query.securityId) : null;
      const effectiveAt = String(req.query.effectiveAt || '').slice(0, 10) || null;
      const knownAt = req.query.knownAt ? String(req.query.knownAt).slice(0, 10) : null;
      if (!effectiveAt || (!symbol && !securityId)) {
        return res.status(400).json({ ok: false, error: 'need effectiveAt and one of symbol|securityId' });
      }
      const shards = await loadShards({ symbol });
      const out = symbol
        ? R.resolveSymbolAsOf({ symbol, effectiveAt, knownAt }, shards)
        : R.resolveSecurityAsOf({ securityId, effectiveAt, knownAt }, shards);
      const classification = securityId ? R.classificationAt({ securityId, effectiveAt, knownAt }, shards) : null;
      res.setHeader('Cache-Control', 's-maxage=300');
      return res.json({ ok: true, version: S.PITDATA_VERSION, resolve: out, classification });
    }
    // Everything below mutates or is expensive — cron/trusted only.
    if (!requireTrusted(req, res)) return undefined;
    if (view === 'probe') {
      const probe = await C.probeCapabilities(deps);
      if (probe.ok) await writeJSON(PROBE_PATH, probe, 0);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: probe.ok, ...probe });
    }
    if (view === 'collect') {
      const out = await C.collectStep(deps);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(out);
    }
    if (view === 'reconcile') {
      const [shards, v1Master] = await Promise.all([loadShards(), readJSON('secmaster/master.json', null)]);
      const report = REC.reconcile({ shards, v1Master });
      await writeJSON(REC.RECON_PATH, report, 0);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, ...report });
    }
    return res.status(400).json({ ok: false, error: `unknown view '${view}'` });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ ok: false, error: redactSecrets((e && e.message) || e) });
  }
}

module.exports = { runPitData };
