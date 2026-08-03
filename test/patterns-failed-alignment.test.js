'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reconcileDetections, higherTimeframeTrend } = require('../lib/patterns/reconcile');

const det = (over = {}) => ({
  family: 'flag', label: 'Bull flag', timeframe: '20d', direction: 'LONG',
  phase: 'CONFIRMED', structuralValidity: 0.9,
  plan: { rr: 2.5, quality: 'good' },
  structurallyInvalid: false,
  ...over,
});

test('a FAILED bullish pattern counts AGAINST bullish alignment, never for it', () => {
  const live = det();                                              // live LONG
  const dead = det({ family: 'base', label: 'Failed base', phase: 'FAILED', timeframe: '60d' });   // FAILED LONG
  const rec = reconcileDetections([live, dead]);
  assert.strictEqual(rec.primary.detection, live, 'a dead pattern can never be primary');
  assert.ok(rec.alignment < 1, `FAILED same-direction pattern must reduce alignment (got ${rec.alignment})`);
  assert.ok(rec.failedNotes.some(n => /against the LONG case/i.test(n)));
});

test('a FAILED bearish pattern supports the bullish case (against its former direction)', () => {
  const live = det();
  const deadShort = det({ family: 'wedge', label: 'Failed wedge', phase: 'FAILED', direction: 'SHORT', timeframe: '60d' });
  const withDeadShort = reconcileDetections([live, deadShort]);
  const alone = reconcileDetections([live]);
  assert.ok(withDeadShort.alignment >= alone.alignment, 'failed bearish pattern must not hurt the bull case');
});

test('EXPIRED patterns are ignored entirely', () => {
  const live = det();
  const expired = det({ family: 'base', phase: 'EXPIRED', timeframe: '60d' });
  const rec = reconcileDetections([live, expired]);
  const alone = reconcileDetections([live]);
  assert.strictEqual(rec.alignment, alone.alignment);
  assert.strictEqual(rec.ranked.length, 1);
});

test('a FAILED pattern can never become primary even when it is the only detection', () => {
  const rec = reconcileDetections([det({ phase: 'FAILED' })]);
  assert.strictEqual(rec.primary, null);
  assert.strictEqual(rec.failed.length, 1);
});

test('higher-timeframe trend is never set by a FAILED or EXPIRED structure', () => {
  const deadHtf = det({ family: 'channel', phase: 'FAILED', timeframe: '120d', direction: 'LONG' });
  const live = det({ timeframe: '20d' });
  const htf = higherTimeframeTrend([deadHtf, live]);
  assert.strictEqual(htf.source, 'flag@20d', 'the live structure defines HTF, not the dead 120d one');
});
