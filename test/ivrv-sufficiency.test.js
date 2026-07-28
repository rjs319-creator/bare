'use strict';
// The Coil × IV/RV experiment pre-registered ≥150 matured joined picks before any
// verdict — but that bar lived only in a research markdown. These tests pin the
// machine check: correct joining, null-safe IV handling, calendar maturity
// approximation labeled as such, truncation disclosure, and — critically — that
// this module can NEVER emit a verdict, only a sample count.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessIvRvSample, MIN_MATURABLE_JOINED, MATURABLE_CALENDAR_DAYS } = require('../lib/ivrv-sufficiency');

const archiveDay = (date, entries, { count = null, withOptions = null } = {}) => ({
  date,
  records: entries.map(([ticker, atmIV]) => ({ ticker, sources: ['coil'], options: atmIV == null ? null : { atmIV } })),
  count: count ?? entries.length,
  withOptions: withOptions ?? entries.filter(([, iv]) => iv != null).length,
});
const coilDay = (date, picks) => ({ date, picks: picks.map(([ticker, dailyVol, selected]) => ({ ticker, dailyVol, selected })) });

test('joins Coil picks to same-date archive atmIV and counts only fully-usable rows', () => {
  // Arrange — AAA joins with IV+RV; BBB has archived record but null IV; CCC not archived.
  const report = assessIvRvSample({
    archiveDays: [archiveDay('2026-07-01', [['AAA', 0.45], ['BBB', null]])],
    coilDays: [coilDay('2026-07-01', [['AAA', 0.02, true], ['BBB', 0.03, true], ['CCC', 0.04, false]])],
    asOf: '2026-07-28',
  });

  // Assert
  assert.equal(report.totals.coilPicks, 3);
  assert.equal(report.totals.joined, 2, 'BBB is archived (joined) even though its IV is null');
  assert.equal(report.totals.joinedWithIv, 1);
  assert.equal(report.totals.usable, 1, 'usable requires BOTH atmIV and positive realized vol');
  assert.equal(report.totals.maturable, 1, '27 calendar days out — well past the maturity approximation');
});

test('recent picks are NOT maturable — calendar approximation, honestly labeled', () => {
  const date = '2026-07-27';
  const report = assessIvRvSample({
    archiveDays: [archiveDay(date, [['AAA', 0.5]])],
    coilDays: [coilDay(date, [['AAA', 0.02, true]])],
    asOf: '2026-07-28', // 1 day later — far below the maturity window
  });
  assert.equal(report.totals.usable, 1);
  assert.equal(report.totals.maturable, 0);
  assert.match(report.maturityApproximation, /re-verify/, 'the approximation must tell the experiment to re-verify');
  assert.ok(MATURABLE_CALENDAR_DAYS >= 14, 'a 10-session horizon cannot mature in under two weeks');
});

test('status stays INSUFFICIENT_SAMPLE below the pre-registered bar and NEVER carries a verdict', () => {
  const report = assessIvRvSample({
    archiveDays: [archiveDay('2026-07-01', [['AAA', 0.5]])],
    coilDays: [coilDay('2026-07-01', [['AAA', 0.02, true]])],
    asOf: '2026-07-28',
  });
  assert.equal(report.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(report.verdict, null, 'the sufficiency module must never judge the hypothesis');
  assert.equal(report.remaining, MIN_MATURABLE_JOINED - 1);
});

test('READY_FOR_EVALUATION requires the full pre-registered maturable sample', () => {
  // Arrange — 30 days × 6 usable matured picks = 180 ≥ 150.
  const archiveDays = [], coilDays = [];
  for (let i = 0; i < 30; i++) {
    const date = `2026-05-${String(i + 1).padStart(2, '0')}`;
    const names = Array.from({ length: 6 }, (_, k) => [`T${i}_${k}`, 0.4]);
    archiveDays.push(archiveDay(date, names));
    coilDays.push(coilDay(date, names.map(([t], k) => [t, 0.02, k % 2 === 0])));
  }
  const report = assessIvRvSample({ archiveDays, coilDays, asOf: '2026-07-28' });
  assert.equal(report.totals.maturable, 180);
  assert.equal(report.status, 'READY_FOR_EVALUATION');
  assert.equal(report.verdict, null, 'READY still carries no verdict — evaluation is a separate, candle-verified step');
});

test('cohort classification: sampleKind wins, legacy boolean falls back, missing both = UNKNOWN with a warning', () => {
  // Arrange — one of each labeling era, all maturable.
  const date = '2026-06-01';
  const report = assessIvRvSample({
    archiveDays: [archiveDay(date, [['NEW_SEL', 0.4], ['NEW_CTL', 0.4], ['OLD_SEL', 0.4], ['LEGACY', 0.4]])],
    coilDays: [{
      date,
      picks: [
        { ticker: 'NEW_SEL', dailyVol: 0.02, sampleKind: 'selected' },
        { ticker: 'NEW_CTL', dailyVol: 0.02, sampleKind: 'decile-stratified' },
        { ticker: 'OLD_SEL', dailyVol: 0.02, selected: true },
        { ticker: 'LEGACY', dailyVol: 0.02 },              // predates cohort labeling
      ],
    }],
    asOf: '2026-07-28',
  });

  // Assert — never silently count an unlabeled row as selected.
  assert.equal(report.totals.selectedUsable, 2);
  assert.equal(report.totals.controlUsable, 1);
  assert.equal(report.totals.unknownCohortUsable, 1);
  assert.ok(report.warnings.some(w => /predate cohort labeling/.test(w)));
});

test('READY with a starved control cohort warns that the comparison is not runnable', () => {
  const archiveDays = [], coilDays = [];
  for (let i = 0; i < 30; i++) {
    const date = `2026-05-${String(i + 1).padStart(2, '0')}`;
    const names = Array.from({ length: 6 }, (_, k) => [`T${i}_${k}`, 0.4]);
    archiveDays.push(archiveDay(date, names));
    coilDays.push(coilDay(date, names.map(([t]) => [t, 0.02, true])));   // ALL selected, zero controls
  }
  const report = assessIvRvSample({ archiveDays, coilDays, asOf: '2026-07-28' });
  assert.equal(report.status, 'READY_FOR_EVALUATION', 'the pre-registered bar itself is met');
  assert.ok(report.warnings.some(w => /control cohort starved/.test(w)), 'but READY must not imply the comparison is runnable');
});

test('truncation is disclosed per day: archive cap and options coverage ride along', () => {
  const report = assessIvRvSample({
    archiveDays: [archiveDay('2026-07-01', [['AAA', 0.5]], { count: 140, withOptions: 96 })],
    coilDays: [coilDay('2026-07-01', [['AAA', 0.02, true], ['ZZZ', 0.05, true]])],
    asOf: '2026-07-28',
  });
  const day = report.perDay[0];
  assert.equal(day.archiveCount, 140, 'the recorded day size must be visible so absence != unfetchable');
  assert.equal(day.archiveWithOptions, 96);
  assert.equal(day.joined, 1, 'ZZZ absent from a possibly-full archive day simply does not join');
});
