'use strict';
// ATLAS-X — persistence, namespaced under atlasx/* so it NEVER collides with the
// live swing supervisor's swing/* store. Thin wrapper over the shared Blob store
// (lib/store.js) and the hash-chained immutable ledger (lib/immutable-ledger.js).
//
// Episodes are persisted as plain JSON: buildSupervisor treats prior episodes as
// read-only data and always emits NEW episode objects, so a JSON round-trip is
// safe (no rehydrate needed). All state writes use cacheMaxAge 0.

const { readJSON, writeJSON, hasStore } = require('./store');
const ledger = require('./immutable-ledger');
const { STORE } = require('./atlasx-config');

const NO_CACHE = 0;

// ── episodes ─────────────────────────────────────────────────────────────────
async function loadEpisodes() {
  const v = await readJSON(STORE.episodes, []);
  return Array.isArray(v) ? v : [];
}
async function saveEpisodes(episodes) {
  if (!hasStore()) return false;
  await writeJSON(STORE.episodes, Array.isArray(episodes) ? episodes : [], NO_CACHE);
  return true;
}

// ── board (server-authoritative sectioned render) ────────────────────────────
async function loadBoard() { return readJSON(STORE.board, null); }
async function saveBoard(board) {
  if (!hasStore()) return false;
  await writeJSON(STORE.board, board, NO_CACHE);
  return true;
}

// ── latest full payload (for op=atlasx read) ─────────────────────────────────
async function loadLatest() { return readJSON(STORE.latest, null); }
async function saveLatest(payload) {
  if (!hasStore()) return false;
  await writeJSON(STORE.latest, payload, NO_CACHE);
  return true;
}

// ── resolved (terminal, graded episodes) ─────────────────────────────────────
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

// ── prospective predictions (immutable forward log) ──────────────────────────
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

// ── capture (matched controls / near-miss / rejected) — keep a rolling window ─
const CAPTURE_KEEP = 90;
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

// ── health + calibration ─────────────────────────────────────────────────────
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

// ── immutable ledger (append-only, hash-chained provenance) ──────────────────
async function appendLedger(payload) {
  if (!ledger.hasStore()) return null;
  return ledger.append(STORE.ledgerStream, payload);
}
async function readLedger() { return ledger.readChain(STORE.ledgerStream); }
async function verifyLedger() { return ledger.verify(STORE.ledgerStream); }

module.exports = {
  hasStore,
  loadEpisodes, saveEpisodes,
  loadBoard, saveBoard,
  loadLatest, saveLatest,
  loadResolved, appendResolved,
  loadPredictions, appendPredictions,
  loadCapture, appendCapture,
  loadHealth, saveHealth,
  loadCalibration, saveCalibration,
  appendLedger, readLedger, verifyLedger,
};
