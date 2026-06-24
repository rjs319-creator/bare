'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { logError, logWarn, logInfo } = require('../lib/log');

// Silence console for these tests (the helpers still return the record).
const orig = { error: console.error, warn: console.warn, log: console.log };
function quiet(fn) {
  console.error = console.warn = console.log = () => {};
  try { return fn(); } finally { Object.assign(console, orig); }
}

test('logError builds a structured record from an Error', () => {
  const rec = quiet(() => logError('predmarkets.fetchKalshi', new Error('429 rate limited'), { series: 'KXINX' }));
  assert.equal(rec.level, 'error');
  assert.equal(rec.ctx, 'predmarkets.fetchKalshi');
  assert.equal(rec.msg, '429 rate limited');
  assert.equal(rec.series, 'KXINX');
  assert.ok(rec.at);
});

test('logWarn accepts a plain string message', () => {
  const rec = quiet(() => logWarn('cron', 'tick skipped', { op: 'crowdtick' }));
  assert.equal(rec.level, 'warn');
  assert.equal(rec.msg, 'tick skipped');
  assert.equal(rec.op, 'crowdtick');
});

test('log helpers stringify non-Error values safely', () => {
  assert.equal(quiet(() => logError('x', null)).msg, 'null');
  assert.equal(quiet(() => logInfo('x', 42)).msg, '42');
});

test('record JSON-serializes to a single line', () => {
  const rec = quiet(() => logError('ctx', new Error('boom')));
  const line = JSON.stringify(rec);
  assert.ok(!line.includes('\n'));
  assert.deepEqual(JSON.parse(line).msg, 'boom');
});
