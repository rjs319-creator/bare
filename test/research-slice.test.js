'use strict';
// Deterministic tests for the research vertical slice (Part XVI of the quant redesign):
// canonical schemas, exact label-end purge, feature train/serve parity, date-grouped rankers,
// and the validation harness (causal correctness, determinism, honest validity stamp).

const test = require('node:test');
const assert = require('node:assert');

const S = require('../lib/research/schemas');
const LP = require('../lib/research/label-purge');
const { computeFeatureVector, FEATURE_KEYS } = require('../lib/research/features');
const BR = require('../lib/research/baseline-ranker');
const H = require('../lib/research/harness');
const L = require('../lib/evolve-labels');

// ── Canonical schemas ──────────────────────────────────────────────────────────
test('schema: prediction rejects a same-close fill (eligibleEntryTs must be after decisionTs)', () => {
  const bad = S.makePrediction({ securityId: 'X', decisionTs: '2023-01-03', horizon: 'swing', eligibleEntryTs: '2023-01-03' });
  assert.equal(S.validatePrediction(bad).valid, false);
  const good = S.makePrediction({ securityId: 'X', decisionTs: '2023-01-03', horizon: 'swing', eligibleEntryTs: '2023-01-04' });
  assert.equal(S.validatePrediction(good).valid, true);
});

test('schema: feature snapshot rejects look-ahead (dataCutoffTs after decisionTs)', () => {
  const bad = S.makeFeatureSnapshot({ securityId: 'X', decisionTs: '2023-01-03', dataCutoffTs: '2023-01-04', values: {} });
  assert.equal(S.validateFeatureSnapshot(bad).valid, false);
});

test('schema: a filled executable outcome must carry a labelEndTs and fillPrice', () => {
  const noEnd = S.makeExecutableOutcome({ predictionId: 'p1', fillStatus: 'filled', fillPrice: 10 });
  assert.equal(S.validateExecutableOutcome(noEnd).valid, false);
  const ok = S.makeExecutableOutcome({ predictionId: 'p1', fillStatus: 'filled', fillPrice: 10, labelEndTs: '2023-02-01' });
  assert.equal(S.validateExecutableOutcome(ok).valid, true);
});

test('schema: records are frozen (immutable) and validity defaults to not-production-grade', () => {
  const p = S.makePrediction({ securityId: 'X', decisionTs: '2023-01-03', horizon: 'swing' });
  assert.throws(() => { p.securityId = 'Y'; }, /Cannot assign|read only|object is not extensible/);
  const m = S.makeExperimentManifest({ experimentId: 'e', primaryMetric: 'ic', datasetHash: 'h' });
  assert.equal(m.researchValidity.productionGrade, false);
  assert.equal(m.researchValidity.survivorshipSafe, false);
});

// ── Exact label-end purge ─────────────────────────────────────────────────────
test('label-purge: keeps a label that closed before the embargoed test boundary, drops one that overlaps', () => {
  const axis = LP.buildDateAxis(['2023-01-02', '2023-01-03', '2023-01-04', '2023-01-05', '2023-01-06', '2023-01-09', '2023-01-10']);
  // test block opens at 2023-01-10 (ord 6); embargo 1 → need labelEnd ord <= 4 (2023-01-06).
  const closed = { labelEndDate: '2023-01-05' };
  const overlaps = { labelEndDate: '2023-01-09' };
  assert.equal(LP.exactPurgeKeep(closed, axis, '2023-01-10', 1), true);
  assert.equal(LP.exactPurgeKeep(overlaps, axis, '2023-01-10', 1), false);
});

test('label-purge: an event without a labelEndDate is dropped (never assumed closed)', () => {
  const axis = LP.buildDateAxis(['2023-01-02', '2023-01-03', '2023-01-04']);
  assert.equal(LP.exactPurgeKeep({ labelEndDate: null }, axis, '2023-01-04', 0), false);
});

test('label-purge: distance is measured in TRADING days, immune to weekend/holiday gaps', () => {
  // Friday 01-06 then Monday 01-09: only 1 trading day apart despite 3 calendar days.
  const axis = LP.buildDateAxis(['2023-01-06', '2023-01-09', '2023-01-10']);
  // labelEnd Friday, test opens Monday, embargo 0 → 1 trading day gap → kept.
  assert.equal(LP.exactPurgeKeep({ labelEndDate: '2023-01-06' }, axis, '2023-01-09', 0), true);
  // embargo 1 → needs 2 trading days → dropped.
  assert.equal(LP.exactPurgeKeep({ labelEndDate: '2023-01-06' }, axis, '2023-01-09', 1), false);
});

// ── Feature train/serve parity + point-in-time ────────────────────────────────
function synthCandles(n, seed) {
  let s = seed >>> 0 || 1; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const out = []; let c = 100;
  for (let i = 0; i < n; i++) { c = Math.max(1, c * (1 + (rnd() - 0.48) * 0.03)); const d = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10); out.push({ date: d, open: +(c * 0.995).toFixed(4), high: +(c * 1.02).toFixed(4), low: +(c * 0.98).toFixed(4), close: +c.toFixed(4), volume: Math.round(1e6 * (1 + rnd())) }); }
  return out;
}

test('features: identical inputs produce byte-identical vectors (deterministic, one implementation)', () => {
  const c = synthCandles(120, 7);
  const a = computeFeatureVector(c, 100, {});
  const b = computeFeatureVector(c, 100, {});
  assert.deepStrictEqual(a.values, b.values);
  assert.equal(a.version, b.version);
});

test('features: point-in-time — appending future bars does not change a past bar\'s vector (no look-ahead)', () => {
  const c = synthCandles(120, 9);
  const atShort = computeFeatureVector(c.slice(0, 101), 100, {});
  const atLong = computeFeatureVector(c, 100, {});          // same idx, more future bars available
  assert.deepStrictEqual(atShort.values, atLong.values);
});

test('features: missing history is reported in `missing`, never fabricated', () => {
  const c = synthCandles(10, 3);
  const v = computeFeatureVector(c, 5, {});                 // too little history for ret63 etc.
  assert.ok(v.missing.includes('ret63'));
  assert.equal(v.values.ret63, null);
});

// ── Date-grouped rankers ──────────────────────────────────────────────────────
test('ranker: residual-momentum orders by residMom21 and is deterministic', () => {
  const rows = [
    { securityId: 'A', features: { residMom21: 0.1 } },
    { securityId: 'B', features: { residMom21: -0.05 } },
  ];
  assert.ok(BR.residualMomentumRanker.score(null, rows[0]) > BR.residualMomentumRanker.score(null, rows[1]));
});

test('ranker: ridge fit is deterministic (identical weights across runs)', () => {
  let s = 5; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const rows = Array.from({ length: 60 }, (_, i) => {
    const rm = rnd() - 0.5;
    const vals = {}; for (const k of FEATURE_KEYS) vals[k] = rnd() - 0.5; vals.residMom21 = rm;
    return { securityId: 'S' + i, decisionTs: '2020-01-0' + (1 + (i % 5)), features: vals, outcome: rm * 0.5 + (rnd() - 0.5) * 0.1 };
  });
  const m1 = BR.ridgeRanker.fit(rows), m2 = BR.ridgeRanker.fit(rows);
  assert.deepStrictEqual(m1.w, m2.w);
  assert.equal(m1.b, m2.b);
});

// ── Harness: causal correctness, determinism, honest validity ─────────────────
function makeStudy(seed) {
  let s = seed >>> 0 || 1; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const dates = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2021, 0, 1 + i)).toISOString().slice(0, 10));
  const events = [];
  for (const d of dates) for (let n = 0; n < 8; n++) {
    const rm = rnd() - 0.5;
    events.push({ securityId: 'N' + n, decisionTs: d, labelEndDate: dates[Math.min(dates.length - 1, dates.indexOf(d) + 5)], horizon: 'swing', features: { residMom21: rm, ret21: rm }, outcome: rm * 0.4 + (rnd() - 0.5) * 0.2, score: rnd() });
  }
  return events;
}

test('harness: control-random scores ~0 IC while residual-momentum recovers the planted signal', () => {
  const events = makeStudy(11);
  const out = H.compareRankers(events, BR.ALL_RANKERS, { folds: 4, embargo: 1 });
  assert.ok(Math.abs(out.perRanker['control-random'].meanIC) < 0.06, 'control should be near zero');
  assert.ok(out.perRanker['residual-momentum'].meanIC > out.perRanker['control-random'].meanIC, 'momentum should beat control on planted data');
});

test('harness: runExperiment is deterministic and stamps survivorship-unsafe / PROVISIONAL', () => {
  const events = makeStudy(11);
  const a = H.runExperiment(events, BR.ALL_RANKERS, { folds: 4, embargo: 1 }, { experimentId: 'e', primaryMetric: 'ic', datasetHash: 'h', survivorshipSafe: false });
  const b = H.runExperiment(events, BR.ALL_RANKERS, { folds: 4, embargo: 1 }, { experimentId: 'e', primaryMetric: 'ic', datasetHash: 'h', survivorshipSafe: false });
  assert.deepStrictEqual(a.result.perRanker, b.result.perRanker);
  assert.equal(a.manifest.researchValidity.survivorshipSafe, false);
  assert.match(a.verdict, /PROVISIONAL/);
});

// ── Label engine: exact end date + honest profitable-timeout ──────────────────
test('evolve-labels: a time-exit records labelEndDate and a POSITIVE timeout is profitable but not "won"', () => {
  // A gently rising path that never reaches +15% nor -7% within the window → time exit, positive.
  const fwd = Array.from({ length: 25 }, (_, i) => ({ date: '2022-03-' + String(1 + i).padStart(2, '0'), high: 100 + i * 0.3 + 0.5, low: 100 + i * 0.3 - 0.5, close: 100 + i * 0.3 }));
  const r = L.tripleBarrier(fwd, 100, { up: 0.15, down: 0.07, window: 21 });
  assert.equal(r.barrier, 'time');
  assert.equal(r.won, false);              // did not touch the upper barrier first
  assert.equal(r.profitable, true);        // but the realized return is positive — NOT a loss
  assert.ok(r.terminalReturn > 0);
  assert.ok(typeof r.labelEndDate === 'string' && r.labelEndDate.length === 10);
});

// ── Tie-corrected AUC (Part XVIII #5 regression) ──────────────────────────────
test('backtest aucRank: tied predictions use averaged ranks (all-ties → 0.5)', () => {
  const { averageRanks } = require('../lib/rankquality');
  // All identical predictions: with tie correction every rank is the same → AUC exactly 0.5.
  const scored = [{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }, { p: 0.5, y: 1 }, { p: 0.5, y: 0 }];
  const ranks = averageRanks(scored.map(s => s.p));
  assert.ok(ranks.every(r => r === ranks[0]), 'all ties share one averaged rank');
  const np = scored.filter(s => s.y === 1).length, nn = scored.length - np;
  let rankSum = 0; scored.forEach((s, i) => { if (s.y === 1) rankSum += ranks[i]; });
  const auc = (rankSum - np * (np + 1) / 2) / (np * nn);
  assert.equal(auc, 0.5);
});
