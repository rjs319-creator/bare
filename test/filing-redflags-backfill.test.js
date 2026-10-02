'use strict';
// scripts/redflags-backfill.js — date planning, resumable progress, 403-block stop vs
// per-date error continue, totals per flag, and the local file store round-trip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../scripts/redflags-backfill');
const RFS = require('../lib/filing-redflags-store');

test('parseArgs: from/to required and ordered; defaults', () => {
  const a = B.parseArgs(['--from', '2026-09-01', '--to', '2026-09-03', '--out', '/tmp/x', '--dry']);
  assert.equal(a.from, '2026-09-01'); assert.equal(a.to, '2026-09-03'); assert.equal(a.out, '/tmp/x'); assert.equal(a.dry, true);
  assert.equal(a.progress, B.DEFAULT_PROGRESS);
  assert.throws(() => B.parseArgs(['--from', '2026-09-05', '--to', '2026-09-03']), /from must be/);
  assert.throws(() => B.parseArgs(['--to', '2026-09-03']), /required/);
});

test('datesBetween + planDates: every calendar date in range, minus the ones the progress file already finished', () => {
  const dates = B.datesBetween('2026-09-28', '2026-10-02');
  assert.deepEqual(dates, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.deepEqual(B.planDates({ dates: { '2026-09-28': { ok: true }, '2026-09-29': { ok: false } } }, dates), ['2026-09-30', '2026-10-01', '2026-10-02']);
  assert.deepEqual(B.planDates(null, dates), dates);
});

test('backfillRange: records each date (incl. missing-index weekends), continues past a per-date error, STOPS on the EDGAR block page', async () => {
  const saved = [];
  const runDate = async (date) => {
    if (date === '2026-09-27') return { ok: true, partial: false, counts: { rows: 0, excluded: 0, byFlag: {} }, stats: { ms: 5, indexDates: [{ missing: true }, { missing: true }] } };
    if (date === '2026-09-28') return { ok: true, partial: true, counts: { rows: 3, excluded: 1, byFlag: { NT_FIRST: 2, ITEM_4_02: 1 } }, stats: { ms: 9, indexDates: [{ missing: true }, { missing: false }] } };
    if (date === '2026-09-29') throw new Error('EDGAR daily index 2026-09-29: 503');
    if (date === '2026-09-30') return { ok: true, partial: false, counts: { rows: 1, excluded: 0, byFlag: { NT_FIRST: 1 } }, stats: { ms: 7, indexDates: [{ missing: false }, { missing: false }] } };
    if (date === '2026-10-01') throw new Error('EDGAR daily index 2026-10-01: 403 (not a missing-key response — blocked?)');
    throw new Error('must not run past the block');
  };
  const r = await B.backfillRange({ dates: B.datesBetween('2026-09-27', '2026-10-02'), progress: { dates: {} }, runDate, saveProgress: async (p) => saved.push(p) });
  assert.equal(r.stopped, '2026-10-01');
  assert.deepEqual(Object.keys(r.progress.dates), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'], 'the blocked date is NOT recorded as done — a rerun resumes there');
  assert.equal(r.progress.dates['2026-09-27'].missingIndex, true);
  assert.equal(r.progress.dates['2026-09-28'].partial, true);
  assert.equal(r.progress.dates['2026-09-29'].ok, false); assert.match(r.progress.dates['2026-09-29'].error, /503/);
  assert.deepEqual(r.totals.byFlag, { NT_FIRST: 3, ITEM_4_02: 1 });
  assert.equal(r.totals.rows, 4); assert.equal(r.totals.errors, 1); assert.equal(r.totals.partial, 1); assert.equal(r.totals.dates, 3);
  assert.equal(saved.length, 4, 'progress saved after every date');
  assert.deepEqual(B.planDates(r.progress, B.datesBetween('2026-09-27', '2026-10-02')), ['2026-10-01', '2026-10-02']);
});

test('isBlockedError: only the non-missing-key 403 stops the walk', () => {
  assert.equal(B.isBlockedError(new Error('EDGAR daily index x: 403 (not a missing-key response — blocked?)')), true);
  assert.equal(B.isBlockedError(new Error('EDGAR daily index x: 503')), false);
});

test('fileStore: shards, state and current round-trip through a local directory with the same union semantics as Blob', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redflags-'));
  const s = B.fileStore(dir);
  await s.writeDayUnion('2026-10-01', { picks: [{ ticker: 'AAA', flag: 'NT_FIRST', accession: 'n1', tier: 'NT_FIRST', key: 'AAA|NT_FIRST|n1', eventDate: '2026-10-01' }], partial: true });
  await s.writeDayUnion('2026-10-01', { picks: [{ ticker: 'AAA', flag: 'NT_FIRST', accession: 'n1', tier: 'NT_FIRST', key: 'AAA|NT_FIRST|n1', eventDate: '2026-10-01' }], partial: false });
  const days = await s.readAllRedflagDays({});
  assert.equal(days.length, 1); assert.equal(days[0].picks.length, 1); assert.equal(days[0].partial, false);
  await s.writeStateUnion({ byTicker: { AAA: { NT: '2026-10-01' } } });
  assert.equal((await s.readState()).byTicker.AAA.NT, '2026-10-01');
  await s.writeCurrent(RFS.buildCurrent(days, '2026-10-01'));
  assert.deepEqual(Object.keys((await s.readCurrent()).symbols), ['AAA']);
  fs.rmSync(dir, { recursive: true, force: true });
});
