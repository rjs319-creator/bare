'use strict';
// RESEARCH DATA-QUALITY GATE (audit-research-data-v1)
//   npm run audit:research          (alias: node scripts/audit-research-data.js)
//
// One command that audits the research panel + its provenance artifacts and
// exits NONZERO on any critical failure, so no experiment can run on a panel
// that fails its own contract. Produces machine-readable JSON
// (research/data/audit-research-data.json) and a concise human report.
//
// CRITICAL (exit 1): manifest invariant violations (duplicate (lid,dt) keys,
//   labels past cutoffs, hash mismatch, null identity), numeric labels on
//   non-trainable states, missing provenance artifacts for a published panel,
//   schema drift on required row fields, artifact/data recompute mismatch.
// WARNING (exit 0, reported): evidence records pinned to superseded dataset
//   hashes (immutable history — reported, never rewritten), stale sources,
//   universe-coverage collapse months, single-provider limitation.
//
// When NO panel exists (e.g. CI, fresh clone: research/data is gitignored) the
// audit SKIPS with exit 0 — the gate binds experiments, not unrelated builds.

const fs = require('fs');
const path = require('path');

const DATA = process.env.RESEARCH_DATA_DIR || path.join(__dirname, '..', 'research', 'data');
const PANEL_PATH = path.join(DATA, 'panel-features-v3.json');
const OUT_PATH = path.join(DATA, 'audit-research-data.json');
const HORIZONS = [21, 63, 126];
const REQUIRED_ROW_KEYS = ['s', 'lid', 'dt', 'cap', 'adv', 'm121', 'f21', 's21', 'f63', 's63', 'f126', 's126'];
const TRAINABLE = new Set(['m', 'c']);
const STALE_SOURCE_DAYS = 120;
const COVERAGE_COLLAPSE_FRAC = 0.5;

function loadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function main() {
  const critical = [], warnings = [], info = [];
  const startedAt = new Date().toISOString();

  if (!fs.existsSync(PANEL_PATH)) {
    console.log('audit-research-data: SKIPPED — no panel artifact present (research/data is not materialized here).');
    process.exitCode = 0;
    return;
  }
  const doc = loadJson(PANEL_PATH);
  if (!doc || !doc.panel) { console.error('audit-research-data: CRITICAL — panel unreadable'); process.exitCode = 1; return; }

  // 1) Manifest invariants (duplicates, cutoffs, hash, identity, counts).
  const MF = require('../research/lib/manifest');
  if (!doc.manifest) {
    critical.push('panel has no embedded DataSnapshotManifest — rebuild with research/15-panel-features-v3.js');
  } else {
    const v = MF.verifySnapshotManifest(doc.manifest, doc.panel, { horizons: HORIZONS });
    if (!v.valid) for (const e of v.errors) critical.push(`manifest: ${e}`);
    info.push({ manifestStats: v.stats });
  }

  // 2) Row-level label-state integrity: a numeric label on a non-trainable
  //    state (pending/unresolved/no_fill) is training-set poison.
  let badLabelState = 0, schemaDrift = 0, rows = 0;
  const months = Object.keys(doc.panel).sort();
  for (const ym of months) {
    for (const r of doc.panel[ym]) {
      rows++;
      for (const k of REQUIRED_ROW_KEYS) if (!(k in r)) { schemaDrift++; break; }
      for (const h of HORIZONS) {
        if (r[`f${h}`] != null && !TRAINABLE.has(r[`s${h}`])) badLabelState++;
      }
    }
  }
  if (badLabelState) critical.push(`${badLabelState} numeric labels carried by non-trainable states (pending/unresolved must be null)`);
  if (schemaDrift) critical.push(`${schemaDrift} rows missing required keys (schema drift)`);

  // 3) Provenance artifacts must exist alongside a published panel.
  for (const [name, p] of [
    ['identity-quality-v3.json', path.join(DATA, 'identity-quality-v3.json')],
    ['extreme-returns-v3.json', path.join(DATA, 'extreme-returns-v3.json')],
    ['universe-coverage-v3.json', path.join(DATA, 'universe-coverage-v3.json')],
    ['panel-v3-manifest.json', path.join(DATA, 'panel-v3-manifest.json')],
  ]) {
    if (!fs.existsSync(p)) critical.push(`provenance artifact missing: ${name}`);
  }
  const identity = loadJson(path.join(DATA, 'identity-quality-v3.json'));
  if (identity && identity.quarantinedGroups > 0) {
    info.push({ identityQuarantined: identity.quarantinedGroups, reasons: (identity.quarantineReasons || []).slice(0, 10) });
  }
  const extremes = loadJson(path.join(DATA, 'extreme-returns-v3.json'));
  if (extremes) info.push({ extremeEvents: extremes.events, byClass: extremes.byClass, poisonedLabels: extremes.poisonedLabels });

  // 4) Recompute spot-check: features in the artifact must re-derive from the
  //    underlying cached bars (catches artifact/data drift and future-known
  //    features). Deterministic sample across months.
  const pit = require('../research/lib/pit');
  const CA = require('../research/lib/corpactions');
  const CORP_DIR = path.join(DATA, 'corpactions');
  let checked = 0, mismatched = 0;
  for (let mi = 0; mi < months.length && checked < 60; mi += Math.max(1, Math.floor(months.length / 12))) {
    const arr = doc.panel[months[mi]];
    if (!arr || !arr.length) continue;
    for (const r of [arr[0], arr[Math.floor(arr.length / 2)], arr[arr.length - 1]]) {
      if (!r || checked >= 60) continue;
      const cachePath = path.join(DATA, 'cache', `${r.cs || r.s}.json`);
      const corp = loadJson(path.join(CORP_DIR, `${r.cs || r.s}.json`));
      const c = loadJson(cachePath);
      if (!c || !corp) continue;
      const ps = CA.withTotalReturn(pit.priceSeries(c.price), corp.dividends);
      const dMs = Date.parse(r.dt);
      let idx = -1; for (let k = 0; k < ps.length; k++) { if (ps[k].ms <= dMs) idx = k; else break; }
      if (idx < 252) continue;
      const a = ps[idx - 252].tr, b = ps[idx - 21].tr;
      const recomputed = (a > 0 && b > 0) ? b / a - 1 : null;
      checked++;
      if (recomputed == null || !Number.isFinite(r.m121) || Math.abs(recomputed - r.m121) > 1e-9) mismatched++;
    }
  }
  if (checked === 0) warnings.push('recompute spot-check could not run (cache/corpactions not materialized)');
  else if (mismatched > 0) critical.push(`${mismatched}/${checked} sampled features do not re-derive from the underlying bars (artifact/data drift)`);
  else info.push({ recomputeSpotCheck: { checked, mismatched } });

  // 5) Evidence records vs the current dataset hash: superseded hashes are
  //    REPORTED (immutable history), never rewritten.
  const evidenceDir = path.join(DATA, 'evidence');
  const currentHash = doc.datasetHash || null;
  const superseded = [];
  if (fs.existsSync(evidenceDir) && currentHash) {
    for (const hyp of fs.readdirSync(evidenceDir)) {
      const hypDir = path.join(evidenceDir, hyp);
      if (!fs.statSync(hypDir).isDirectory()) continue;
      for (const f of fs.readdirSync(hypDir)) {
        if (!f.endsWith('.json') || f === 'index.json') continue;
        const rec = loadJson(path.join(hypDir, f));
        if (rec && rec.datasetHash && !String(rec.datasetHash).includes(currentHash.slice(0, 16))) {
          superseded.push({ hypothesis: hyp, recordId: rec.recordId, datasetHash: String(rec.datasetHash).slice(0, 24) });
        }
      }
    }
  }
  if (superseded.length) {
    warnings.push(`${superseded.length} evidence records pinned to superseded dataset hashes — findings there describe the OLD data until re-run`);
    info.push({ supersededEvidence: superseded.slice(0, 20) });
  }

  // 6) Source staleness + coverage collapse.
  if (doc.securityMasterBuiltAt) {
    const ageDays = (Date.now() - Date.parse(doc.securityMasterBuiltAt)) / 86400000;
    if (ageDays > STALE_SOURCE_DAYS) warnings.push(`security master is ${Math.round(ageDays)} days old`);
  }
  const coverage = loadJson(path.join(DATA, 'universe-coverage-v3.json'));
  if (coverage && coverage.monthlyFunnel) {
    const emitted = Object.entries(coverage.monthlyFunnel).map(([ym, f]) => ({ ym, n: f.emitted })).filter((x) => x.n > 0);
    const med = emitted.map((x) => x.n).sort((a, b) => a - b)[Math.floor(emitted.length / 2)] || 0;
    const collapsed = emitted.filter((x) => x.n < med * COVERAGE_COLLAPSE_FRAC && x.ym !== emitted[emitted.length - 1].ym);
    if (collapsed.length) warnings.push(`universe-coverage collapse in ${collapsed.map((x) => x.ym).join(', ')} (emitted < ${COVERAGE_COLLAPSE_FRAC * 100}% of median ${med})`);
  }
  warnings.push('single-price-provider limitation: cross-provider disagreement checks unavailable (FMP only)');

  // ── report ──────────────────────────────────────────────────────────────────
  const result = {
    version: 'audit-research-data-v1', startedAt, finishedAt: new Date().toISOString(),
    panelVersion: doc.panelVersion, datasetHash: currentHash,
    rows, months: months.length,
    critical, warnings, info,
    verdict: critical.length ? 'FAIL' : 'PASS',
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
  console.log(`audit-research-data: ${result.verdict} — ${rows} rows / ${months.length} months, panel ${doc.panelVersion}, hash ${(currentHash || '').slice(0, 16)}…`);
  for (const c of critical) console.log(`  CRITICAL: ${c}`);
  for (const w of warnings) console.log(`  warning:  ${w}`);
  console.log(`  full report: ${path.relative(process.cwd(), OUT_PATH)}`);
  process.exitCode = critical.length ? 1 : 0;
}

main();
