'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const I = require('../lib/ignition');

// Build a candle series from a list of {close, volume} (highs/lows default around close).
function series(rows) {
  let d = new Date('2026-01-01T00:00:00Z');
  return rows.map(r => {
    const date = d.toISOString().slice(0, 10); d = new Date(d.getTime() + 86400000);
    const close = r.close, vol = r.volume ?? 1e6;
    return { date, open: r.open ?? close, high: r.high ?? close * 1.02, low: r.low ?? close * 0.98, close, volume: vol };
  });
}
// An accelerating early mover: flat then curving UP with rising volume, only ~10% total.
function accelerating() {
  const rows = [];
  let px = 100;
  for (let i = 0; i < 35; i++) { px *= (i < 28 ? 1.001 : 1 + 0.004 * (i - 27)); rows.push({ close: px, volume: 1e6 * (i < 28 ? 1 : 1 + 0.4 * (i - 27)) }); }
  return series(rows);
}
// An extended, decelerating late mover: huge run, then daily gains TAPER toward zero over
// the last stretch (recent velocity < prior velocity ⇒ negative acceleration), up a lot,
// volume fading.
function extendedSlowing() {
  const rows = [];
  let px = 100;
  for (let i = 0; i < 22; i++) { px *= 1.025; rows.push({ close: px, volume: 2e6 }); }   // big run → extended
  for (let k = 0; k < 13; k++) { px *= 1 + 0.02 * (1 - k / 13); rows.push({ close: px, volume: 7e5 }); }  // tapering
  return series(rows);
}

test('accelerationMetrics returns null below 30 bars', () => {
  assert.strictEqual(I.accelerationMetrics(series([{ close: 100 }])), null);
});

test('accelerationMetrics: accelerating name has positive priceAccel + volAccel', () => {
  const m = I.accelerationMetrics(accelerating());
  assert.ok(m.priceAccel > 0, 'price accelerating');
  assert.ok(m.volAccel > 0, 'volume expanding');
  assert.ok(m.extAbove20 < 25, 'not yet extended');
});

test('accelerationMetrics: extended name shows deceleration + high extension', () => {
  const m = I.accelerationMetrics(extendedSlowing());
  assert.ok(m.priceAccel < 0, 'decelerating');
  assert.ok(m.extAbove20 > 0);
});

test('SIGNATURE: up-10%-accelerating outscores up-60%-decelerating', () => {
  const early = I.accelerationMetrics(accelerating());
  const late = I.accelerationMetrics(extendedSlowing());
  const cat = I.catalystQuality({ catalyst: 'contract', ageDays: 1 });
  const sEarly = I.ignitionScore(early, { catalyst: cat, regime: { riskOn: true } });
  const sLate = I.ignitionScore(late, { catalyst: cat, regime: { riskOn: true } });
  assert.ok(sEarly.score > sLate.score, `early ${sEarly.score} should beat late ${sLate.score}`);
  assert.ok(sLate.penalties.includes('decelerating'));
});

test('catalystQuality: fresh material catalyst > stale, absent → low', () => {
  const fresh = I.catalystQuality({ catalyst: 'FDA approval', ageDays: 1 });
  const stale = I.catalystQuality({ catalyst: 'FDA approval', ageDays: 9 });
  const none = I.catalystQuality({});
  assert.ok(fresh.quality > stale.quality);
  assert.ok(none.quality < 0.3 && none.label === null);
  assert.ok(fresh.fresh === true);
});

test('ignitionScore penalizes thin liquidity and risk-off', () => {
  const m = I.accelerationMetrics(accelerating());
  const thin = { ...m, dollarVol: 1e6 };
  const s = I.ignitionScore(thin, { catalyst: I.catalystQuality({ catalyst: 'contract', ageDays: 1 }), regime: { bearish: true, riskOn: false } });
  assert.ok(s.penalties.includes('thin liquidity'));
  assert.ok(s.penalties.includes('risk-off tape'));
});

test('ignitionStage: accelerating small move → Watch/Ignition; extended slowing → Extended', () => {
  const early = I.accelerationMetrics(accelerating());
  const late = I.accelerationMetrics(extendedSlowing());
  assert.ok(['Watch', 'Ignition', 'Pressure'].includes(I.ignitionStage(early, I.ignitionScore(early, {}))));
  assert.strictEqual(I.ignitionStage(late, I.ignitionScore(late, {})), 'Extended');
});

test('ignitionTier thresholds', () => {
  assert.strictEqual(I.ignitionTier({ score: 75 }), 'IGNITION');
  assert.strictEqual(I.ignitionTier({ score: 60 }), 'WATCH');
  assert.strictEqual(I.ignitionTier({ score: 40 }), 'WEAK');
});
