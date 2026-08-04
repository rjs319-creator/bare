'use strict';
// MODEL REGISTRY — immutable artifacts, card-completeness fail-closed, gate-checked
// shadow-first promotion, live promotion tied to save-time evidence, one-call rollback,
// graceful no-store degradation.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  HISTORY_CAP, SHADOW_BASIS, DETERMINISTIC_BASELINE,
  validateModelCard, applyPointerChange, rollbackPointer,
  saveCandidate, loadArtifact, getChampion, promote, promoteLive, rollback, scoreShadow,
  recordShadowObservations, shadowStats, scoreShadowBatch, setShadowChallenger,
} = require('../lib/model-registry');
const { trainLogistic } = require('../lib/survival-model');

// In-memory store fake honoring the { readJSON, writeJSON, hasStore } surface.
function memStore(seed = {}) {
  const docs = { ...seed };
  return {
    docs,
    hasStore: () => true,
    readJSON: async (k, fallback) => (k in docs ? docs[k] : fallback),
    writeJSON: async (k, v) => { docs[k] = JSON.parse(JSON.stringify(v)); },
  };
}
const noStore = {
  hasStore: () => false,
  readJSON: async (_k, fallback) => fallback,
  writeJSON: async () => { throw new Error('Blob storage not configured'); },
};

const NOW = '2026-08-03T20:00:00Z';

// A deterministically-fit real model so artifacts carry genuine trainLogistic output.
function fitModel() {
  const rows = [];
  for (let i = 0; i < 200; i++) { const x = (i % 20) - 10; rows.push({ features: { x }, y: x > 0 ? 1 : 0 }); }
  return trainLogistic(rows, ['x'], r => r.y, { iters: 400 });
}

const goodMeta = (version, extra = {}) => ({
  version,
  trainedAt: '2026-08-03T00:00:00Z',
  dataWindow: { firstDate: '2026-06-01', lastDate: '2026-07-31', rows: 5000, episodes: 900 },
  features: ['x'],
  exclusions: ['version-incompatible rows/labels (fail-closed skip counts in the fold report)'],
  metrics: { weighted: { brier: 0.2, ece: 0.05 } },
  limitations: ['out-of-fold calibration not passed', 'shadow research output only'],
  ...extra,
});
const PASSING_GATE = { promote: true, checks: [], failed: [] };

// ── Pure card validation (no store required) ─────────────────────────────────
test('validateModelCard: fails closed with the exact missing-field list', () => {
  // Arrange: card missing trainedAt, metrics, and a dataWindow subfield.
  const card = {
    version: 'v1', dataWindow: { firstDate: '2026-06-01', lastDate: '2026-07-31', rows: 10 },
    features: ['x'], exclusions: [], limitations: ['a'], promotionDecision: 'candidate',
  };

  // Act
  const r = validateModelCard(card);

  // Assert
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('trainedAt'));
  assert.ok(r.missing.includes('metrics'));
  assert.ok(r.missing.includes('dataWindow.episodes'));
});

test('validateModelCard: requires limitations to be a non-empty array — an honest card names its limits', () => {
  const base = { version: 'v', trainedAt: 't', dataWindow: { firstDate: 'a', lastDate: 'b', rows: 1, episodes: 1 }, features: [], exclusions: [], metrics: {}, promotionDecision: 'candidate' };
  assert.equal(validateModelCard({ ...base, limitations: [] }).ok, false);
  assert.equal(validateModelCard({ ...base, limitations: ['uncalibrated'] }).ok, true);
});

// ── Pure pointer-transition logic ────────────────────────────────────────────
test('applyPointerChange: appends the prior pointer to history, capped, without mutation', () => {
  // Arrange
  const pointer = { version: 'v1', mode: 'shadow', promotedAt: '2026-08-01T00:00:00Z' };
  const history = Array.from({ length: HISTORY_CAP }, (_, i) => ({ version: `old${i}`, mode: 'shadow', promotedAt: 't' }));

  // Act
  const next = applyPointerChange({ pointer, history, version: 'v2', mode: 'shadow', promotedAt: NOW });

  // Assert
  assert.deepEqual(next.pointer, { version: 'v2', mode: 'shadow', promotedAt: NOW });
  assert.equal(next.history.length, HISTORY_CAP, 'history stays capped');
  assert.deepEqual(next.history.at(-1), pointer, 'prior pointer is the newest history entry');
  assert.equal(history.length, HISTORY_CAP, 'input history not mutated');
});

test('rollbackPointer: restores the newest history entry; null when there is nothing to restore', () => {
  const prior = { version: 'v1', mode: 'shadow', promotedAt: 't1' };
  const rb = rollbackPointer({ pointer: { version: 'v2', mode: 'live', promotedAt: 't2' }, history: [prior] });
  assert.deepEqual(rb.pointer, prior);
  assert.equal(rb.history.length, 0);
  assert.equal(rb.rolledBackFrom.version, 'v2');
  assert.equal(rollbackPointer({ pointer: prior, history: [] }), null);
});

// ── saveCandidate ────────────────────────────────────────────────────────────
test('saveCandidate: writes an immutable artifact and refuses to overwrite an existing version', async () => {
  // Arrange
  const store = memStore();
  const model = fitModel();
  const version = 'dataset-utility-v1@2026-08-03';

  // Act
  const first = await saveCandidate({ model, meta: goodMeta(version) }, { store, now: NOW });
  const again = await saveCandidate({ model, meta: goodMeta(version) }, { store, now: NOW });

  // Assert
  assert.equal(first.ok, true);
  assert.equal(first.promotionDecision, 'candidate');
  assert.deepEqual(again, { ok: false, reason: 'version-exists', version });
  const artifact = await loadArtifact(version, { store });
  assert.ok(Array.isArray(artifact.model.coef), 'artifact carries the trainLogistic coefficients');
  assert.equal(artifact.card.version, version);
  assert.equal(artifact.card.promotionDecision, 'candidate');
});

test('saveCandidate: card completeness fails closed with the missing list', async () => {
  const store = memStore();
  const meta = goodMeta('v-incomplete');
  delete meta.limitations;
  delete meta.metrics;
  const r = await saveCandidate({ model: fitModel(), meta }, { store, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'incomplete-card');
  assert.ok(r.missing.includes('limitations') && r.missing.includes('metrics'));
  assert.equal(Object.keys(store.docs).length, 0, 'nothing persisted on a failed card');
});

test('saveCandidate: promotionDecision is DERIVED from an attached gate result, never caller prose', async () => {
  const store = memStore();
  const passed = await saveCandidate({ model: fitModel(), meta: goodMeta('v-passed', { gate: PASSING_GATE }) }, { store, now: NOW });
  assert.equal(passed.promotionDecision, 'passed-gates');
  const failedGate = await saveCandidate({ model: fitModel(), meta: goodMeta('v-failed', { gate: { promote: false } }) }, { store, now: NOW });
  assert.equal(failedGate.promotionDecision, 'candidate', 'a failing gate yields a candidate card');
});

// ── promote / promoteLive / rollback ─────────────────────────────────────────
test('promote: refused without a passing gate result; lands in SHADOW mode always', async () => {
  // Arrange
  const store = memStore();
  await saveCandidate({ model: fitModel(), meta: goodMeta('v1') }, { store, now: NOW });

  // Act + Assert: no gate / failed gate → refusal before anything is written.
  assert.deepEqual(await promote('v1', { store }), { ok: false, reason: 'gate-not-passed' });
  assert.deepEqual(await promote('v1', { gate: { promote: false }, store }), { ok: false, reason: 'gate-not-passed' });

  // Passing gate → shadow pointer, never live.
  const r = await promote('v1', { gate: PASSING_GATE, store, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.pointer.mode, 'shadow', 'promotion ALWAYS writes shadow first');
  const champ = await getChampion({ store });
  assert.equal(champ.version, 'v1');
  assert.equal(champ.mode, 'shadow');
  assert.ok(champ.artifact, 'champion loads its artifact');
});

test('promote: refuses a version that was never saved', async () => {
  const store = memStore();
  const r = await promote('ghost-version', { gate: PASSING_GATE, store });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'artifact-not-found');
});

test('promoteLive: requires the artifact card to carry passed-gates evidence from save time', async () => {
  // Arrange: one candidate artifact, one saved with a passing gate.
  const store = memStore();
  await saveCandidate({ model: fitModel(), meta: goodMeta('v-candidate') }, { store, now: NOW });
  await saveCandidate({ model: fitModel(), meta: goodMeta('v-gated', { gate: PASSING_GATE }) }, { store, now: NOW });

  // Act + Assert
  const refused = await promoteLive('v-candidate', { store, now: NOW });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not-passed-gates');

  // Even a passed-gates artifact cannot go live without the MINIMUM PROSPECTIVE SHADOW
  // WINDOW — a backtest alone can never serve.
  const noShadow = await promoteLive('v-gated', { store, now: NOW });
  assert.equal(noShadow.ok, false);
  assert.equal(noShadow.reason, 'insufficient-shadow-window');

  const { GATES } = require('../lib/promotion-gate');
  const perDay = Math.ceil(GATES.minShadowEpisodes / GATES.minShadowDays);
  for (let d = 1; d <= GATES.minShadowDays; d++) {
    await recordShadowObservations({ date: `2026-07-${String(d).padStart(2, '0')}`, episodes: perDay }, { store });
  }
  const stats = await shadowStats({ store });
  assert.ok(stats.shadowDays >= GATES.minShadowDays && stats.shadowEpisodes >= GATES.minShadowEpisodes);

  const live = await promoteLive('v-gated', { store, now: NOW });
  assert.equal(live.ok, true);
  assert.equal(live.pointer.mode, 'live');
});

test('27. the shadow artifact loads ONCE and scores in batch; a challenger coexists with a live champion', async () => {
  const store = memStore();
  await saveCandidate({ model: fitModel(), meta: goodMeta('v-champ') }, { store, now: NOW });
  await saveCandidate({ model: fitModel(), meta: goodMeta('v-chal') }, { store, now: NOW });
  await promote('v-champ', { gate: PASSING_GATE, store, now: NOW });

  // Batch scoring: read count stays flat regardless of batch size (ONE artifact load).
  let reads = 0;
  const counting = { ...store, readJSON: async (k, d) => { reads++; return store.readJSON(k, d); } };
  const feats = Array.from({ length: 10 }, () => ({ x: 1, z: 0 }));
  const out = await scoreShadowBatch(feats, { store: counting });
  assert.equal(out.length, 10);
  assert.ok(out.every(s => s && s.calibrated === false && s.version === 'v-champ'));
  assert.ok(reads <= 3, `champion loaded once for the whole batch (${reads} reads)`);

  // A shadow CHALLENGER registers beside the champion and takes over shadow scoring,
  // while the champion pointer is untouched.
  const reg = await setShadowChallenger('v-chal', { store, now: NOW, actor: 'test', reason: 'challenger trial' });
  assert.equal(reg.ok, true);
  const s2 = await scoreShadow({ x: 1, z: 0 }, { store });
  assert.equal(s2.version, 'v-chal');
  assert.equal(s2.mode, 'shadow-challenger');
  assert.equal((await getChampion({ store })).version, 'v-champ', 'champion pointer untouched');
});

test('rollback: one call restores the previous pointer; refuses with no history', async () => {
  // Arrange: v1 promoted, then v2 promoted over it.
  const store = memStore();
  await saveCandidate({ model: fitModel(), meta: goodMeta('v1') }, { store, now: NOW });
  await saveCandidate({ model: fitModel(), meta: goodMeta('v2') }, { store, now: NOW });
  await promote('v1', { gate: PASSING_GATE, store, now: '2026-08-01T00:00:00Z' });
  await promote('v2', { gate: PASSING_GATE, store, now: NOW });
  assert.equal((await getChampion({ store })).version, 'v2');

  // Act
  const rb = await rollback({ store, now: NOW });

  // Assert
  assert.equal(rb.ok, true);
  assert.equal(rb.pointer.version, 'v1', 'previous pointer restored in one call');
  assert.equal(rb.rolledBackFrom.version, 'v2');
  assert.equal((await getChampion({ store })).version, 'v1');

  // History exhausted (v1 had no prior pointer): refuse instead of inventing state.
  const empty = await rollback({ store, now: NOW });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no-history');
});

// ── Default champion + shadow scoring ────────────────────────────────────────
test('getChampion: deterministic baseline when no pointer exists — an honest "no model"', async () => {
  const champ = await getChampion({ store: memStore() });
  assert.equal(champ.version, null);
  assert.equal(champ.kind, 'deterministic-baseline');
  assert.match(champ.note, /deterministic runner\/dud scores/);
});

test('scoreShadow: champion coefficients score features, permanently labeled uncalibrated', async () => {
  // Arrange
  const store = memStore();
  await saveCandidate({ model: fitModel(), meta: goodMeta('v1') }, { store, now: NOW });
  await promote('v1', { gate: PASSING_GATE, store, now: NOW });

  // Act
  const out = await scoreShadow({ x: 8 }, { store });

  // Assert
  assert.equal(out.version, 'v1');
  assert.ok(out.pTarget > 0 && out.pTarget < 1);
  assert.equal(out.calibrated, false, 'NEVER presented as a calibrated probability');
  assert.equal(out.basis, SHADOW_BASIS, 'the basis disclaimer travels with every output');
  const high = await scoreShadow({ x: 8 }, { store });
  const low = await scoreShadow({ x: -8 }, { store });
  assert.ok(high.pTarget > low.pTarget, 'the artifact model actually ranks');
});

test('scoreShadow: two-stage { target, stop } artifacts score both probabilities', async () => {
  const store = memStore();
  const m = fitModel();
  await saveCandidate({ model: { target: m, stop: m }, meta: goodMeta('v-two-stage') }, { store, now: NOW });
  await promote('v-two-stage', { gate: PASSING_GATE, store, now: NOW });
  const out = await scoreShadow({ x: 3 }, { store });
  assert.ok(Number.isFinite(out.pTarget) && Number.isFinite(out.pStop));
  assert.equal(out.calibrated, false);
});

test('scoreShadow: null with no learned champion — the deterministic baseline has no fake scores', async () => {
  assert.equal(await scoreShadow({ x: 1 }, { store: memStore() }), null);
});

// ── No-store degradation (runs exactly as production does without Blob) ──────
test('every function degrades gracefully without Blob storage', async () => {
  assert.deepEqual(await saveCandidate({ model: fitModel(), meta: goodMeta('v1') }, { store: noStore }), { ok: false, reason: 'no-store' });
  assert.deepEqual(await promote('v1', { gate: PASSING_GATE, store: noStore }), { ok: false, reason: 'no-store' });
  assert.deepEqual(await promoteLive('v1', { store: noStore }), { ok: false, reason: 'no-store' });
  assert.deepEqual(await rollback({ store: noStore }), { ok: false, reason: 'no-store' });
  const champ = await getChampion({ store: noStore });
  assert.deepEqual(champ, { ...DETERMINISTIC_BASELINE });
  assert.equal(await scoreShadow({ x: 1 }, { store: noStore }), null);
  assert.equal(await loadArtifact('v1', { store: noStore }), null);
});
