'use strict';
// Locks the preregistered design of research/100-external-events-study.js to the four
// registry entries and research/PREREGISTRATION-EXTERNAL-EVENTS-2026-09.md, and pins the
// pure helpers so a "small fix" cannot quietly move a frozen parameter.
const test = require('node:test');
const assert = require('node:assert/strict');
const REG = require('../lib/research/hypothesis-registry');
const S = require('../research/100-external-events-study');

const IDS = ['activist-13d-initial', 'buyback-authorization-8k', 'dividend-initiation', 'analyst-upgrade-cluster'];

test('the four external-event hypotheses are registered, valid, exploratory and in one family', () => {
  for (const id of IDS) {
    const h = REG.find(id);
    assert.ok(h, `${id} registered`);
    assert.equal(REG.validateHypothesis(h).valid, true, id);
    assert.equal(h.mode, 'exploratory', id);
    assert.equal(h.familyId, 'event-drift', id);
    assert.notEqual(h.status, 'confirmed', 'an exploratory pass can never confirm');
    assert.match(h.evidence, /EVALUATED 2026-09-19/, `${id} carries the one pass's verdict`);
  }
  assert.ok(REG.find('analyst-revisions'), 'the prior monthly-revision hypothesis stays untouched');
  assert.ok(REG.find('index-timing-overlays'), 'the prior index-event hypothesis stays untouched');
});

test('frozen parameters match the preregistration', () => {
  const F = S.FROZEN;
  assert.equal(Object.isFrozen(F), true);
  assert.equal(S.SEAL, 'b43f45a');
  assert.deepEqual(F.horizons, [5, 21, 63]);
  assert.deepEqual(F.universe, { minAdv: 2e6, maxNames: 12000 });
  assert.deepEqual(F.eligibility, { minPriorBars: 60, minClose: 2, minAdv: 2e6 });
  assert.equal(F.cooldownSessions, 63);
  assert.equal(F.placeboShift, 126);
  assert.deepEqual(F.dev, { from: '2021-08-02', to: '2024-12-31' });
  assert.deepEqual(F.holdout, { from: '2025-01-02', to: '2026-03-31' });
  assert.equal(F.fdrAlpha, 0.10);
  assert.deepEqual(F.gates, { minEvents: 50, minDates: 20, minT: 2.0, minPositiveBlocks: 3, maxTop1Share: 0.5 });
  assert.deepEqual(Object.keys(F.hypotheses), IDS);
  assert.deepEqual(F.hypotheses['activist-13d-initial'].primary, { variant: 'A', H: 21 });
  assert.deepEqual(F.hypotheses['buyback-authorization-8k'].primary, { variant: 'B', H: 21 });
  assert.deepEqual(F.hypotheses['dividend-initiation'].primary, { variant: 'A', H: 63 });
  assert.deepEqual(F.hypotheses['analyst-upgrade-cluster'].primary, { variant: 'A', H: 5 });
  assert.equal(F.dividend.gapDays, 1095);
  assert.deepEqual(F.upgrade, { windowSessions: 3, minBrokersA: 2, minBrokersB: 3 });
  // 21 development cells: (2+2+1+2 variants) × 3 horizons
  const cells = Object.values(F.hypotheses).reduce((n, h) => n + h.variants.length * F.horizons.length, 0);
  assert.equal(cells, 21);
});

test('initial 13D means BOTH the legacy and the December-2024 renamed form label, never an amendment', () => {
  assert.deepEqual([...S.INITIAL_13D_FORMS].sort(), ['SC 13D', 'SCHEDULE 13D']);
  assert.equal(S.INITIAL_13D_FORMS.has('SC 13D/A'), false);
  assert.equal(S.INITIAL_13D_FORMS.has('SCHEDULE 13D/A'), false);
});

test('tickerOf parses the EDGAR display name and normalises share-class dots', () => {
  assert.equal(S.tickerOf('TITAN INTERNATIONAL INC  (TWI)  (CIK 0000899751)'), 'TWI');
  assert.equal(S.tickerOf('BERKSHIRE HATHAWAY INC  (BRK.B)  (CIK 0001067983)'), 'BRK-B');
  assert.equal(S.tickerOf('AIPCF V (Cayman), Ltd.  (CIK 0002014556)'), null, 'a filer without a ticker is not an event');
  assert.equal(S.tickerOf(undefined), null);
});

test('makeCalendar: the decision date is the last session on or before the calendar date', () => {
  const spy = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'].map((date) => ({ date, open: 1, close: 1 }));
  const cal = S.makeCalendar(spy);
  assert.equal(cal.decisionDateFor('2024-01-03'), '2024-01-03', 'a filing on a session is decided that session (entry next open)');
  assert.equal(cal.decisionDateFor('2024-01-06'), '2024-01-05', 'a Saturday filing rolls back to Friday; entry is Monday open');
  assert.equal(cal.decisionDateFor('2023-12-31'), null);
  assert.equal(cal.sessionIndex.get('2024-01-08'), 4);
});

test('cellStats: per-date clustering, median, top-1% share', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const date = `2023-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`;
    rows.push({ date, out: { 21: { netx: 1 } } });
  }
  rows[0].out[21].netx = 101; // one lottery ticket
  const c = S.cellStats(rows, 21);
  assert.equal(c.events, 100);
  assert.equal(c.eventMedian, 1);
  assert.ok(c.top1Share > 0.4 && c.top1Share < 0.6, `the single outlier carries ~half the mean (${c.top1Share})`);
  assert.equal(S.cellStats([], 21), null);
});

test('verdictFor is mechanical: data wall → inconclusive, failed development → no-edge, all gates → provisional', () => {
  const id = S.cellId('dividend-initiation', 'A', 63);
  const good = { events: 80, dates: 60, avg: 1.2, t: 2.5, positiveBlocks: 4, eventMedian: 0.4, top1Share: 0.1 };
  const mk = (dev, holdout, placebo = { avg: 0.1, t: 0.3 }, doubled = { avg: 0.8 }) => ({ [id]: { dev: { main: dev, placebo }, holdout: { main: holdout, placebo, doubled } } });
  assert.equal(S.verdictFor('dividend-initiation', mk({ ...good, events: 30 }, good), { [id]: { survives: true } }).status, 'inconclusive');
  assert.equal(S.verdictFor('dividend-initiation', mk(good, good), { [id]: { survives: false, q: 0.4 } }).status, 'no-edge');
  assert.equal(S.verdictFor('dividend-initiation', mk(good, good), { [id]: { survives: true, q: 0.02 } }).status, 'provisional');
  assert.equal(S.verdictFor('dividend-initiation', mk(good, { ...good, eventMedian: -0.1 }), { [id]: { survives: true, q: 0.02 } }).status, 'no-edge', 'a lottery-skewed holdout fails the median gate');
  assert.equal(S.verdictFor('dividend-initiation', mk(good, good, { avg: 1.5, t: 2.4 }), { [id]: { survives: true, q: 0.02 } }).status, 'no-edge', 'a placebo that also "works" is a name effect');
});
