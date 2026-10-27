'use strict';
// Regression: a re-dated event keeps its original eventDate (the conflict stays visible),
// but buildEventRisk filtered on eventDate >= today — so FOMC 10-28 re-reported as 11-04
// vanished from the playbook on 10-29, a week before it happens.
const test = require('node:test');
const assert = require('node:assert');
const { buildEventRisk } = require('../lib/pulse2-routes');

const fomc = { id: 'fomc', headline: 'FOMC decision', eventDate: '2026-10-28', reportedEventDates: ['2026-10-28', '2026-11-04'], dateConflict: true, scheduleStatus: 'changed' };
const cpi = { id: 'cpi', headline: 'CPI', eventDate: '2026-11-02' };

test('a re-dated event stays listed until its latest reported date', () => {
  const out = buildEventRisk([fomc, cpi], { today: '2026-10-29' });
  assert.deepStrictEqual(out.map(e => e.eventId), ['cpi', 'fomc']);
  assert.strictEqual(out[1].eventDate, '2026-10-28', 'original date is still what is shown');
});

test('an event whose every reported date has passed is dropped', () => {
  assert.deepStrictEqual(buildEventRisk([fomc], { today: '2026-11-05' }), []);
});

test('an ordinary past event is still dropped', () => {
  assert.deepStrictEqual(buildEventRisk([cpi], { today: '2026-11-03' }), []);
});
