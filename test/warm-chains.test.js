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
  assert.deepStrictEqual(real, ['/api/tracker?op=today', '/api/tracker?op=ensemble', '/api/tracker?op=orbitlog', '/api/tracker?op=orbitmltick']);
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

// ── Expanded-universe refresh throughput (2026-08-05) ───────────────────────
// The chain was already scheduled and completing nightly; it was under-provisioned at
// 2 x 150 names against a multi-thousand candidate list (~3-week refresh cycle), which is
// why the coil vintage gate found the `expanded` cohort five sessions behind and excluded
// it from every ranking.
test('the universe chain scans through NESTED chains so each gets its own invocation wall', () => {
  const steps = WC.CHAINS.universe;
  const nested = steps.filter(s => s.startsWith('@'));
  assert.equal(nested.length, 4, 'four nested scan chains');
  for (const n of nested) {
    const name = n.slice(1);
    assert.ok(WC.CHAINS[name], `${name} must be a defined chain`);
    assert.ok(WC.pathFor(n).includes('op=warmchain&name=' + name), 'a nested step dispatches its own invocation');
  }
});

test('the compile runs strictly AFTER every scan (the parent awaits the nested chains)', () => {
  const steps = WC.CHAINS.universe;
  const lastScan = Math.max(...steps.map((s, i) => (s.startsWith('@') ? i : -1)));
  const compileAt = steps.indexOf('op=universecompile');
  assert.ok(compileAt > lastScan, 'compile must not merge shards the night has not written yet');
  assert.ok(steps.indexOf('op=secmasterbuild') > compileAt);
});

test('every scan step targets a DISTINCT deterministic slot at the 200-name cap', () => {
  // Audit 2026-08-14: the shared Blob cursor this test used to pin was the bug — an
  // overwritten cursor propagates with a 10-30s+ read-back lag, so back-to-back steps
  // read the SAME cursor and re-scanned the same slice (halving the claimed coverage).
  // slot=N is a pure function of (epoch day, slot): nothing stored, nothing to lag.
  const scanChains = ['universescan1', 'universescan2', 'universescan3', 'universescan4'];
  const slots = [];
  let total = 0;
  for (const c of scanChains) {
    for (const step of WC.CHAINS[c]) {
      const m = step.match(/^op=universescan&slot=(\d+)&limit=200$/);
      assert.ok(m, `slot mode keeps same-night scans collision-free with no Blob dependency: ${step}`);
      slots.push(Number(m[1]));
      total += 200;
    }
  }
  assert.equal(new Set(slots).size, slots.length, 'each step must own its own slot');
  assert.equal(total, 1600, 'nightly coverage: 1,600 names (was 300)');
});

test('the nested scan chains are NOT root chains (only the parent dispatches them)', () => {
  for (const n of ['universescan1', 'universescan2', 'universescan3', 'universescan4']) {
    assert.ok(!WC.ROOT_CHAINS.includes(n), `${n} must not be dispatched independently of its parent`);
  }
  assert.ok(WC.ROOT_CHAINS.includes('universe'));
});

test('no nested scan chain can exceed its own invocation budget', () => {
  // Each scan self-bounds at 45s (lib/universe-routes). Under the 300s function wall
  // (vercel.json) the chain deadline is 240s, so both scans in a nested chain now run to
  // completion (at the old 48s deadline the second scan started at ~45s and squeaked in);
  // the work stays spread across chains so no single invocation carries the whole night.
  for (const n of ['universescan1', 'universescan2', 'universescan3', 'universescan4']) {
    assert.ok(WC.CHAINS[n].length <= 2, `${n} must stay at 2 steps to fit one invocation`);
  }
  // Deadline must leave headroom under the 300s wall for one slow awaited step started
  // near the deadline — a hard wall kill is a 504 that persists no report at all.
  assert.ok(WC.CHAIN_DEADLINE_MS <= 240000, 'chain deadline must leave >=60s headroom under the 300s function wall');
});

test('the universe chain refreshes its candidate list BEFORE scanning (op=universebuild first)', () => {
  // universe/candidates.json was never wired to a cron and silently aged 29 days past the
  // 10-day staleness bound data-health itself enforces. The build is the cheap free-
  // directory ingest, so it leads the chain: scans below always draw from a fresh list.
  assert.equal(WC.CHAINS.universe[0], 'op=universebuild');
  assert.ok(WC.CHAINS.universe.includes('op=universecompile'));
  assert.ok(WC.CHAINS.universe.indexOf('op=universebuild') < WC.CHAINS.universe.indexOf('@universescan1'));
});

test('dispatchDelayMs: the first wave dispatches immediately, later waves are gapped', () => {
  // The 2026-08-07→11 OOM regression: all roots fired at t=0 shared Fluid instances and
  // the instance was killed out-of-memory on every cron run, taking unrelated in-flight
  // invocations with it. Waves are the fix — wave membership must be stable arithmetic.
  const { dispatchDelayMs, DISPATCH_WAVE_SIZE, DISPATCH_WAVE_GAP_MS } = WC;
  for (let i = 0; i < DISPATCH_WAVE_SIZE; i++) assert.equal(dispatchDelayMs(i), 0, `index ${i} is wave 0`);
  assert.equal(dispatchDelayMs(DISPATCH_WAVE_SIZE), DISPATCH_WAVE_GAP_MS);
  assert.equal(dispatchDelayMs(2 * DISPATCH_WAVE_SIZE), 2 * DISPATCH_WAVE_GAP_MS);
  // Monotone: a later chain never dispatches before an earlier one.
  for (let i = 1; i < WC.ROOT_CHAINS.length; i++) {
    assert.ok(dispatchDelayMs(i) >= dispatchDelayMs(i - 1), `delay must be monotone at ${i}`);
  }
});

test('dispatchDelayMs: every root chain is dispatched well inside warm\'s 280s drain', () => {
  const last = dispatchDelayLast();
  assert.ok(last <= 90000, `last wave at ${last}ms leaves too little of the 280s drain to hear reports`);
  function dispatchDelayLast() { return WC.dispatchDelayMs(WC.ROOT_CHAINS.length - 1); }
});

test('dispatchDelayMs: degenerate options never divide by zero or go negative', () => {
  assert.equal(WC.dispatchDelayMs(5, { waveSize: 0, waveGapMs: 1000 }), 5000);
  assert.equal(WC.dispatchDelayMs(-3), 0);
  assert.equal(WC.dispatchDelayMs(9, { waveGapMs: -50 }), 0);
});

test('the heavy decision spine (ledger) dispatches in wave 0', () => {
  // ledger → @decision → @reprime is the one lineage that uses most of its 240s budget;
  // starting it in a later wave would push its report past warm's drain ceiling.
  assert.ok(WC.ROOT_CHAINS.indexOf('ledger') < WC.DISPATCH_WAVE_SIZE);
});

test('ticks3 forces the challenger eval strictly AFTER the resolve that feeds it', () => {
  // The eval endpoint returns its cache unless force=1 — no cron forced it before
  // 2026-08-11, so it sat at its first-ever computation (n=0) while 109 resolved
  // outcomes accrued invisibly. It must recompute nightly, after resolution.
  const t3 = WC.CHAINS.ticks3;
  const resolveIdx = t3.indexOf('op=challengerresolve');
  const evalIdx = t3.indexOf('op=challengereval&force=1');
  assert.ok(resolveIdx >= 0, 'challengerresolve must stay in ticks3');
  assert.ok(evalIdx > resolveIdx, 'challengereval&force=1 must run after challengerresolve');
});

// 🚨 Audit 2026-08-14: an awaited @child used to claim a FRESH full deadline regardless of
// how much the parent had already spent — a parent 200s in could await a child entitled
// to 240s more, blowing the parent's 300s wall mid-await (504, no report persisted).
// A nested dispatch now hands the child the parent's REMAINING budget.
test('runChain: a nested @chain inherits the parent\'s REMAINING budget, not a fresh deadline', async () => {
  const c = clock(0);
  const call = recorder({ tick: () => c.advance(60000) }); // each step burns 60s
  await WC.runChain('ledger', { call, now: c.now, deadlineMs: 240000 });
  const nested = call.calls.filter(p => p.includes('op=warmchain'));
  assert.ok(nested.length > 0, 'ledger must dispatch at least one nested chain');
  for (const p of nested) {
    const m = p.match(/budgetMs=(\d+)/);
    assert.ok(m, `nested dispatch must carry budgetMs: ${p}`);
    assert.ok(Number(m[1]) < 240000, `inherited budget must be less than a fresh deadline: ${p}`);
  }
});

test('pathFor: budgetMs rides only on nested dispatches, and only when given', () => {
  assert.ok(!WC.pathFor('@decision').includes('budgetMs'), 'no budget given → no param (root dispatch)');
  assert.ok(WC.pathFor('@decision', 120000).includes('budgetMs=120000'));
  assert.ok(!WC.pathFor('op=track', 120000).includes('budgetMs'), 'plain ops never carry it');
});

// 🚨 Review 2026-08-15: falsy-zero budget hand-off. A parent dispatching at exactly
// elapsed === deadlineMs sends budgetMs=0 (pathFor clamps at 0), and the child guard
// `inheritedMs > 0` read 0 as "absent" → granted the FULL fresh 240s — the exact
// parent-wall blowup the parameter exists to prevent. Any finite budget >= 0 now counts
// as inherited and clamps to the 15s floor.
test('inheritedDeadlineMs: budgetMs=0 is INHERITED (15s floor), never a fresh full deadline', () => {
  const WCR = require('../lib/warm-chains-routes');
  assert.equal(WCR.inheritedDeadlineMs('0'), WCR.CHILD_DEADLINE_FLOOR_MS, 'zero budget → floor, not full deadline');
  assert.equal(WCR.inheritedDeadlineMs(0), WCR.CHILD_DEADLINE_FLOOR_MS);
  assert.equal(WCR.CHILD_DEADLINE_FLOOR_MS, 15000);
});

test('inheritedDeadlineMs: absent/garbage budget keeps the full deadline; real budgets clamp to [floor, deadline]', () => {
  const WCR = require('../lib/warm-chains-routes');
  assert.equal(WCR.inheritedDeadlineMs(undefined), WC.CHAIN_DEADLINE_MS, 'root dispatch (no param) → full deadline');
  assert.equal(WCR.inheritedDeadlineMs(''), WC.CHAIN_DEADLINE_MS);
  assert.equal(WCR.inheritedDeadlineMs('nope'), WC.CHAIN_DEADLINE_MS);
  assert.equal(WCR.inheritedDeadlineMs('-5000'), WC.CHAIN_DEADLINE_MS, 'pathFor never emits a negative — treat as absent');
  assert.equal(WCR.inheritedDeadlineMs('120000'), 120000, 'a real remaining budget passes through');
  assert.equal(WCR.inheritedDeadlineMs('7000'), WCR.CHILD_DEADLINE_FLOOR_MS, 'tiny budgets floor at 15s');
  assert.equal(WCR.inheritedDeadlineMs(String(WC.CHAIN_DEADLINE_MS * 2)), WC.CHAIN_DEADLINE_MS, 'never above a fresh deadline');
});

test('runWarmChain passes the inherited (floored) deadline into runChain — budgetMs=0 wiring end to end', async () => {
  // Patch runChain on the shared warm-chains exports BEFORE the routes module loads and
  // destructures it, then restore. Proves the route actually uses inheritedDeadlineMs.
  const routesPath = require.resolve('../lib/warm-chains-routes');
  const realRunChain = WC.runChain;
  const seen = [];
  WC.runChain = async (name, opts) => { seen.push(opts.deadlineMs); return { name, complete: true, failed: [], skipped: [], steps: [], elapsedMs: 1 }; };
  delete require.cache[routesPath];
  try {
    const R = require(routesPath);
    const mkRes = () => ({ headers: {}, code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } });
    await R.runWarmChain({ query: { name: 'pulse', budgetMs: '0' } }, mkRes());
    await R.runWarmChain({ query: { name: 'pulse' } }, mkRes());
    assert.equal(seen[0], 15000, 'budgetMs=0 → 15s floor reaches runChain');
    assert.equal(seen[1], WC.CHAIN_DEADLINE_MS, 'absent budget → full deadline reaches runChain');
  } finally {
    WC.runChain = realRunChain;
    delete require.cache[routesPath];
  }
});


// ── op=challengerlog MUST be dispatched shallow ─────────────────────────────
// It ran at `ledger → @decision → @reprime → op=challengerlog`, three hops deep, and
// self-fetches 18 endpoints (including op=today, which fans out further). Every night it
// returned 503 "no ranked signals gathered (0/18 answered, 0 barren)" in ~2s — 0 of 18, at
// ~110ms each. Not a timeout (the budget is 25s with a retry) and not a data problem:
// every one of those sources returns 200 with a real payload when called directly. Same
// shallow-works/deep-fails signature `evolve` showed at the same depth, and the same fix.
test('op=challengerlog is a ROOT step, never nested behind warmchain hops', () => {
  // Depth of the chain each op is reachable at: roots are depth 1.
  const depth = new Map();
  const walk = (name, d) => {
    if (depth.has(name) && depth.get(name) <= d) return;
    depth.set(name, d);
    for (const step of WC.CHAINS[name] || []) if (step.startsWith('@')) walk(step.slice(1), d + 1);
  };
  WC.ROOT_CHAINS.forEach(r => walk(r, 1));

  const owners = Object.entries(WC.CHAINS)
    .filter(([, steps]) => steps.some(s => s === 'op=challengerlog'))
    .map(([name]) => name);
  assert.deepStrictEqual(owners, ['challenger'], 'exactly one chain runs it');
  assert.strictEqual(depth.get('challenger'), 1, 'and that chain is dispatched as a root');
  assert.ok(WC.ROOT_CHAINS.includes('challenger'));
});

test('the challenger root is dispatched in the LAST wave, after the decision spine', () => {
  // As a root it races the spine, so it must gather as late as possible: op=today should
  // have been re-primed by then. `ledger` stays first for the opposite reason.
  const i = WC.ROOT_CHAINS.indexOf('challenger');
  assert.strictEqual(i, WC.ROOT_CHAINS.length - 1, 'last root');
  assert.ok(WC.dispatchDelayMs(i) >= WC.dispatchDelayMs(WC.ROOT_CHAINS.indexOf('ledger')) + 60000,
    'gathers at least a minute after the spine starts');
});
