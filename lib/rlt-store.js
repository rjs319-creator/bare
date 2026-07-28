// ═══════════════════════════════════════════════════════════════════════════
// RLT — persistence, namespaced under rlt/* so it never collides with the
// live swing supervisor's swing/* store or ATLAS-X's atlasx/* store. Thin
// wrapper over the shared Blob store (lib/store.js) and the hash-chained
// immutable ledger (lib/immutable-ledger.js).
//
// One authoritative writer per artifact; cross-section snapshots are
// WRITE-ONCE (an existing date is never overwritten — old predictions are
// never rewritten with new information).
// ═══════════════════════════════════════════════════════════════════════════

const { readJSON, writeJSON, hasStore } = require('./store');
const ledger = require('./immutable-ledger');
const { STORE } = require('./rlt-config');

const NO_CACHE = 0;
const CAPTURE_KEEP = 90;

// ── episodes (supervisor state, plain JSON round-trip) ──────────────────────
async function loadEpisodes() {
  const v = await readJSON(STORE.episodes, []);
  return Array.isArray(v) ? v : [];
}
async function saveEpisodes(episodes) {
  if (!hasStore()) return false;
  await writeJSON(STORE.episodes, Array.isArray(episodes) ? episodes : [], NO_CACHE);
  return true;
}

// ── latest full payload (op=rlt read; also the prior-state source for diffs) ─
async function loadLatest() { return readJSON(STORE.latest, null); }
async function saveLatest(payload) {
  if (!hasStore()) return false;
  await writeJSON(STORE.latest, payload, NO_CACHE);
  return true;
}

// ── sector-state time series (rolling; the app's first PERSISTED record of
//    sector leadership — previously computed everywhere, stored nowhere) ─────
const SECTOR_KEEP = 120;
async function loadSectorStateHistory() {
  const v = await readJSON(STORE.sectorState, []);
  return Array.isArray(v) ? v : [];
}
async function appendSectorState(record) {
  if (!hasStore() || !record || !record.asOf) return false;
  const prev = await loadSectorStateHistory();
  if (prev.some(r => r.asOf === record.asOf)) return false;   // one per session
  await writeJSON(STORE.sectorState, [...prev, record].slice(-SECTOR_KEEP), NO_CACHE);
  return true;
}

// ── resolved (terminal, graded episodes — grader-owned) ─────────────────────
async function loadResolved() {
  const v = await readJSON(STORE.resolved, []);
  return Array.isArray(v) ? v : [];
}
async function appendResolved(records) {
  if (!hasStore() || !records || !records.length) return false;
  const prev = await loadResolved();
  const seen = new Set(prev.map(r => r.predictionId || r.episodeId));
  const fresh = records.filter(r => !seen.has(r.predictionId || r.episodeId));
  if (!fresh.length) return false;
  await writeJSON(STORE.resolved, [...prev, ...fresh], NO_CACHE);
  return true;
}

// ── prospective predictions (immutable forward log, dedup by predictionId) ──
async function loadPredictions() {
  const v = await readJSON(STORE.predictions, []);
  return Array.isArray(v) ? v : [];
}
async function appendPredictions(preds) {
  if (!hasStore() || !preds || !preds.length) return false;
  const prev = await loadPredictions();
  const seen = new Set(prev.map(p => p.predictionId));
  const fresh = preds.filter(p => p.predictionId && !seen.has(p.predictionId));
  if (!fresh.length) return false;
  await writeJSON(STORE.predictions, [...prev, ...fresh], NO_CACHE);
  return true;
}

// ── daily cross-section snapshot — WRITE-ONCE per date ──────────────────────
async function loadCrossSection(date) {
  if (!date) return null;
  return readJSON(STORE.crossSectionPrefix + date + '.json', null);
}
async function saveCrossSection(date, doc) {
  if (!hasStore() || !date || !doc) return { written: false, reason: 'no-store-or-args' };
  const existing = await loadCrossSection(date);
  if (existing) return { written: false, reason: 'already-recorded' };
  await writeJSON(STORE.crossSectionPrefix + date + '.json', doc, NO_CACHE);
  return { written: true, reason: 'new' };
}

// ── capture (selected/rejected/near-threshold/controls) — rolling window ────
async function loadCapture() {
  const v = await readJSON(STORE.capture, []);
  return Array.isArray(v) ? v : [];
}
async function appendCapture(record) {
  if (!hasStore() || !record) return false;
  const prev = await loadCapture();
  const next = [...prev.filter(r => r.date !== record.date), record].slice(-CAPTURE_KEEP);
  await writeJSON(STORE.capture, next, NO_CACHE);
  return true;
}

// ── health + calibration ────────────────────────────────────────────────────
async function loadHealth() { return readJSON(STORE.health, null); }
async function saveHealth(h) {
  if (!hasStore()) return false;
  await writeJSON(STORE.health, h, NO_CACHE);
  return true;
}
async function loadCalibration() { return readJSON(STORE.calibration, null); }
async function saveCalibration(c) {
  if (!hasStore()) return false;
  await writeJSON(STORE.calibration, c, NO_CACHE);
  return true;
}

// ── immutable ledger (append-only, hash-chained provenance) ─────────────────
async function appendLedger(payload) {
  if (!ledger.hasStore()) return null;
  return ledger.append(STORE.ledgerStream, payload);
}
async function readLedger() { return ledger.readChain(STORE.ledgerStream); }
async function verifyLedger() { return ledger.verify(STORE.ledgerStream); }

module.exports = {
  hasStore,
  loadEpisodes, saveEpisodes,
  loadLatest, saveLatest,
  loadSectorStateHistory, appendSectorState,
  loadResolved, appendResolved,
  loadPredictions, appendPredictions,
  loadCrossSection, saveCrossSection,
  loadCapture, appendCapture,
  loadHealth, saveHealth,
  loadCalibration, saveCalibration,
  appendLedger, readLedger, verifyLedger,
};
