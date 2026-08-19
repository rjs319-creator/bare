'use strict';
// OOM GUARD — api/tracker was killed 24 times in 11 days (Vercel runtime errors,
// 2026-08-07 → 2026-08-18), five kills landing in the SAME second (22:01:40).
// Simultaneous deaths are the Fluid signature: one instance is killed and takes its
// co-tenant invocations with it, which is why unrelated chains (atlasx, ticks3, swing)
// all returned 500 with complete:null — their work simply never happened.
//
// Two levers, both pinned here:
//   1. tracker runs the whole chain fan-out, so it needs explicit memory headroom
//      rather than the platform default.
//   2. the dispatch burst is flattened — smaller waves, proportionally tighter gap,
//      so the average dispatch RATE is unchanged and warm's drain still hears back.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const WC = require('../lib/warm-chains');

test('api/tracker declares explicit memory headroom — the default is what OOM-killed it', () => {
  const fn = vercel.functions['api/tracker.js'];
  assert.ok(fn, 'api/tracker.js must be configured');
  assert.ok(fn.memory, 'memory must be explicit, not the platform default');
  assert.ok(fn.memory >= 3009, `${fn.memory}MB is not enough headroom for the chain fan-out`);
});

test('the heaviest fan-out endpoints keep their 300s wall alongside the memory bump', () => {
  assert.equal(vercel.functions['api/tracker.js'].maxDuration, 300);
  assert.equal(vercel.functions['api/warm.js'].maxDuration, 300);
});

test('dispatch waves are small enough to flatten the co-tenancy peak', () => {
  assert.ok(WC.DISPATCH_WAVE_SIZE <= 4,
    `wave size ${WC.DISPATCH_WAVE_SIZE} puts too many heavy invocations on one instance at once`);
});

test('flattening the wave does NOT slow the average dispatch rate', () => {
  // 8 chains / 20s and 4 chains / 10s are the same names-per-second; only the
  // instantaneous peak differs. Slowing the rate would push the last wave past
  // warm's drain and reintroduce "dispatched but never heard from".
  const ratePerSec = WC.DISPATCH_WAVE_SIZE / (WC.DISPATCH_WAVE_GAP_MS / 1000);
  assert.ok(ratePerSec >= 0.4, `dispatch rate ${ratePerSec}/s is slower than the 8-per-20s baseline`);
});

test('every root chain still dispatches well inside warm drain after the reshape', () => {
  assert.ok(WC.dispatchDelayMs(WC.ROOT_CHAINS.length - 1) <= 90000);
});

test('the ledger spine still starts in wave 0', () => {
  assert.ok(WC.ROOT_CHAINS.indexOf('ledger') < WC.DISPATCH_WAVE_SIZE);
});
