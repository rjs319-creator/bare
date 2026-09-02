'use strict';
// FOLDS: chronological-only splitting, purge by exact label interval, embargo boundaries,
// inner-fold construction for cross-fitting, and the absence of any random split.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/forecast/folds');
const FX = require('./forecast-fixtures');

const cfg = FX.testConfig();
const sessions = Array.from({ length: 600 }, (_, i) => `S${String(i).padStart(4, '0')}`);

test('the embargo defaults to the LONGEST horizon plus a buffer', () => {
  assert.equal(F.defaultEmbargo(cfg), Math.max(...cfg.horizons) + cfg.walkforward.embargoExtra);
  const pinned = FX.testConfig({ walkforward: { embargoSessions: 25, minTrainSessions: 60, testSessions: 25, innerFolds: 3, holdoutFraction: 0.2 } });
  assert.equal(F.defaultEmbargo(pinned), 25, 'an explicit embargo is honoured');
});

test('the embargo converts to decision-date units by rounding UP (over-purge, never under)', () => {
  assert.equal(F.embargoUnitsFor(cfg, 1), 12);
  assert.equal(F.embargoUnitsFor(cfg, 5), 3, 'ceil(12/5) = 3 — three strided steps is 15 sessions, more than 12');
  assert.equal(F.embargoUnitsFor(cfg, 10), 2);
  assert.ok(F.embargoUnitsFor(cfg, 7) * 7 >= F.defaultEmbargo(cfg), 'the converted gap always covers the session embargo');
});

test('outer folds are chronological, non-overlapping and separated by the full embargo', () => {
  const folds = F.buildOuterFolds(sessions, cfg);
  assert.ok(folds.length >= 3, `expected several folds, got ${folds.length}`);
  for (const f of folds) {
    assert.ok(f.trainStart <= f.trainEnd);
    assert.ok(f.trainEnd < f.testStart, 'train must end before test starts');
    const gap = sessions.indexOf(f.testStart) - sessions.indexOf(f.trainEnd) - 1;
    assert.equal(gap, f.embargoUnits, 'the gap between train and test is exactly the embargo');
    assert.ok(f.testStart <= f.testEnd);
  }
  for (let i = 1; i < folds.length; i++) {
    assert.ok(folds[i].testStart > folds[i - 1].testEnd, 'test blocks must not overlap');
  }
});

test('expanding and rolling schemes differ only in where training starts', () => {
  const exp = F.buildOuterFolds(sessions, FX.testConfig({ walkforward: { scheme: 'expanding', minTrainSessions: 60, testSessions: 25, innerFolds: 3, holdoutFraction: 0.2 } }));
  const roll = F.buildOuterFolds(sessions, FX.testConfig({ walkforward: { scheme: 'rolling', rollingTrainSessions: 100, minTrainSessions: 60, testSessions: 25, innerFolds: 3, holdoutFraction: 0.2 } }));
  assert.equal(exp.length, roll.length);
  assert.equal(exp.at(-1).trainStart, sessions[0], 'expanding always trains from the beginning');
  assert.ok(roll.at(-1).trainSessions <= 100, 'rolling caps the training window');
  assert.equal(exp.at(-1).testStart, roll.at(-1).testStart, 'the test blocks are identical either way');
});

test('the final holdout is carved off the END and is disjoint from development', () => {
  const { development, holdout, holdoutViable } = F.splitHoldout(sessions, cfg);
  assert.equal(holdoutViable, true);
  assert.equal(development.length + holdout.length, sessions.length);
  assert.ok(development.at(-1) < holdout[0], 'the holdout is strictly later than development');
  assert.equal(new Set([...development, ...holdout]).size, sessions.length, 'no session appears in both');
});

test('a short history refuses a holdout rather than carving a meaningless one', () => {
  const { holdoutViable, reason, holdout } = F.splitHoldout(sessions.slice(0, 120), cfg);
  assert.equal(holdoutViable, false);
  assert.equal(holdout.length, 0);
  assert.match(reason, /insufficient history/);
});

test('purge drops a training row whose LABEL is still open at the test boundary', () => {
  const axis = F.buildAxis(sessions);
  const testStart = sessions[100];
  const embargo = 5;
  const rows = [
    { ticker: 'CLOSED', decisionDate: sessions[80], label: { labelEnd: sessions[90] } },   // closed well before
    { ticker: 'EDGE_OK', decisionDate: sessions[88], label: { labelEnd: sessions[94] } },  // 94 <= 100-1-5
    { ticker: 'EDGE_BAD', decisionDate: sessions[89], label: { labelEnd: sessions[95] } }, // 95 > 94 → dropped
    { ticker: 'OPEN', decisionDate: sessions[98], label: { labelEnd: sessions[103] } },    // straddles the boundary
    { ticker: 'NO_END', decisionDate: sessions[70], label: {} },                            // unprovable → dropped
  ];
  const { kept, dropped } = F.purgeTrainingRows(rows, axis, testStart, embargo);
  assert.deepEqual(kept.map((r) => r.ticker), ['CLOSED', 'EDGE_OK']);
  assert.equal(dropped.overlapping, 2);
  assert.equal(dropped.noLabelEnd, 1, 'a row that cannot prove its label closed is dropped, not assumed closed');
});

test('purge is exact on the observed session axis, so holidays cannot shift the boundary', () => {
  // A calendar with a long gap between S0094 and S0095 must behave identically — the axis is
  // ordinal, not calendar-arithmetic.
  const gappy = sessions.slice();
  const axis = F.buildAxis(gappy);
  const a = F.purgeTrainingRows([{ label: { labelEnd: gappy[94] } }], axis, gappy[100], 5);
  const b = F.purgeTrainingRows([{ label: { labelEnd: gappy[95] } }], axis, gappy[100], 5);
  assert.equal(a.kept.length, 1);
  assert.equal(b.kept.length, 0);
});

test('inner folds are chronological, each training strictly before its validation block', () => {
  const inner = F.buildInnerFolds(sessions.slice(0, 400), cfg, { stride: 1 });
  assert.ok(inner.length >= 2);
  for (const f of inner) {
    assert.ok(f.trainEnd < f.validStart, 'inner training must end before inner validation begins');
    const gap = sessions.indexOf(f.validStart) - sessions.indexOf(f.trainEnd) - 1;
    assert.ok(gap >= f.embargoUnits, `inner embargo not honoured: gap ${gap} < ${f.embargoUnits}`);
  }
  for (let i = 1; i < inner.length; i++) {
    assert.ok(inner[i].validStart > inner[i - 1].validStart, 'inner validation blocks advance in time');
  }
});

test('a training window too short for inner folds returns none rather than improvising', () => {
  assert.deepEqual(F.buildInnerFolds(sessions.slice(0, 20), cfg), []);
});

test('rowsInRange is inclusive on both ends and date-based only', () => {
  const rows = sessions.slice(0, 10).map((d) => ({ decisionDate: d }));
  const got = F.rowsInRange(rows, sessions[2], sessions[5]);
  assert.deepEqual(got.map((r) => r.decisionDate), sessions.slice(2, 6));
});
