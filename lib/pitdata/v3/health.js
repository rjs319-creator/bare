'use strict';
// PIT-DATA-V3 HEALTH — the v3 sections of op=datahealth plus the three-tier
// readiness verdict, persisted as a DAILY IMMUTABLE artifact
// (pitdata/v3/health/<date>.json) rather than only an ephemeral route response.
//
// Readiness tiers (strictly ordered, each implies the previous):
//   operationallyHealthy — keys present, collector state exists, latest run not
//                          stale/failed, no section read errors.
//   researchReady        — operationally healthy AND reconciliation exists with
//                          the raw-integrity + identity + longitudinal gates
//                          passing AND mandatory PIT sections present.
//   promotionReady       — researchReady AND the reconciliation report is fully
//                          engineering-complete AND a human promotion artifact
//                          exists. (Applying it is STILL a reviewed code change.)
//
// Fail-closed rules baked in: a missing required key, a missing mandatory PIT
// section, or survivorshipSafe=false in a would-be consumer switch all cap the
// readiness verdict. Absence of data is a finding, never a blank.

const S = require('./schema');
const C = require('./collector');
const { redactSecrets } = require('../../redact');

const MANDATORY_SECTIONS = Object.freeze(['collector', 'probe', 'latestRun', 'reconciliation', 'rawIntegrity', 'identity', 'universe', 'labels', 'keys']);

async function section(name, fn) {
  try { return { name, ok: true, ...(await fn()) }; }
  catch (e) { return { name, ok: false, error: redactSecrets((e && e.message) || e) }; }
}

// deps: { readJSON, writeJSON, now } — env consulted only for key BOOLEANS.
async function buildV3Health(deps, { env = process.env } = {}) {
  const now = deps.now();
  const today = new Date(now).toISOString().slice(0, 10);

  const state = await deps.readJSON(S.P.state(C.COLLECTOR_ID), null);
  const latestRunRef = state && (state.activeRun
    || (state.lastCompletedRunDate ? { date: state.lastCompletedRunDate, runId: `run-${state.lastCompletedRunDate}-${String(state.runSeq || 0).padStart(4, '0')}` } : null));
  const latestRun = latestRunRef ? await deps.readJSON(S.P.run(latestRunRef.date, latestRunRef.runId), null) : null;
  const probe = await deps.readJSON('pitdata/v3/probe.json', null);
  const recon = await deps.readJSON(S.P.reconciliation(today), null)
    || await deps.readJSON('pitdata/v3/reconciliation/latest.json', null);
  const promotion = await deps.readJSON('pitdata/v3/promotion/latest.json', null);

  const sections = {};
  sections.keys = await section('keys', async () => ({
    fmp: !!env.FMP_API_KEY,
    blobStore: !!env.BLOB_READ_WRITE_TOKEN,
    cronSecret: !!env.CRON_SECRET,
    openfigi: !!env.OPENFIGI_API_KEY,   // optional — lowers identity confidence only
    requiredMissing: [!env.FMP_API_KEY && 'FMP_API_KEY', !env.BLOB_READ_WRITE_TOKEN && 'BLOB_READ_WRITE_TOKEN'].filter(Boolean),
  }));
  sections.collector = await section('collector', async () => {
    if (!state) return { present: false, warning: 'v3 collector has never run' };
    return {
      present: true,
      initialBackfillComplete: !!state.initialBackfillComplete,
      lastCompletedRunDate: state.lastCompletedRunDate || null,
      runsCompleted: state.runsCompleted || 0,
      prospectiveDates: (state.prospectiveDates || []).length,
      activeRun: state.activeRun ? { runId: state.activeRun.runId, step: state.activeRun.step } : null,
    };
  });
  sections.probe = await section('probe', async () => {
    if (!probe) return { present: false, warning: 'capability probe has never run' };
    const eps = probe.endpoints || {};
    return {
      present: true, probedAt: probe.probedAt || null,
      available: Object.keys(eps).filter((k) => eps[k].available),
      blocked: Object.keys(eps).filter((k) => !eps[k].available),
      openfigiKeyPresent: !!(probe.corroboration && probe.corroboration.openfigi && probe.corroboration.openfigi.keyPresent),
    };
  });
  sections.latestRun = await section('latestRun', async () => {
    if (!latestRun) return { present: false, warning: 'no run manifest found' };
    const ageDays = latestRun.endedAt ? (now - new Date(latestRun.endedAt).getTime()) / 86400000 : null;
    return {
      present: true, runId: latestRun.runId, date: latestRun.date,
      provenance: latestRun.provenance, complete: !!latestRun.complete,
      completenessStatus: latestRun.completenessStatus,
      requestedPages: latestRun.requestedPages.length, completedPages: latestRun.completedPages.length,
      failures: latestRun.failures.length, retries: latestRun.retries,
      ageDays: ageDays == null ? null : +ageDays.toFixed(1),
      stale: ageDays != null && ageDays > 3,
    };
  });
  sections.reconciliation = await section('reconciliation', async () => {
    if (!recon) return { present: false, warning: 'no v3 reconciliation report' };
    return {
      present: true, generatedAt: recon.generatedAt || null,
      engineeringComplete: recon.engineeringComplete === true,
      failedGates: recon.failedGates || null,
      survivorshipSafe: recon.survivorshipSafe === true,   // structurally false in v3 reports
    };
  });
  sections.rawIntegrity = await section('rawIntegrity', async () => {
    if (!latestRun || !latestRun.contentHashes) return { present: false, warning: 'no run manifest to sample' };
    const hashes = Object.values(latestRun.contentHashes).slice(0, 5);
    let checked = 0, failures = 0;
    for (const h of hashes) {
      const content = await deps.readJSON(S.P.content(h), null);
      if (!content) { failures++; continue; }
      checked++;
      if (S.contentHashOf(content.payload) !== h) failures++;
    }
    return { present: checked > 0, sampled: hashes.length, checked, failures };
  });
  sections.identity = await section('identity', async () => {
    if (!recon || !recon.counts) return { present: false, warning: 'identity coverage needs a reconciliation report' };
    return {
      present: true,
      listings: recon.counts.listings, lowConfidenceFrac: recon.fractions ? recon.fractions.lowConfidence : null,
      identityConflicts: recon.counts.identityConflicts,
    };
  });
  sections.universe = await section('universe', async () => {
    if (!recon || !recon.counts) return { present: false, warning: 'universe coverage needs a reconciliation report' };
    return {
      present: true,
      confirmedDelisted: recon.counts.confirmedDelisted,
      instrumentTypeFrac: recon.fractions ? recon.fractions.instrumentType : null,
      exchangeKnownFrac: recon.fractions ? recon.fractions.exchangeKnown : null,
      universeSampleDates: recon.counts.universeSampleDates,
    };
  });
  sections.labels = await section('labels', async () => {
    const doc = await deps.readJSON('pitdata/v3/labels/latest-stats.json', null);
    if (!doc) return { present: false, warning: 'no v3 label-state statistics yet (panel-v3 not generated)' };
    return { present: true, ...doc };
  });
  sections.provenanceMix = await section('provenanceMix', async () => {
    if (!state) return { present: false };
    return {
      present: true,
      prospectiveRunDates: (state.prospectiveDates || []).length,
      reconstructionComplete: !!state.initialBackfillComplete,
    };
  });

  const problems = [];
  for (const s of Object.values(sections)) {
    if (!s.ok) problems.push(`${s.name}: ${s.error}`);
    else if (s.warning) problems.push(`${s.name}: ${s.warning}`);
    else if (s.stale) problems.push(`${s.name}: stale`);
  }
  const missingMandatory = MANDATORY_SECTIONS.filter((m) => !sections[m] || sections[m].present === false || sections[m].ok === false);
  const requiredKeysMissing = (sections.keys.requiredMissing || []).length > 0;

  // Fail-closed readiness. Mandatory-section absence caps EVERYTHING below green.
  const operationallyHealthy = !requiredKeysMissing
    && !!state
    && !!latestRun && latestRun.completenessStatus !== 'failed'
    && !(sections.latestRun.stale === true)
    && Object.values(sections).every((s) => s.ok);
  const researchReady = operationallyHealthy
    && missingMandatory.length === 0
    && !!recon
    && recon.gates && recon.gates.rawHashesReproducible === true
    && recon.gates.lowConfidenceIdentity === true
    && recon.gates.minProspectiveDates === true;
  const promotionReady = researchReady
    && recon.engineeringComplete === true
    && !!promotion && promotion.ok !== false;

  return {
    schema: 'PitHealthV3', version: S.PITDATA_V3_VERSION,
    date: today, generatedAt: new Date(now).toISOString(),
    sections, problems, missingMandatorySections: missingMandatory,
    readiness: {
      operationallyHealthy,
      researchReady,
      promotionReady,
      note: promotionReady
        ? 'promotion-ready: a human-approved proposal exists; applying it is still a reviewed code change.'
        : researchReady ? 'research-ready: v3 data usable for research; NOT promotion-ready.'
          : operationallyHealthy ? 'operationally healthy only: collection running, gates not yet passed.'
            : 'NOT operationally healthy — see problems.',
    },
    survivorshipSafe: false,
  };
}

// Persist today's health artifact IMMUTABLY: first write of the day wins; later
// calls return the recorded artifact instead of rewriting history.
async function persistDailyHealth(deps, health) {
  const path = S.P.health(health.date);
  const existing = await deps.readJSON(path, null);
  if (existing) return { written: false, reason: 'already-recorded', path };
  await deps.writeJSON(path, health, 0);
  return { written: true, reason: 'new', path };
}

module.exports = { MANDATORY_SECTIONS, buildV3Health, persistDailyHealth };
