'use strict';
// 📡 MARKET PULSE — CLIENT FETCH-TIMEOUT GUARD.
//
// THE REGRESSION (PR #195, 2026-07-23): runPulseUI/refinePulseUI were routed from a bare
// untimed `fetch` onto the shared `fetchJSON`, whose DEFAULT timeout is 20s. But both pulse
// stages make a LIVE bounded LLM call whenever the 4h cache has lapsed, and the SERVER bounds
// itself at GATHER_TIMEOUT_MS=52s / REFINE_TIMEOUT_MS=50s. A 20s client abort therefore fired
// BEFORE the server could ever answer — every cold load rendered "Could not load Market Pulse".
// The only crons are daily, so the 4h cache is stale most of the day => it failed most of the day.
//
// These are SOURCE-SCAN assertions on purpose: the defect is a client-side call-site config
// that no data-layer test can reach (the fetch itself is browser-only). Scanning the call site
// is what actually pins the contract "client timeout > server self-bound".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readJs = f => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const APP_JS = readJs('app.js');
const FETCH_JSON_JS = readJs('fetch-json.js');
const PULSE_ROUTES = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pulse-routes.js'), 'utf8');

const numFrom = (src, name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  assert.ok(m, `could not find constant ${name}`);
  return Number(m[1]);
};

// Every pulse call site, with the guard that each must carry an explicit timeout override.
const PULSE_CALL_SITES = ['op=pulse', 'op=pulserefine'];

test('both pulse fetch call sites pass an explicit timeoutMs override', () => {
  for (const op of PULSE_CALL_SITES) {
    // Arrange: isolate the fetchJSON call for this op (up to the closing paren of the call).
    const idx = APP_JS.indexOf(`fetchJSON('/api/tracker?${op}'`);
    assert.ok(idx > -1, `no fetchJSON call site found for ${op}`);
    const callSite = APP_JS.slice(idx, idx + 220);

    // Assert: it must NOT ride the 20s default.
    assert.match(callSite, /timeoutMs:/, `${op} rides fetchJSON's 20s default — cold loads will abort`);
  }
});

test('the pulse client timeout exceeds BOTH server-side LLM bounds', () => {
  // Arrange
  const clientMs = numFrom(FETCH_JSON_JS, 'HEAVY_TIMEOUT_MS');
  const gatherMs = numFrom(PULSE_ROUTES, 'GATHER_TIMEOUT_MS');
  const refineMs = numFrom(PULSE_ROUTES, 'REFINE_TIMEOUT_MS');

  // Assert: the server must always get to return its own answer (or its last-known-good
  // fallback) before the client gives up — otherwise the fallback path is unreachable.
  assert.ok(clientMs > gatherMs, `client ${clientMs}ms must exceed gather bound ${gatherMs}ms`);
  assert.ok(clientMs > refineMs, `client ${clientMs}ms must exceed refine bound ${refineMs}ms`);
});

test('the pulse client timeout sits above the 60s serverless wall', () => {
  // Arrange
  const VERCEL_WALL_MS = 60000;
  const clientMs = numFrom(FETCH_JSON_JS, 'HEAVY_TIMEOUT_MS');

  // Assert: past the wall the platform itself terminates the function, so the client abort
  // should only ever fire for a genuinely wedged request — never race a live generation.
  assert.ok(clientMs > VERCEL_WALL_MS, `client ${clientMs}ms must exceed the ${VERCEL_WALL_MS}ms wall`);
});

test('THE REGRESSION: the 20s default alone cannot cover a cold pulse generation', () => {
  // Arrange
  const defaultMs = numFrom(FETCH_JSON_JS, 'DEFAULT_TIMEOUT_MS');
  const gatherMs = numFrom(PULSE_ROUTES, 'GATHER_TIMEOUT_MS');

  // Act / Assert: this documents WHY the override is mandatory. If someone ever raises the
  // shared default above the gather bound this test goes stale-green — the call-site test
  // above is what keeps the contract honest in that case.
  assert.ok(defaultMs < gatherMs, 'shared default no longer undercuts the gather bound — revisit this guard');
});

test('fetchJSON still honours a caller-supplied timeoutMs', () => {
  // Arrange / Assert: the override is destructured out of opts and drives the abort timer.
  assert.match(FETCH_JSON_JS, /timeoutMs\s*=\s*DEFAULT_TIMEOUT_MS/, 'timeoutMs is no longer a caller option');
  assert.match(FETCH_JSON_JS, /setTimeout\(\s*\(\)\s*=>\s*ctrl\.abort\(\)\s*,\s*timeoutMs\s*\)/, 'abort timer no longer driven by timeoutMs');
});

// ── The refine GATE ───────────────────────────────────────────────────────────
// SECOND DEFECT (same feature): the client gated the Fable refine pass on `p.persisted`.
// That flag comes from writeVerified's read-back confirmation, which FALSE-NEGATIVES under
// Blob propagation lag — the write lands, the read-back still sees the previous doc. The
// user then silently lost the refined read on that load. Replaced with a generation check,
// which is the property that actually matters and cannot false-negative.

test('refine is NOT gated on the unreliable persisted flag', () => {
  // Arrange: isolate the stage-2 trigger inside runPulseUI.
  const idx = APP_JS.indexOf("if (p && p.ok && p.stage !== 'refined'");
  assert.ok(idx > -1, 'stage-2 refine trigger not found');
  const trigger = APP_JS.slice(idx, idx + 120);

  // Assert: `p.persisted` must not decide whether the refine pass runs.
  assert.ok(!/p\.persisted/.test(trigger), 'refine is still gated on p.persisted — lag will drop the Fable pass');
});

test('refinePulseUI takes the displayed generation and only renders a matching one', () => {
  // Arrange
  assert.match(APP_JS, /async function refinePulseUI\(force, expectedGeneration\)/,
    'refinePulseUI no longer receives the expected generation');

  // Assert: the render is conditioned on generation agreement, so a stale `alreadyRefined`
  // response for a PREVIOUS generation can never repaint over the current draft.
  assert.match(APP_JS, /sameGeneration\s*=\s*!expectedGeneration\s*\|\|\s*!p\?\.generation\s*\|\|\s*p\.generation === expectedGeneration/,
    'generation agreement check missing or altered');
  assert.match(APP_JS, /p\.stage === 'refined' && sameGeneration\) renderPulse\(p\)/,
    'renderPulse is not guarded by the generation check');
});

test('the caller actually passes the generation it rendered', () => {
  // Assert: the guard is inert unless runPulseUI forwards the displayed generation.
  assert.match(APP_JS, /refinePulseUI\(force, p\.generation\)/,
    'runPulseUI does not forward p.generation — the generation guard would be a no-op');
});
