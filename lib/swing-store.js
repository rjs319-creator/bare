'use strict';
// SWING SUPERVISOR STORAGE — reuses the app's existing adapters, adds no parallel system.
//
//   swing/episodes.json   singleton map { episodeId → episode record }. The union universe. Loaded
//                         by the monitor, re-frozen on read, written back read-modify-write (last-
//                         writer-wins is safe because the monitor is idempotent per session).
//   swing/board.json      the last served, sectioned board (for an instant UI serve without recompute).
//   swing/resolved.json   append-bounded log of resolved (terminal) unique episodes — the router and
//                         the shadow survival model consume this.
//   ledger stream 'swing' the tamper-evident hash-chained spine — one append per monitor pass, each
//                         entry carrying that pass's transitions (immutable-ledger.js, append-once).
//
// All heavy lifting is delegated to lib/store.js (readJSON/writeJSON) and lib/immutable-ledger.js.

const { hasStore, readJSON, writeJSON } = require('./store');
const ledger = require('./immutable-ledger');
const EP = require('./swing-episode');

const EPISODES_PATH = 'swing/episodes.json';
const BOARD_PATH = 'swing/board.json';
const RESOLVED_PATH = 'swing/resolved.json';
const LEDGER_STREAM = 'swing';
const EPISODES_VERSION = 'swing-episodes-v1';
const MAX_EPISODES = 2500;        // hard cap; oldest terminal episodes drop first
const RESOLVED_MAX = 1500;

// Re-freeze a plain-JSON episode back into the schema (recomputes slotKey/terminal deterministically).
function rehydrate(rec) {
  if (!rec || !rec.origin) return null;
  return EP.makeEpisode({ origin: EP.makeOrigin(rec.origin), assessment: rec.assessment ? EP.makeAssessment(rec.assessment) : null, transitions: (rec.transitions || []).map(EP.makeTransition) });
}

async function loadEpisodes() {
  if (!hasStore()) return [];
  const doc = await readJSON(EPISODES_PATH, null).catch(() => null);
  const list = (doc && doc.episodes) || [];
  return list.map(rehydrate).filter(Boolean);
}

function terminalSortKey(ep) {
  const ts = ep.transitions || [];
  for (let i = ts.length - 1; i >= 0; i--) if (ts[i].session) return ts[i].session;
  return ep.origin.firstDecisionDate || '';
}

// Cap the stored set: keep every non-terminal episode; keep the most-recent terminals up to the cap.
function prune(episodes) {
  const open = episodes.filter(e => !e.terminal);
  const terminal = episodes.filter(e => e.terminal).sort((a, b) => (terminalSortKey(a) < terminalSortKey(b) ? 1 : -1));
  const room = Math.max(0, MAX_EPISODES - open.length);
  return [...open, ...terminal.slice(0, room)];
}

async function saveEpisodes(episodes, date) {
  if (!hasStore()) return { written: false, reason: 'no-store' };
  const pruned = prune(episodes);
  await writeJSON(EPISODES_PATH, { version: EPISODES_VERSION, date, savedAt: new Date().toISOString(), episodes: pruned }, 0);
  return { written: true, count: pruned.length, dropped: episodes.length - pruned.length };
}

async function saveBoard(board) {
  if (!hasStore()) return { written: false, reason: 'no-store' };
  await writeJSON(BOARD_PATH, board, 0);
  return { written: true };
}
async function loadBoard() {
  if (!hasStore()) return null;
  return readJSON(BOARD_PATH, null).catch(() => null);
}

// Append this pass's transitions to the immutable hash-chained ledger. One entry per pass; skipped
// when there is nothing to record so a quiet re-run does not bloat the chain.
async function appendTransitions(date, transitions, meta = {}) {
  if (!hasStore() || !transitions || !transitions.length) return { appended: false, reason: transitions && transitions.length ? 'no-store' : 'no-transitions' };
  try {
    const entry = await ledger.append(LEDGER_STREAM, { kind: 'swing-monitor-batch', date, count: transitions.length, transitions, ...meta });
    return { appended: true, seq: entry && entry.seq, hash: entry && entry.hash };
  } catch (e) {
    return { appended: false, error: String((e && e.message) || e) };
  }
}

async function verifyLedger() {
  if (!hasStore()) return { ok: null, reason: 'no-store' };
  return ledger.verify(LEDGER_STREAM).catch(e => ({ ok: false, error: String((e && e.message) || e) }));
}

// Append resolved (terminal) episodes — deduped by episodeId — for the router / survival model.
async function recordResolved(gradedEpisodes, date) {
  if (!hasStore() || !gradedEpisodes || !gradedEpisodes.length) return { written: false };
  const doc = (await readJSON(RESOLVED_PATH, null).catch(() => null)) || { rows: [] };
  const seen = new Set((doc.rows || []).map(r => r.episodeId));
  const add = gradedEpisodes
    .filter(e => e.origin && !seen.has(e.origin.episodeId))
    .map(e => ({
      episodeId: e.origin.episodeId, ticker: e.origin.ticker, side: e.origin.side,
      strategyFamily: e.origin.strategyFamily, sourceStrategy: e.origin.sourceStrategy,
      horizon: e.origin.horizon, resolvedDate: date,
      outcomeState: e.assessment && e.assessment.outcomeState, executionState: e.assessment && e.assessment.executionState,
      returnSinceFill: e.assessment && e.assessment.returnSinceFill, excessVsSpy: e.assessment && e.assessment.excessVsSpy,
      mfeSinceFill: e.assessment && e.assessment.mfeSinceFill, maeSinceFill: e.assessment && e.assessment.maeSinceFill,
      sessionsSinceEntry: e.assessment && e.assessment.sessionsSinceEntry,
    }));
  if (!add.length) return { written: false, reason: 'already-recorded' };
  const rows = [...(doc.rows || []), ...add].slice(-RESOLVED_MAX);
  await writeJSON(RESOLVED_PATH, { version: 'swing-resolved-v1', date, rows }, 0);
  return { written: true, added: add.length, total: rows.length };
}

async function loadResolved() {
  if (!hasStore()) return [];
  const doc = await readJSON(RESOLVED_PATH, null).catch(() => null);
  return (doc && doc.rows) || [];
}

module.exports = {
  EPISODES_PATH, BOARD_PATH, RESOLVED_PATH, LEDGER_STREAM, EPISODES_VERSION,
  rehydrate, loadEpisodes, saveEpisodes, saveBoard, loadBoard,
  appendTransitions, verifyLedger, recordResolved, loadResolved, prune,
};
