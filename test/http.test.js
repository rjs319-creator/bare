const { test } = require('node:test');
const assert = require('node:assert');
const { fetchWithTimeout, classifyStatus, classifyError, isRetryableError, backoffMs } = require('../lib/http');

// Swap the global fetch for a scripted stub; each call shifts the next outcome.
function stubFetch(outcomes) {
  const calls = { n: 0 };
  globalThis.fetch = async () => {
    calls.n++;
    const o = outcomes.shift();
    if (o instanceof Error) throw o;
    return o;
  };
  return calls;
}
const resp = (status) => ({ status, ok: status >= 200 && status < 300 });
const netErr = (name = 'TypeError') => Object.assign(new Error('net'), { name });

test('classifyStatus maps HTTP outcomes to categories', () => {
  assert.equal(classifyStatus(resp(200)), 'ok');
  assert.equal(classifyStatus(resp(429)), 'rate_limited');
  assert.equal(classifyStatus(resp(401)), 'auth');
  assert.equal(classifyStatus(resp(403)), 'auth');
  assert.equal(classifyStatus(resp(503)), 'unavailable');
  assert.equal(classifyStatus(resp(404)), 'empty');
  assert.equal(classifyStatus(resp(418)), 'bad_response');
  assert.equal(classifyStatus(null), 'unavailable');
});

test('classifyError distinguishes timeout from other errors', () => {
  assert.equal(classifyError(Object.assign(new Error(), { name: 'TimeoutError' })), 'timeout');
  assert.equal(classifyError(Object.assign(new Error(), { name: 'AbortError' })), 'timeout');
  assert.equal(classifyError(netErr()), 'unavailable');
});

test('isRetryableError: timeouts and network errors are retryable, others not', () => {
  assert.equal(isRetryableError(Object.assign(new Error(), { name: 'TimeoutError' })), true);
  assert.equal(isRetryableError(Object.assign(new Error(), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryableError(new RangeError('x')), false);
});

test('backoffMs stays within the exponential ceiling', () => {
  for (let a = 1; a <= 6; a++) {
    const cap = Math.min(4000, 300 * 2 ** a);
    for (let i = 0; i < 20; i++) assert.ok(backoffMs(a, 300) <= cap);
  }
});

test('no retry by default: a 429 returns immediately', async () => {
  const prev = globalThis.fetch;
  const calls = stubFetch([resp(429)]);
  try {
    const r = await fetchWithTimeout('http://x', {});
    assert.equal(r.status, 429);
    assert.equal(calls.n, 1);
  } finally { globalThis.fetch = prev; }
});

test('retries a 429 then succeeds', async () => {
  const prev = globalThis.fetch;
  const calls = stubFetch([resp(429), resp(500), resp(200)]);
  try {
    const r = await fetchWithTimeout('http://x', { retries: 3, retryBaseMs: 1 });
    assert.equal(r.status, 200);
    assert.equal(calls.n, 3);
  } finally { globalThis.fetch = prev; }
});

test('retries a network error then throws when attempts are exhausted', async () => {
  const prev = globalThis.fetch;
  const calls = stubFetch([netErr(), netErr(), netErr()]);
  try {
    await assert.rejects(() => fetchWithTimeout('http://x', { retries: 2, retryBaseMs: 1 }));
    assert.equal(calls.n, 3); // initial + 2 retries
  } finally { globalThis.fetch = prev; }
});

test('a non-retryable HTTP status (404) is returned without retry', async () => {
  const prev = globalThis.fetch;
  const calls = stubFetch([resp(404)]);
  try {
    const r = await fetchWithTimeout('http://x', { retries: 3, retryBaseMs: 1 });
    assert.equal(r.status, 404);
    assert.equal(calls.n, 1);
  } finally { globalThis.fetch = prev; }
});
