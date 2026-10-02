'use strict';
// A HUNG STEP MUST NOT TAKE THE CHAIN'S REPORT WITH IT (site audit 2026-10-02).
//
// On the 2026-10-01 cron the pattern / pitdata / pulse2 / challenger chains "never persisted a
// report for this run": runChain refused to START a step past its 240s deadline, but a step
// already in flight had no AbortSignal and held the chain to the tracker's 300s wall, where
// the invocation was killed before the report write. Each step now gets the chain's remaining
// budget as an abort budget, an aborted step is recorded as `aborted:budget`, and the report
// still lands.
const test = require('node:test');
const assert = require('node:assert/strict');
const WC = require('../lib/warm-chains');
const ROUTES = require('../lib/warm-chains-routes');

// Deterministic clock: each read advances by `stepMs`.
const clock = (stepMs = 10) => { let t = 0; return () => (t += stepMs); };

// A TimeoutError in the shape AbortSignal.timeout rejects with.
const timeoutError = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };

test('runChain hands every step the chain\'s remaining budget (floored), as { budgetMs }', async () => {
  // Arrange: capture the second argument of every call.
  const seen = [];
  const call = async (path, opts) => { seen.push({ path, opts }); return { ok: true, status: 200 }; };
  const steps = WC.CHAINS.capture;

  // Act
  await WC.runChain('capture', { call, now: clock(1000), deadlineMs: 100000 });

  // Assert
  assert.equal(seen.length, steps.length);
  for (const s of seen) {
    assert.ok(s.opts && Number.isFinite(s.opts.budgetMs), `step ${s.path} got no budgetMs`);
    assert.ok(s.opts.budgetMs >= WC.STEP_BUDGET_FLOOR_MS, 'budget below the floor');
    assert.ok(s.opts.budgetMs <= 100000, 'budget above the chain deadline');
  }
  // Budgets shrink as the chain progresses (each clock read costs 1s here).
  assert.ok(seen[seen.length - 1].opts.budgetMs < seen[0].opts.budgetMs);
});

test('an aborted step is recorded as aborted:budget, counts as failed, and the chain goes on', async () => {
  // Arrange: the first op of the chain hangs until its budget aborts it; the rest answer.
  const steps = WC.CHAINS.capture;
  const hang = steps[0];
  const c = clock(10);
  const call = async (path, { budgetMs }) => {
    if (path.includes(hang)) { for (let i = 0; i < budgetMs / 10; i++) c(); throw timeoutError(); }
    return { ok: true, status: 200 };
  };

  // Act
  const r = await WC.runChain('capture', { call, now: c, deadlineMs: 60000 });

  // Assert: named as an abort (not a generic error), failed, with the budget in the reason.
  const aborted = r.steps.find(s => s.op === hang);
  assert.equal(aborted.status, 'aborted:budget');
  assert.match(aborted.error, /budget/);
  assert.ok(r.failed.includes(hang));
  assert.equal(r.ok, false);
  // The remaining steps were still attempted (or budget-skipped) — never silently dropped.
  assert.equal(r.steps.length, steps.length);
  assert.ok(r.steps.slice(1).every(s => s.status === 'ok' || s.status === 'skipped:budget'));
});

test('call() aborts a never-resolving fetch at its budget instead of hanging', async () => {
  // Arrange: a fetch stub that only ever settles when its signal aborts.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    const t0 = Date.now();
    // Act + Assert
    await assert.rejects(ROUTES.call('/api/tracker?op=hang', { budgetMs: 40 }), (e) => e && e.name === 'TimeoutError');
    assert.ok(Date.now() - t0 < 2000, 'the abort did not fire near its budget');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('runWarmChain persists the partial report when a step aborts', async () => {
  // Arrange: stub the store so the durable report write is observable, and a step runner
  // whose first step aborts (the shape call() throws after AbortSignal.timeout fires).
  const store = require('../lib/store');
  const orig = { hasStore: store.hasStore, writeJSON: store.writeJSON };
  const writes = [];
  store.hasStore = () => true;
  store.writeJSON = async (p, doc) => { writes.push({ p, doc }); return { url: p }; };
  const hang = WC.CHAINS.capture[0];
  const callStep = async (path) => { if (path.includes(hang)) throw timeoutError(); return { ok: true, status: 200, body: { ok: true } }; };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const info = console.info; console.info = () => {};
  try {
    // Act
    await ROUTES.runWarmChain({ query: { name: 'capture' } }, res, { call: callStep });
  } finally {
    console.info = info;
    store.hasStore = orig.hasStore; store.writeJSON = orig.writeJSON;
  }

  // Assert: 200 with the aborted step named, AND the compact report reached the store.
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.failed.includes(hang));
  const report = writes.find(w => w.p === ROUTES.chainReportPath('capture'));
  assert.ok(report, 'chain report was not persisted');
  assert.equal(report.doc.complete, true, 'an aborted step is a failure, not an incomplete run');
  assert.ok(report.doc.failed.includes(hang));
  assert.equal(report.doc.failDetail.find(d => d.op === hang).status, 'aborted:budget');
});
