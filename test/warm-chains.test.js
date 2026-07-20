const test = require('node:test');
const assert = require('node:assert');
const WC = require('../lib/warm-chains');

// A fake `call` so the runner is testable without network: records paths, returns ok.
const recorder = (opts = {}) => {
  const calls = [];
  const fn = async (path) => {
    calls.push(path);
    if (opts.failOn && opts.failOn.some(f => path.includes(f))) return { ok: false, status: 500 };
    if (opts.throwOn && opts.throwOn.some(f => path.includes(f))) throw new Error('boom');
    if (opts.tick) opts.tick();
    return { ok: true, status: 200 };
  };
  fn.calls = calls;
  return fn;
};
// Deterministic clock — the runner must never read Date.now() itself for the deadline.
const clock = (startAt = 0, stepMs = 0) => {
  let t = startAt;
  return { now: () => t, advance: (ms) => { t += ms; }, auto: () => { t += stepMs; return t; } };
};

test('CHAINS: every declared chain is non-empty and references known ops', () => {
  for (const [name, steps] of Object.entries(WC.CHAINS)) {
    assert.ok(Array.isArray(steps) && steps.length, `${name} must have steps`);
    for (const s of steps) assert.ok(typeof s === 'string' && s.length, `${name} has a bad step`);
  }
});

test('CHAINS: a nested @chain reference always names a chain that exists', () => {
  // A typo here would silently drop an entire branch of the cron.
  for (const [name, steps] of Object.entries(WC.CHAINS)) {
    for (const s of steps) {
      if (s.startsWith('@')) {
        assert.ok(WC.CHAINS[s.slice(1)], `${name} dispatches unknown chain "${s}"`);
      }
    }
  }
});

test('CHAINS: no chain reaches itself (a cycle would recurse until the budget dies)', () => {
  const seen = (name, path = []) => {
    assert.ok(!path.includes(name), `cycle: ${[...path, name].join(' → ')}`);
    for (const s of WC.CHAINS[name] || []) if (s.startsWith('@')) seen(s.slice(1), [...path, name]);
  };
  for (const name of Object.keys(WC.CHAINS)) seen(name);
});

test('runChain: runs its steps IN ORDER', async () => {
  const call = recorder();
  const r = await WC.runChain('decision', { call, now: clock().now });
  assert.deepStrictEqual(
    call.calls.filter(p => !p.includes('warmchain')),
    ['/api/tracker?op=today&log=1', '/api/tracker?op=redundancy&force=1'],
  );
  assert.strictEqual(r.name, 'decision');
  assert.ok(r.steps.every(s => s.status === 'ok' || s.status === 'dispatched'));
});

test('runChain: an unknown chain name is an explicit error, not a silent no-op', async () => {
  const r = await WC.runChain('nope', { call: recorder(), now: clock().now });
  assert.strictEqual(r.ok, false);
  assert.ok(/unknown chain/.test(r.error));
});

test('runChain: a FAILED step does not abort the rest of the chain', async () => {
  // Ledger writes are independent; one bad feed must not cost the whole day.
  const call = recorder({ failOn: ['op=narrative'] });
  const r = await WC.runChain('ledger', { call, now: clock().now });
  const narrative = r.steps.find(s => s.op.includes('narrative'));
  assert.strictEqual(narrative.status, 'http:500');
  assert.ok(r.steps.filter(s => s.status === 'ok').length >= 2, 'later steps still ran');
});

test('runChain: a THROWN step is caught and recorded, never escapes', async () => {
  const call = recorder({ throwOn: ['op=track'] });
  const r = await WC.runChain('ledger', { call, now: clock().now });
  assert.strictEqual(r.steps[0].status, 'error');
  assert.ok(r.ok !== undefined);
});

test('runChain: stops starting steps past the deadline and says so', async () => {
  const c = clock(0);
  const call = recorder({ tick: () => c.advance(20000) }); // each step burns 20s
  const r = await WC.runChain('capture', { call, now: c.now, deadlineMs: 45000 });
  const skipped = r.steps.filter(s => s.status === 'skipped:budget');
  assert.ok(skipped.length > 0, 'a long chain must record budget skips');
  assert.strictEqual(r.complete, false, 'an incomplete chain must not claim completion');
  // The honest bit: what it did NOT run is named, not silently dropped.
  assert.ok(r.skipped.length > 0);
});

test('runChain: a chain that finishes reports complete + no skips', async () => {
  const r = await WC.runChain('pulse', { call: recorder(), now: clock().now, deadlineMs: 50000 });
  assert.strictEqual(r.complete, true);
  assert.deepStrictEqual(r.skipped, []);
});

test('runChain: a nested @chain is dispatched as its own invocation', async () => {
  const call = recorder();
  await WC.runChain('ledger', { call, now: clock().now });
  // ledger hands off to decision — and MUST do it by dispatching a fresh warmchain
  // invocation (its own 60s), not by inlining decision's steps into ledger's budget.
  assert.ok(call.calls.some(p => p.includes('op=warmchain&name=decision')),
    `expected a nested dispatch, got ${JSON.stringify(call.calls)}`);
  assert.ok(!call.calls.some(p => p.includes('op=ensemble')),
    'ledger must NOT inline decision\'s steps — that is the 60s-wall bug this fixes');
});

test('runChain: the deadline is measured from the injected clock, never Date.now()', async () => {
  // Guard: reading the wall clock directly makes the budget untestable and was how the
  // original purge bug hid (ordinals vs real time).
  const c = clock(1_000_000);
  const call = recorder({ tick: () => c.advance(30000) });
  const r = await WC.runChain('pulse', { call, now: c.now, deadlineMs: 10000 });
  assert.ok(r.steps.some(s => s.status === 'skipped:budget'), 'must honour the injected clock');
});

test('chainPaths: warm dispatches only the ROOT chains (nested ones are dispatched by their parent)', () => {
  const roots = WC.ROOT_CHAINS;
  assert.ok(roots.length, 'there must be roots');
  // Anything reachable via @ must NOT also be a root, or it runs twice.
  const nested = new Set();
  for (const steps of Object.values(WC.CHAINS)) for (const s of steps) if (s.startsWith('@')) nested.add(s.slice(1));
  for (const r of roots) assert.ok(!nested.has(r), `${r} is both a root and nested — it would run twice`);
  // Every chain must be reachable, or it silently never runs.
  const reach = new Set();
  const walk = (n) => { if (reach.has(n)) return; reach.add(n); for (const s of WC.CHAINS[n] || []) if (s.startsWith('@')) walk(s.slice(1)); };
  roots.forEach(walk);
  for (const n of Object.keys(WC.CHAINS)) assert.ok(reach.has(n), `chain "${n}" is unreachable — it would never run`);
});

test('reprime: the reprime chain re-fetches today BEFORE priming the ensemble', async () => {
  // op=today's CDN copy carries the PREVIOUS model's credits until refetched, and
  // op=ensemble is a projection of op=today — prime it first and it caches a stale board.
  const call = recorder();
  await WC.runChain('reprime', { call, now: clock().now });
  const real = call.calls.filter(p => !p.includes('warmchain'));
  assert.deepStrictEqual(real, ['/api/tracker?op=today', '/api/tracker?op=ensemble', '/api/tracker?op=challengerlog', '/api/tracker?op=orbitlog', '/api/tracker?op=orbitmltick']);
  // invariant this test protects: today is re-fetched BEFORE the ensemble projection
  assert.ok(real.indexOf('/api/tracker?op=today') < real.indexOf('/api/tracker?op=ensemble'));
});

test('decision: the ensemble is NOT behind the unknown-cost rebuild in one budget', async () => {
  // Regression for the near-miss: decision was today+redundancy+today+ensemble = ~47s
  // against a 48s deadline, so one slow redundancy rebuild would budget-skip the ensemble.
  const call = recorder();
  await WC.runChain('decision', { call, now: clock().now });
  assert.ok(!call.calls.some(p => p.includes('op=ensemble')),
    'ensemble must live in its own invocation, not behind the rebuild');
});

// ── nested-chain failure propagation (finding #1, one level down) ───────────
// A recorder that returns a BODY for nested @chain dispatches, simulating the child's
// own runChain result — so we can prove a nested failure bubbles up to the parent.
const nestedRecorder = (childBodies = {}) => {
  const calls = [];
  const fn = async (path) => {
    calls.push(path);
    const m = path.match(/op=warmchain&name=(\w+)/);
    if (m) return { ok: true, status: 200, body: childBodies[m[1]] || { ok: true, failed: [], skipped: [] } };
    return { ok: true, status: 200 };
  };
  fn.calls = calls;
  return fn;
};

test('PROPAGATE: a nested chain\'s failed step bubbles into the parent, name-prefixed', async () => {
  // ledger → @decision, where decision reported a failed redundancy rebuild.
  const call = nestedRecorder({ decision: { ok: false, failed: ['op=redundancy&force=1'], skipped: [] } });
  const r = await WC.runChain('ledger', { call, now: clock().now });
  assert.strictEqual(r.ok, false, 'a nested failure must fail the parent');
  assert.ok(r.failed.includes('decision/op=redundancy&force=1'),
    `expected the prefixed nested failure, got ${JSON.stringify(r.failed)}`);
});

test('PROPAGATE: a nested chain\'s budget skip bubbles up as a parent skip', async () => {
  const call = nestedRecorder({ decision: { ok: false, failed: [], skipped: ['op=ensemble'] } });
  const r = await WC.runChain('ledger', { call, now: clock().now });
  assert.ok(r.skipped.includes('decision/op=ensemble'));
  assert.strictEqual(r.complete, false);
});

test('PROPAGATE: a healthy nested chain leaves the parent healthy', async () => {
  const call = nestedRecorder({ decision: { ok: true, failed: [], skipped: [] } });
  const r = await WC.runChain('ledger', { call, now: clock().now });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.failed, []);
});

test('PROPAGATE: a nested chain with NO body (child killed) is unknown, not a failure', async () => {
  // The recorder returns no body for the child → honest "dispatched", parent stays ok.
  const call = recorder();
  const r = await WC.runChain('ledger', { call, now: clock().now });
  assert.strictEqual(r.ok, true, 'no body = child still running/killed = not a failure');
});

// ── failDetail: why a step failed, not just that it did ──────────────────────
// Motivated by a real 3-run fail streak in the evolve sub-chain that op=health
// could not diagnose: it reported `evolve/op=evolvescore&log=1` as failed but not
// whether that was a 401, a 504, or a throw — three bugs with three different fixes.

test('failDetail records the STATUS behind each failed step, not just its name', async () => {
  const r = await WC.runChain('researchgrade', { call: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual(r.failed, ['op=researchgrade'], 'names still reported for existing consumers');
  assert.equal(r.failDetail.length, 1);
  assert.equal(r.failDetail[0].op, 'op=researchgrade');
  assert.equal(r.failDetail[0].status, 'http:500', 'the status is what makes it diagnosable');
});

test('failDetail captures a THROWN step\'s error text', async () => {
  const r = await WC.runChain('researchgrade', { call: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(r.failDetail[0].status, 'error');
  assert.match(r.failDetail[0].error, /ECONNRESET/);
});

test('failDetail from a nested chain bubbles up, name-prefixed like failed does', async () => {
  const child = {
    complete: true, failed: ['op=evolvescore&log=1'], skipped: [],
    failDetail: [{ op: 'op=evolvescore&log=1', status: 'http:504', ms: 60000, error: null }],
  };
  const r = await WC.runChain('evolve', {
    call: async (p) => (p.includes('warmchain') ? { ok: true, status: 200, body: child } : { ok: true, status: 200 }),
  });
  const d = r.failDetail.find(x => x.op.endsWith('op=evolvescore&log=1'));
  assert.ok(d, 'nested detail must reach the parent');
  assert.match(d.op, /^postdecision\//, 'prefixed with the child chain name');
  assert.equal(d.status, 'http:504');
});

test('a healthy chain reports an empty failDetail', async () => {
  const r = await WC.runChain('researchgrade', { call: async () => ({ ok: true, status: 200 }) });
  assert.deepEqual(r.failDetail, []);
});

// ── evolve depth guard (508 regression) ──────────────────────────────────────
// evolve was `ledger → @decision → @reprime → @evolve` (4 warmchain hops deep) and
// every step returned Vercel 508 INFINITE_LOOP_DETECTED on every cron run for 4 days.
// Each evolve step self-fetches op=today, which itself fans out to more self-fetches, so
// nested deep the lineage trips the platform's loop guard. It MUST stay a shallow root.
// Empirical basis: op=evolve is 200 shallow, 508 deep.

test('EVOLVE 508 REGRESSION: evolve is a shallow root, never nested under the decision spine', () => {
  assert.ok(WC.ROOT_CHAINS.includes('evolve'), 'evolve must be dispatched by warm directly (shallow)');
  // If any chain hands off to @evolve, evolve is nested again and the 508 returns.
  for (const [name, steps] of Object.entries(WC.CHAINS)) {
    assert.ok(!steps.includes('@evolve'), `${name} hands off to @evolve — re-nesting resurrects the 508`);
  }
});

test('evolve is reachable exactly once (root, not also nested)', () => {
  const nested = new Set();
  for (const steps of Object.values(WC.CHAINS)) for (const s of steps) if (s.startsWith('@')) nested.add(s.slice(1));
  assert.equal(nested.has('evolve'), false, 'evolve must not be an @-target');
  assert.equal(WC.ROOT_CHAINS.filter(r => r === 'evolve').length, 1, 'exactly one root entry');
});

test('detaching evolve did not orphan postdecision', () => {
  // postdecision still runs — now under the evolve root instead of the reprime spine.
  const nested = new Set();
  for (const steps of Object.values(WC.CHAINS)) for (const s of steps) if (s.startsWith('@')) nested.add(s.slice(1));
  assert.ok(nested.has('postdecision'), 'postdecision must still be reachable');
  assert.ok(WC.CHAINS.evolve.includes('@postdecision'), 'via the evolve root');
});
