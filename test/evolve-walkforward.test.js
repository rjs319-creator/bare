'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const WF = require('../lib/evolve-walkforward');

const isoDay = (n) => new Date(2025, 0, 1 + n).toISOString().slice(0, 10);

// Deterministic, stationary synthetic ledger: specialist 'S' fires in two contexts.
// ctxHi always wins (+10%), ctxLo always loses (−5%). Same pattern in every period, so a
// perf model trained on the past should rank ctxHi test events above ctxLo test events.
function makeEvents({ numDates = 80, perDate = 6, horizon = 'fast' } = {}) {
  const events = [];
  for (let d = 0; d < numDates; d++) {
    for (let i = 0; i < perDate; i++) {
      const hi = i % 2 === 0;
      events.push({
        ticker: `T${i}`, predDate: isoDay(d), horizon,
        contextKey: hi ? 'ctxHi' : 'ctxLo',
        specialists: ['S'], contribs: [{ specialist: 'S', p: 0.4 }],
        won: hi ? 1 : 0, terminalReturn: hi ? 0.10 : -0.05,
        spyRelReturn: hi ? 0.08 : -0.06,
      });
    }
  }
  return events;
}

test('horizonWindow returns the triple-barrier windows 5/21/63', () => {
  assert.strictEqual(WF.horizonWindow('fast'), 5);
  assert.strictEqual(WF.horizonWindow('swing'), 21);
  assert.strictEqual(WF.horizonWindow('position'), 63);
});

test('fitPerf tallies global + per-context wins/n per specialist', () => {
  const perf = WF.fitPerf([
    { contextKey: 'ctxHi', specialists: ['S'], won: 1, terminalReturn: 0.1 },
    { contextKey: 'ctxHi', specialists: ['S'], won: 1, terminalReturn: 0.1 },
    { contextKey: 'ctxLo', specialists: ['S'], won: 0, terminalReturn: -0.05 },
  ]);
  assert.strictEqual(perf.bySpecialist.S.global.n, 3);
  assert.strictEqual(perf.bySpecialist.S.global.wins, 2);
  assert.strictEqual(perf.bySpecialist.S.byContext.ctxHi.wins, 2);
  assert.strictEqual(perf.bySpecialist.S.byContext.ctxLo.n, 1);
  assert.strictEqual(perf.bySpecialist.S.byContext.ctxLo.wins, 0);
});

test('scoreEvent: a winning context scores higher than a losing one; cold context ~prior', () => {
  const perf = WF.fitPerf(makeEvents({ numDates: 10, perDate: 6 }));
  const hi = WF.scoreEvent({ specialists: ['S'], contextKey: 'ctxHi' }, perf);
  const lo = WF.scoreEvent({ specialists: ['S'], contextKey: 'ctxLo' }, perf);
  assert.ok(hi.p > lo.p, 'winning context yields a higher ensemble P');
  const cold = WF.scoreEvent({ specialists: ['S'], contextKey: 'neverSeen' }, perf);
  assert.ok(cold.p > 0.3 && cold.p < 0.5, 'unseen context shrinks toward the ~0.4 prior');
  assert.strictEqual(WF.scoreEvent({ specialists: [] }, perf), null, 'no firing specialist → null');
});

test('walkForward: embargo removes near-boundary training events (purged train ⊂ leaky train)', () => {
  const events = makeEvents({ numDates: 60, perDate: 6, horizon: 'fast' });
  const purged = WF.walkForward(events, { folds: 4, embargo: 3, purge: true, minTrain: 5, minTest: 5 });
  const leaky = WF.walkForward(events, { folds: 4, embargo: 3, purge: false, minTrain: 5, minTest: 5 });
  const pf = purged.folds.find(f => f.trainN != null && f.fold === 1);
  const lf = leaky.folds.find(f => f.trainN != null && f.fold === 1);
  assert.ok(pf.trainN < lf.trainN, `purge must drop boundary events (purged ${pf.trainN} < leaky ${lf.trainN})`);
});

test('walkForward: a real stationary edge holds out-of-sample with positive mean OOS IC', () => {
  const events = makeEvents({ numDates: 80, perDate: 6, horizon: 'fast' });
  const wf = WF.walkForward(events, { folds: 4, embargo: 3, purge: true });
  assert.ok(wf.ready, 'produces OOS blocks');
  assert.ok(wf.meanOOS > 0, `mean OOS IC positive (got ${wf.meanOOS})`);
  assert.strictEqual(wf.positiveBlocks, wf.testedBlocks, 'all tested blocks positive on a real edge');
  assert.ok(Number.isFinite(wf.brier), 'reports a Brier score');
});

test('walkForward: pure noise does NOT pass the ship criterion', () => {
  // Outcome independent of context → no learnable ranking → should not "pass".
  const events = [];
  for (let d = 0; d < 80; d++) for (let i = 0; i < 6; i++) {
    const win = (d * 7 + i * 13) % 2 === 0;          // deterministic pseudo-noise, context-independent
    events.push({ predDate: isoDay(d), horizon: 'fast', contextKey: i % 2 ? 'ctxHi' : 'ctxLo',
      specialists: ['S'], contribs: [{ specialist: 'S', p: 0.4 }], won: win ? 1 : 0, terminalReturn: win ? 0.03 : -0.03 });
  }
  const wf = WF.walkForward(events, { folds: 4, embargo: 3, purge: true });
  assert.strictEqual(wf.passed, false, 'noise must not clear the ≥3-all-positive + margin gate');
});

test('purge distance is measured in CALENDAR days, not cohort ordinals (sparse cohorts still train)', () => {
  // Regression: cohorts spaced 30 calendar days apart (like the 21-trading-day backfill).
  // A 'fast' label (5td ≈ 7 cal days) closes well within one 30-day step, so past cohorts
  // MUST remain trainable. The old ordinal-distance form wrongly dropped them all.
  const events = [];
  for (let d = 0; d < 24; d++) {                    // 24 cohorts × 30 days = ~2y
    const date = new Date(2025, 0, 1 + d * 30).toISOString().slice(0, 10);
    for (let i = 0; i < 8; i++) {
      const hi = i % 2 === 0;
      events.push({ predDate: date, horizon: 'fast', contextKey: hi ? 'ctxHi' : 'ctxLo',
        specialists: ['S'], contribs: [{ specialist: 'S', p: 0.4 }], won: hi ? 1 : 0, terminalReturn: hi ? 0.1 : -0.05 });
    }
  }
  const wf = WF.walkForward(events, { folds: 4, embargo: 3, purge: true });
  const trained = wf.folds.filter(f => f.trainN >= 30);
  assert.ok(trained.length >= 1, 'sparse cohorts must still yield trained folds');
  assert.ok(wf.testedBlocks >= 1, 'produces at least one OOS block on sparse cohorts');
  // labelClearsTestBlock: a 'fast' event 30 cal days back clears; 2 days back does not.
  assert.strictEqual(WF.labelClearsTestBlock('2025-01-01', '2025-01-31', 'fast', 3), true);
  assert.strictEqual(WF.labelClearsTestBlock('2025-01-29', '2025-01-31', 'fast', 3), false);
});

test('evaluate: returns per-horizon + pooled reads with a leakage-inflation figure and a verdict', () => {
  const out = WF.evaluate(makeEvents({ numDates: 80, perDate: 6, horizon: 'fast' }), { folds: 4, embargo: 3 });
  assert.ok(out.byHorizon.fast && out.byHorizon.swing && out.byHorizon.position, 'all 3 horizons present');
  assert.strictEqual(out.byHorizon.swing.n, 0, 'empty horizons report zero, not fabricated');
  assert.ok(out.pooled.purged && out.pooled.leaky, 'pooled purged + leaky reads present');
  assert.ok('leakageInflation' in out.pooled, 'reports leakage inflation');
  assert.ok(['edge-holds-oos', 'no-edge', 'inconclusive', 'insufficient'].includes(out.verdict));
  assert.strictEqual(out.version, WF.WF_VERSION);
});
