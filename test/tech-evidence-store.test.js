'use strict';
// Prevents: overwritten history (immutability), duplicate observations under cron
// retries, lost firstObservedAt on re-observation, and unbounded series growth.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const TSTORE = require('../lib/tech-evidence/store');
const SCHEMA = require('../lib/tech-evidence/schema');
const STORE = require('../lib/store');

const NOW = '2026-08-11T15:00:00.000Z';
const obs = (over = {}) => SCHEMA.makeObservation({
  source: 'npm', ticker: 'MDB', entity: 'mongodb', metric: 'downloads',
  effectiveDate: '2026-08-10', value: 42, unit: 'downloads/day', retrievedAt: NOW, ...over,
});

test('foldIntoSeries: identical observation is not fresh twice (idempotent retry)', () => {
  const first = TSTORE.foldIntoSeries('npm', TSTORE.emptySeries('npm'), [obs()]);
  assert.equal(first.freshObservations.length, 1);
  const second = TSTORE.foldIntoSeries('npm', first.series, [obs()]);
  assert.equal(second.freshObservations.length, 0, 'a cron retry must add nothing');
});

test('foldIntoSeries: a restated npm value becomes a revision — the original point stands', () => {
  const first = TSTORE.foldIntoSeries('npm', TSTORE.emptySeries('npm'), [obs()]);
  const revised = TSTORE.foldIntoSeries('npm', first.series, [obs({ value: 99 })]);
  assert.equal(revised.freshObservations.length, 1, 'the revision is recorded');
  assert.equal(revised.series.entities.mongodb.points['2026-08-10'], 42, 'the first-observed value is immutable');
  assert.equal(revised.series.entities.mongodb.revisions[0].value, 99);
});

test('foldIntoSeries does not mutate its input (immutability)', () => {
  const empty = TSTORE.emptySeries('npm');
  const before = JSON.stringify(empty);
  TSTORE.foldIntoSeries('npm', empty, [obs()]);
  assert.equal(JSON.stringify(empty), before);
});

test('sec fold keys on (measure,start,end,value): amendments with new values are new entries', () => {
  const secObs = (val, filed) => SCHEMA.makeObservation({
    source: 'sec', ticker: 'MDB', entity: '0001441816', metric: 'revenue',
    effectiveDate: '2026-04-30', value: val, unit: 'USD', retrievedAt: NOW,
    detail: { start: '2026-02-01', filed, form: '10-Q' },
  });
  const a = TSTORE.foldIntoSeries('sec', TSTORE.emptySeries('sec'), [secObs(450e6, '2026-06-05')]);
  const b = TSTORE.foldIntoSeries('sec', a.series, [secObs(450e6, '2026-06-05')]);
  assert.equal(b.freshObservations.length, 0);
  const c = TSTORE.foldIntoSeries('sec', b.series, [secObs(455e6, '2026-07-20')]);
  assert.equal(c.freshObservations.length, 1);
  assert.equal(Object.keys(c.series.entities['0001441816'].facts).length, 2);
});

test('appendObservations merges first-wins by id and reports zero added on replay', async (t) => {
  const docs = {};
  const origRead = STORE.readJSON;
  const origWrite = STORE.writeJSON;
  STORE.readJSON = async (key, fallback) => (key in docs ? docs[key] : fallback);
  STORE.writeJSON = async (key, doc) => { docs[key] = doc; return { pathname: key }; };
  t.after(() => { STORE.readJSON = origRead; STORE.writeJSON = origWrite; });

  const o = obs();
  const r1 = await TSTORE.appendObservations('npm', '2026-08-11', [o]);
  assert.deepEqual({ written: r1.written, added: r1.added }, { written: true, added: 1 });
  const r2 = await TSTORE.appendObservations('npm', '2026-08-11', [o]);
  assert.deepEqual({ written: r2.written, added: r2.added }, { written: false, added: 0 }, 'replay must not rewrite the day doc');
  // first-wins: a same-id observation with a different retrievedAt keeps the original record
  const later = { ...o, retrievedAt: '2026-08-11T23:00:00.000Z', firstObservedAt: '2026-08-11T23:00:00.000Z' };
  await TSTORE.appendObservations('npm', '2026-08-11', [later]);
  const stored = docs[TSTORE.KEYS.obsDay('npm', '2026-08-11')].observations;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].firstObservedAt, NOW, 'firstObservedAt is preserved from the first sighting');
});

test('rowsFromDayDocs: derived cache rebuilds from immutable day docs — Blob RMW lost-update corruption self-heals', () => {
  const toRow = (event, o) => ({ d: event.cutoffDate, t: event.ticker, arm: event.arm, n: [o.netResidual[1], o.netResidual[5], o.netResidual[10]] });
  const outcome = (id) => ({ id, status: 'resolved', netResidual: { 1: 0.01, 5: 0.02, 10: 0.03 } });
  const dayDocs = [
    { date: '2026-06-01', events: [{ id: 'e1', cutoffDate: '2026-06-01', ticker: 'MDB', arm: 'npm' }, { id: 'e2', cutoffDate: '2026-06-01', ticker: 'DDOG', arm: 'npm' }], resolved: { outcomes: [outcome('e1'), outcome('e2'), { id: 'e2x', status: 'no-history-after-retries' }] } },
    { date: '2026-06-08', events: [{ id: 'e3', cutoffDate: '2026-06-08', ticker: 'MDB', arm: 'github' }], resolved: { outcomes: [outcome('e3')] } },
    { date: '2026-06-15', events: [{ id: 'e4', cutoffDate: '2026-06-15', ticker: 'NET', arm: 'npm' }] }, // unresolved day — excluded
  ];
  const built = TSTORE.rowsFromDayDocs(dayDocs, { toRow });
  assert.equal(built.rows.length, 3, 'every resolved outcome across day docs becomes exactly one row');
  assert.equal(built.trimmed, 0);
  // Deterministic: rebuilding from the same day docs yields the same rows regardless of
  // any prior rows.json content — this is what makes lost updates unrepresentable.
  assert.deepEqual(TSTORE.rowsFromDayDocs(dayDocs, { toRow }).rows, built.rows);
});

test('rowsFromDayDocs enforces the row cap and discloses trimming', () => {
  const toRow = (event) => ({ d: event.cutoffDate, t: event.ticker, arm: 'npm', n: [0, 0, 0] });
  const dayDocs = Array.from({ length: TSTORE.EVENT_ROW_CAP + 10 }, (_, i) => ({
    date: '2026-06-01',
    events: [{ id: `e${i}`, cutoffDate: '2026-06-01', ticker: `T${i}`, arm: 'npm' }],
    resolved: { outcomes: [{ id: `e${i}`, status: 'resolved', netResidual: { 1: 0, 5: 0, 10: 0 } }] },
  }));
  const built = TSTORE.rowsFromDayDocs(dayDocs, { toRow });
  assert.equal(built.rows.length, TSTORE.EVENT_ROW_CAP);
  assert.equal(built.trimmed, 10, 'silent truncation is forbidden — the trim count must be disclosed');
});

test('mergeHealth: a failing run never erases the previous lastSuccessAt', async (t) => {
  const docs = {};
  const origRead = STORE.readJSON;
  const origWrite = STORE.writeJSON;
  STORE.readJSON = async (key, fallback) => (key in docs ? docs[key] : fallback);
  STORE.writeJSON = async (key, doc) => { docs[key] = doc; return { pathname: key }; };
  t.after(() => { STORE.readJSON = origRead; STORE.writeJSON = origWrite; });

  await TSTORE.mergeHealth({ sources: { npm: { lastAttemptAt: 't1', lastSuccessAt: 't1', lastError: null } } });
  // a failed run patches lastSuccessAt: undefined — the shallow-spread bug clobbered it
  await TSTORE.mergeHealth({ sources: { npm: { lastAttemptAt: 't2', lastSuccessAt: undefined, lastError: 'HTTP 503' } } });
  const h = await TSTORE.readHealth();
  assert.equal(h.sources.npm.lastSuccessAt, 't1', 'the success record must survive a failing night');
  assert.equal(h.sources.npm.lastError, 'HTTP 503');
});

test('series day cap trims the OLDEST days', () => {
  let series = TSTORE.emptySeries('npm');
  let d = '2024-01-01';
  const batch = [];
  for (let i = 0; i < TSTORE.SERIES_DAY_CAP + 30; i += 1) {
    batch.push(obs({ effectiveDate: d, value: i }));
    d = require('../lib/tech-evidence/signals').addDays(d, 1);
  }
  series = TSTORE.foldIntoSeries('npm', series, batch).series;
  const days = Object.keys(series.entities.mongodb.points).sort();
  assert.equal(days.length, TSTORE.SERIES_DAY_CAP);
  assert.ok(days[0] > '2024-01-30', 'oldest days are the ones trimmed');
});
