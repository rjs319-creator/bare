'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runComponentLabRoute, COMPONENTS, outcomeAt } = require('../lib/component-lab-routes');

function fakeRes() {
  return { _json: null, _headers: {}, setHeader(k, v) { this._headers[k] = v; }, status() { return this; }, json(o) { this._json = o; return this; } };
}

test('op=complab degrades gracefully with no store (no crash, no fabricated study)', async () => {
  const res = fakeRes();
  await runComponentLabRoute({ query: {} }, res);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.configured, false);
  assert.deepEqual(res._json.components, []);
  assert.equal(res._headers['Cache-Control'], 'no-store');
});

test('the lab tests at least five named components (spec §2 acceptance minimum)', () => {
  assert.ok(COMPONENTS.length >= 5);
  assert.ok(COMPONENTS.every(c => c.key && c.label && typeof c.detect === 'function'));
});

test('outcomeAt: resolves target-before-stop from logged levels, direction-aware', () => {
  // Long from 100, target 110, stop 95. Candles rise to 112 → target first.
  const candles = [{ date: '2026-01-01', close: 100, high: 100, low: 100 }];
  for (let i = 1; i <= 25; i++) candles.push({ date: '2026-01-' + String(i + 1).padStart(2, '0'), close: 100 + i, high: 101 + i, low: 99 + i });
  const o = outcomeAt(candles, 0, { entry: 100, target: 110, stop: 95 });
  assert.equal(o.targetBeforeStop, true);
  assert.ok(o.ret > 0 && o.mfe > 0);
});
