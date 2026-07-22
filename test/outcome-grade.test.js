'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { forwardBarsAfter, gradeOutcome } = require('../lib/outcome-grade');
const { buildSnapshot, firstEntryEpisodes, firstRetirementObservations } = require('../lib/lifecycle-capture');
const { STATES } = require('../lib/opportunity-lifecycle');

function bar(t, o, h, l, c, v = 1000) { return { t, o, h, l, c, v }; }

// ── leakage guard ────────────────────────────────────────────────────────────
test('forwardBarsAfter: keeps ONLY bars strictly after the decision timestamp', () => {
  const bars = [
    bar('2026-07-08T14:00:00Z', 10, 10, 10, 10), bar('2026-07-08T14:05:00Z', 10, 11, 10, 11),
    bar('2026-07-08T14:10:00Z', 11, 12, 11, 12),
  ];
  const fwd = forwardBarsAfter(bars, '2026-07-08T14:05:00Z');
  assert.equal(fwd.length, 1);                     // only the 14:10 bar — the decision bar is excluded
  assert.equal(fwd[0].t, '2026-07-08T14:10:00Z');
});

// ── triple-barrier labels ─────────────────────────────────────────────────────
test('gradeOutcome: SUCCESS when the up barrier is reached first', () => {
  // decision 100, ATR 4 → up 102 (+0.5*4), down 98.6 (-0.35*4).
  const fwd = [bar('t1', 100, 101, 99.5, 100.5), bar('t2', 100.5, 102.5, 100, 102.2)];   // t2 high 102.5 ≥ 102
  const g = gradeOutcome({ decisionPrice: 100, decisionAt: '2026-07-08T14:00:00Z', atr: 4, forwardBars: fwd });
  assert.equal(g.barrier, 'SUCCESS');
  assert.ok(g.grossReturn > 0 && g.netReturn < g.grossReturn);   // slippage haircut applied
});

test('gradeOutcome: FAILURE when the down barrier is reached first', () => {
  const fwd = [bar('t1', 100, 100.5, 98.0, 98.2)];   // low 98.0 ≤ 98.6
  const g = gradeOutcome({ decisionPrice: 100, decisionAt: '2026-07-08T14:00:00Z', atr: 4, forwardBars: fwd });
  assert.equal(g.barrier, 'FAILURE');
  assert.ok(g.grossReturn < 0);
});

test('gradeOutcome: an intrabar straddle resolves CONSERVATIVELY to FAILURE', () => {
  const fwd = [bar('t1', 100, 103, 98.0, 101)];   // one bar hits BOTH up(102) and down(98.6)
  const g = gradeOutcome({ decisionPrice: 100, decisionAt: '2026-07-08T14:00:00Z', atr: 4, forwardBars: fwd });
  assert.equal(g.barrier, 'FAILURE');             // never optimistically claim the win came first
});

test('gradeOutcome: TIMEOUT with MFE/MAE + close return when neither barrier is hit', () => {
  const fwd = [bar('t1', 100, 101, 99.5, 100.4), bar('t2', 100.4, 101.2, 99.8, 100.8)];
  const g = gradeOutcome({ decisionPrice: 100, decisionAt: '2026-07-08T14:00:00Z', atr: 4, forwardBars: fwd });
  assert.equal(g.barrier, 'TIMEOUT');
  assert.equal(g.timeToBarrierMin, null);
  assert.ok(g.mfe > 0 && g.mae < 0);
  assert.equal(g.closeReturn, +((100.8 - 100) / 100).toFixed(5));
});

test('gradeOutcome: null when there is no forward evidence (never invent a label)', () => {
  assert.equal(gradeOutcome({ decisionPrice: 100, decisionAt: 't', atr: 4, forwardBars: [] }), null);
  assert.equal(gradeOutcome({ decisionPrice: 0, decisionAt: 't', atr: 4, forwardBars: [bar('t1', 1, 1, 1, 1)] }), null);
});

// ── capture: immutability + first-entry dedup ─────────────────────────────────
function rec(ticker, state, at, extra = {}) {
  return {
    ticker, state, strategyVersion: 'lifecycle-v1', updatedAt: at, entryAlertAt: null,
    lastMetrics: { last: 50 }, lastFreshness: { candidateDate: '2026-07-08', freshnessStatus: 'FRESH_TODAY', barIsToday: true, intradayBarAsOf: at, quoteAsOf: null, dataAgeSeconds: 5 },
    history: [{ from: null, to: state, at, reasonCode: extra.reason || 'ACTIONABLE_CONFIRMED', explanation: '', metrics: null, freshness: null, strategyVersion: 'lifecycle-v1' }],
  };
}

test('buildSnapshot: is frozen (immutable) and carries the full provenance envelope', () => {
  const s = buildSnapshot({ record: rec('ABC', STATES.ACTIONABLE_NOW, '2026-07-08T14:00:00Z'), ev: { session: 'regular' }, pick: { last: 50, score: 88, tier: 'A', scan: 'momentum_liquid', entry: 50, stop: 48, target: 56, orb: { atr: 3, trigger: 51 } }, displayed: true, displayPosition: 0 });
  assert.ok(Object.isFrozen(s));
  assert.throws(() => { s.state = 'HACKED'; }, /Cannot assign|read only/);   // cannot be mutated after capture
  assert.equal(s.decisionPrice, 50);
  assert.equal(s.atr, 3);
  assert.equal(s.dataTimestamps.candidateDate, '2026-07-08');
  assert.equal(s.ranking.score, 88);
  assert.equal(s.plan.trigger, 51);
  assert.equal(s.policyVersion, 'lifecycle-v1');
  assert.equal(s.modelOutputs, null);
});

test('firstEntryEpisodes: ONE first-entry per ticker/day (overlapping snapshots collapse)', () => {
  const mk = (ticker, at) => buildSnapshot({ record: rec(ticker, STATES.ACTIONABLE_NOW, at), ev: { session: 'regular' }, pick: { last: 50, orb: { atr: 3 } } });
  const snaps = [
    mk('ABC', '2026-07-08T14:10:00Z'), mk('ABC', '2026-07-08T14:05:00Z'), mk('ABC', '2026-07-08T14:15:00Z'),   // 3 snapshots, one episode
    mk('XYZ', '2026-07-08T15:00:00Z'),
  ];
  const eps = firstEntryEpisodes(snaps);
  assert.equal(eps.length, 2);
  const abc = eps.find(e => e.ticker === 'ABC');
  assert.equal(abc.decisionAt, '2026-07-08T14:05:00Z');   // the EARLIEST actionable snapshot
});

test('firstRetirementObservations: first retired snapshot for names that were never actionable', () => {
  const retired = buildSnapshot({ record: rec('DUD', STATES.FAILED, '2026-07-08T14:20:00Z', { reason: 'FAIL_VWAP_LOSS' }), ev: { session: 'regular' }, pick: { last: 30, orb: { atr: 2 } } });
  const alsoActionable = buildSnapshot({ record: rec('WIN', STATES.ACTIONABLE_NOW, '2026-07-08T14:00:00Z'), ev: { session: 'regular' }, pick: { last: 40, orb: { atr: 2 } } });
  const winRetired = buildSnapshot({ record: rec('WIN', STATES.FAILED, '2026-07-08T14:30:00Z'), ev: { session: 'regular' }, pick: { last: 40, orb: { atr: 2 } } });
  const obs = firstRetirementObservations([retired, alsoActionable, winRetired]);
  assert.equal(obs.length, 1);                 // only DUD (WIN was actionable first → not a false-retirement candidate)
  assert.equal(obs[0].ticker, 'DUD');
});
