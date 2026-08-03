'use strict';
// v2 decision layer: evidence-gated actions, horizon-aware freshness, honest probability.
const { test } = require('node:test');
const assert = require('node:assert');
const { decidePattern, ACTIONS, isRecentSession } = require('../lib/patterns/decision');
const { buildPrediction } = require('../lib/patterns/predict');
const { buildPatternPrediction } = require('../lib/patterns/schema');
const { computeFreshness, etDate } = require('../lib/freshness');

const ET = etDate();
const nowIso = new Date().toISOString();
const freshToday = () => computeFreshness({ barDate: ET, intradayBarAsOf: nowIso, quoteAsOf: nowIso });

function det(over = {}) {
  return {
    ticker: 'ABC', family: 'BULL_FLAG', label: 'Bull flag', direction: 'LONG', timeframe: '20d', horizon: 'swing',
    phase: 'CONFIRMED', invalidationHit: false, breakoutConfirmed: true, retesting: false,
    confirmation: { status: 'CLOSE_CONFIRMED', closedThrough: true },
    extensionAtr: 0.3, patternStart: '2026-05-20', patternAsOf: ET,
    plan: { trigger: 100, stop: 97, target: 110, rr: 3.3, quality: 'good' },
    structural: { validity: 0.9, pass: true, featureCoverage: 1, missingRequiredFeatures: [] },
    structuralValidity: 0.9,
    similarity: { combined: 0.8, matchTier: 'MODERATE', calibratedThreshold: false },
    geometry: { lastClose: 100.5, atr: 2 },
    ...over,
  };
}

const PROVEN_TABLE = { version: 'v', cells: { 'BULL_FLAG|LONG|20d': { proven: true, effectiveN: 60, incrementalLift: 0.1 } } };

test('decision: daily-close-confirmed swing setup with a validated family → LONG_TRIGGERED (next-session)', () => {
  const d = decidePattern(det(), { now: nowIso, freshness: freshToday(), evidenceTable: PROVEN_TABLE });
  assert.strictEqual(d.action, ACTIONS.LONG_TRIGGERED);
  assert.strictEqual(d.actionable, true);
});

test('decision: the same setup WITHOUT validated evidence → RESEARCH_ONLY (never a buy)', () => {
  const d = decidePattern(det(), { now: nowIso, freshness: freshToday(), evidenceTable: null });
  assert.strictEqual(d.action, ACTIONS.RESEARCH_ONLY);
  assert.strictEqual(d.proven, false);
  assert.match(d.recommendationEligibility.reason, /No independently graded/);
});

test('decision: analog sufficiency has NO vote — only the evidence artifact counts', () => {
  const d = decidePattern(det(), { now: nowIso, freshness: freshToday(), evidenceTable: { version: 'v', cells: {} } });
  assert.strictEqual(d.proven, false);
  assert.strictEqual(d.action, ACTIONS.RESEARCH_ONLY);
});

test('decision: stale pattern data windows down to WATCH even when validated', () => {
  const d = decidePattern(det({ patternAsOf: '2026-01-05' }), { now: nowIso, freshness: computeFreshness({ barDate: '2026-01-05' }), evidenceTable: PROVEN_TABLE });
  assert.strictEqual(d.action, ACTIONS.WATCH);
  assert.strictEqual(d.freshEnough, false);
});

test('decision: a stale intraday-horizon setup can never be triggered', () => {
  const stale = decidePattern(det({ horizon: 'intraday', timeframe: 'session', patternAsOf: '2026-01-05' }), {
    now: nowIso, freshness: computeFreshness({ barDate: '2026-01-05' }), evidenceTable: null,
  });
  assert.notStrictEqual(stale.action, ACTIONS.LONG_TRIGGERED);
});

test('decision: a failed detection is FAILED and thesis-invalid, retained not hidden', () => {
  const d = decidePattern(det({ invalidationHit: true, breakoutConfirmed: false, confirmation: { status: 'NONE' }, phase: 'FAILED' }), { now: nowIso, freshness: freshToday(), evidenceTable: PROVEN_TABLE });
  assert.strictEqual(d.action, ACTIONS.FAILED);
  assert.strictEqual(d.thesisValid, false);
});

test('decision: isRecentSession accepts the latest completed session, rejects old bars', () => {
  assert.strictEqual(isRecentSession(ET, nowIso), true);
  assert.strictEqual(isRecentSession('2026-01-05', nowIso), false);
});

test('predict: probability is NULL unless a leakage-safe study calibrated the family', () => {
  const p = buildPrediction(det(), { dailyVol: 0.02, horizonBars: 21, analog: { targetFirstRate: 0.7, effectiveN: 500, sufficient: true, calibrated: false } });
  assert.strictEqual(p.available, true);
  assert.strictEqual(p.probability, null, 'uncalibrated → null probability even with 500 analogs');
  const cal = buildPrediction(det(), { dailyVol: 0.02, horizonBars: 21, analog: { targetFirstRate: 0.7, baselineRate: 0.5, effectiveN: 60, calibrated: true } });
  assert.strictEqual(cal.probability, 0.7);
});

test('schema: canonical object carries null probability + the reason when uncalibrated', () => {
  const decision = decidePattern(det(), { now: nowIso, freshness: freshToday(), evidenceTable: null });
  const p = buildPrediction(det(), { dailyVol: 0.02, horizonBars: 21 });
  const c = buildPatternPrediction({ ticker: 'ABC', detection: det(), decision, prediction: p, context: {}, now: nowIso });
  assert.strictEqual(c.probability, null);
  assert.match(c.probabilityNote, /No calibrated probability/);
  assert.strictEqual(c.prediction.modelEstimateOnly, true);
  assert.ok(c.reasonCodes.includes('MODEL_ESTIMATE_ONLY'));
  assert.strictEqual(c.schemaVersion, 'pattern-v2');
});

test('schema: a SHORT canonical object never contains buy language', () => {
  const shortDet = det({ direction: 'SHORT', family: 'DOUBLE_TOP', label: 'Double top', plan: { trigger: 95, stop: 101, target: 85, rr: 1.7, quality: 'acceptable' } });
  const decision = decidePattern(shortDet, { now: nowIso, freshness: freshToday(), evidenceTable: null });
  const c = buildPatternPrediction({ ticker: 'ABC', detection: shortDet, decision, context: {}, now: nowIso });
  assert.ok(!/buy triggered/i.test(c.noviceExplanation), c.noviceExplanation);
  assert.ok(!/do not buy/i.test(c.noviceExplanation), c.noviceExplanation);
});
