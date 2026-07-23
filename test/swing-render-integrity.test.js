'use strict';
// Render-integrity for the new three-horizon payload — same philosophy as
// render-guard.test.js: the UI drops these fields straight into innerHTML template
// strings, so a NaN / stray "undefined" / unresolved `${…}` in the payload becomes
// visible garbage. Scan the swing + synthesis output for those hazards. (The DOM
// render itself is browser-only; this guards the data layer where garbage starts.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { swingRead } = require('../lib/swingread');
const { synthesizeHorizons } = require('../lib/horizon-synthesis');

function scanClean(value, path = '$') {
  if (value == null) return;
  if (typeof value === 'number') { assert.ok(Number.isFinite(value), `non-finite number at ${path}`); return; }
  if (typeof value === 'string') {
    assert.ok(!value.includes('${'), `unresolved template at ${path}: ${value}`);
    assert.ok(!/\bundefined\b/.test(value), `"undefined" leaked at ${path}: ${value}`);
    assert.ok(!/\bNaN\b/.test(value), `"NaN" leaked at ${path}: ${value}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => scanClean(v, `${path}[${i}]`)); return; }
  if (typeof value === 'object') for (const k of Object.keys(value)) scanClean(value[k], `${path}.${k}`);
}

function gen(n, fn) {
  const out = []; let d = new Date(Date.UTC(2023, 0, 2));
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const c = Math.max(0.5, fn(i)); const prev = i ? out[i - 1].close : c;
    out.push({ date: d.toISOString().slice(0, 10), open: prev, high: Math.max(prev, c) * 1.006, low: Math.min(prev, c) * 0.994, close: c, volume: 8e5 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const spy = gen(220, () => 400);
const SCENARIOS = {
  up: gen(220, i => 50 * Math.pow(1.002, i)),
  down: gen(220, i => 50 * Math.pow(0.998, i)),
  flat: gen(220, () => 50),
  short: gen(30, i => 50 + i),
  empty: [],
};

test('every swing payload scenario is render-clean and terminal', () => {
  for (const [name, bars] of Object.entries(SCENARIOS)) {
    const r = swingRead(bars, spy);
    scanClean(r, `swing.${name}`);
    assert.ok(['BUY', 'WAIT', 'SELL', 'UNAVAILABLE'].includes(r.action), `terminal action for ${name}`);
    if (r.plan) {
      // plan numbers must be finite (they render as $levels)
      for (const k of ['trigger', 'invalidation', 'objective']) assert.ok(Number.isFinite(r.plan[k]), `${name} plan.${k}`);
    }
  }
});

test('missing SPY payload is render-clean (no undefined RS strings)', () => {
  scanClean(swingRead(SCENARIOS.up, null), 'swing.noSpy');
});

test('synthesis payload is render-clean across horizon combinations', () => {
  const s = synthesizeHorizons({
    intraday: { action: 'SELL', available: true },
    swing: swingRead(SCENARIOS.up, spy),
    longTerm: { trend: 'bullish', available: true },
  });
  scanClean(s, 'synthesis');
  assert.ok(s.headline.length > 0);
});
