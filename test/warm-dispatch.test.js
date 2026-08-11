'use strict';
// WARM DISPATCH CONTRACTS — source-text assertions on api/warm.js (the technique
// test/cfl-routes.test.js and test/pulse2-routes.test.js use), pinning the 2026-08-11
// OOM-burst fix: staggered chain dispatch, deferred fire-and-forget kicks, and honest
// grading of a chain-level non-200.
//
// Background: from 2026-08-07 every 22:00 UTC cron OOM-killed a shared /api/tracker
// Fluid instance ("instance was killed because it ran out of available memory"),
// killing whichever unrelated invocations were in flight — ledger/patternlog/
// downdaytick/orbitresolve on 08-10, an invisible post-drain straggler on 08-11.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const WARM = read('api/warm.js');
const CHALLENGER = read('lib/challenger-routes.js');

test('warm staggers root-chain dispatch through dispatchDelayMs (no simultaneous burst)', () => {
  assert.match(WARM, /WC\.dispatchDelayMs\(i\)/, 'chain kicks must consult the wave schedule');
  assert.match(WARM, /await sleep\(delay\)/, 'a non-zero wave delay must actually be awaited');
});

test('warm defers the AI ticks and single-dispatch kicks out of the t=0 burst', () => {
  assert.match(WARM, /AI_TICKS_DELAY_MS = 2 \* WC\.DISPATCH_WAVE_GAP_MS/);
  assert.match(WARM, /SINGLE_KICKS_DELAY_MS = 3 \* WC\.DISPATCH_WAVE_GAP_MS/);
  for (const kick of ['op=putsell', 'op=optionsepisodes&refresh=1', 'op=calibration&force=1', 'op=research&scope=large', 'op=biotechgrade', 'op=optionsassess']) {
    assert.match(WARM, new RegExp(`delayedWarmOne\\('/api/tracker\\?${kick.replace(/[?&=]/g, (m) => '\\' + m)}'`), `${kick} must use the deferred kick`);
  }
  assert.ok(!/\.map\(p => warmOne\(p\)\.catch/.test(WARM), 'aiTicks must not fire immediately');
});

test('a chain-level non-200 WITH a JSON body is graded failed and its error surfaced', () => {
  // The warmchain handler's own catch returns {ok:false, error} with HTTP 500 — that body
  // has no `complete` field, so `b.complete !== false` used to record the crashed chain
  // as complete:true and drop the error text entirely.
  assert.match(WARM, /chainOk \? b\.complete !== false : false/);
  assert.match(WARM, /chainError/);
});

test('challengerlog refuses to immutably record an empty board (503, not ok:true/logged:0)', () => {
  const start = CHALLENGER.indexOf('async function runChallengerLog');
  const end = CHALLENGER.indexOf('async function runChallengerResolve');
  const fn = CHALLENGER.slice(start, end);
  assert.match(fn, /if \(!board\.sourceCount\)/, 'the empty-gather guard must exist');
  assert.match(fn, /status\(503\)/, 'the refusal must be a non-200 so the chain records a stepFail');
});
