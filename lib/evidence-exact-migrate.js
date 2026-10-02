'use strict';
// EXACT-PRECISION MIGRATION for persisted evidence-stats summaries (evidence-stats-v2).
//
// Summaries written before v2 carry display-rounded avg/ci95/tCI/bootstrapCI (2dp) and se
// (4dp), plus — since the audit of 2026-08-14 — full-precision avgExact/seExact, and —
// since F-11 — the per-date `values` series itself. Every gate now reads the `exact`
// block (lib/evidence-stats exactOf), so legacy records need one:
//   * series present  → recompute with the SAME lags / blockLen / B / seed the record
//                       stored, then REFUSE the result unless it reproduces the stored
//                       display fields exactly (a tampered or re-deduplicated series must
//                       not be laundered into an "exact" block) → precision 'exact'
//   * series missing  → derive from avgExact/seExact ('partial') or the display fields
//                       ('rounded'); the label makes the degradation visible downstream.
// Idempotent: a summary that already carries `exact` is passed through by reference.
// Pure except for createMigrateHandler, whose store is injected.

const ES = require('./evidence-stats');

const MIGRATION_VERSION = 'evidence-exact-migrate-v1';
const DISPLAY_DP = 2;
const SE_DP = 4;
const ESS_DP = 1;
const ROUND_TOL = 1e-9;
const DEFAULT_PATH = 'scoreboard/summary.json';
// Docs this op may rewrite, with the cache age their owning writer uses.
const ALLOWED_PATHS = Object.freeze({
  'scoreboard/summary.json': { cacheMaxAge: 300 },
});
const isNum = Number.isFinite;

// A persisted evidence-stats summary (e.g. a `dateNet`) that pre-dates the exact block.
function isLegacySummary(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (o.exact && typeof o.exact === 'object') return false;
  const hasInterval = o.ci95 && isNum(o.ci95.lo) && isNum(o.ci95.hi);
  const hasProvenance = typeof o.seBasis === 'string' || isNum(o.avgExact) || isNum(o.se);
  return !!(hasInterval && isNum(o.avg) && isNum(o.n) && hasProvenance);
}

const lagsFromBasis = (seBasis) => {
  const m = typeof seBasis === 'string' ? /lags (\d+)/.exec(seBasis) : null;
  return m ? parseInt(m[1], 10) : null;
};
const roundTo = (v, d) => (isNum(v) ? +v.toFixed(d) : null);
const same = (a, b) => (a == null && b == null) || (isNum(a) && isNum(b) && Math.abs(a - b) <= ROUND_TOL);

// Does a fresh summary reproduce the legacy record's display fields? Compared on every
// rounded statistic the record stored; a single mismatch refuses the recompute.
function reproducesDisplay(legacy, fresh) {
  const checks = [
    [legacy.avg, roundTo(fresh.exact.avg, DISPLAY_DP)],
    [legacy.se, roundTo(fresh.exact.se, SE_DP)],
    [legacy.sd, roundTo(fresh.exact.sd, DISPLAY_DP)],
    [legacy.ci95.lo, roundTo(fresh.exact.ci95.lo, DISPLAY_DP)],
    [legacy.ci95.hi, roundTo(fresh.exact.ci95.hi, DISPLAY_DP)],
    [legacy.effectiveN, roundTo(fresh.exact.ess, ESS_DP)],
  ];
  if (legacy.bootstrapCI && fresh.exact.bootstrapCI) {
    checks.push([legacy.bootstrapCI.lo, roundTo(fresh.exact.bootstrapCI.lo, DISPLAY_DP)]);
    checks.push([legacy.bootstrapCI.hi, roundTo(fresh.exact.bootstrapCI.hi, DISPLAY_DP)]);
  }
  return checks.every(([stored, recomputed]) => stored == null || same(stored, recomputed));
}

function recomputeFromSeries(legacy) {
  const values = Array.isArray(legacy.values) ? legacy.values.filter(isNum) : null;
  if (!values || values.length < 2) return { fresh: null, note: 'no per-date series stored' };
  if (values.length !== legacy.n) return { fresh: null, note: `series length ${values.length} ≠ n ${legacy.n}` };
  const boot = legacy.bootstrapCI || {};
  const fresh = ES.summarizeDateSeries(values, {
    lags: lagsFromBasis(legacy.seBasis),
    blockLen: isNum(boot.blockLen) ? boot.blockLen : null,
    B: isNum(boot.B) ? boot.B : undefined,
    seed: isNum(boot.seed) ? boot.seed : undefined,
    blocks: legacy.blockStability && isNum(legacy.blockStability.blocks) && legacy.blockStability.blocks > 0 ? legacy.blockStability.blocks : undefined,
  });
  if (!fresh) return { fresh: null, note: 'series too short to summarise' };
  if (!reproducesDisplay(legacy, fresh)) return { fresh: null, note: 'recompute mismatch — the stored series does not reproduce the stored display fields' };
  return { fresh, note: null };
}

// The exact block derived from whatever a series-less record still carries.
function deriveFromStoredFields(legacy, note) {
  const ex = ES.exactOf(legacy);
  const { precision, ...exact } = ex;
  return {
    ...legacy,
    exact,
    precision,
    migration: { version: MIGRATION_VERSION, method: 'derived-from-stored-fields', note },
  };
}

// → a NEW summary object carrying `exact` + `precision` + `migration`; the input is untouched.
// A summary that is not legacy (already exact, or not a summary) is returned as-is.
function migrateSummary(summary) {
  if (!isLegacySummary(summary)) return summary;
  const { fresh, note } = recomputeFromSeries(summary);
  if (!fresh) return deriveFromStoredFields(summary, note);
  return {
    ...summary,
    exact: fresh.exact,
    precision: fresh.precision,
    params: fresh.params,
    migration: { version: MIGRATION_VERSION, method: 'recomputed-from-series', note: null },
  };
}

const emptyStats = () => ({ scanned: 0, migrated: 0, exact: 0, partial: 0, rounded: 0, alreadyExact: 0 });

// Walk any JSON document, migrating every legacy summary found. Returns { doc, stats }
// where `doc` shares untouched subtrees with the input (nothing is mutated).
function migrateDoc(doc) {
  const stats = emptyStats();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      let changed = false;
      const out = node.map((x) => { const y = walk(x); if (y !== x) changed = true; return y; });
      return changed ? out : node;
    }
    if (node.exact && typeof node.exact === 'object' && isNum(node.avg) && node.ci95) {
      stats.scanned++; stats.alreadyExact++;
      return node;
    }
    if (isLegacySummary(node)) {
      stats.scanned++; stats.migrated++;
      const next = migrateSummary(node);
      stats[next.precision] = (stats[next.precision] || 0) + 1;
      return next;
    }
    let changed = false;
    const out = {};
    for (const k of Object.keys(node)) {
      const y = walk(node[k]);
      if (y !== node[k]) changed = true;
      out[k] = y;
    }
    return changed ? out : node;
  };
  return { doc: walk(doc), stats };
}

// ── op=evidencemigrate ───────────────────────────────────────────────────────
// Store is injected ({ hasStore, readJSON, writeJSON }) so the handler is testable without
// Blob. Bearer protection is the tracker's (PRIVILEGED_OPS). Idempotent: an already-exact
// doc is not rewritten.
function createMigrateHandler({ hasStore, readJSON, writeJSON }) {
  return async function runEvidenceMigrate(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
    const path = String((req.query && req.query.path) || DEFAULT_PATH);
    const allowed = ALLOWED_PATHS[path];
    if (!allowed) return res.status(400).json({ ok: false, error: `path not allowlisted for migration: ${path}`, allowed: Object.keys(ALLOWED_PATHS) });
    const dry = String((req.query && req.query.dry) || '') === '1';
    const started = Date.now();
    const current = await readJSON(path, null);
    if (!current) return res.status(404).json({ ok: false, error: `${path} not found`, path });
    const { doc, stats } = migrateDoc(current);
    const changed = stats.migrated > 0;
    let written = false, url = null, error = null;
    if (changed && !dry) {
      try { const w = await writeJSON(path, doc, allowed.cacheMaxAge); url = (w && w.url) || null; written = true; }
      catch (e) { error = String((e && e.message) || e); }
    }
    return res.status(error ? 502 : 200).json({
      ok: !error, version: MIGRATION_VERSION, path, dry, stats,
      written, idempotent: !changed, url, error, tookMs: Date.now() - started,
    });
  };
}

module.exports = {
  MIGRATION_VERSION, ALLOWED_PATHS, DEFAULT_PATH,
  isLegacySummary, lagsFromBasis, migrateSummary, migrateDoc, createMigrateHandler,
};
