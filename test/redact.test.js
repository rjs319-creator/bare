'use strict';
// Secret redaction (Phase 10): no API key may appear in errors, output, manifests or
// snapshots — this is the mechanism, not a convention.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, redactedMessage, MASK } = require('../lib/redact');

test('a configured secret value is masked wherever it appears', () => {
  process.env.FMP_API_KEY = 'sk_test_ABCDEF123456';
  try {
    const msg = `fetch failed: https://financialmodelingprep.com/stable/quote?symbol=SPY&apikey=sk_test_ABCDEF123456 (429)`;
    const out = redactSecrets(msg);
    assert.ok(!out.includes('sk_test_ABCDEF123456'));
    assert.ok(out.includes(MASK));
  } finally { delete process.env.FMP_API_KEY; }
});

test('key-shaped query params are masked even when the env var is not set', () => {
  const out = redactSecrets('GET https://example.com/api?symbol=SPY&apikey=whatever-key&x=1');
  assert.ok(!out.includes('whatever-key'));
  assert.ok(out.includes(`apikey=${MASK}`));
  assert.ok(out.includes('x=1'), 'non-secret params survive');
});

test('short/missing env secrets can never become match-everything patterns', () => {
  process.env.CRON_SECRET = 'abc';   // < 8 chars — must be ignored, not split on
  try {
    assert.equal(redactSecrets('abcabc plain text'), 'abcabc plain text');
  } finally { delete process.env.CRON_SECRET; }
});

test('redactedMessage takes the message only, never a stack', () => {
  const err = new Error('boom token=SECRETVALUE123');
  const out = redactedMessage(err);
  assert.ok(!/at .*\(/.test(out), 'no stack frames');
  assert.ok(out.includes(`token=${MASK}`));
});
