'use strict';
// RESEARCH DATA-QUALITY GATE (audit-research-data-v2)
//   npm run audit:research          (alias: node scripts/audit-research-data.js)
//
// One command that audits the research panel + its provenance artifacts and
// exits NONZERO on any critical failure, so no experiment can run on a panel
// that fails its own contract. Produces machine-readable JSON
// (research/data/audit-research-data.json) and a concise human report.
//
// v2 ADDITIONS (each closes a verified defect):
//   * COHORT MATURITY — recomputes the cohort-eligibility ledger from the rows
//     and the market-session calendar; a partial cohort declared eligible, a
//     pending row inside an eligible cohort, or an eligible date below the
//     coverage threshold is CRITICAL. Rank-IC on 3 early delistings while
//     1,704 names were pending is the exact failure this catches.
//   * FUTURE-PATH CLEANING — poisoning classes must be decision-time
//     structural evidence only; persistence/reversion classes appearing as
//     poison (not diagnostics) is CRITICAL.
//   * PROVENANCE — incomplete source content hashes, a null code commit, or a
//     dirty worktree without a recorded diff hash is CRITICAL.
//   * EVIDENCE BOUNDARIES — a current-hash evidence record whose periodEnd
//     exceeds the horizon's last fully observed cohort is CRITICAL.
//   * SURVIVORSHIP — a safe claim without a measured contract is CRITICAL.
//   * COST EVIDENCE — embedded cost evidence must be a verified execution-
//     engine artifact (next-session-open entry); anything else is CRITICAL.
//   * EVIDENCE TRIAGE — superseded-hash records are EXPECTED history (info)
//     when a current-hash rerun exists; hypotheses lacking a current-hash
//     rerun are a warning; no more permanent generic warning.
//
// CRITICAL (exit 1) vs WARNING (exit 0, reported) — see checks below. When NO
// panel exists (CI, fresh clone: research/data is gitignored) the audit SKIPS
// with exit 0 — the gate binds experiments, not unrelated builds.

const fs = require('fs');
const path = require('path');

const DATA = process.env.RESEARCH_DATA_DIR || path.join(__dirname, '..', 'research', 'data');
const PANEL_PATH = path.join(DATA, 'panel-features-v3.json');
const CALENDAR_PATH = path.join(DATA, 'market-calendar-v1.json');
const COHORT_PATH = path.join(DATA, 'cohort-eligibility-v3.json');
const OUT_PATH = path.join(DATA, 'audit-research-data.json');
const HORIZONS = [21, 63, 126];
const REQUIRED_ROW_KEYS = ['s', 'lid', 'dt', 'cap', 'adv', 'm121', 'f21', 's21', 'f63', 's63', 'f126', 's126'];
const TRAINABLE = new Set(['m', 'c']);
const STALE_SOURCE_DAYS = 120;
const COVERAGE_COLLAPSE_FRAC = 0.5;
// Persistence classes may only ever be diagnostics — never data-quality classes.
const FUTURE_PATH_CLASSES = ['spike-revert', 'ambiguous', 'legitimate-persistent', 'tail-truncated'];

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

  const MF = require('../research/lib/manifest');
  const CAL = require('../research/lib/calendar');
  const CA = require('../research/lib/corpactions');
  const SV = require('../lib/research/survivorship');
  const EX = require('../lib/research/execution');

  // 0) Market-session calendar — required to recompute cohort maturity.
  let calendar = null;
  const calDoc = loadJson(CALENDAR_PATH);
  if (calDoc) {
    try { calendar = CAL.loadCalendarArtifact(calDoc); }
    catch (e) { critical.push(`market calendar artifact invalid: ${e.message}`); }
  } else {
    critical.push('market-calendar-v1.json missing — cohort maturity cannot be independently recomputed');
  }

  // 1) Manifest invariants incl. INDEPENDENT cohort recomputation from rows +
  //    calendar (partial-cohort-declared-eligible, pending rows in eligible
  //    cohorts, coverage stats, source hashes, dataset hash, duplicates).
  let recomputedLedger = null;
  if (!doc.manifest) {
    critical.push('panel has no embedded DataSnapshotManifest — rebuild with research/15-panel-features-v3.js');
  } else if (calendar) {
    const v = MF.verifySnapshotManifest(doc.manifest, doc.panel, { horizons: HORIZONS, calendar });
    if (!v.valid) for (const e of v.errors) critical.push(`manifest: ${e}`);
    recomputedLedger = v.recomputedLedger || null;
    info.push({ manifestStats: v.stats });
  }

  // 1b) Cohort artifact must match the recomputation (hash-pinned).
  const cohortDoc = loadJson(COHORT_PATH);
  if (!cohortDoc) critical.push('cohort-eligibility-v3.json missing — experiments have no verified eligibility map');
  else if (recomputedLedger && cohortDoc.ledgerHash !== recomputedLedger.ledgerHash) {
    critical.push(`cohort-eligibility artifact hash ${String(cohortDoc.ledgerHash).slice(0, 12)}… != recomputed ${recomputedLedger.ledgerHash.slice(0, 12)}… — stale eligibility map`);
  }

  // 1c) Build provenance: null commit / unrecorded dirty diff can never back a
  //     confirmatory panel.
  const build = doc.manifest && doc.manifest.build;
  if (!build) critical.push('manifest.build missing — no code/build provenance');
  else {
    if (!build.codeCommit) critical.push('build.codeCommit is null — confirmatory reproducibility is impossible without a commit');
    if (build.worktreeDirty && !build.dirtyDiffHash) critical.push('dirty worktree without a recorded diff hash — the exact built code is unrecoverable');
    if (build.worktreeDirty && build.dirtyDiffHash) warnings.push(`panel built from a dirty worktree (diff hash ${build.dirtyDiffHash.slice(0, 12)}…) — evidence from it is ${build.reproducibility}`);
    info.push({ build: { codeCommit: build.codeCommit ? build.codeCommit.slice(0, 12) : null, worktreeDirty: build.worktreeDirty, reproducibility: build.reproducibility } });
  }

  // 1d) Survivorship must be a measured contract consistent with itself.
  if (!doc.manifest || !doc.manifest.survivorship) {
    critical.push('manifest.survivorship missing — survivorship must be a measured contract, not an assumption');
  } else {
    const sv = SV.verifySurvivorshipContract(doc.manifest.survivorship);
    if (!sv.valid) critical.push(`survivorship contract invalid: ${sv.reason}`);
    else info.push({ survivorship: { status: doc.manifest.survivorship.status, delistedCovered: doc.manifest.survivorship.delistedSecuritiesCovered } });
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

  // 3b) FUTURE-PATH CLEANING GUARD: data-quality classes must be decision-time
  //     structural evidence only. Persistence classes may exist ONLY under
  //     persistenceDiagnostics (diagnosticOnly).
  const extremes = loadJson(path.join(DATA, 'extreme-returns-v3.json'));
  if (extremes) {
    const qualityClasses = Object.keys(extremes.byClass || {});
    const leaked = qualityClasses.filter((c) => FUTURE_PATH_CLASSES.includes(c));
    if (leaked.length) critical.push(`future-path-dependent quality classes in the data-cleaning layer: ${leaked.join(', ')} — persistence may only be a post-event diagnostic`);
    const badPoison = qualityClasses.filter((c) => !CA.POISONING_CLASSES.includes(c) && c !== 'unconfirmed-extreme' && c !== 'explained-dividend');
    if (badPoison.length) warnings.push(`unrecognized extreme-event classes: ${badPoison.join(', ')}`);
    info.push({ extremeEvents: extremes.events, byClass: extremes.byClass, persistenceDiagnostics: extremes.persistenceDiagnostics || null, structuralPoisonedLabels: extremes.poisonedLabels });
  }

  // 4) Recompute spot-check: features in the artifact must re-derive from the
  //    underlying cached bars (catches artifact/data drift and future-known
  //    features). Deterministic sample across months.
  const pit = require('../research/lib/pit');
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

  // 5) EVIDENCE TRIAGE. Three distinct situations, no permanent generic warning:
  //    a) superseded-hash records where a current-hash rerun exists → INFO
  //       (expected immutable history);
  //    b) hypotheses with NO current-hash record → WARNING (needs a rerun
  //       before its conclusion applies to the current data);
  //    c) a CURRENT-hash record evaluated beyond the horizon's last fully
  //       observed cohort, with unverifiable cost evidence, or with a
  //       signal-close economic entry → CRITICAL.
  const evidenceDir = path.join(DATA, 'evidence');
  const currentHash = doc.datasetHash || null;
  const lastObserved = (doc.manifest && doc.manifest.lastFullyObservedCohortDateByHorizon) || {};
  const triage = { historical: [], needsRerun: [], currentInvalid: [] };
  if (fs.existsSync(evidenceDir) && currentHash) {
    for (const hyp of fs.readdirSync(evidenceDir)) {
      const hypDir = path.join(evidenceDir, hyp);
      if (!fs.statSync(hypDir).isDirectory()) continue;
      const records = fs.readdirSync(hypDir)
        .filter((f) => f.endsWith('.json') && f !== 'index.json')
        .map((f) => loadJson(path.join(hypDir, f)))
        .filter(Boolean);
      const isPanelScheme = (rec) => /^panel-(features|v\d)/.test(String(rec.datasetHash || ''));
      const isCurrent = (rec) => rec.datasetHash && String(rec.datasetHash).includes(currentHash.slice(0, 16));
      const panelRecords = records.filter(isPanelScheme);
      const currents = records.filter(isCurrent);
      const olds = panelRecords.filter((r) => !isCurrent(r));
      if (panelRecords.length === 0 && records.length > 0) {
        // External-dataset hypothesis (its own hash scheme, e.g. SUE's
        // cache+secmaster hash) — panel supersession does not apply to it.
        triage.externalDataset = triage.externalDataset || [];
        triage.externalDataset.push({ hypothesis: hyp, records: records.length });
      } else if (currents.length === 0 && olds.length > 0) {
        triage.needsRerun.push({ hypothesis: hyp, records: olds.length });
      } else if (olds.length) {
        triage.historical.push({ hypothesis: hyp, superseded: olds.length, current: currents.length });
      }
      for (const rec of currents) {
        const hz = String(rec.horizon || '').match(/^(\d+)/);
        const lo = hz && lastObserved[hz[1]];
        if (lo && rec.periodEnd && rec.periodEnd > lo) {
          triage.currentInvalid.push({ hypothesis: hyp, recordId: rec.recordId, periodEnd: rec.periodEnd, lastFullyObserved: lo });
          critical.push(`evidence ${hyp}/${rec.recordId}: periodEnd ${rec.periodEnd} exceeds last fully observed ${hz[1]}-session cohort ${lo} — partial cohorts entered the evaluation`);
        }
        const ce = rec.metrics && rec.metrics.costEvidence;
        if (ce) {
          const v = EX.verifyCostEvidence(ce);
          if (!v.valid) critical.push(`evidence ${hyp}/${rec.recordId}: cost evidence rejected (${v.reason})`);
        }
      }
    }
  }
  if (triage.needsRerun.length) {
    warnings.push(`${triage.needsRerun.length} hypotheses have evidence only on superseded dataset hashes — rerun before citing them against the current panel: ${triage.needsRerun.map((x) => x.hypothesis).join(', ')}`);
  }
  if (triage.historical.length) info.push({ supersededEvidenceExpectedHistory: triage.historical });

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
    version: 'audit-research-data-v2', startedAt, finishedAt: new Date().toISOString(),
    panelVersion: doc.panelVersion, datasetHash: currentHash,
    rows, months: months.length,
    lastFullyObservedCohortDateByHorizon: lastObserved,
    critical, warnings, info,
    evidenceTriage: triage,
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
