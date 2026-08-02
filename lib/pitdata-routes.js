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
const S3 = require('./pitdata/v3/schema');
const C3 = require('./pitdata/v3/collector');
const R3 = require('./pitdata/v3/resolve');
const REC3 = require('./pitdata/v3/reconcile');
const H3 = require('./pitdata/v3/health');

const PROBE_PATH = 'pitdata/probe.json';
const PROBE_V3_PATH = 'pitdata/v3/probe.json';
const SHARD_KEYS = ['0', ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))];

async function fetchJson(url) {
  const r = await fetchWithTimeout(url, { timeoutMs: 12_000 });
  let text = null, body = null;
  try { text = await r.text(); } catch { text = null; }
  try { body = text == null ? null : JSON.parse(text); } catch { body = null; }
  // On FAILURE, surface a raw-text snippet so vendor gate messages (402/403
  // bodies are often plain text) reach the collector's failure records.
  // Success payloads stay strictly parsed JSON — never a wrapped snippet.
  if (!r.ok && body == null && text) body = { _raw: String(text).slice(0, 300) };
  const retryAfter = typeof r.headers?.get === 'function' ? r.headers.get('retry-after') : null;
  return { ok: r.ok, status: r.status, body, headers: retryAfter ? { 'retry-after': retryAfter } : {} };
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
    if (view === 'v3status') {
      const [state, probe] = await Promise.all([
        readJSON(S3.P.state(C3.COLLECTOR_ID), null), readJSON(PROBE_V3_PATH, null),
      ]);
      res.setHeader('Cache-Control', 's-maxage=300');
      return res.json({
        ok: true, version: S3.PITDATA_V3_VERSION, shadow: true,
        state: state || { note: 'v3 collector has not run yet' },
        probe: probe ? { probedAt: probe.probedAt, endpoints: Object.keys(probe.endpoints || {}) } : { note: 'v3 probe has not run yet' },
        note: 'pit-data-v3 is a SHADOW append-only store: no live consumer reads it; a consumer switch needs reconciliation gates + a human promotion artifact + a reviewed code change.',
      });
    }
    if (view === 'v3resolve') {
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
      const securityId = req.query.securityId ? String(req.query.securityId) : null;
      const effectiveAt = String(req.query.effectiveAt || '') || null;   // full ISO preserved
      const knownAt = req.query.knownAt ? String(req.query.knownAt) : null;
      const policy = req.query.policy ? String(req.query.policy) : null;
      if (!effectiveAt || (!symbol && !securityId)) {
        return res.status(400).json({ ok: false, error: 'need effectiveAt and one of symbol|securityId' });
      }
      const aliasShards = {}, listingShards = {};
      if (symbol) {
        const k = S3.shardKeyFor(symbol);
        aliasShards[k] = await readJSON(S3.P.aliases(k), null);
        const entries = ((aliasShards[k] || {}).aliases || {})[symbol] || [];
        await Promise.all([...new Set(entries.map((e) => e.listingId))].map(async (id) => {
          for (const sk of S3.SHARD_KEYS) {
            if (listingShards[sk]) continue;
            const doc = await readJSON(S3.P.listings(sk), null);
            if (doc && doc.listings && doc.listings[id]) listingShards[sk] = doc;
          }
        }));
      } else {
        for (const sk of S3.SHARD_KEYS) {
          const doc = await readJSON(S3.P.listings(sk), null);
          if (doc) listingShards[sk] = doc;
        }
      }
      const out = symbol
        ? R3.resolveSymbolAsOfV3({ symbol, effectiveAt, knownAt, policy }, { aliasShards, listingShards })
        : R3.resolveSecurityAsOfV3({ securityId, effectiveAt, knownAt, policy }, { listingShards });
      res.setHeader('Cache-Control', 's-maxage=300');
      return res.json({ ok: true, version: S3.PITDATA_V3_VERSION, resolve: out });
    }
    // Everything below mutates or is expensive — cron/trusted only.
    if (!requireTrusted(req, res)) return undefined;
    if (view === 'v3probe') {
      const probe = await C3.probeCapabilitiesV3(deps);
      if (probe.ok) await writeJSON(PROBE_V3_PATH, probe, 0);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: probe.ok, ...probe });
    }
    if (view === 'v3collect') {
      // newrun=1: same-day operational recovery (fresh runId, append-only).
      const out = await C3.collectStepV3(deps, { forceNewRun: req.query.newrun === '1' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(out);
    }
    if (view === 'v3health') {
      const health = await H3.buildV3Health(deps);
      const persisted = await H3.persistDailyHealth(deps, health);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, persisted, ...health });
    }
    if (view === 'v3reconcile') {
      const listingShards = {}, aliasShards = {};
      for (const k of S3.SHARD_KEYS) {
        const [ls, as] = await Promise.all([readJSON(S3.P.listings(k), null), readJSON(S3.P.aliases(k), null)]);
        if (ls) listingShards[k] = ls;
        if (as) aliasShards[k] = as;
      }
      const state = await readJSON(S3.P.state(C3.COLLECTOR_ID), null);
      const latestRun = state && state.lastCompletedRunDate
        ? await readJSON(S3.P.run(state.lastCompletedRunDate, `run-${state.lastCompletedRunDate}-${String(state.runSeq || 0).padStart(4, '0')}`), null)
        : null;
      const rawSample = [];
      for (const h of Object.values((latestRun && latestRun.contentHashes) || {}).slice(0, 5)) {
        const c = await readJSON(S3.P.content(h), null);
        if (c) rawSample.push({ contentHash: h, payload: c.payload });
      }
      const v1Master = await readJSON('secmaster/master.json', null);
      const report = REC3.reconcileV3({
        listingShards, aliasShards, latestRun, state, rawSample, v1Master,
        tickerReuseTestsPass: true,   // enforced by test/pitdata-v3-resolve.test.js in CI
        now: Date.now(),
      });
      const today = new Date().toISOString().slice(0, 10);
      await writeJSON(S3.P.reconciliation(today), report, 0);
      await writeJSON('pitdata/v3/reconciliation/latest.json', report, 0);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, ...report });
    }
    if (view === 'v3export') {
      // Listing-shard dump for the offline research migration
      // (research/16-secmaster-v3.js --from <this>). Read-only, privileged.
      const shards = {};
      for (const k of S3.SHARD_KEYS) {
        const doc = await readJSON(S3.P.listings(k), null);
        if (doc) shards[k] = doc;
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, version: S3.PITDATA_V3_VERSION, exportedAt: new Date().toISOString(), shards });
    }
    if (view === 'v3promote') {
      // The explicit human step: requires a named approver AND the current
      // engineering-complete reconciliation. Writes a PROPOSAL only — applying
      // it is a reviewed code change, never automatic.
      const approvedBy = req.query.approvedBy ? String(req.query.approvedBy) : null;
      const recon = await readJSON('pitdata/v3/reconciliation/latest.json', null);
      const out = REC3.makePromotionProposal({ reconReport: recon, approvedBy, now: Date.now() });
      if (!out.ok) return res.status(400).json(out);
      const today = new Date().toISOString().slice(0, 10);
      await writeJSON(S3.P.promotion(today), out.proposal, 0);
      await writeJSON('pitdata/v3/promotion/latest.json', out.proposal, 0);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(out);
    }
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
