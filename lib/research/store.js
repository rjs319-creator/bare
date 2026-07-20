'use strict';
// RESEARCH PERSISTENCE — decisions and outcomes, in SEPARATE Blob prefixes.
//
//   research/decisions/<YYYY-MM-DD>.json   immutable DecisionSnapshot (write-once)
//   research/outcomes/<YYYY-MM-DD>.json    grader-owned OutcomeBatch
//
// The split is structural, not conventional: the contract requires that ingestion
// never overwrite grading and grading never mutate a prediction. Two prefixes with
// two writers make that impossible to violate by accident — a grader bug can corrupt
// outcomes but can never rewrite the decision that is being judged.
//
// WRITE-ONCE ON DECISIONS: saveDecisionSnapshot refuses to overwrite an existing day
// unless explicitly forced. A prediction that can be rewritten after the fact is not
// evidence, and `op=today` is called many times a day — without this guard the last
// call of the day would silently replace the morning's decision record.
//
// Uses the generic readJSON/writeJSON helpers (which cache-bust reads, avoiding the
// read-modify-write race that previously cost this project lost ingest batches).

const { readJSON, writeJSON, hasStore } = require('../store');

const DECISIONS_PREFIX = 'research/decisions/';
const OUTCOMES_PREFIX = 'research/outcomes/';
// Multi-horizon vectors live in their OWN prefix — a separate authoritative artifact
// (Phase 15), so the single-horizon outcome contract the UI already reads is never touched.
const HORIZON_OUTCOMES_PREFIX = 'research/horizon-outcomes/';

const decisionPath = date => `${DECISIONS_PREFIX}${date}.json`;
const outcomePath = date => `${OUTCOMES_PREFIX}${date}.json`;
const horizonOutcomePath = date => `${HORIZON_OUTCOMES_PREFIX}${date}.json`;

const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

async function loadDecisionSnapshot(date) {
  if (!hasStore() || !isDate(date)) return null;
  return readJSON(decisionPath(date), null).catch(() => null);
}

// Write-once unless forced. Returns {written, reason}.
async function saveDecisionSnapshot(date, snapshot, { force = false } = {}) {
  if (!hasStore()) return { written: false, reason: 'no-store' };
  if (!isDate(date)) return { written: false, reason: 'bad-date' };
  if (!snapshot || !snapshot.predictions) return { written: false, reason: 'empty-snapshot' };
  if (!force) {
    const existing = await loadDecisionSnapshot(date);
    if (existing) return { written: false, reason: 'already-recorded' };
  }
  await writeJSON(decisionPath(date), { ...snapshot, savedAt: new Date().toISOString() }, 0);
  return { written: true, reason: force ? 'forced' : 'new' };
}

async function loadOutcomes(date) {
  if (!hasStore() || !isDate(date)) return null;
  return readJSON(outcomePath(date), null).catch(() => null);
}

// Outcomes ARE re-writable: a horizon that was pending yesterday resolves today, so a
// re-grade legitimately supersedes. It still cannot touch the decision document.
async function saveOutcomes(date, batch) {
  if (!hasStore()) return { written: false, reason: 'no-store' };
  if (!isDate(date)) return { written: false, reason: 'bad-date' };
  await writeJSON(outcomePath(date), { ...batch, savedAt: new Date().toISOString() }, 0);
  return { written: true, reason: 'graded' };
}

async function loadHorizonOutcomes(date) {
  if (!hasStore() || !isDate(date)) return null;
  return readJSON(horizonOutcomePath(date), null).catch(() => null);
}

// Like outcomes, the horizon vector is re-writable: pending rungs resolve over time, so a
// re-grade legitimately supersedes. It still cannot touch decisions or single-horizon outcomes.
async function saveHorizonOutcomes(date, batch) {
  if (!hasStore()) return { written: false, reason: 'no-store' };
  if (!isDate(date)) return { written: false, reason: 'bad-date' };
  await writeJSON(horizonOutcomePath(date), { ...batch, savedAt: new Date().toISOString() }, 0);
  return { written: true, reason: 'graded' };
}

// Recent decision dates, newest first, walking back from `from`. Avoids a Blob list
// call (and its pagination) by probing dates directly — the caller knows the window.
function recentDates(from, days = 90) {
  if (!isDate(from)) return [];
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  for (let i = 0; i < days; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

module.exports = {
  DECISIONS_PREFIX, OUTCOMES_PREFIX, HORIZON_OUTCOMES_PREFIX,
  decisionPath, outcomePath, horizonOutcomePath,
  loadDecisionSnapshot, saveDecisionSnapshot, loadOutcomes, saveOutcomes,
  loadHorizonOutcomes, saveHorizonOutcomes, recentDates,
};
