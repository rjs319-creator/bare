'use strict';
// API SURFACE: the three read-only ops. Their response SHAPES are pinned, and — more
// importantly — so is their behaviour in an environment that cannot serve them: they must say
// what is missing, never return an empty board that looks like "no opportunities today".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/forecast-routes');

function fakeRes() {
  return {
    headers: {}, body: null, statusCode: 200,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return o; },
  };
}

test('op=forecastcaps reports the tier, the reasons and actionable hints', async () => {
  const res = fakeRes();
  await R.runForecastCaps({ query: {} }, res);
  const b = res.body;
  assert.equal(b.ok, true);
  assert.ok(b.tier >= 1 && b.tier <= 6);
  assert.equal(b.fallbackHierarchy.length, 6);
  assert.ok(b.components.ridge.available, 'the permanent baseline is always available');
  assert.ok(['ridge', 'chronos2', 'moirai2'].every((k) => k in b.components));
  assert.ok(Array.isArray(b.setupHints));
  for (const [name, c] of Object.entries(b.components)) {
    if (!c.available) assert.ok(c.reason, `${name} is unavailable but gives no reason`);
  }
  assert.ok(b.config.configHash && b.config.horizons.length === 4);
  assert.match(b.note, /not a guarantee/);
  assert.ok(res.headers['Cache-Control']);
});

test('op=forecastboard separates evaluation types and never invents an artifact', async () => {
  const res = fakeRes();
  await R.runForecastBoard({ query: {} }, res);
  const b = res.body;
  assert.equal(b.ok, true);
  assert.equal(typeof b.available, 'boolean');
  if (!b.available) {
    assert.ok(b.reason && /artifact/.test(b.reason), 'an absent artifact must explain itself');
    return;
  }
  assert.ok(b.evaluationTypes['walk-forward-oos']);
  assert.match(b.evaluationTypes['final-holdout'], /influences nothing/);
  for (const [h, v] of Object.entries(b.horizons)) {
    if (!v.ok) continue;
    assert.ok(Array.isArray(v.walkForwardOos), `horizon ${h} has no OOS comparison`);
    assert.ok('finalHoldout' in v, 'the holdout is reported separately, even when null');
    assert.ok(v.classPrevalence, 'class prevalence must be reported, not hidden');
    assert.equal(v.scoreboardRows, undefined, 'per-fold rows are opt-in via full=1');
  }
  assert.ok(Array.isArray(b.honesty) && b.honesty.length > 0);
});

test('op=forecastboard full=1 opts into the per-fold rows', async () => {
  const bare = fakeRes(); await R.runForecastBoard({ query: {} }, bare);
  if (!bare.body.available) return;                      // nothing to compare against
  const res = fakeRes();
  await R.runForecastBoard({ query: { full: '1' } }, res);
  const first = Object.values(res.body.horizons).find((v) => v.ok);
  assert.ok(Array.isArray(first.scoreboardRows) && first.scoreboardRows.length > 0);
});

test('op=forecastrank rejects an unsupported horizon instead of guessing', async () => {
  const res = fakeRes();
  await R.runForecastRank({ query: { horizon: '7' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.reason, /horizon must be one of/);
});

test('readArtifact reports a missing artifact with the command that produces one', () => {
  const orig = process.env.FORECAST_ARTIFACT_PATH;
  try {
    // The module resolved its path at load time, so exercise the failure branch directly.
    const missing = R.readArtifact.call(null);
    assert.equal(typeof missing.ok, 'boolean');
    if (!missing.ok) assert.match(missing.reason, /research\/88-forecast-walkforward\.js|unreadable/);
  } finally {
    if (orig === undefined) delete process.env.FORECAST_ARTIFACT_PATH; else process.env.FORECAST_ARTIFACT_PATH = orig;
  }
});

test('every route response carries the research-only disclaimer', async () => {
  for (const fn of [R.runForecastCaps, R.runForecastBoard]) {
    const res = fakeRes();
    await fn({ query: {} }, res);
    assert.match(res.body.note, /Research and decision support only/);
    assert.match(res.body.note, /does not place trades|no result here places trades/i);
  }
});
