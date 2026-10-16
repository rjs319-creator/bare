'use strict';
// Review Prompt 6 (lib/evolve, lib/evolve-routes): the prospective snapshot is frozen with its
// raw AND published probability, side and versions; the calibrator learns from the RAW
// probability only; shorts are not scored with long labels; duplicated specialist support
// cannot pass the sample gate; resolves and day logs are idempotent / write-once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/evolve-routes');
const E = require('../lib/evolve');
const L = require('../lib/evolve-labels');

const CTX = 'neutral|large|swing';
function sharedEvents(n, { side = 'long', raw = 0.5, pub = 0.5, contextKey = CTX } = {}) {
  const rows = {};
  for (let i = 0; i < n; i++) {
    const d = `2026-${String(i + 1).padStart(2, '0')}-05`;
    rows[`${d}|T${i}|swing`] = { ticker: `T${i}`, predDate: d, horizon: 'swing', side, contextKey,
      specialists: ['momentumIgnition', 'quietAccumulation'],
      contribs: [{ specialist: 'momentumIgnition', p: 0.4 }, { specialist: 'quietAccumulation', p: 0.4 }],
      probability: pub, rawProbability: raw, won: i % 2 === 0, terminalReturn: i % 2 ? -0.07 : 0.15, spyRelReturn: i % 2 ? -0.05 : 0.1 };
  }
  return rows;
}

// ── D1: the logged snapshot carries raw + published P, side and versions ────────────────
test('buildLoggedPredictions freezes side, rawProbability, calibrationStatus and the versions', () => {
  const payload = { byHorizon: { fast: [], swing: [{ ticker: 'AAA', side: 'short', entry: 50, price: 50, barriers: { up: 0.15, down: 0.07, window: 21 },
    specialists: ['momentumIgnition'], contribs: [{ specialist: 'momentumIgnition', p: 0.44 }], probability: 0.52, rawProbability: 0.44,
    calibrationStatus: 'calibrated', decision: 'WATCH', contextKey: CTX, sector: 'Technology', cap: 'large', strengthPercentile: 80 }], position: [], micro: [] } };
  const [p] = R.buildLoggedPredictions(payload, { date: '2026-09-01', model: { activeId: 'evolve-2026-08-01' } });
  assert.equal(p.id, '2026-09-01|AAA|swing');
  assert.equal(p.side, 'short');
  assert.equal(p.probability, 0.52);
  assert.equal(p.rawProbability, 0.44);
  assert.equal(p.calibrationStatus, 'calibrated');
  assert.equal(p.modelId, 'evolve-2026-08-01');
  assert.equal(p.labelsVersion, L.LABELS_VERSION);
  assert.equal(p.evolveVersion, E.EVOLVE_VERSION);
});

// ── D3b: the day document is write-once ─────────────────────────────────────────────────
test('a second log on the same date cannot change the first snapshot (write-once day doc)', async () => {
  const writes = [];
  const store = { EVOLVE_PREFIX: 'evolve/', hasStore: () => true,
    blobExists: async (path) => writes.some(w => w.path === path),
    writeEvolveDay: async (date, doc) => { writes.push({ path: `evolve/${date}.json`, doc }); } };
  const first = await R.logEvolveDay('2026-09-01', { predictions: [{ id: 'a' }] }, store);
  assert.deepEqual(first, { logged: 1, alreadyLogged: false, logError: null });
  const second = await R.logEvolveDay('2026-09-01', { predictions: [{ id: 'b' }, { id: 'c' }] }, store);
  assert.equal(second.logged, 0);
  assert.equal(second.alreadyLogged, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].doc.predictions, [{ id: 'a' }], 'the first snapshot is untouched');
});

test('an existence probe that THROWS fails closed: no write, error surfaced', async () => {
  let wrote = 0;
  const store = { EVOLVE_PREFIX: 'evolve/', hasStore: () => true, blobExists: async () => { throw new Error('blob list 503'); }, writeEvolveDay: async () => { wrote++; } };
  const out = await R.logEvolveDay('2026-09-01', { predictions: [{ id: 'a' }] }, store);
  assert.equal(out.logged, 0);
  assert.match(out.logError, /503/);
  assert.equal(wrote, 0);
});

// ── C4: shorts are not resolved with long barrier logic ─────────────────────────────────
test('a short prediction resolves as EXCLUDED with its reason, never as a long label', () => {
  const p = { id: '2026-01-05|SHRT|fast', ticker: 'SHRT', predDate: '2026-01-05', evolveHorizon: 'fast', side: 'short', entry: 100,
    barriers: { up: 0.08, down: 0.04, window: 5 }, specialists: ['momentumIgnition'], contribs: [{ specialist: 'momentumIgnition', p: 0.4 }], probability: 0.4, rawProbability: 0.4, contextKey: CTX };
  const row = R.resolvePrediction(p, { core: { resolved: true, won: false, barrier: 'lower' }, spy: { ret: 0, reason: null }, sector: { ret: null, reason: 'benchmark-unavailable' }, today: '2026-02-01' });
  assert.equal(row.excluded, true);
  assert.equal(row.reason, 'short-side-label-unsupported');
  assert.equal(row.side, 'short');
  assert.equal(row.won, undefined, 'no long-logic win/loss on a short');
  assert.equal(row.labelsVersion, L.LABELS_VERSION);
  // and a legacy row without `side` is treated as long (counted as such)
  const legacy = R.resolvePrediction({ ...p, side: undefined }, { core: { resolved: true, won: true, barrier: 'upper', label: 1, terminalReturn: 0.08, mfe: 0.09, mae: 0, barsToBarrier: 1, labelEndDate: '2026-01-06', gapThrough: false }, spy: { ret: 0, reason: null, startDate: '2026-01-06', endDate: '2026-01-06' }, sector: { ret: null, reason: 'benchmark-unavailable' }, today: '2026-02-01' });
  assert.equal(legacy.excluded, undefined);
  assert.equal(legacy.side, 'long');
  assert.equal(legacy.sideAssumed, true);
  assert.equal(legacy.spyRelReturn, 0.08);
});

test('recomputePerf and the calibrator skip excluded (short) rows', () => {
  const rows = sharedEvents(6);
  rows['x|SHRT|swing'] = { ticker: 'SHRT', predDate: '2026-07-05', horizon: 'swing', side: 'short', contextKey: CTX, specialists: ['momentumIgnition'],
    contribs: [{ specialist: 'momentumIgnition', p: 0.4 }], probability: 0.4, rawProbability: 0.4, excluded: true, reason: 'short-side-label-unsupported' };
  const perf = R.recomputePerf(rows, { weighted: false });
  assert.equal(perf.bySpecialist.momentumIgnition.global.n, 6);
  assert.equal(perf.n, 6);
  assert.equal(perf.excluded.short, 1);
  const cal = R.calibratorInput(rows);
  assert.equal(cal.rows.length, 6);
  assert.equal(cal.excludedShort, 1);
});

// ── D2: calibrate on rawProbability only ───────────────────────────────────────────────
test('raw .5 / published 1 trains on .5; rows without a raw P are excluded and counted', () => {
  const rows = sharedEvents(40, { raw: 0.5, pub: 1 });
  for (let i = 0; i < 10; i++) rows[`legacy${i}`] = { ticker: `L${i}`, predDate: '2026-03-0' + ((i % 9) + 1), horizon: 'swing', contextKey: CTX,
    specialists: ['momentumIgnition'], contribs: [{ specialist: 'momentumIgnition', p: 0.9 }], probability: 0.9, won: true, terminalReturn: 0.15 };
  const input = R.calibratorInput(rows);
  assert.equal(input.rows.length, 40);
  assert.ok(input.rows.every(r => r.p === 0.5), 'the fit sees the RAW probability, never the published one');
  assert.equal(input.excludedNoRaw, 10);
  assert.equal(input.excludedReason, 'legacy-no-raw-probability');
  const cal = R.fitEvolveCalibrator(rows, { today: '2026-09-30' });
  assert.ok(cal, 'enough rows to fit');
  assert.equal(cal.n, 40);
  assert.equal(cal.fitCutoff, '2026-09-30');
  assert.equal(cal.excludedNoRaw, 10);
  assert.equal(cal.basis, 'rawProbability');
  // The 0.4–0.6 bin learned the realised 50% hit rate; the top bin was never fed the published 1.0
  assert.equal(cal.table[2], 0.5);
});

// ── D3: repeated resolve bookkeeping is idempotent ──────────────────────────────────────
test('recomputePerf on the same resolved map twice is deep-equal (idempotent)', () => {
  const rows = sharedEvents(12);
  const a = R.recomputePerf(rows), b = R.recomputePerf(rows);
  delete a.updatedAt; delete b.updatedAt;
  assert.deepEqual(a, b);
});

// ── D4: duplicated specialist support cannot pass the sample gate ───────────────────────
test('two specialists sharing six events cannot become twelve: effN is capped by distinct events', () => {
  const perf = R.recomputePerf(sharedEvents(6), { weighted: false });
  assert.equal(perf.events.global, 6);
  assert.equal(perf.events.byContext[CTX], 6);
  const contribs = ['momentumIgnition', 'quietAccumulation'].map(sp => ({ specialist: sp, ...E.specialistProb(perf.bySpecialist[sp], CTX) }));
  const w = E.metaWeights(contribs.map(c => c.specialist), { perfById: perf.bySpecialist });
  const uncapped = E.ensembleProbability(contribs, w, { redundancyModel: perf.redundancy });
  assert.equal(uncapped.effN, 15, 'the raw sum double-counts the same six events (pinned legacy behaviour without counts)');
  const capped = E.ensembleProbability(contribs, w, { redundancyModel: perf.redundancy, eventCounts: perf.events, contextKey: CTX });
  assert.equal(capped.effN, 7.5);               // 6 context events + 0.25 × 6 global events
  assert.equal(capped.effNCap, 7.5);
  assert.ok(capped.effN < E.GUARDRAILS.minEffSample, 'below the TRADE gate of 12');
});

test('scoreCandidate + buildEvolvePayload thread the event counts so a duplicated pair cannot reach the TRADE gate', () => {
  // the candidate's own context key (regime × cap bucket × horizon) must be the one the events carry
  const key = E.contextKey({ regimeLabel: 'neutral', cap: E.capBucket(5e8), horizon: 'swing' });
  const perf = R.recomputePerf(sharedEvents(6, { contextKey: key }), { weighted: false });
  const sig = { ticker: 'NEW', source: 'screener', sources: ['screener', 'ghost'], horizon: 'swing', evolveHorizon: 'swing', side: 'long', price: 50, liquidity: { dollarVol: 5e8 }, execution: { quality: 1 } };
  const ctx = { regime: { riskOn: true, label: 'neutral' }, perfBySpecialist: perf.bySpecialist, barriersByHorizon: R.BARRIERS };
  const before = E.scoreCandidate(sig, ctx);
  assert.equal(before.specialists.length, 2);
  assert.equal(before.effSampleRaw, 15);
  const after = E.scoreCandidate(sig, { ...ctx, eventCounts: perf.events });
  assert.equal(after.effSample, 7.5);
  assert.equal(after.effSampleRaw, 15);
  assert.equal(after.effSampleCap, 7.5);
  assert.notEqual(after.decision, 'TRADE_CANDIDATE');
  // the route-level payload builder passes perf.events through
  const payload = R.buildEvolvePayload([sig], { regime: { riskOn: true, label: 'neutral' }, perf, model: null });
  assert.equal(payload.counts.trade, 0);
  assert.equal(payload.sampleBasis, 'effective sample capped by distinct resolved events (uniqueness-weighted) per context');
});
