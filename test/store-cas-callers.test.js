'use strict';
// The read-modify-write callers migrated to store.updateJSON. Each is a genuine MULTI-
// WRITER doc: health/runs.json (Vercel cron + launchd fallback + manual warm can overlap),
// pulse/v2/health.json (every privileged pulse2 tick merges its own component), and
// notify/push-subscriptions.json (any number of browsers subscribe concurrently). Under
// a rival writer landing mid-update, the OLD code lost one side; these prove both survive.

process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
delete process.env.VAPID_PUBLIC_KEY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeBlob } = require('./helpers/fake-blob');

const fake = installFakeBlob();
if (!fake) {
  test('store CAS callers battery (skipped: @vercel/blob not installed — dependency-free CI)', (t) => t.skip());
  return;
}

const STORE = require('../lib/store');
const CAS = require('../lib/store-cas');
const HEALTH = require('../lib/health');
const PULSE2 = require('../lib/pulse2-store');
const PUSH = require('../lib/push-notify');

// Make the migrated callers' retries instant: the sleep is an updateJSON option, so wrap it.
const origUpdate = STORE.updateJSON;
STORE.updateJSON = (path, fn, opts = {}) => origUpdate(path, fn, { sleep: async () => {}, ...opts });

function resetAll() {
  fake.docs.clear();
  fake.putCalls.length = 0;
  fake.hooks.beforePut = null;
  CAS.resetStoreCasStats();
}

const run = (at, ok = true) => ({ at, ok, failCount: ok ? 0 : 1, failed: ok ? [] : ['track'], warmFails: [], stages: {} });

// ── lib/health.writeHealthRun ────────────────────────────────────────────────

test('writeHealthRun: prepends the record and caps the list, via a conditional put', async () => {
  resetAll();
  fake.seed(HEALTH.HEALTH_PATH, { runs: [run('t1')] });
  await HEALTH.writeHealthRun(run('t2'));
  const doc = fake.read(HEALTH.HEALTH_PATH);
  assert.deepEqual(doc.runs.map((r) => r.at), ['t2', 't1']);
  assert.ok(fake.putCalls[0].opts.ifMatch, 'health runs are written compare-and-swap');
  assert.equal(fake.putCalls[0].opts.cacheControlMaxAge, 0);
});

test('writeHealthRun: creates the doc on first use', async () => {
  resetAll();
  await HEALTH.writeHealthRun(run('t1'));
  assert.deepEqual(fake.read(HEALTH.HEALTH_PATH), { runs: [run('t1')] });
});

test('writeHealthRun: caps at 30 runs, newest first', async () => {
  resetAll();
  fake.seed(HEALTH.HEALTH_PATH, { runs: Array.from({ length: 30 }, (_, i) => run(`old${i}`)) });
  await HEALTH.writeHealthRun(run('new'));
  const doc = fake.read(HEALTH.HEALTH_PATH);
  assert.equal(doc.runs.length, 30);
  assert.equal(doc.runs[0].at, 'new');
  assert.equal(doc.runs[29].at, 'old28');
});

test('writeHealthRun: a rival run landing mid-write is NOT lost (the pre-CAS defect)', async () => {
  resetAll();
  fake.seed(HEALTH.HEALTH_PATH, { runs: [run('t1')] });
  fake.hooks.beforePut = async () => { fake.seed(HEALTH.HEALTH_PATH, { runs: [run('rival'), run('t1')] }); };
  await HEALTH.writeHealthRun(run('mine'));
  assert.deepEqual(fake.read(HEALTH.HEALTH_PATH).runs.map((r) => r.at), ['mine', 'rival', 't1']);
  assert.equal(STORE.getStoreCasStats().conflicts, 1);
});

test('writeHealthRun: without a store it is a silent no-op (the cron must never 500 on observability)', async () => {
  resetAll();
  const tok = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try { await HEALTH.writeHealthRun(run('x')); } finally { process.env.BLOB_READ_WRITE_TOKEN = tok; }
  assert.equal(fake.putCalls.length, 0);
});

// ── op=health exposes the CAS counters ───────────────────────────────────────

test('buildHealthResponse carries storeCas counters (per-instance scope stated) and keeps the envelope contract', async () => {
  resetAll();
  fake.seed('x.json', { n: 0 });
  fake.hooks.beforePut = async () => { fake.seed('x.json', { n: 1 }); };
  await STORE.updateJSON('x.json', (c) => ({ n: c.n + 1 }));
  const res = HEALTH.buildHealthResponse([run('t1')], { auth: { ok: true, production: false, secretConfigured: true, warnings: [] } });
  assert.equal(res.ok, true, 'ok stays the hardcoded envelope');
  assert.equal(res.storeCas.conflicts, 1);
  assert.equal(res.storeCas.updates, 1);
  assert.equal(res.storeCas.exhausted, 0);
  assert.equal(res.storeCas.scope, 'instance');
  assert.equal(res.healthy, true, 'conflicts are retried successfully — not a health problem');
});

// ── lib/pulse2-store.mergeHealth ─────────────────────────────────────────────

test('mergeHealth: merges one component into the shared health doc without touching the others', async () => {
  resetAll();
  fake.seed(PULSE2.KEYS.HEALTH, { narratives: { lastRunAt: 'n1' } });
  const ok = await PULSE2.mergeHealth('marketState', { lastTickAt: 'm1' });
  assert.equal(ok, true);
  const doc = fake.read(PULSE2.KEYS.HEALTH);
  assert.deepEqual(doc.narratives, { lastRunAt: 'n1' });
  assert.deepEqual(doc.marketState, { lastTickAt: 'm1' });
  assert.ok(typeof doc.updatedAt === 'string');
  assert.ok(fake.putCalls[0].opts.ifMatch, 'merged compare-and-swap');
});

test('mergeHealth: two components merging concurrently BOTH survive', async () => {
  resetAll();
  fake.seed(PULSE2.KEYS.HEALTH, {});
  fake.hooks.beforePut = async () => { fake.seed(PULSE2.KEYS.HEALTH, { grading: { lastGradeAt: 'g1' } }); };
  assert.equal(await PULSE2.mergeHealth('narratives', { lastRunAt: 'n1' }), true);
  const doc = fake.read(PULSE2.KEYS.HEALTH);
  assert.deepEqual(doc.grading, { lastGradeAt: 'g1' }, 'the rival component\'s record is kept');
  assert.deepEqual(doc.narratives, { lastRunAt: 'n1' });
});

test('mergeHealth: a partial record deep-merges into the existing component record', async () => {
  resetAll();
  fake.seed(PULSE2.KEYS.HEALTH, { narratives: { lastRunAt: 'n1', lastError: 'boom' } });
  await PULSE2.mergeHealth('narratives', { lastError: null });
  assert.deepEqual(fake.read(PULSE2.KEYS.HEALTH).narratives, { lastRunAt: 'n1', lastError: null });
});

test('mergeHealth: returns false (never throws) when every retry is lost', async () => {
  resetAll();
  fake.seed(PULSE2.KEYS.HEALTH, {});
  const rival = async () => { fake.seed(PULSE2.KEYS.HEALTH, { r: Math.random() }); fake.hooks.beforePut = rival; };
  fake.hooks.beforePut = rival;
  assert.equal(await PULSE2.mergeHealth('x', { a: 1 }), false);
  assert.equal(STORE.getStoreCasStats().exhausted, 1);
});

// ── lib/push-notify subscriptions ────────────────────────────────────────────

const SUB_A = { endpoint: 'https://fcm.googleapis.com/fcm/send/aaa', keys: { p256dh: 'pa', auth: 'ka' } };
const SUB_B = { endpoint: 'https://fcm.googleapis.com/fcm/send/bbb', keys: { p256dh: 'pb', auth: 'kb' } };
const SUBS_PATH = 'notify/push-subscriptions.json';

test('addSubscription: two browsers subscribing at the same moment both end up stored', async () => {
  resetAll();
  fake.hooks.beforePut = async () => {
    fake.seed(SUBS_PATH, { subscriptions: [{ id: 'b', endpoint: SUB_B.endpoint, keys: SUB_B.keys, createdAt: 't', lastSuccessAt: null, failures: 0 }], sentIds: [] });
  };
  const r = await PUSH.addSubscription(SUB_A);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  const doc = fake.read(SUBS_PATH);
  assert.deepEqual(doc.subscriptions.map((s) => s.endpoint).sort(), [SUB_A.endpoint, SUB_B.endpoint].sort());
});

test('addSubscription: re-subscribing refreshes keys but keeps identity and createdAt', async () => {
  resetAll();
  fake.seed(SUBS_PATH, { subscriptions: [{ id: 'ida', endpoint: SUB_A.endpoint, keys: { p256dh: 'old', auth: 'old' }, createdAt: 't0', lastSuccessAt: 't1', failures: 3 }], sentIds: ['s1'] });
  const r = await PUSH.addSubscription(SUB_A);
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  const [s] = fake.read(SUBS_PATH).subscriptions;
  assert.deepEqual(s, { id: 'ida', endpoint: SUB_A.endpoint, keys: SUB_A.keys, createdAt: 't0', lastSuccessAt: 't1', failures: 0 });
  assert.deepEqual(fake.read(SUBS_PATH).sentIds, ['s1'], 'the dedup window is preserved');
});

test('removeSubscription: a concurrent add is not erased by the remove', async () => {
  resetAll();
  fake.seed(SUBS_PATH, { subscriptions: [{ id: 'a', endpoint: SUB_A.endpoint, keys: SUB_A.keys, createdAt: 't', lastSuccessAt: null, failures: 0 }], sentIds: [] });
  fake.hooks.beforePut = async () => {
    const cur = fake.read(SUBS_PATH);
    fake.seed(SUBS_PATH, { ...cur, subscriptions: [...cur.subscriptions, { id: 'b', endpoint: SUB_B.endpoint, keys: SUB_B.keys, createdAt: 't', lastSuccessAt: null, failures: 0 }] });
  };
  const r = await PUSH.removeSubscription(SUB_A.endpoint);
  assert.deepEqual(r, { ok: true, removed: true, count: 1 });
  assert.deepEqual(fake.read(SUBS_PATH).subscriptions.map((s) => s.endpoint), [SUB_B.endpoint]);
});

test('removeSubscription: an unknown endpoint writes nothing', async () => {
  resetAll();
  const etag = fake.seed(SUBS_PATH, { subscriptions: [], sentIds: [] });
  const r = await PUSH.removeSubscription('https://nope.example/x');
  assert.deepEqual(r, { ok: true, removed: false, count: 0 });
  assert.equal(fake.putCalls.length, 0);
  assert.equal(fake.etagOf(SUBS_PATH), etag);
});

test('addSubscription: exhausted CAS retries surface as an honest { ok:false, reason } — never a throw', async () => {
  resetAll();
  const rival = async () => { fake.seed(SUBS_PATH, { subscriptions: [], sentIds: [String(Math.random())] }); fake.hooks.beforePut = rival; };
  fake.hooks.beforePut = rival;
  const r = await PUSH.addSubscription(SUB_A);
  assert.equal(r.ok, false);
  assert.match(r.reason, /CAS conflict/);
});
