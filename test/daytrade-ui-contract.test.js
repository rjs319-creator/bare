'use strict';
// DAY-TRADE UI CONTRACT — (a) unit tests for the pure notification-decision policy
// (public/js/notify-prefs.js, imported as ESM), and (b) text-level source assertions on
// app.js (the established pattern for frontend checks: the render path is string-built, so
// the contract is directly greppable).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const prefsMod = import(path.join(__dirname, '..', 'public', 'js', 'notify-prefs.js'));
const NOW = Date.parse('2026-07-08T14:30:00.000Z');

test('early_watch notifications are OFF by default (opt-in) while confirmed triggers are ON', async () => {
  const { shouldNotify, DEFAULT_PREFS } = await prefsMod;
  assert.equal(DEFAULT_PREFS.earlyWatch, false);
  const early = { id: 'a1', type: 'daytrade', kind: 'early_watch' };
  const entry = { id: 'a2', type: 'daytrade', kind: 'entry' };
  assert.equal(shouldNotify(early, {}, {}, NOW, 10).notify, false);
  assert.equal(shouldNotify(early, {}, {}, NOW, 10).reason, 'class-off:earlyWatch');
  assert.equal(shouldNotify(entry, {}, {}, NOW, 10).notify, true);
  assert.equal(shouldNotify(early, { earlyWatch: true }, {}, NOW, 10).notify, true);
});

test('an already-notified id NEVER re-fires (the 60s re-notification defect)', async () => {
  const { shouldNotify, recordNotified } = await prefsMod;
  const item = { id: 'dup1', type: 'daytrade', kind: 'entry' };
  let state = {};
  assert.equal(shouldNotify(item, {}, state, NOW, 10).notify, true);
  state = recordNotified(state, item, NOW);
  // The exact scenario: same unread item re-evaluated on the next 60s tick.
  assert.equal(shouldNotify(item, {}, state, NOW + 60_000, 10).notify, false);
  assert.equal(shouldNotify(item, {}, state, NOW + 60_000, 10).reason, 'already-notified');
});

test('quiet hours block, including the midnight-wrapping window', async () => {
  const { shouldNotify } = await prefsMod;
  const item = { id: 'q1', type: 'daytrade', kind: 'entry' };
  const prefs = { quietHours: { enabled: true, startET: 20, endET: 7 } };
  assert.equal(shouldNotify(item, prefs, {}, NOW, 22).notify, false);   // evening
  assert.equal(shouldNotify(item, prefs, {}, NOW, 3).notify, false);    // after midnight
  assert.equal(shouldNotify(item, prefs, {}, NOW, 10).notify, true);    // mid-day
  assert.equal(shouldNotify(item, { quietHours: { enabled: false, startET: 20, endET: 7 } }, {}, NOW, 22).notify, true);
});

test('per-hour and per-day caps bound the notification load', async () => {
  const { shouldNotify } = await prefsMod;
  const item = { id: 'c1', type: 'daytrade', kind: 'entry' };
  const hourFull = { sentLog: Array.from({ length: 6 }, (_, i) => NOW - 60_000 * (i + 1)) };
  assert.equal(shouldNotify(item, {}, hourFull, NOW, 10).reason, 'hourly-cap');
  // Spread over the day (under the hourly cap in the last hour, over the daily cap overall).
  const dayFull = { sentLog: Array.from({ length: 20 }, (_, i) => NOW - 3_600_000 * 2 - i * 60_000) };
  assert.equal(shouldNotify(item, {}, dayFull, NOW, 10).reason, 'daily-cap');
});

test('retirement class pref governs retire/caution; non-daytrade items are untouched by class prefs', async () => {
  const { shouldNotify, classOfItem } = await prefsMod;
  assert.equal(classOfItem({ type: 'daytrade', kind: 'retire' }), 'retirement');
  assert.equal(classOfItem({ type: 'daytrade', kind: 'caution' }), 'retirement');
  assert.equal(classOfItem({ type: 'sharp' }), null);
  assert.equal(shouldNotify({ id: 'r1', type: 'daytrade', kind: 'retire' }, { retirement: false }, {}, NOW, 10).notify, false);
  assert.equal(shouldNotify({ id: 's1', type: 'sharp', sev: 'high' }, { retirement: false, earlyWatch: false }, {}, NOW, 10).notify, true);
});

test('global browser-notifications switch gates everything', async () => {
  const { shouldNotify } = await prefsMod;
  assert.equal(shouldNotify({ id: 'g1', type: 'daytrade', kind: 'entry' }, { browserNotifications: false }, {}, NOW, 10).reason, 'browser-notifications-off');
});

// ── Source-contract assertions on the render path ─────────────────────────────
const appSrc = readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

test('app.js fetches the scan-health contract and renders its verdict verbatim', () => {
  assert.ok(appSrc.includes('op=daytradescanhealth'), 'health endpoint is fetched');
  assert.ok(appSrc.includes('_scanHealth'), 'health payload reaches the renderer');
  assert.ok(appSrc.includes('sh.explain'), "the server's novice explain line is rendered verbatim");
});

test('expert diagnostics are gated behind expert-only (novice mode hides them)', () => {
  for (const marker of ['Stage-2 selection diagnostics', 'Discovery diagnostics', 'Expert evidence', 'Missed / Revived — audit lane']) {
    const i = appSrc.indexOf(marker);
    assert.ok(i > 0, `${marker} present`);
    const windowBack = appSrc.slice(Math.max(0, i - 600), i);
    assert.ok(windowBack.includes('expert-only'), `${marker} is inside an expert-only surface`);
  }
});

test('early-watch UI copy never uses buy language', () => {
  for (const snippet of ['watch-only — not an entry', 'watch-only']) {
    assert.ok(appSrc.includes(snippet), `copy present: ${snippet}`);
  }
  // The early-watch alert row builder must not contain buy verbs.
  const start = appSrc.indexOf("if (a.kind === 'early_watch')");
  assert.ok(start > 0);
  const block = appSrc.slice(start, start + 1400);
  assert.ok(!/\bbuy\b|confirmed runner|trigger met/i.test(block), 'no buy language in the early-watch row');
});

test('alert settings panel exposes per-class prefs, quiet hours, caps and background push', () => {
  for (const marker of ['dtAlertPrefs', "chk('earlyWatch'", 'data-dt-pref="quietEnabled"', 'maxPerHour', 'dt-push-toggle', 'op=pushstatus', 'op=pushsubscribe', 'op=pushunsubscribe']) {
    assert.ok(appSrc.includes(marker), `settings marker present: ${marker}`);
  }
});

test('sector residual is surfaced with explicit missingness, never a fabricated zero', () => {
  assert.ok(appSrc.includes("'sector evidence unavailable'"), 'null sector residual reads as unavailable');
});
