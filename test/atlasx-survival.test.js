'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const {
  barriersForExpert,
  assessAtlasSurvival,
  openEpisode,
  landmark,
} = require('../lib/atlasx-survival');
const { prosecute } = require('../lib/atlasx-prosecutor');
const { keyPartsFor, buildSurvivalTable } = require('../lib/challenger-survival');
const { validateSurvival, validateProsecutor } = require('../lib/atlasx-contracts');

// ── shared fixtures ───────────────────────────────────────────────────────────
function baseSig(over = {}) {
  return {
    ticker: 'ABC',
    horizon: 'swing',
    strategyFamily: 'trend',
    state: 'ready',
    side: 'long',
    liquidity: { dollarVol: 50_000_000 },
    remainingEdge: { rated: true, netRemainingPct: 4, freshness: 'fresh' },
    price: 100,
    entry: 100,
    stop: 97,
    ...over,
  };
}
const CTX = { regime: { label: 'neutral' } };

function sumProbs(a) {
  return a.pTargetBeforeStop + a.pStopBeforeTarget + a.pNeither;
}

// ── competing-risk probabilities ──────────────────────────────────────────────
test('competing-risk probs sum to 1 and pass validateSurvival', () => {
  const a = assessAtlasSurvival(baseSig(), CTX, 'pre-entry');
  assert.ok(Math.abs(sumProbs(a) - 1) < 1e-9, `sum was ${sumProbs(a)}`);
  assert.ok(validateSurvival(a).ok, JSON.stringify(validateSurvival(a).errors));
});

test('per-expert barriers do NOT share identical geometry', () => {
  const experts = ['compressionRelease', 'breakoutContinuation', 'firstPullback', 'catalystDrift'];
  const geos = experts.map((e) => barriersForExpert(e, { atrPct: 0.03 }));
  const seen = new Set();
  for (const g of geos) {
    const sig = `${g.targetAtr}|${g.stopAtr}|${g.timeoutSessions}`;
    assert.ok(!seen.has(sig), `duplicate geometry ${sig}`);
    seen.add(sig);
  }
  // Unknown expert falls back to the config defaults.
  const dflt = barriersForExpert('unknownExpert', {});
  assert.strictEqual(dflt.targetAtr, 1.5);
  assert.strictEqual(dflt.stopAtr, 1.0);
  assert.strictEqual(dflt.timeoutSessions, 10);
});

// ── cold-start / thin-cell shrinkage ──────────────────────────────────────────
test('cold-start cell shrinks toward the prior, no extreme 0/1 probabilities', () => {
  // Empty table → shrinks to DEFAULT_PRIOR (0.35 / 0.40 / 0.25).
  const a = assessAtlasSurvival(baseSig(), { ...CTX, table: new Map() }, 'pre-entry');
  assert.ok(a.shrunkToPrior === true);
  for (const p of [a.pTargetBeforeStop, a.pStopBeforeTarget, a.pNeither]) {
    assert.ok(p > 0.05 && p < 0.95, `extreme prob ${p}`);
  }
});

test('a single-observation cell does not emit a degenerate probability of 1', () => {
  const sig = baseSig();
  const parts = keyPartsFor(sig, CTX);
  // One resolved event (all target) in this exact cell — naive rate would be 1.0.
  const table = buildSurvivalTable([{ barrier: 'upper', keyParts: parts, barsToBarrier: 5 }]);
  const a = assessAtlasSurvival(sig, { ...CTX, table }, 'pre-entry');
  assert.ok(a.pTargetBeforeStop < 0.9, `not shrunk: ${a.pTargetBeforeStop}`);
  assert.ok(a.pStopBeforeTarget > 0, 'stop mass collapsed to 0');
  assert.ok(Math.abs(sumProbs(a) - 1) < 1e-9);
});

// ── dynamic landmarking preserves prior predictions ───────────────────────────
test('landmark appends and preserves original + earlier landmarks (immutable)', () => {
  const sig = baseSig();
  const table = buildSurvivalTable([]);
  const ep0 = openEpisode(sig, { ...CTX, table });
  assert.ok(Object.isFrozen(ep0));
  assert.ok(Object.isFrozen(ep0.original));
  assert.strictEqual(ep0.landmarks.length, 0);

  const ep1 = landmark(ep0, { sig: { ...sig, ageBars: 3 }, table, ...CTX, asOf: '2023-02-01' });
  const ep2 = landmark(ep1, { sig: { ...sig, ageBars: 6 }, table, ...CTX, asOf: '2023-02-06' });

  // Original prediction preserved by reference — never rewritten.
  assert.strictEqual(ep2.original, ep0.original);
  // Earlier landmark preserved by reference.
  assert.strictEqual(ep2.landmarks[0], ep1.landmarks[0]);
  // A new landmark was appended each time.
  assert.strictEqual(ep0.landmarks.length, 0);
  assert.strictEqual(ep1.landmarks.length, 1);
  assert.strictEqual(ep2.landmarks.length, 2);
  // The prior episode object is untouched (no mutation).
  assert.strictEqual(ep1.landmarks.length, 1);
  assert.strictEqual(ep2.landmarks[1].asOf, '2023-02-06');
  assert.strictEqual(ep2.landmarks[1].phase, 'post-entry');
});

test('each landmark is a valid, mutually-exclusive competing-risk assessment', () => {
  const sig = baseSig();
  const table = buildSurvivalTable([]);
  const ep = landmark(openEpisode(sig, { ...CTX, table }), { sig, table, ...CTX, asOf: '2023-03-01' });
  const l = ep.landmarks[0];
  // target / stop / timeout are mutually exclusive → probabilities sum to exactly 1.
  assert.ok(Math.abs(l.pTargetBeforeStop + l.pStopBeforeTarget + l.pNeither - 1) < 1e-9);
  assert.ok(validateSurvival(l).ok, JSON.stringify(validateSurvival(l).errors));
});

// ── prosecutor (shadow, non-binding) ──────────────────────────────────────────
test('prosecutor exposes explainable failure modes with evidence and never binds', () => {
  const sig = baseSig({
    state: 'extended',
    event: { kind: 'binary' },
    execution: { quality: 0.15 },
    sectorStrength: -0.6,
    remainingRR: 0.7,
    score: 72,
  });
  const p = prosecute(sig, { regime: { bearish: true } });
  assert.strictEqual(p.binding, false);
  assert.ok(p.failureModes.length > 0, 'expected non-empty failure modes');
  for (const m of p.failureModes) {
    assert.ok(m.mode && typeof m.evidence === 'string' && m.evidence.length > 0, JSON.stringify(m));
    assert.ok(m.severity > 0);
  }
  assert.ok(p.failureScore > 0.2, `expected a real failure score, got ${p.failureScore}`);
  assert.ok(validateProsecutor(p).ok, JSON.stringify(validateProsecutor(p).errors));
});

test('a data outage yields a LOW failure score, not a failure', () => {
  const p = prosecute({ dataUnavailable: true }, { dataUnavailable: true });
  assert.strictEqual(p.binding, false);
  assert.ok(p.failureScore < 0.2, `outage should be low, got ${p.failureScore}`);
  assert.strictEqual(p.failureModes.length, 0);
  assert.ok(p.notes.includes('data-unavailable'));
  assert.ok(validateProsecutor(p).ok, JSON.stringify(validateProsecutor(p).errors));
});
