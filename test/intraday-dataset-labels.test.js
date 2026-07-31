'use strict';
// PIT DATASET + SAME-DAY LABELS + RUNNER CAPTURE — leakage, sampling and taxonomy tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeLabels, LABEL_VERSION } = require('../lib/intraday-labels');
const { buildScanRows, sampleDecision, isAtRisk, NEG_RATE, bucketOf, fnv1a } = require('../lib/intraday-dataset');
const { buildCaptureReport, isRunner, RUNNER_DEFS, MISS } = require('../lib/runner-capture');

const DECISION_AT = '2026-07-08T14:00:00Z';

const bar = (iso, o, h, l, c) => ({ t: iso, o, h, l, c, v: 10000 });

// ── 11. Labels use bars STRICTLY AFTER the decision timestamp ────────────────
test('11. a monster bar AT or BEFORE the decision instant never leaks into the label', () => {
  const sessionBars = [
    bar('2026-07-08T13:55:00Z', 100, 999, 99, 100),    // pre-decision spike — must be invisible
    bar(DECISION_AT, 100, 500, 99, 100),               // the decision bar itself — excluded
    bar('2026-07-08T14:05:00Z', 100, 101, 99.8, 100.5),
    bar('2026-07-08T14:10:00Z', 100.5, 101.5, 100.2, 101),
  ];
  const l = computeLabels({ decisionPrice: 100, decisionAt: DECISION_AT, atr: 2, sessionBars });
  assert.equal(l.labelVersion, LABEL_VERSION);
  assert.equal(l.forwardBars, 2, 'only strictly-after bars count');
  assert.ok(l.horizons.h30.mfe <= 0.02, `MFE from forward bars only (${l.horizons.h30.mfe}), not the 999 spike`);
});

test('11b. no forward evidence → null labels (never invented)', () => {
  const only = [bar(DECISION_AT, 100, 101, 99, 100)];
  assert.equal(computeLabels({ decisionPrice: 100, decisionAt: DECISION_AT, atr: 2, sessionBars: only }), null);
});

// ── 14. Same-bar barrier collisions resolve conservatively ───────────────────
test('14. a bar straddling both barriers grades FAILURE (never the optimistic read)', () => {
  const sessionBars = [
    bar('2026-07-08T14:05:00Z', 100, 103, 97, 100),   // hits +0.5×ATR AND −0.35×ATR in one bar
  ];
  const l = computeLabels({ decisionPrice: 100, decisionAt: DECISION_AT, atr: 4, sessionBars });
  for (const [k, b] of Object.entries(l.barriers)) {
    assert.equal(b.outcome, 'FAILURE', `${k} resolves against the strategy on ambiguity`);
  }
  assert.equal(l.timeToUpBarrierMin, null, 'no upside-barrier time credit on an ambiguous bar');
});

// ── 12./13. Sampling: deterministic, PIT-only, positives preserved, weighted ─
test('13. every at-risk row is kept with probability 1 — INCLUDING names the system rejected', () => {
  // cusum 2 is BELOW the alarm threshold (4): the current system surfaced nothing for this
  // name — exactly the false-negative class the old training set could never contain.
  const rejected = { ticker: 'REJ', cusum: 2, z: 0.5, dayPct: 0.3, relVol: 1.0 };
  assert.equal(isAtRisk(rejected), true);
  assert.deepEqual(sampleDecision(rejected, '2026-07-08', 10), { keep: true, sampleProb: 1 });
});

test('13b. ordinary negatives carry their sampling probability for 1/p weighting', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ ticker: `T${i}`, cusum: 0, z: 0, dayPct: 0.1, relVol: 0.9, last: 10, atr: 0.5 }));
  const built = buildScanRows(rows, { date: '2026-07-08', at: DECISION_AT });
  const kept = built.rows.filter(r => !r.atRisk);
  assert.ok(kept.length > 0 && kept.length < 100, `deterministic thinning happened (${kept.length}/400)`);
  assert.ok(kept.every(r => r.sampleProb === NEG_RATE), 'stored sampling probability = NEG_RATE');
});

test('12. sampling is a pure function of (date, bucket, ticker) — no future data can influence keep/drop', () => {
  const row = { ticker: 'T7', cusum: 0, z: 0, dayPct: 0.1, relVol: 0.9 };
  const a = sampleDecision(row, '2026-07-08', 10);
  const b = sampleDecision({ ...row, somethingElse: 'later-known-junk' }, '2026-07-08', 10);
  assert.deepEqual(a, b, 'identical identity → identical decision, other fields irrelevant');
  assert.equal(fnv1a('x'), fnv1a('x'), 'hash deterministic');
  const built = buildScanRows([{ ...row, last: 10, atr: 0.5 }], { date: '2026-07-08', at: DECISION_AT });
  for (const r of built.rows) {
    assert.equal(r.label, undefined, 'captured rows carry NO outcome fields — labels attach later from strictly-after bars');
    assert.equal(r.outcome, undefined);
  }
});

test('12b. decision buckets are 5-minute point-in-time slots from 04:00 ET', () => {
  assert.equal(bucketOf('2026-07-08T08:00:00Z'), 0);            // 04:00 ET
  assert.equal(bucketOf('2026-07-08T13:30:00Z'), 66);           // 09:30 ET open
  assert.ok(bucketOf('2026-07-08T14:00:00Z') > bucketOf('2026-07-08T13:30:00Z'));
});

// ── Runner capture + miss taxonomy ───────────────────────────────────────────
test('runner definitions: ATR-normalized primary + percent sensitivity grid', () => {
  assert.equal(isRunner({ high: 106.1, prevClose: 100, atr: 3 }, RUNNER_DEFS.atr2), true);
  assert.equal(isRunner({ high: 105.9, prevClose: 100, atr: 3 }, RUNNER_DEFS.atr2), false);
  assert.equal(isRunner({ high: 105.2, prevClose: 100, atr: 0 }, RUNNER_DEFS.pct5), true);
});

test('capture report: captured runners get lead-time credit; misses are reason-coded', () => {
  const scans = Array.from({ length: 10 }, (_, i) => ({
    at: new Date(Date.parse('2026-07-08T13:35:00Z') + i * 5 * 60000).toISOString(),
    anomalies: i >= 2 ? [{ ticker: 'CAUGHT', cusum: 6, last: 102 }] : [],
  }));
  const report = buildCaptureReport({
    date: '2026-07-08',
    dailyByTicker: {
      CAUGHT: { high: 110, close: 109, prevClose: 100, atr: 3 },   // runner, seen at $102 → 80% remaining
      MISSED: { high: 112, close: 111, prevClose: 100, atr: 3 },   // runner, never alarmed
      QUIET: { high: 101, close: 100.5, prevClose: 100, atr: 3 },  // not a runner
    },
    discoveryLog: { scans },
    records: {},
    baselineTickers: new Set(['CAUGHT', 'MISSED']),
  });
  assert.equal(report.runners, 2);
  assert.equal(report.captured.length, 1);
  assert.equal(report.captured[0].ticker, 'CAUGHT');
  assert.equal(report.captured[0].remainingFractionAtDetection, 0.8, '80% of the move was still ahead at first sighting');
  assert.equal(report.missed.length, 1);
  assert.equal(report.missed[0].reason, MISS.CUSUM_NOT_TRIPPED, 'scanner ran continuously → the detector itself missed');
  assert.equal(report.metrics.captureRate, 0.5);
});

test('capture report: scanner downtime is blamed on the scanner, not the detector', () => {
  const report = buildCaptureReport({
    date: '2026-07-08',
    dailyByTicker: { RUN: { high: 110, close: 109, prevClose: 100, atr: 3 } },
    discoveryLog: { scans: [] },   // nothing ran all day
    records: {},
    baselineTickers: new Set(['RUN']),
  });
  assert.equal(report.missed[0].reason, MISS.SCANNER_NOT_RUNNING);
});

test('capture report: a runner outside the baseline universe is a universe hole, not a detector miss', () => {
  const report = buildCaptureReport({
    date: '2026-07-08',
    dailyByTicker: { ILLQ: { high: 110, close: 109, prevClose: 100, atr: 3 } },
    discoveryLog: { scans: Array.from({ length: 8 }, (_, i) => ({ at: new Date(Date.parse('2026-07-08T13:35:00Z') + i * 5 * 60000).toISOString(), anomalies: [] })) },
    records: {},
    baselineTickers: new Set(['OTHER']),
  });
  assert.equal(report.missed[0].reason, MISS.BELOW_LIQUIDITY_FLOOR);
});

// ── 15. Promotion stays fail-closed on the new evaluation surface ─────────────
test('15. thin data / poor calibration still cannot promote (re-asserted on the v2 surface)', () => {
  const { checkPromotion, GATES } = require('../lib/promotion-gate');
  assert.equal(checkPromotion({ episodes: 399, testEpisodes: 500, folds: 5, precisionLift: 0.2, netReturnLift: 0.01, ece: 0.01, brier: 0.1 }).promote, false, 'one thin gate blocks');
  assert.equal(checkPromotion({ episodes: 5000, testEpisodes: 500, folds: 5, precisionLift: 0.2, netReturnLift: 0.01, ece: GATES.maxEce + 0.01, brier: 0.1 }).promote, false, 'bad calibration blocks');
});
