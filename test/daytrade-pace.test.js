const test = require('node:test');
const assert = require('node:assert');
const { sessionPaceFraction, dayMetrics, AVG_VOL_WINDOW } = require('../lib/daytrade');

// July → America/New_York is EDT (UTC-4). RTH 09:30–16:00 ET = 13:30–20:00 UTC.

test('sessionPaceFraction: mid-session prorates by fraction elapsed', () => {
  // 2026-07-07 14:00 UTC = 10:00 ET = 30 min into a 390-min session.
  const f = sessionPaceFraction(new Date('2026-07-07T14:00:00Z'));
  assert.ok(Math.abs(f - 30 / 390) < 1e-6, `expected ~0.077, got ${f}`);
});

test('sessionPaceFraction: pre-open returns 1 (no pacing)', () => {
  // 08:00 ET
  assert.equal(sessionPaceFraction(new Date('2026-07-07T12:00:00Z')), 1);
});

test('sessionPaceFraction: post-close returns 1 (no pacing)', () => {
  // 17:00 ET
  assert.equal(sessionPaceFraction(new Date('2026-07-07T21:00:00Z')), 1);
});

test('sessionPaceFraction: weekend returns 1', () => {
  // 2026-07-11 is a Saturday; 10:00 ET
  assert.equal(sessionPaceFraction(new Date('2026-07-11T14:00:00Z')), 1);
});

test('sessionPaceFraction: floored at 0.05 in the first minutes', () => {
  // 09:31 ET = 1 min in → raw 1/390 ≈ 0.0026, floored to 0.05
  assert.equal(sessionPaceFraction(new Date('2026-07-07T13:31:00Z')), 0.05);
});

test('dayMetrics: pace inflates relVol but leaves rawRelVol and pctChange intact', () => {
  // Flat 20-day base at volume 1,000,000, then a +6% day on only 100k volume (partial bar).
  const candles = [];
  for (let i = 0; i < AVG_VOL_WINDOW; i++) candles.push({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, open: 10, high: 10.2, low: 9.8, close: 10, volume: 1_000_000 });
  candles.push({ date: '2026-07-07', open: 10, high: 10.7, low: 10, close: 10.6, volume: 100_000 });

  const unpaced = dayMetrics(candles, null);
  assert.equal(unpaced.rawRelVol, 0.1);          // 100k / 1M
  assert.equal(unpaced.relVol, 0.1);             // no pacing
  assert.equal(unpaced.paced, false);

  const paced = dayMetrics(candles, null, undefined, 0.1);   // 10% of session elapsed
  assert.equal(paced.rawRelVol, 0.1);            // raw unchanged
  assert.equal(paced.relVol, 1);                 // 0.1 / 0.1 projected to full day
  assert.equal(paced.paced, true);
  assert.equal(paced.pctChange, unpaced.pctChange);   // price move is NOT paced
});
