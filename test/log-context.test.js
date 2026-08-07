'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { logWarn, withLogContext } = require('../lib/log');

// WHY THIS EXISTS
// The daily 22:00Z /api/tracker 504s were traced by reading `no daily data` warnings, but
// those lines name only the module that fetched (screener.fetchDailyHistory) — not the op
// that asked for it. Two separate investigations mis-attributed the caller because the log
// could not answer "who requested this ticker?". Request context makes the log line name
// its own caller, so the next occurrence identifies itself instead of being inferred.

test('a log line emitted inside withLogContext carries the request context', () => {
  // Arrange / Act
  const rec = withLogContext({ op: 'alertsgrade' }, () => logWarn('screener.fetchDailyHistory', 'no daily data', { ticker: 'BTC.X' }));

  // Assert
  assert.equal(rec.op, 'alertsgrade');
  assert.equal(rec.ticker, 'BTC.X');
  assert.equal(rec.ctx, 'screener.fetchDailyHistory');
});

test('context survives across await boundaries — the fetch is async', async () => {
  // Arrange: the real call path awaits a provider before it warns.
  const rec = await withLogContext({ op: 'daytradescan' }, async () => {
    await new Promise(r => setImmediate(r));
    return logWarn('screener.fetchDailyHistory', 'no daily data', { ticker: 'CTLT' });
  });

  // Assert: an inherited store, not a module-global that a concurrent request could clobber.
  assert.equal(rec.op, 'daytradescan');
});

test('concurrent contexts do not bleed into each other', async () => {
  // Fluid Compute runs concurrent requests in ONE process, so a module-level "current op"
  // would mis-attribute under load — exactly the failure this must not reintroduce.
  const [a, b] = await Promise.all([
    withLogContext({ op: 'opA' }, async () => { await new Promise(r => setTimeout(r, 5)); return logWarn('c', 'm'); }),
    withLogContext({ op: 'opB' }, async () => { await new Promise(r => setTimeout(r, 1)); return logWarn('c', 'm'); }),
  ]);

  assert.equal(a.op, 'opA');
  assert.equal(b.op, 'opB');
});

test('outside any context the log line is unchanged — no empty keys added', () => {
  const rec = logWarn('screener.fetchDailyHistory', 'no daily data', { ticker: 'AAPL' });

  assert.equal('op' in rec, false);
  assert.equal(rec.ticker, 'AAPL');
});

test('explicit extra wins over request context', () => {
  // A caller that knows better must be able to override the ambient value.
  const rec = withLogContext({ op: 'ambient' }, () => logWarn('c', 'm', { op: 'explicit' }));

  assert.equal(rec.op, 'explicit');
});

test('request context never overwrites the module ctx or the level', () => {
  const rec = withLogContext({ ctx: 'hijack', level: 'info' }, () => logWarn('screener.fetchDailyHistory', 'no daily data'));

  assert.equal(rec.ctx, 'screener.fetchDailyHistory');
  assert.equal(rec.level, 'warn');
});
