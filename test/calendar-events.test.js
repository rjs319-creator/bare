'use strict';
// Calendar rows → pulse2-freshness-shaped scheduled events and CERN SPLIT_FLOW candidates.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CE = require('../lib/calendar-events');
const NC = require('../lib/nasdaq-calendar');
const PF = require('../lib/pulse2-freshness');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'datapack', `nasdaq-${name}.sample.json`), 'utf8'));
const NOW = Date.parse('2026-10-02T12:00:00Z');

test('toScheduledEvents: the three clocks stay separate — event = calendar date, publication = announcement, discovery = now', () => {
  const splits = NC.normalizeNasdaq('splits', fixture('splits'), '2026-10-02').rows;
  const ev = CE.toScheduledEvents('splits', splits, { now: NOW });
  assert.equal(ev.length, splits.length);
  const dxj = ev.find((e) => e.ticker === 'DXJ');
  assert.equal(dxj.eventOccurredAt, '2026-10-09T00:00:00.000Z');
  assert.equal(dxj.firstPublishedAt, null, 'Nasdaq splits carry no announcement date — unknown stays unknown');
  assert.equal(dxj.firstSeenAt, new Date(NOW).toISOString());
  assert.ok(PF.DATE_CONFIDENCE.includes(dxj.dateConfidence));
  assert.equal(dxj.dateConfidence, 'publisher');
  assert.equal(dxj.scheduled, true);
  assert.deepEqual(dxj.detail, { ratio: '3 : 1', factor: 3, reverse: false });
  assert.equal(dxj.id, 'calendar:splits:DXJ:2026-10-09');

  const divs = NC.normalizeNasdaq('dividends', fixture('dividends'), '2026-10-02').rows;
  const alco = CE.toScheduledEvents('dividends', divs, { now: NOW }).find((e) => e.ticker === 'ALCO');
  assert.equal(alco.eventOccurredAt, '2026-10-02T00:00:00.000Z');
  assert.equal(alco.firstPublishedAt, '2026-09-08T00:00:00.000Z');
  assert.equal(alco.detail.payDate, '2026-10-16');

  const earn = NC.normalizeNasdaq('earnings', fixture('earnings'), '2026-10-02').rows;
  const enlv = CE.toScheduledEvents('earnings', earn, { now: NOW }).find((e) => e.ticker === 'ENLV');
  assert.equal(enlv.detail.epsForecast, -0.31);
  assert.throws(() => CE.toScheduledEvents('ipos', []), /unknown kind/);
  assert.deepEqual(CE.toScheduledEvents('splits', [{ symbol: 'X' }, null]), [], 'rows without a date are dropped');
});

test('splitsToCernEvents: flow window, direction by ratio, 2×ADV flow, no bars → no event, cap', () => {
  const rows = [
    { symbol: 'FWD', ratio: '3 : 1', factor: 3, executionDate: '2026-10-05' },   // +3d: inside
    { symbol: 'REV', ratio: '1 : 5', factor: 0.2, executionDate: '2026-09-27' },  // −5d: inside
    { symbol: 'FAR', ratio: '2 : 1', factor: 2, executionDate: '2026-10-20' },    // +18d: outside
    { symbol: 'OLD', ratio: '2 : 1', factor: 2, executionDate: '2026-09-20' },    // −12d: outside
    { symbol: 'NOBARS', ratio: '2 : 1', factor: 2, executionDate: '2026-10-02' },
  ];
  const adv = { FWD: 1_000_000, REV: 50_000, FAR: 1, OLD: 1 };
  const ev = CE.splitsToCernEvents(rows, { nowMs: NOW, advShares: (t) => adv[t] ?? null });
  assert.deepEqual(ev.map((e) => e.symbol), ['FWD', 'REV']);
  assert.equal(ev[0].type, 'SPLIT_FLOW');
  assert.equal(ev[0].direction, 1, 'forward split: fade the giveback (like INDEX_ADD_FADE)');
  assert.equal(ev[0].estFlowShares, 2_000_000);
  assert.equal(ev[0].dateMs, Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(ev[0].meta.shadow, true);
  assert.equal(ev[1].direction, -1, 'reverse split: distressed supply');
  assert.equal(ev[1].meta.reverse, true);
  const capped = CE.splitsToCernEvents([rows[0], { ...rows[0], symbol: 'FWD2' }], { nowMs: NOW, advShares: () => 1, max: 1 });
  assert.equal(capped.length, 1);
});
