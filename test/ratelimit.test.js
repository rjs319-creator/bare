'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rateLimit, clientKey, _reset } = require('../lib/ratelimit');

test('rateLimit: allows up to the limit, then blocks with a retry hint', () => {
  _reset();
  const cfg = { limit: 3, windowMs: 60000 };
  const t0 = 1_000_000;
  assert.equal(rateLimit('ip1', cfg, t0).ok, true);
  assert.equal(rateLimit('ip1', cfg, t0 + 1).ok, true);
  assert.equal(rateLimit('ip1', cfg, t0 + 2).ok, true);
  const blocked = rateLimit('ip1', cfg, t0 + 3);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);
});

test('rateLimit: window expiry lets the caller through again', () => {
  _reset();
  const cfg = { limit: 1, windowMs: 1000 };
  const t0 = 2_000_000;
  assert.equal(rateLimit('ip2', cfg, t0).ok, true);
  assert.equal(rateLimit('ip2', cfg, t0 + 500).ok, false); // within window
  assert.equal(rateLimit('ip2', cfg, t0 + 1500).ok, true); // window passed
});

test('rateLimit: separate keys are independent', () => {
  _reset();
  const cfg = { limit: 1, windowMs: 1000 };
  assert.equal(rateLimit('a', cfg, 100).ok, true);
  assert.equal(rateLimit('b', cfg, 100).ok, true); // different key, own budget
});

test('clientKey: takes the first forwarded IP, falls back to unknown', () => {
  assert.equal(clientKey({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4');
  assert.equal(clientKey({ headers: {} }), 'unknown');
});
