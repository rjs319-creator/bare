'use strict';
// APPEND-ONLY EVIDENCE LOG (evidence-log-v1) — the hypothesis registry's missing
// half. lib/research/hypothesis-registry.js keeps ONE mutable `status` per idea;
// editing it loses the trail of what was measured when, on which data, by which
// code. This module stores EVIDENCE RECORDS instead: one immutable record per
// (hypothesis, dataset, period, horizon, code version, experiment manifest),
// appended forever. The registry's status becomes a VIEW over the records
// (deriveStatus), not a hand-edited field.
//
// Also holds the sealed-holdout ledger contract: a holdout must be REGISTERED
// (sealed) before it can ever be opened, and opening is a one-way, recorded
// event — an opened holdout can never be called untouched again.
//
// Pure core + injected persistence (deps.readJSON/writeJSON): no ambient store.

const crypto = require('crypto');

const EVIDENCE_LOG_VERSION = 'evidence-log-v1';
const EVIDENCE_PREFIX = 'research/evidence/';
const HOLDOUT_PATH = 'research/evidence/holdouts.json';

const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const VERDICTS = Object.freeze(['pass-provisional', 'not-confirmed', 'invalid-data', 'inconclusive']);

// One immutable evidence record. The recordId is derived from the full evidence
// key, so the same experiment re-run on the same dataset/period/code lands on
// the same id (idempotent), while ANY change to the key creates a new record.
function makeEvidenceRecord({
  hypothesisId, datasetHash, periodStart, periodEnd, horizon,
  codeVersion, manifestHash, metrics = {}, verdict, mode = 'exploratory',
  generatedAt, note = null,
}) {
  const errors = [];
  if (!hypothesisId) errors.push('hypothesisId required');
  if (!datasetHash) errors.push('datasetHash required');
  if (!periodStart || !periodEnd) errors.push('periodStart/periodEnd required');
  if (!horizon) errors.push('horizon required');
  if (!codeVersion) errors.push('codeVersion required');
  if (!manifestHash) errors.push('manifestHash required');
  if (!VERDICTS.includes(verdict)) errors.push(`verdict must be one of ${VERDICTS.join('|')}`);
  if (errors.length) return { ok: false, errors };
  const recordId = sha16([hypothesisId, datasetHash, periodStart, periodEnd, horizon, codeVersion, manifestHash].join('|'));
  return {
    ok: true,
    record: Object.freeze({
      schema: 'EvidenceRecord', version: EVIDENCE_LOG_VERSION,
      recordId, hypothesisId, datasetHash, periodStart, periodEnd, horizon,
      codeVersion, manifestHash, metrics: Object.freeze({ ...metrics }),
      verdict, mode, generatedAt: generatedAt || null, note,
    }),
  };
}

const recordPath = (hypothesisId, recordId) => `${EVIDENCE_PREFIX}${hypothesisId}/${recordId}.json`;
const indexPath = (hypothesisId) => `${EVIDENCE_PREFIX}${hypothesisId}/index.json`;

// APPEND-ONLY: an existing record is never rewritten — re-appending the same
// evidence key is a recorded no-op, and there is no force/overwrite parameter.
async function appendEvidence(deps, record) {
  if (!record || !record.recordId) return { written: false, reason: 'invalid-record' };
  const path = recordPath(record.hypothesisId, record.recordId);
  const existing = await deps.readJSON(path, null);
  if (existing) return { written: false, reason: 'already-recorded', recordId: record.recordId };
  await deps.writeJSON(path, record, 0);
  const idx = (await deps.readJSON(indexPath(record.hypothesisId), null)) || { hypothesisId: record.hypothesisId, recordIds: [] };
  if (!idx.recordIds.includes(record.recordId)) idx.recordIds.push(record.recordId);
  await deps.writeJSON(indexPath(record.hypothesisId), idx, 0);
  return { written: true, reason: 'appended', recordId: record.recordId };
}

async function loadEvidence(deps, hypothesisId) {
  const idx = await deps.readJSON(indexPath(hypothesisId), null);
  if (!idx) return [];
  const records = await Promise.all(idx.recordIds.map((id) => deps.readJSON(recordPath(hypothesisId, id), null)));
  return records.filter(Boolean);
}

// The registry status as a VIEW over evidence, never a hand edit. Confirmatory
// passes on ≥2 distinct periods → 'provisional' at best (promotion is a human,
// gated act); any invalid-data verdict poisons the view until superseded.
function deriveStatus(records) {
  const rs = (records || []).filter(Boolean);
  if (!rs.length) return { status: 'open', basis: 'no evidence recorded' };
  const newestFirst = rs.slice().sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
  if (newestFirst[0].verdict === 'invalid-data') return { status: 'invalid-data', basis: newestFirst[0].recordId };
  const passes = rs.filter((r) => r.verdict === 'pass-provisional' && r.mode === 'confirmatory');
  const fails = rs.filter((r) => r.verdict === 'not-confirmed');
  const distinctPassPeriods = new Set(passes.map((r) => `${r.periodStart}..${r.periodEnd}`)).size;
  if (distinctPassPeriods >= 2 && fails.length === 0) return { status: 'provisional', basis: `${distinctPassPeriods} confirmatory pass periods, 0 fails` };
  if (passes.length && fails.length) return { status: 'open', basis: 'conflicting evidence — needs a deciding confirmatory run' };
  if (passes.length) return { status: 'open', basis: 'single pass period — one period is never strong validation' };
  // NO-EDGE IS AN AFFIRMATIVE CLAIM and requires an affirmative failure (F-10).
  // `inconclusive` is in VERDICTS but matched no branch above, so it fell through
  // to this return and a hypothesis whose only record decided nothing was buried
  // with the basis "0 not-confirmed records, 0 passes" — a no-edge verdict
  // justified by a count of zero failures. This is the graveyard label the
  // registry exists to maintain (24 of 43 hypotheses carry it): an idea filed
  // here is deliberately not re-run, so "never actually decided" must not land
  // in it. Absence of a decision is not evidence of absence.
  if (!fails.length) return { status: 'inconclusive', basis: `${rs.length} record(s), none decisive — no passes and no not-confirmed results` };
  return { status: 'no-edge', basis: `${fails.length} not-confirmed records, 0 passes` };
}

// ── Sealed holdouts ───────────────────────────────────────────────────────────
// Register (seal) BEFORE the holdout exists as an evaluation target; open ONCE.
async function registerHoldout(deps, { id, description, periodStart, periodEnd, sealedAt }) {
  if (!id || !periodStart || !periodEnd || !sealedAt) return { ok: false, error: 'id/periodStart/periodEnd/sealedAt required' };
  const doc = (await deps.readJSON(HOLDOUT_PATH, null)) || { version: EVIDENCE_LOG_VERSION, holdouts: [] };
  if (doc.holdouts.some((h) => h.id === id)) return { ok: false, error: 'holdout id already registered' };
  doc.holdouts.push({ id, description: description || null, periodStart, periodEnd, sealedAt, openedAt: null, openedBy: null });
  await deps.writeJSON(HOLDOUT_PATH, doc, 0);
  return { ok: true };
}

// One-way: opening is recorded forever; a second open is refused, and there is
// no API to reset openedAt.
async function openHoldout(deps, { id, openedAt, openedBy }) {
  if (!id || !openedAt || !openedBy) return { ok: false, error: 'id/openedAt/openedBy required' };
  const doc = await deps.readJSON(HOLDOUT_PATH, null);
  const h = doc && doc.holdouts.find((x) => x.id === id);
  if (!h) return { ok: false, error: 'holdout not registered — seal before opening' };
  if (h.openedAt) return { ok: false, error: `holdout already opened at ${h.openedAt} by ${h.openedBy} — an opened holdout is never untouched again` };
  h.openedAt = openedAt; h.openedBy = openedBy;
  await deps.writeJSON(HOLDOUT_PATH, doc, 0);
  return { ok: true, holdout: { ...h } };
}

async function untouchedHoldouts(deps) {
  const doc = await deps.readJSON(HOLDOUT_PATH, null);
  return ((doc && doc.holdouts) || []).filter((h) => !h.openedAt);
}

module.exports = {
  EVIDENCE_LOG_VERSION, EVIDENCE_PREFIX, HOLDOUT_PATH, VERDICTS,
  makeEvidenceRecord, appendEvidence, loadEvidence, deriveStatus,
  registerHoldout, openHoldout, untouchedHoldouts,
  recordPath, indexPath,
};
