'use strict';
// MODEL REGISTRY — durable model artifacts + champion pointer + shadow scoring + rollback.
//
// WHY. Learned survival models were EPHEMERAL: fit per-request inside the evaluation
// harness and discarded, so there was no champion pointer, no shadow scoring against a
// fixed artifact, and no rollback. This registry makes model state explicit:
//   • saveCandidate  — immutable versioned artifact (coefficients + a complete MODEL CARD)
//   • getChampion    — pointer doc → artifact; default is the DETERMINISTIC baseline
//   • promote        — gate-checked, ALWAYS lands in shadow mode first
//   • promoteLive    — separate explicit step, requires the artifact's passed-gates card
//   • rollback       — one call restores the previous pointer from history
//   • scoreShadow    — champion coefficients → pTarget, permanently labeled uncalibrated
//
// HONESTY. scoreShadow output is NEVER a probability claim: `calibrated: false` and the
// basis string travel with every score. Promotion decisions on the card are DERIVED from
// a lib/promotion-gate result — a caller cannot assert 'passed-gates' by hand.
// Everything degrades gracefully without Blob storage ({ok:false, reason:'no-store'} /
// null / deterministic-baseline default) so tests and store-less deploys keep working.

const { readJSON, writeJSON, hasStore } = require('./store');
const { predictProba } = require('./survival-model');

const MODELS_PREFIX = 'lifecycle/daytrade/models/';
const CHAMPION_KEY = `${MODELS_PREFIX}champion.json`;
// A SHADOW CHALLENGER can coexist beside a live champion (separate pointer): shadow scoring
// prefers the challenger, so a promoted-live model keeps serving while its would-be
// replacement accrues prospective shadow evidence.
const CHALLENGER_KEY = `${MODELS_PREFIX}challenger.json`;
const SHADOW_STATS_KEY = `${MODELS_PREFIX}shadow-stats.json`;
const HISTORY_KEY = `${MODELS_PREFIX}history.json`;
const HISTORY_CAP = 50;   // rollback depth — enough for years of promotions, bounded doc size
const SHADOW_BASIS = 'shadow model output — research only, not a calibrated probability';

// Version strings become Blob pathnames — restrict to safe chars (no traversal, no '/').
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const artifactKey = version => `${MODELS_PREFIX}${version}.json`;

const DEFAULT_STORE = { readJSON, writeJSON, hasStore };
const nowIso = () => new Date().toISOString();

// ── Pure card / pointer logic (unit-testable without any store) ─────────────────

const REQUIRED_CARD_FIELDS = Object.freeze([
  'version', 'trainedAt', 'dataWindow', 'features', 'exclusions', 'metrics', 'limitations', 'promotionDecision',
]);
const REQUIRED_DATA_WINDOW_FIELDS = Object.freeze(['firstDate', 'lastDate', 'rows', 'episodes']);

// Fail closed with the exact missing list — an artifact without a complete model card is
// an unaccountable model, and unaccountable models don't get persisted.
function validateModelCard(card) {
  const missing = [];
  for (const f of REQUIRED_CARD_FIELDS) if (!card || card[f] == null) missing.push(f);
  if (card && card.dataWindow) {
    for (const f of REQUIRED_DATA_WINDOW_FIELDS) if (card.dataWindow[f] == null) missing.push(`dataWindow.${f}`);
  }
  if (card && card.limitations != null && (!Array.isArray(card.limitations) || !card.limitations.length)) {
    missing.push('limitations (must be a non-empty array)');
  }
  return { ok: missing.length === 0, missing };
}

// Pointer transition: new pointer, prior pointer appended to capped history. Immutable —
// returns fresh objects, never mutates inputs.
function applyPointerChange({ pointer, history, version, mode, promotedAt }) {
  const priorEntries = Array.isArray(history) ? history : [];
  const nextHistory = (pointer ? [...priorEntries, pointer] : [...priorEntries]).slice(-HISTORY_CAP);
  return { pointer: { version, mode, promotedAt }, history: nextHistory };
}

// Inverse transition: pop the most recent prior pointer. Null when there is nothing to
// restore — rollback with no history must refuse, not invent a state.
function rollbackPointer({ pointer, history }) {
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length) return null;
  return { pointer: entries[entries.length - 1], history: entries.slice(0, -1), rolledBackFrom: pointer ?? null };
}

// ── Artifact persistence ────────────────────────────────────────────────────────

// Save an immutable candidate artifact. `model` is a lib/survival-model trainLogistic
// result (or a { target, stop } pair of them for the two-stage evaluator). The card's
// promotionDecision is DERIVED: 'passed-gates' only when a passing lib/promotion-gate
// result is attached as meta.gate — never caller-asserted prose.
async function saveCandidate({ model, meta } = {}, { store = DEFAULT_STORE, now = null } = {}) {
  if (!store.hasStore()) return { ok: false, reason: 'no-store' };
  if (!model) return { ok: false, reason: 'missing-model' };
  const m = meta || {};
  if (!m.version || !VERSION_RE.test(m.version)) return { ok: false, reason: 'invalid-version' };

  const promotionDecision = m.gate && m.gate.promote === true ? 'passed-gates' : 'candidate';
  const card = {
    version: m.version, trainedAt: m.trainedAt ?? null, dataWindow: m.dataWindow ?? null,
    features: m.features ?? null, exclusions: m.exclusions ?? null, metrics: m.metrics ?? null,
    limitations: m.limitations ?? null, promotionDecision,
  };
  const valid = validateModelCard(card);
  if (!valid.ok) return { ok: false, reason: 'incomplete-card', missing: valid.missing };

  try {
    const existing = await store.readJSON(artifactKey(m.version), null);
    if (existing) return { ok: false, reason: 'version-exists', version: m.version };
    // Blob writes are technically overwritable; immutability is enforced HERE by the
    // read-before-write check plus the discipline that this is the only writer.
    await store.writeJSON(artifactKey(m.version), {
      version: m.version, model, card, gate: m.gate ?? null, savedAt: now || nowIso(),
    }, 0);
    return { ok: true, version: m.version, key: artifactKey(m.version), promotionDecision };
  } catch (err) {
    return { ok: false, reason: 'store-error', error: err && err.message };
  }
}

async function loadArtifact(version, { store = DEFAULT_STORE } = {}) {
  if (!store.hasStore() || !version || !VERSION_RE.test(version)) return null;
  try { return await store.readJSON(artifactKey(version), null); } catch { return null; }
}

// ── Champion pointer ────────────────────────────────────────────────────────────

// The honest default: with no promoted artifact, production runs the deterministic
// runner/dud scores — the registry says so instead of pretending a model exists.
const DETERMINISTIC_BASELINE = Object.freeze({
  version: null, kind: 'deterministic-baseline',
  note: 'no learned champion — deterministic runner/dud scores are the production baseline',
});

async function getChampion({ store = DEFAULT_STORE } = {}) {
  if (!store.hasStore()) return { ...DETERMINISTIC_BASELINE };
  try {
    const pointer = await store.readJSON(CHAMPION_KEY, null);
    if (!pointer || !pointer.version) return { ...DETERMINISTIC_BASELINE };
    const artifact = await store.readJSON(artifactKey(pointer.version), null);
    if (!artifact) {
      // A dangling pointer is a store inconsistency — fall back loudly, never crash.
      return { ...DETERMINISTIC_BASELINE, note: `champion pointer '${pointer.version}' has no artifact — deterministic baseline in effect` };
    }
    return { version: pointer.version, mode: pointer.mode, promotedAt: pointer.promotedAt, kind: 'learned', artifact };
  } catch {
    return { ...DETERMINISTIC_BASELINE };
  }
}

// Shared pointer writer: history FIRST (so a crash between writes can only lose the new
// pointer, never the rollback trail), then the pointer. `audit` ({actor, reason, gate})
// is stamped onto the pointer so every promotion is attributable and auditable.
async function writePointer(version, mode, { store, now, audit = null }) {
  try {
    const pointer = await store.readJSON(CHAMPION_KEY, null);
    const historyDoc = await store.readJSON(HISTORY_KEY, { entries: [] });
    const next = applyPointerChange({ pointer, history: historyDoc.entries, version, mode, promotedAt: now || nowIso() });
    const stamped = {
      ...next.pointer,
      actor: (audit && audit.actor) || null,
      reason: (audit && audit.reason) || null,
      gateSummary: audit && audit.gate ? { promote: audit.gate.promote === true, failed: audit.gate.failed || [] } : null,
    };
    await store.writeJSON(HISTORY_KEY, { entries: next.history, updatedAt: next.pointer.promotedAt }, 0);
    await store.writeJSON(CHAMPION_KEY, stamped, 0);
    return { ok: true, pointer: stamped, priorPointer: pointer ?? null };
  } catch (err) {
    return { ok: false, reason: 'store-error', error: err && err.message };
  }
}

// Promote a saved artifact to champion — SHADOW MODE ALWAYS. Refuses without a passing
// lib/promotion-gate result; going live is a separate explicit decision (promoteLive),
// never a side effect of passing gates once.
async function promote(version, { gate, store = DEFAULT_STORE, now = null, actor = null, reason = null } = {}) {
  if (!gate || gate.promote !== true) return { ok: false, reason: 'gate-not-passed' };
  if (!store.hasStore()) return { ok: false, reason: 'no-store' };
  const artifact = await loadArtifact(version, { store });
  if (!artifact) return { ok: false, reason: 'artifact-not-found', version };
  return writePointer(version, 'shadow', { store, now, audit: { actor, reason, gate } });
}

// Register a SHADOW CHALLENGER beside the current champion (separate pointer — the
// champion, live or shadow, is untouched). No gate requirement: a challenger only accrues
// observation; it can never serve. scoreShadow prefers the challenger when one exists.
async function setShadowChallenger(version, { store = DEFAULT_STORE, now = null, actor = null, reason = null } = {}) {
  if (!store.hasStore()) return { ok: false, reason: 'no-store' };
  const artifact = await loadArtifact(version, { store });
  if (!artifact) return { ok: false, reason: 'artifact-not-found', version };
  try {
    await store.writeJSON(CHALLENGER_KEY, { version, mode: 'shadow-challenger', promotedAt: now || nowIso(), actor, reason }, 0);
    return { ok: true, version };
  } catch (err) { return { ok: false, reason: 'store-error', error: err && err.message }; }
}

async function getShadowChallenger({ store = DEFAULT_STORE } = {}) {
  if (!store.hasStore()) return null;
  try {
    const pointer = await store.readJSON(CHALLENGER_KEY, null);
    if (!pointer || !pointer.version) return null;
    const artifact = await store.readJSON(artifactKey(pointer.version), null);
    return artifact ? { version: pointer.version, mode: 'shadow-challenger', promotedAt: pointer.promotedAt, kind: 'learned', artifact } : null;
  } catch { return null; }
}

// Separate explicit step to serve the champion live. Requires the ARTIFACT itself to have
// been saved with a passing gate (card.promotionDecision === 'passed-gates') — a live
// promotion can never outrun the evidence recorded at save time.
async function promoteLive(version, { store = DEFAULT_STORE, now = null, actor = null, reason = null } = {}) {
  if (!store.hasStore()) return { ok: false, reason: 'no-store' };
  const artifact = await loadArtifact(version, { store });
  if (!artifact) return { ok: false, reason: 'artifact-not-found', version };
  if (!artifact.card || artifact.card.promotionDecision !== 'passed-gates') {
    return { ok: false, reason: 'not-passed-gates', version };
  }
  // Minimum prospective observation window: a live promotion additionally requires the
  // accrued shadow evidence to meet the gate minima — a backtest alone can never go live.
  const stats = await shadowStats({ store });
  const { GATES } = require('./promotion-gate');
  if (stats.shadowDays < GATES.minShadowDays || stats.shadowEpisodes < GATES.minShadowEpisodes) {
    return { ok: false, reason: 'insufficient-shadow-window', version, shadow: stats, required: { minShadowDays: GATES.minShadowDays, minShadowEpisodes: GATES.minShadowEpisodes } };
  }
  return writePointer(version, 'live', { store, now, audit: { actor, reason } });
}

// One-call restore of the previous pointer from history. The abandoned pointer is
// returned (rolledBackFrom) so the caller can log it; it does not re-enter history.
async function rollback({ store = DEFAULT_STORE, now = null } = {}) {
  if (!store.hasStore()) return { ok: false, reason: 'no-store' };
  try {
    const pointer = await store.readJSON(CHAMPION_KEY, null);
    const historyDoc = await store.readJSON(HISTORY_KEY, { entries: [] });
    const rb = rollbackPointer({ pointer, history: historyDoc.entries });
    if (!rb) return { ok: false, reason: 'no-history' };
    await store.writeJSON(HISTORY_KEY, { entries: rb.history, updatedAt: now || nowIso() }, 0);
    await store.writeJSON(CHAMPION_KEY, rb.pointer, 0);
    return { ok: true, pointer: rb.pointer, rolledBackFrom: rb.rolledBackFrom };
  } catch (err) {
    return { ok: false, reason: 'store-error', error: err && err.message };
  }
}

// ── Shadow scoring ──────────────────────────────────────────────────────────────

// Pure scorer against a loaded champion/challenger object — no store reads. Accepts a
// single trainLogistic model or the two-stage { target, stop } pair.
function scoreWithChampion(champ, features) {
  if (!champ || !champ.artifact || !champ.artifact.model) return null;
  const m = champ.artifact.model;
  const targetModel = m.target && Array.isArray(m.target.coef) ? m.target : (Array.isArray(m.coef) ? m : null);
  if (!targetModel) return null;
  const stopModel = m.stop && Array.isArray(m.stop.coef) ? m.stop : null;
  return {
    version: champ.version,
    mode: champ.mode,
    pTarget: predictProba(targetModel, features),
    pStop: stopModel ? predictProba(stopModel, features) : null,
    calibrated: false,
    basis: SHADOW_BASIS,
  };
}

// Load the shadow-scoring model ONCE per request/batch: the shadow CHALLENGER when one is
// registered, else the champion (shadow OR live — a shadow champion is exactly what this
// exists to observe). Returns null when no learned artifact exists.
async function loadShadowScorer({ store = DEFAULT_STORE } = {}) {
  const challenger = await getShadowChallenger({ store });
  if (challenger) return challenger;
  const champ = await getChampion({ store });
  return champ && champ.artifact ? champ : null;
}

// Score features against the champion artifact. Returns null when there is no learned
// champion. The basis string travels with EVERY output: this is not, and must never be
// displayed as, a calibrated probability.
// NOTE: per-call store reads — batch callers use scoreShadowBatch (ONE load, N scores).
async function scoreShadow(features, { store = DEFAULT_STORE } = {}) {
  const champ = await loadShadowScorer({ store });
  return scoreWithChampion(champ, features);
}

// Batch shadow scoring: the artifact is loaded ONCE and applied to every feature vector
// (the per-ticker champion-reload defect this closes: up to 2 Blob reads × N tickers).
async function scoreShadowBatch(featuresList, { store = DEFAULT_STORE } = {}) {
  const champ = await loadShadowScorer({ store });
  if (!champ) return null;
  return (featuresList || []).map(f => scoreWithChampion(champ, f));
}

// ── Prospective shadow-observation accounting ───────────────────────────────────
// The board tick records how many episodes the shadow scorer actually observed per session;
// promotion's prospective-shadow gate and promoteLive's minimum window read these counts.
async function recordShadowObservations({ date, episodes = 0 } = {}, { store = DEFAULT_STORE, now = null } = {}) {
  if (!store.hasStore() || !date || !(episodes > 0)) return { ok: false, reason: 'no-store-or-input' };
  try {
    const doc = await store.readJSON(SHADOW_STATS_KEY, { byDate: {} }).catch(() => ({ byDate: {} }));
    const byDate = { ...(doc.byDate || {}) };
    byDate[date] = (byDate[date] || 0) + episodes;
    await store.writeJSON(SHADOW_STATS_KEY, { byDate, firstAt: doc.firstAt || (now || nowIso()), updatedAt: now || nowIso() }, 0);
    return { ok: true, days: Object.keys(byDate).length };
  } catch (err) { return { ok: false, reason: 'store-error', error: err && err.message }; }
}

async function shadowStats({ store = DEFAULT_STORE } = {}) {
  if (!store.hasStore()) return { shadowDays: 0, shadowEpisodes: 0 };
  try {
    const doc = await store.readJSON(SHADOW_STATS_KEY, null);
    if (!doc || !doc.byDate) return { shadowDays: 0, shadowEpisodes: 0 };
    const days = Object.keys(doc.byDate);
    return {
      shadowDays: days.length,
      shadowEpisodes: days.reduce((s, d) => s + (doc.byDate[d] || 0), 0),
      firstAt: doc.firstAt || null, updatedAt: doc.updatedAt || null,
    };
  } catch { return { shadowDays: 0, shadowEpisodes: 0 }; }
}

module.exports = {
  MODELS_PREFIX, CHAMPION_KEY, CHALLENGER_KEY, SHADOW_STATS_KEY, HISTORY_KEY, HISTORY_CAP, SHADOW_BASIS,
  REQUIRED_CARD_FIELDS, REQUIRED_DATA_WINDOW_FIELDS, DETERMINISTIC_BASELINE,
  validateModelCard, applyPointerChange, rollbackPointer,
  saveCandidate, loadArtifact, getChampion, promote, promoteLive, rollback,
  setShadowChallenger, getShadowChallenger, loadShadowScorer, scoreWithChampion,
  scoreShadow, scoreShadowBatch, recordShadowObservations, shadowStats,
};
