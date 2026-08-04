'use strict';
// DAY TRADE LEARNING LOOP — the dataset→model connection, IPW weighting, capture priority,
// bucket upgrades, grading backlog/rotation, and scheduler-cadence health. These are the
// regression tests for the defects confirmed in docs/predictive-redesign-audit.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const DS = require('../lib/intraday-dataset');
const { gradeDatasetBacklog, RETENTION_DAYS } = require('../lib/intraday-backlog');
const { joinDay, evaluateDatasetSurvival, expectedUtility, severityScore, PRIMARY_BARRIER } = require('../lib/intraday-training');
const { trainLogistic, predictProba, rowWeight, WEIGHT_CAP } = require('../lib/survival-model');
const { brierScore, baseRate, precisionAtK, expectedCalibrationError } = require('../lib/survival-metrics');
const SR = require('../lib/daytrade-scan-runner');
const { DATASET_FEATURES, datasetRowFeatures, missingnessOf } = require('../lib/intraday-schema');
const { LABEL_VERSION } = require('../lib/intraday-labels');

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

const AT = '2026-07-29T14:00:00Z';   // Wednesday, 10:00 ET — regular session
const mkLabel = (outcome, netReturn = 0.01) => ({
  labelVersion: LABEL_VERSION, decisionAt: AT, decisionPrice: 100, atr: 2, costBps: 10,
  horizons: { h30: { mfe: 0.01, mae: -0.005, bars: 6 } },
  barriers: { [PRIMARY_BARRIER]: { outcome, timeToBarrierMin: 25, netReturn } },
  netReturn, timeToUpBarrierMin: outcome === 'SUCCESS' ? 25 : null,
  remainingMfe: 0.02, remainingMae: -0.01, remainingFractionOfDayMove: 0.5, forwardBars: 30,
});
const mkRow = (ticker, over = {}) => ({
  ticker, at: over.at || AT, bucket: 72, sessionBucket: 'open30',
  last: 100, prevClose: 98, atr: 2, dayPct: 2.0, excessPct: 1.5, relVol: 2.0,
  cusum: 3, z: 1.8, intervalRet: 0.5, avgDollarVol: 5e7, sector: 'XLK',
  quoteAsOf: AT, sampleProb: over.sampleProb ?? 1, atRisk: over.atRisk ?? true,
  datasetVersion: DS.DATASET_VERSION, ...over,
});

// ── Dataset → learner connection ────────────────────────────────────────────────

test('full-universe dataset grades feed the learner — including REJECTED and sampled ordinary candidates', () => {
  // Arrange: an at-risk row the system rejected, plus a sampled ordinary negative.
  const rows = [
    mkRow('REJD', { atRisk: true, sampleProb: 1 }),                       // rejected by Stage-2, still captured
    mkRow('ORDN', { atRisk: false, sampleProb: 0.06, cusum: 0.2, z: 0.1, dayPct: 0.3, relVol: 0.9 }),
  ];
  const grades = {
    [`REJD|${AT}`]: { ticker: 'REJD', at: AT, sampleProb: 1, label: mkLabel('SUCCESS') },
    [`ORDN|${AT}`]: { ticker: 'ORDN', at: AT, sampleProb: 0.06, label: mkLabel('TIMEOUT', 0.001) },
  };

  // Act
  const { rows: joined, skipped } = joinDay({ date: '2026-07-29', rows, grades });

  // Assert: both appear in training rows — no first-entry / actionable-only filtering.
  assert.equal(joined.length, 2);
  const ordn = joined.find(r => r.ticker === 'ORDN');
  assert.equal(ordn.weight, Math.min(1 / 0.06, WEIGHT_CAP), 'ordinary negative carries its 1/sampleProb weight');
  assert.equal(joined.find(r => r.ticker === 'REJD').labelTarget, 1);
  assert.equal(skipped.ungraded, 0);
});

test('version-incompatible rows and labels fail closed — counted, never trained on', () => {
  const rows = [mkRow('OLD', { datasetVersion: 'intraday-dataset-v0' }), mkRow('OK')];
  const grades = {
    [`OLD|${AT}`]: { ticker: 'OLD', at: AT, label: mkLabel('SUCCESS') },
    [`OK|${AT}`]: { ticker: 'OK', at: AT, label: { ...mkLabel('SUCCESS'), labelVersion: 'intraday-labels-v0' } },
  };
  const { rows: joined, skipped } = joinDay({ date: '2026-07-29', rows, grades });
  assert.equal(joined.length, 0);
  assert.equal(skipped.incompatibleRow, 1);
  assert.equal(skipped.incompatibleLabel, 1);
});

test('duplicate ticker|at identities dedup while distinct 5-minute decision states survive', () => {
  const at2 = '2026-07-29T14:05:00Z';
  const rows = [mkRow('AAA'), mkRow('AAA'), mkRow('AAA', { at: at2 })];
  const grades = {
    [`AAA|${AT}`]: { ticker: 'AAA', at: AT, label: mkLabel('SUCCESS') },
    [`AAA|${at2}`]: { ticker: 'AAA', at: at2, label: mkLabel('FAILURE', -0.01) },
  };
  const { rows: joined, skipped } = joinDay({ date: '2026-07-29', rows, grades });
  assert.equal(joined.length, 2, 'two decision states, one duplicate dropped');
  assert.equal(skipped.duplicate, 1);
});

test('missing features remain missing (null) with explicit missingness indicators — never zeroed', () => {
  const feats = datasetRowFeatures(mkRow('X', { relVol: null, avgDollarVol: null }));
  assert.equal(feats.relVol, null);
  assert.equal(feats.logDollarVol, null);
  const miss = missingnessOf(feats, ['relVol', 'logDollarVol', 'cusum']);
  assert.deepEqual(miss, { relVol: true, logDollarVol: true, cusum: false });
  // Deep-tier features on a broad row are own-property nulls, not absent keys.
  const { rows: joined } = joinDay({
    date: '2026-07-29', rows: [mkRow('X')],
    grades: { [`X|${AT}`]: { ticker: 'X', at: AT, label: mkLabel('SUCCESS') } },
  });
  for (const k of DATASET_FEATURES) assert.ok(k in joined[0].features, `feature ${k} present as own property`);
  assert.equal(joined[0].features.mom15, null, 'deep feature null without a Stage-2 join');
  assert.equal(joined[0].featureTier, 'broad');
});

test('deep Stage-2 features join only within the decision-time tolerance', () => {
  const grades = { [`X|${AT}`]: { ticker: 'X', at: AT, label: mkLabel('SUCCESS') } };
  const near = [{ ticker: 'X', decisionAt: '2026-07-29T14:03:00Z', features: { mom15: 0.02, residualVsSpy: 1.2 } }];
  const far = [{ ticker: 'X', decisionAt: '2026-07-29T15:00:00Z', features: { mom15: 0.02 } }];
  const a = joinDay({ date: '2026-07-29', rows: [mkRow('X')], grades, deepRecords: near }).rows[0];
  const b = joinDay({ date: '2026-07-29', rows: [mkRow('X')], grades, deepRecords: far }).rows[0];
  assert.equal(a.featureTier, 'deep');
  assert.equal(a.features.mom15, 0.02);
  assert.equal(a.features.residual15, 0.012, 'legacy percent residual aliased to fraction');
  assert.equal(b.featureTier, 'broad', 'an hour-away evaluation is NOT this decision state');
});

// ── Inverse-probability weighting ───────────────────────────────────────────────

test('sampleProb changes weights and weighted metrics exactly as 1/p (capped)', () => {
  assert.equal(rowWeight({ weight: 1 / 0.06 }), 1 / 0.06);
  assert.equal(rowWeight({ weight: 1000 }), WEIGHT_CAP, 'weights cap for variance control');
  assert.equal(rowWeight({}), 1);

  // Weighted base rate: one positive at weight 1, one negative at weight 3 → 0.25.
  assert.equal(baseRate([1, 0], [1, 3]), 0.25);
  assert.equal(baseRate([1, 0]), 0.5, 'unweighted stays the sampled-row rate');

  // Weighted Brier: perfect on the heavy row pulls the score toward it.
  const w = brierScore([0.9, 0.1], [1, 0], [9, 1]);
  const u = brierScore([0.9, 0.1], [1, 0]);
  assert.equal(u, +(((0.1 ** 2) + (0.1 ** 2)) / 2).toFixed(5));
  assert.equal(w, u, 'symmetric errors: same value, different weighting path');
  assert.notEqual(brierScore([0.9, 0.5], [1, 0], [1, 9]), brierScore([0.9, 0.5], [1, 0]), 'asymmetric errors: weights move the estimate');

  // Weighted precision@k: ranking never reorders, but the estimate weights the top-k rows.
  const scored = [
    { score: 3, label: 1, weight: 1, id: 'a' },
    { score: 2, label: 0, weight: 9, id: 'b' },
    { score: 1, label: 1, weight: 1, id: 'c' },
  ];
  assert.equal(precisionAtK(scored, 2), 0.5);
  assert.equal(precisionAtK(scored, 2, { weighted: true }), 0.1);
});

test('weighted training changes the fitted model vs unweighted on the same rows', () => {
  // Arrange: 80 rows where the ordinary (up-weighted) negatives contradict feature x.
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ features: { x: 1 + (i % 3) * 0.01 }, label: 1, weight: 1 });
  for (let i = 0; i < 40; i++) rows.push({ features: { x: 0.5 + (i % 5) * 0.01 }, label: 0, weight: i < 20 ? 16 : 1 });
  const un = trainLogistic(rows, ['x'], r => r.label, {});
  const wt = trainLogistic(rows, ['x'], r => r.label, { weighted: true });
  assert.ok(un && wt);
  assert.ok(wt.weighted && wt.sumWeight > un.n, 'weighted fit sees the reconstructed universe mass');
  assert.notEqual(un.intercept, wt.intercept, 'weights must actually alter the fit');
  assert.ok(predictProba(wt, { x: 0.5 }) < predictProba(un, { x: 0.5 }), 'up-weighted negatives push P down where they live');
});

// ── Two-stage utility ───────────────────────────────────────────────────────────

test('expectedUtility combines pTarget/pStop/pNeither with reward, risk and costs', () => {
  const u = expectedUtility({ pTarget: 0.4, pStop: 0.3, atrFrac: 0.02, timeoutNet: 0.001, costFrac: 0.001 });
  const expected = 0.4 * 0.02 - 0.3 * 0.01 + 0.3 * 0.001 - 0.001;
  assert.ok(Math.abs(u - expected) < 1e-12);
  assert.equal(expectedUtility({ pTarget: null, pStop: 0.3, atrFrac: 0.02 }), null, 'missing inputs → no utility, never a guess');
});

test('evaluateDatasetSurvival fails closed on thin data and never promotes from it', () => {
  const out = evaluateDatasetSurvival([]);
  assert.equal(out.status, 'insufficient-data');
  assert.equal(out.promotion.promote, false);
});

test('evaluateDatasetSurvival trains out-of-fold from dataset rows and reports weighted+unweighted', () => {
  // Arrange: 60 dates × 8 rows with a real (noisy) signal in cusum.
  const rows = [];
  for (let d = 0; d < 60; d++) {
    const date = `2026-04-${String((d % 28) + 1).padStart(2, '0')}`.replace('2026-04', d < 28 ? '2026-04' : '2026-05');
    for (let i = 0; i < 8; i++) {
      const strong = i < 3;
      const noise = ((d * 8 + i) % 7) / 7;
      const win = strong ? noise < 0.6 : noise < 0.25;
      const stop = !win && noise > 0.7;
      rows.push({
        id: `T${i}|${date}`, date, ticker: `T${i}`, at: `${date}T14:00:00Z`,
        atRisk: strong, sampleProb: strong ? 1 : 0.06, weight: strong ? 1 : Math.min(1 / 0.06, WEIGHT_CAP),
        features: { ...datasetRowFeatures(mkRow(`T${i}`, { cusum: strong ? 4 + noise : 0.5, relVol: strong ? 2.5 : 1 })) },
        featureTier: 'broad',
        outcome: win ? 'SUCCESS' : stop ? 'FAILURE' : 'TIMEOUT',
        labelTarget: win ? 1 : 0, labelStop: stop ? 1 : 0,
        netReturn: win ? 0.018 : stop ? -0.011 : 0.0005,
        timeToBarrierMin: 30, atrFrac: 0.02, costFrac: 0.001,
        horizons: null, remainingMfe: null, remainingFractionOfDayMove: null, captureSource: 'dataset',
      });
    }
  }
  const out = evaluateDatasetSurvival(rows, { features: ['cusum', 'relVol', 'dayPct'] });
  assert.equal(out.status, 'evaluated');
  assert.ok(out.folds >= 1);
  assert.ok(out.metrics.weighted.brier != null && out.metrics.unweighted.brier != null, 'both metric families reported');
  assert.ok(out.metrics.weighted.baseRate < out.metrics.unweighted.baseRate, 'IPW pulls the base rate toward the (mostly negative) full universe');
  assert.ok(Number.isFinite(out.metrics.weighted.utilityTopKNet));
  assert.equal(typeof out.promotion.promote, 'boolean');
});

// ── Capture priority + bucket upgrade ───────────────────────────────────────────

test('24. the storage cap never silently violates the recorded sampling probability (v2 contract)', () => {
  // Arrange: 450 at-risk rows — the cap binds on the at-risk class itself.
  const universe = [];
  for (let i = 0; i < 450; i++) universe.push(mkRow(`T${String(i).padStart(3, '0')}`, { cusum: 1.0 + i * 0.02, z: null, dayPct: null, relVol: null }));
  const built = DS.buildScanRows(universe, { date: '2026-07-29', at: AT });

  // The cap is honored as a RATE, not a slice: the at-risk class is hash-thinned at
  // cap/atRiskN and every kept row's sampleProb RECORDS that rate (no row claims prob 1
  // while others in its class were dropped — the IPW-bias defect this closes).
  const expectedRate = DS.MAX_ROWS_PER_SCAN / 450;
  assert.ok(built.rows.length <= DS.MAX_ROWS_PER_SCAN, 'cap respected');
  assert.ok(built.rows.length >= 0.85 * DS.MAX_ROWS_PER_SCAN, `thinned to ≈ the cap (${built.rows.length})`);
  for (const r of built.rows) {
    assert.equal(r.sampleProb, +expectedRate.toFixed(5), `${r.ticker}: recorded prob = true inclusion rate`);
    assert.equal(r.capThinned, true);
  }
  // The bucket doc carries the full cap contract: pre-cap, post-cap, threshold, rates.
  assert.equal(built.capContract.preCapRows, 450);
  assert.equal(built.capContract.postCapRows, built.rows.length);
  assert.equal(built.capContract.capThreshold, DS.MAX_ROWS_PER_SCAN);
  assert.equal(built.capContract.atRiskStageRate, +expectedRate.toFixed(5));
  assert.equal(built.droppedByReason.atRisk, 450 - built.rows.length);

  // Determinism: reversed input produces the IDENTICAL kept set (hash of date|bucket|ticker,
  // never input order).
  const rebuilt = DS.buildScanRows([...universe].reverse(), { date: '2026-07-29', at: AT });
  assert.deepEqual(new Set(rebuilt.rows.map(r => r.ticker)), new Set(built.rows.map(r => r.ticker)));

  // When everything fits, at-risk rows keep sampleProb 1 exactly (no phantom thinning).
  const small = DS.buildScanRows(universe.slice(0, 50), { date: '2026-07-29', at: AT });
  assert.ok(small.rows.every(r => r.sampleProb === 1 && !r.capThinned));
  assert.equal(small.capContract.atRiskStageRate, 1);
});

test('a bucket upgrades only for a demonstrably more complete capture, preserving audit history', async () => {
  const store = memStore();
  const thin = DS.buildScanRows([mkRow('AAA'), mkRow('BBB')], { date: '2026-07-29', at: AT });
  const rich = DS.buildScanRows(['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map(t => mkRow(t)), { date: '2026-07-29', at: AT });

  const first = await DS.appendScanRows('2026-07-29', thin, { store });
  assert.equal(first.persisted, true);
  const again = await DS.appendScanRows('2026-07-29', thin, { store });
  assert.equal(again.persisted, false, 'same-completeness recapture stays write-once');
  assert.equal(again.reason, 'bucket-already-captured');

  const upgraded = await DS.appendScanRows('2026-07-29', rich, { store });
  assert.equal(upgraded.persisted, true);
  assert.equal(upgraded.upgraded, true);
  const doc = store.docs[`lifecycle/daytrade/dataset/2026-07-29/b${thin.bucket}.json`];
  assert.equal(doc.rows.length, 5);
  assert.equal(doc.superseded.length, 1, 'audit history preserved');
  assert.equal(doc.superseded[0].rows, 2);

  const downgrade = await DS.appendScanRows('2026-07-29', thin, { store });
  assert.equal(downgrade.persisted, false, 'a thinner capture can never clobber a richer one');
});

// ── Grading: rotation, honest accounting, backlog ───────────────────────────────

test('a repeatedly failing ticker rotates back and never blocks later tickers; ungradeable rows stay visible', async () => {
  const date = '2026-07-29';
  const rows = [
    mkRow('AAAA'), mkRow('BBBB'), mkRow('CCCC'),
    mkRow('ZERO', { last: 0 }),           // ungradeable forever — must be REPORTED, not hidden
  ];
  const built = { bucket: 72, rows, dropped: 0, droppedByReason: null };
  const store = memStore();
  await DS.appendScanRows(date, built, { store });

  // Yahoo chart-result shape (what sessionsFromResult consumes).
  const barTimes = ['2026-07-29T14:05:00Z', '2026-07-29T14:35:00Z'];
  const mkResult = () => ({
    timestamp: barTimes.map(t => Date.parse(t) / 1000),
    indicators: { quote: [{
      open: [100, 102], high: [103, 104], low: [99.5, 101], close: [102, 103], volume: [5000, 5000],
    }] },
  });
  // AAAA always fails to fetch; others succeed.
  const fetcher = async t => { if (t === 'AAAA') throw new Error('feed down'); return mkResult(); };

  // sessionsFromResult shapes bars by ET date — emulate its contract via a stub result.
  const { sessionsFromResult } = require('../lib/intraday-features');
  const shaped = sessionsFromResult(mkResult());
  assert.ok(shaped[date] && shaped[date].length, 'stub bars land on the expected ET date');

  // Pass 1 with limit 2: AAAA fails, BBBB grades; AAAA acquires a fail count.
  const p1 = await DS.gradeDatasetDay(date, { limit: 2, fetchFiveMin: fetcher, store });
  assert.equal(p1.failedFetch, 1);
  assert.ok(p1.graded >= 1);
  // Pass 2 with limit 2: AAAA has rotated BEHIND the fresh ticker — CCCC grades now.
  const p2 = await DS.gradeDatasetDay(date, { limit: 2, fetchFiveMin: fetcher, store });
  const grades = store.docs[`lifecycle/daytrade/dataset/${date}/grades.json`];
  assert.ok(grades.grades[`CCCC|${AT}`], 'later ticker graded despite the persistent failure');
  assert.equal(p2.ungradeable, 1, 'zero-price row visibly ungradeable, not silently complete');
  assert.ok(grades.fetchFails.AAAA >= 1, 'failure count persisted for rotation');

  // Exhaust attempts: AAAA becomes terminal and leaves `remaining`, visibly.
  let last;
  for (let i = 0; i < DS.MAX_FETCH_ATTEMPTS; i++) last = await DS.gradeDatasetDay(date, { limit: 2, fetchFiveMin: fetcher, store });
  assert.equal(last.remaining, 0);
  assert.equal(last.terminalTickers, 1, 'terminally unavailable ticker reported, not forgotten');
});

test('the grading backlog retries prior incomplete dates oldest-first and expires past retention', async () => {
  const now = new Date('2026-07-29T23:30:00Z');
  const store = memStore({
    'lifecycle/daytrade/dataset/backlog.json': {
      dates: {
        '2026-07-27': { status: 'pending', attempts: 1, remaining: 30 },
        '2026-07-20': { status: 'pending', attempts: 3, remaining: 12 },   // 9 days old — beyond bar retention
        '2026-07-28': { status: 'complete', attempts: 2, remaining: 0 },
      },
    },
  });
  const gradedDates = [];
  const gradeDay = async d => { gradedDates.push(d); return { ok: true, date: d, graded: 5, remaining: d === '2026-07-27' ? 0 : 4, ungradeable: 0, terminalTickers: 0, gradedTotal: 5 }; };
  const listDates = async () => ['2026-07-20', '2026-07-27', '2026-07-28', '2026-07-29'];

  const out = await gradeDatasetBacklog({ limit: 40, maxDates: 2, now, gradeDay, listDates, store });

  assert.ok(out.ok);
  assert.deepEqual(gradedDates, ['2026-07-27', '2026-07-29'], 'oldest pending first; expired date skipped; today picked up');
  const doc = store.docs['lifecycle/daytrade/dataset/backlog.json'];
  assert.equal(doc.dates['2026-07-27'].status, 'complete', 'prior date retried to remaining=0');
  assert.equal(doc.dates['2026-07-20'].status, 'expired', `past ${RETENTION_DAYS}-day bar retention → terminal, not retried forever`);
  assert.equal(doc.dates['2026-07-29'].status, 'pending', 'incomplete today stays pending for the next pass');
  assert.equal(doc.dates['2026-07-28'].status, 'complete', 'completed dates untouched');
});

// ── Scheduler cadence + health honesty ──────────────────────────────────────────

test('the five-minute scheduler does not register four false misses per healthy tick', async () => {
  const now = new Date('2026-07-29T18:00:00Z');   // Wed 14:00 ET — regular session
  const store = memStore({
    [SR.HEALTH_KEY]: { lastRunAt: '2026-07-29T17:55:00Z', lastSuccessAt: '2026-07-29T17:55:00Z', consecutiveErrors: 0, missedScanEstimate: 0, missedScanDate: '2026-07-29' },
  });
  const out = await SR.runScanCycle({ now, scan: async () => ({ ok: true, session: 'regular', anomalies: [], scanned: 100 }), store });
  assert.equal(out.ok, true);
  assert.equal(out.missedThisGap, 0, 'a healthy 5-minute tick is ZERO misses under the 5-minute target');
  assert.equal(out.health.missedScanEstimate, 0);
  assert.equal(out.health.targetIntervalMs, SR.DEFAULT_TARGET_INTERVAL_MS);
});

test('a genuine mid-session outage still counts, and the estimate resets each ET date', async () => {
  const now = new Date('2026-07-29T18:00:00Z');   // Wed 14:00 ET
  const store = memStore({
    [SR.HEALTH_KEY]: { lastSuccessAt: '2026-07-29T17:29:00Z', consecutiveErrors: 0, missedScanEstimate: 500, missedScanDate: '2026-07-28' },
  });
  const out = await SR.runScanCycle({ now, scan: async () => ({ ok: true, session: 'regular', anomalies: [], scanned: 100 }), store });
  assert.ok(out.missedThisGap >= 4 && out.missedThisGap <= 6, `31 in-session minutes ≈ 5 missed 5-min slots (got ${out.missedThisGap})`);
  assert.equal(out.health.missedScanEstimate, out.missedThisGap, 'yesterday\'s 500 does not leak into today');
});

test('nights and weekends contribute zero scannable time — no fabricated overnight misses', () => {
  // Friday 16:30 ET → Monday 04:00 ET (2026-07-24 was a Friday): after-hours + weekend.
  const friClose = Date.parse('2026-07-24T20:30:00Z');   // 16:30 ET EDT — after the close
  const monPre = Date.parse('2026-07-27T08:00:00Z');     // 04:00 ET Monday — session edge
  assert.equal(SR.scannableMsBetween(friClose, monPre), 0);
  // In-session minutes DO count.
  const t0 = Date.parse('2026-07-29T17:00:00Z'), t1 = Date.parse('2026-07-29T17:30:00Z');
  assert.equal(SR.scannableMsBetween(t0, t1), 30 * 60 * 1000);
});

test('stale in-session health is reported as degraded, never as a healthy no-op', () => {
  const inSession = new Date('2026-07-29T18:00:00Z');
  const stale = SR.healthStatus({ lastSuccessAt: '2026-07-29T16:00:00Z', targetIntervalMs: SR.DEFAULT_TARGET_INTERVAL_MS }, inSession);
  assert.equal(stale.status, 'stale');
  assert.ok(stale.stale && /CRON_SECRET/.test(stale.reason), 'reason names the silent 401/503 failure mode');
  const fresh = SR.healthStatus({ lastSuccessAt: '2026-07-29T17:57:00Z', targetIntervalMs: SR.DEFAULT_TARGET_INTERVAL_MS }, inSession);
  assert.equal(fresh.stale, false);
  const never = SR.healthStatus(null, inSession);
  assert.equal(never.status, 'never-succeeded');
  assert.ok(never.stale);
  // Off-session, an aged lastSuccess is NOT stale — nothing was supposed to run.
  const weekend = SR.healthStatus({ lastSuccessAt: '2026-07-24T19:00:00Z', targetIntervalMs: SR.DEFAULT_TARGET_INTERVAL_MS }, new Date('2026-07-26T18:00:00Z'));
  assert.equal(weekend.stale, false);
});

test('severityScore ranks a strong anomaly above a weak one for the deterministic baseline', () => {
  const strong = severityScore({ cusum: 6, zShock: 3, dayPct: 4, relVol: 3 });
  const weak = severityScore({ cusum: 1, zShock: null, dayPct: 0.5, relVol: 1 });
  assert.ok(strong > weak);
});
