'use strict';
// lib/push-notify contract tests — the DEGRADED paths are the spec here: no network,
// no web-push dependency assumed installed, no Blob token. What must hold is that the
// module never throws and reports honest machine-readable reasons at every gate.
const test = require('node:test');
const assert = require('node:assert');

// Arrange (global): force the fully-unconfigured local environment BEFORE first use.
// The module reads env lazily per call, but deleting here makes the tests deterministic
// regardless of the developer's shell.
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.VAPID_SUBJECT;
delete process.env.BLOB_READ_WRITE_TOKEN;

const push = require('../lib/push-notify');

const VALID_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'BPk', auth: 'a1' },
};

test('isConfigured() is false without VAPID env', () => {
  assert.strictEqual(push.isConfigured(), false);
});

test('module load and every export are throw-free without env/deps', () => {
  // The feature flag's core promise: absence of config can never crash a caller.
  assert.strictEqual(typeof push.isConfigured, 'function');
  assert.strictEqual(typeof push.sendAlerts, 'function');
  assert.strictEqual(typeof push.addSubscription, 'function');
  assert.strictEqual(typeof push.removeSubscription, 'function');
  assert.strictEqual(typeof push.listSubscriptions, 'function');
  assert.strictEqual(typeof push.status, 'function');
  assert.strictEqual(typeof push.minimizePayload, 'function');
});

// ── addSubscription validation (runs BEFORE the store gate, so testable locally) ──

test('addSubscription rejects a missing/garbage endpoint', async () => {
  assert.deepStrictEqual(await push.addSubscription(null), { ok: false, reason: 'invalid-endpoint' });
  assert.deepStrictEqual(await push.addSubscription({}), { ok: false, reason: 'invalid-endpoint' });
  assert.deepStrictEqual(
    await push.addSubscription({ endpoint: 'not a url', keys: VALID_SUB.keys }),
    { ok: false, reason: 'invalid-endpoint' },
  );
});

test('addSubscription rejects a non-https endpoint', async () => {
  const r = await push.addSubscription({ ...VALID_SUB, endpoint: 'http://push.example.com/x' });
  assert.deepStrictEqual(r, { ok: false, reason: 'insecure-endpoint' });
});

test('addSubscription rejects missing or empty encryption keys', async () => {
  const cases = [
    { ...VALID_SUB, keys: undefined },
    { ...VALID_SUB, keys: {} },
    { ...VALID_SUB, keys: { p256dh: 'BPk' } },          // auth missing
    { ...VALID_SUB, keys: { auth: 'a1' } },             // p256dh missing
    { ...VALID_SUB, keys: { p256dh: '', auth: 'a1' } }, // empty string
    { ...VALID_SUB, keys: { p256dh: 42, auth: 'a1' } }, // wrong type
  ];
  for (const sub of cases) {
    assert.deepStrictEqual(await push.addSubscription(sub), { ok: false, reason: 'missing-keys' });
  }
});

// ── no-store degrade contracts (BLOB_READ_WRITE_TOKEN deleted above) ──

test('addSubscription with a VALID sub degrades to no-store without Blob', async () => {
  assert.deepStrictEqual(await push.addSubscription(VALID_SUB), { ok: false, reason: 'no-store' });
});

test('removeSubscription degrades to no-store without Blob', async () => {
  assert.deepStrictEqual(await push.removeSubscription(VALID_SUB.endpoint), { ok: false, reason: 'no-store' });
});

test('listSubscriptions degrades to no-store without Blob', async () => {
  assert.deepStrictEqual(await push.listSubscriptions(), { ok: false, reason: 'no-store' });
});

// ── payload minimization (pure) ──

test('minimizePayload clips title to 80 and body to 160 chars', () => {
  const p = push.minimizePayload({
    id: 'alert-1', kind: 'entry', sev: 'high',
    title: 'T'.repeat(300), body: 'B'.repeat(500),
  });
  assert.ok(p.title.length <= push.TITLE_MAX);
  assert.ok(p.body.length <= push.BODY_MAX);
  assert.ok(p.title.startsWith('TTT'));
  assert.ok(p.body.startsWith('BBB'));
});

test('minimizePayload passes short text through untouched', () => {
  const p = push.minimizePayload({ id: 'a', kind: 'entry', sev: 'high', title: 'short', body: 'tiny' });
  assert.strictEqual(p.title, 'short');
  assert.strictEqual(p.body, 'tiny');
});

test('minimizePayload emits ONLY {title, body, tag, kind, sev} with tag = alert id', () => {
  // Payload minimization is a privacy contract: nothing beyond these five fields may
  // transit third-party push relays (no plan levels, no endpoints, no extras).
  const p = push.minimizePayload({
    id: 'alert-9', kind: 'early_watch', sev: 'med', title: 't', body: 'b',
    plan: { entry: 1, stop: 2 }, secret: 'leak-me',
  });
  assert.deepStrictEqual(Object.keys(p).sort(), ['body', 'kind', 'sev', 'tag', 'title']);
  assert.strictEqual(p.tag, 'alert-9');
  assert.strictEqual(p.kind, 'early_watch');
  assert.strictEqual(p.sev, 'med');
});

test('minimizePayload tolerates missing fields without throwing', () => {
  const p = push.minimizePayload({});
  assert.strictEqual(p.title, '');
  assert.strictEqual(p.body, '');
  assert.strictEqual(p.tag, '');
  assert.strictEqual(p.kind, null);
  assert.strictEqual(p.sev, null);
});

// ── sendAlerts degrade contract ──

test('sendAlerts returns {sent:0, reason:"not-configured"} without VAPID env', async () => {
  const r = await push.sendAlerts([{ id: 'x', kind: 'entry', sev: 'high', title: 't', body: 'b' }]);
  assert.deepStrictEqual(r, { sent: 0, reason: 'not-configured' });
});

test('sendAlerts never throws on garbage input while unconfigured', async () => {
  assert.deepStrictEqual(await push.sendAlerts(null), { sent: 0, reason: 'not-configured' });
  assert.deepStrictEqual(await push.sendAlerts('nope'), { sent: 0, reason: 'not-configured' });
});

// ── status() diagnostics ──

test('status() shape and honest note while unconfigured', async () => {
  const s = await push.status();
  assert.deepStrictEqual(Object.keys(s).sort(), ['configured', 'dependencyInstalled', 'note', 'subscriptions', 'vapidPresent']);
  assert.strictEqual(s.configured, false);
  assert.strictEqual(s.vapidPresent, false);
  assert.strictEqual(typeof s.dependencyInstalled, 'boolean'); // true iff web-push is installed
  // No Blob token in this environment → subscription count is honestly unknown, not 0.
  assert.strictEqual(s.subscriptions, null);
  // The note must NAME the missing env vars (and never echo values — none exist to echo).
  assert.match(s.note, /VAPID_PUBLIC_KEY/);
  assert.match(s.note, /VAPID_PRIVATE_KEY/);
  assert.match(s.note, /Not configured/);
});
