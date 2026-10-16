'use strict';
// TRANSPORT SUCCESS IS NOT APPLICATION SUCCESS (lib/warm-chains.js runChain, 2026-10-04).
//
// Reproduced before the fix with an injected `call`: every step answering HTTP 200 with
// `{ok:false, error:'Blob storage not configured.'}` graded the chain ok:true/complete:true;
// a nested child answering 503 `{ok:false, error:'server authorization not configured'}` with
// no failed[] graded the parent ok:true; a 200 with no parseable body graded ok. All three
// are now pinned to their honest verdicts. Injected clock, mocked I/O, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const WC = require('../lib/warm-chains');

const clock = () => { let t = 0; return () => (t += 10); };
const leaf = (body, status = 200) => ({ ok: status < 400, status, body, raw: status < 400 ? null : JSON.stringify(body) });
// A `call` in the exact shape lib/warm-chains-routes.js call() produces (body ALWAYS present).
const byOp = (map, fallback = leaf({ ok: true })) => async (path) => {
  const m = /op=([^&]+)/.exec(path);
  const key = m && m[1] === 'warmchain' ? `@${/name=(\w+)/.exec(path)[1]}` : (m ? m[1] : path);
  return map[key] || fallback;
};
// A flat chain with ≥2 independent leaf steps and NO declared prerequisites (so every step is graded on its own).
const flat = Object.keys(WC.CHAINS).find((n) => WC.CHAINS[n].every((s) => !s.startsWith('@')) && WC.CHAINS[n].length >= 2 && !WC.STEP_REQUIRES[n]);
const nested = Object.keys(WC.CHAINS).find((n) => WC.CHAINS[n].some((s) => s.startsWith('@')));
const opOf = (step) => /op=([^&]+)/.exec(step)[1];

test('D1: HTTP 200 with body ok:false is an APPLICATION failure, carrying the body\'s own reason', async () => {
  const r = await WC.runChain(flat, { now: clock(), call: byOp({}, leaf({ ok: false, error: 'Blob storage not configured.' })) });
  assert.equal(r.ok, false);
  assert.ok(r.failed.length === WC.CHAINS[flat].length, 'every step failed');
  assert.ok(r.steps.every((s) => s.status === 'app:failed'), JSON.stringify(r.steps.map((s) => s.status)));
  assert.match(r.failDetail[0].error, /Blob storage not configured/);
  assert.equal(r.complete, true, 'every step RAN to a known outcome — it just failed');
});

test('D1: a step that failed does not abort the rest; later ok steps still run and are ok', async () => {
  const [first, second] = WC.CHAINS[flat];
  const r = await WC.runChain(flat, { now: clock(), call: byOp({ [opOf(first)]: leaf({ ok: false, error: 'no SPY history' }) }) });
  assert.deepEqual(r.failed, [first]);
  assert.equal(r.steps.find((s) => s.op === second).status, 'ok');
});

test('D2: a 200 with no parseable body is UNKNOWN — never a failure, never success, chain incomplete', async () => {
  const r = await WC.runChain(flat, { now: clock(), call: byOp({}, { ok: true, status: 200, body: null, raw: null }) });
  assert.equal(r.ok, false); assert.equal(r.complete, false);
  assert.deepEqual(r.failed, [], 'unknown is not failure');
  assert.deepEqual(r.unknown, WC.CHAINS[flat]);
  assert.ok(r.steps.every((s) => s.status === 'unknown:no-body'));
});

test('D2 (legacy fakes): a transport-only `{ok, status}` result with NO body key is graded by status, as before', async () => {
  const r = await WC.runChain(flat, { now: clock(), call: async () => ({ ok: true, status: 200 }) });
  assert.equal(r.ok, true); assert.equal(r.complete, true); assert.deepEqual(r.unknown, []);
});

test('D3: a nested child answering a NON-200 (503, no failed[]) fails the parent with the child\'s reason', async () => {
  const child = leaf({ ok: false, error: 'server authorization not configured' }, 503);
  const r = await WC.runChain(nested, { now: clock(), call: byOp({ [`@${WC.CHAINS[nested].find((s) => s.startsWith('@')).slice(1)}`]: child }) });
  assert.equal(r.ok, false);
  const step = WC.CHAINS[nested].find((s) => s.startsWith('@'));
  assert.ok(r.failed.includes(step), `nested dispatch must be in failed: ${JSON.stringify(r.failed)}`);
  const d = r.failDetail.find((x) => x.op === step);
  assert.equal(d.status, 'http:503'); assert.match(d.error, /authorization/);
});

test('D3: a nested child 504 with a non-JSON body is a failure too (http:504), not "dispatched"', async () => {
  const step = WC.CHAINS[nested].find((s) => s.startsWith('@'));
  const r = await WC.runChain(nested, { now: clock(), call: byOp({ [step]: { ok: false, status: 504, body: null, raw: '<html>gateway timeout' } }) });
  assert.ok(r.failed.includes(step)); assert.equal(r.failDetail.find((x) => x.op === step).status, 'http:504');
});

test('D3: a nested child 200 that says ok:false and names NOTHING is an application failure', async () => {
  const step = WC.CHAINS[nested].find((s) => s.startsWith('@'));
  const r = await WC.runChain(nested, { now: clock(), call: byOp({ [step]: leaf({ ok: false, name: step.slice(1), error: 'unknown chain' }) }) });
  assert.ok(r.failed.includes(step)); assert.equal(r.steps.find((s) => s.op === step).status, 'app:failed');
});

test('D3: a nested child with NO body is UNKNOWN (status dispatched), the parent is incomplete and not ok', async () => {
  const step = WC.CHAINS[nested].find((s) => s.startsWith('@'));
  const r = await WC.runChain(nested, { now: clock(), call: byOp({ [step]: { ok: true, status: 200, body: null, raw: null } }) });
  assert.equal(r.ok, false); assert.equal(r.complete, false);
  assert.deepEqual(r.unknown, [step]); assert.ok(!r.failed.includes(step), 'unknown is not failure');
  assert.equal(r.steps.find((s) => s.op === step).status, 'dispatched');
});

test('D3: a child\'s own unknown/blocked lists bubble up name-prefixed, and make the parent incomplete', async () => {
  const step = WC.CHAINS[nested].find((s) => s.startsWith('@'));
  const child = leaf({ ok: false, complete: false, failed: [], skipped: [], unknown: ['op=x'], blocked: ['op=y'] });
  const r = await WC.runChain(nested, { now: clock(), call: byOp({ [step]: child }) });
  assert.deepEqual(r.unknown, [`${step.slice(1)}/op=x`]); assert.deepEqual(r.blocked, [`${step.slice(1)}/op=y`]);
  assert.equal(r.complete, false); assert.equal(r.ok, false); assert.deepEqual(r.failed, []);
});

test('benign ok:false shapes are graded skipped:noop, listed under benign[], and keep the chain ok', async () => {
  const r = await WC.runChain('optionsv2', { now: clock(), call: byOp({
    optionsscan2: leaf({ ok: false, disabled: true, note: 'OPTIONS_V2_MODE=off' }),
    optionsresolve2: leaf({ ok: false, disabled: true }),
  }) });
  assert.equal(r.ok, true); assert.equal(r.complete, true); assert.deepEqual(r.failed, []);
  assert.deepEqual(r.benign, [{ op: 'op=optionsscan2', reason: 'disabled' }, { op: 'op=optionsresolve2', reason: 'disabled' }]);
  assert.ok(r.steps.every((s) => s.status === 'skipped:noop'));
  const p2 = await WC.runChain('pulse2', { now: clock(), call: byOp({ pulse2refine: leaf({ ok: false, superseded: true }) }) });
  assert.equal(p2.ok, true); assert.deepEqual(p2.benign, [{ op: 'op=pulse2refine', reason: 'superseded' }]);
  const p1 = await WC.runChain('pulse', { now: clock(), call: byOp({ pulserefine: leaf({ ok: false, needsDraft: true, error: 'no draft to refine' }) }) });
  assert.equal(p1.ok, true); assert.deepEqual(p1.benign, [{ op: 'op=pulserefine&force=1', reason: 'needs-draft' }]);
});

test('benignNoop: only an explicit marker on an ok:false body is benign', () => {
  assert.equal(WC.benignNoop({ ok: false, disabled: true }), 'disabled');
  assert.equal(WC.benignNoop({ ok: false, error: 'Blob storage not configured.' }), null);
  assert.equal(WC.benignNoop({ ok: true, disabled: true }), null, 'an ok body needs no excuse');
  assert.equal(WC.benignNoop(null), null);
  assert.equal(WC.benignNoop({ ok: false, disabled: 'yes' }), null, 'markers are strict booleans');
});

test('blocked dependency: a declared dependent is BLOCKED when its prerequisite failed, and the chain is incomplete', async () => {
  const r = await WC.runChain('router', { now: clock(), call: byOp({ router: leaf({ ok: false, error: 'candles unavailable' }) }) });
  assert.deepEqual(r.failed, ['op=router&force=1'], 'the root cause is the only failure (no double count)');
  assert.deepEqual(r.blocked, ['op=routercf&force=1']);
  const b = r.steps.find((s) => s.op === 'op=routercf&force=1');
  assert.equal(b.status, 'blocked:prerequisite'); assert.deepEqual(b.blockedBy, ['op=router&force=1']);
  assert.equal(r.complete, false); assert.equal(r.ok, false);
});

test('blocked dependency: an UNKNOWN prerequisite blocks too; a benign no-op prerequisite does not', async () => {
  const unk = await WC.runChain('pulse2', { now: clock(), call: byOp({ pulse2collect: { ok: true, status: 200, body: null, raw: null } }) });
  assert.deepEqual(unk.blocked, ['op=pulse2refine']); assert.deepEqual(unk.unknown, ['op=pulse2collect']);
  const fine = await WC.runChain('pulse2', { now: clock(), call: byOp({ pulse2collect: leaf({ ok: false, noop: true }) }) });
  assert.deepEqual(fine.blocked, []); assert.equal(fine.ok, true);
});

test('blocked dependency: independent steps are NOT blocked — ledger\'s @decision still runs after op=track fails (decision of record)', async () => {
  const seen = [];
  const call = async (path) => { seen.push(path); return /op=track/.test(path) ? leaf({ ok: false, error: 'no picks' }) : leaf({ ok: true, failed: [], skipped: [] }); };
  const r = await WC.runChain('ledger', { now: clock(), call });
  assert.ok(seen.some((p) => /op=warmchain&name=decision/.test(p)), '@decision was dispatched');
  assert.deepEqual(r.blocked, []); assert.deepEqual(r.failed, ['op=track']);
});

test('STEP_REQUIRES only names steps that exist in their chain, in dependency order', () => {
  for (const [chain, deps] of Object.entries(WC.STEP_REQUIRES)) {
    const steps = WC.CHAINS[chain];
    assert.ok(steps, `${chain} exists`);
    for (const [dep, pres] of Object.entries(deps)) {
      assert.ok(steps.includes(dep), `${chain}: ${dep} is a step`);
      for (const pre of pres) assert.ok(steps.indexOf(pre) < steps.indexOf(dep), `${chain}: ${pre} precedes ${dep}`);
    }
  }
});

test('deadline: budget skips still make the chain incomplete and not ok, without being failures', async () => {
  let t = 0; const now = () => t;
  const call = async () => { t += 20000; return leaf({ ok: true }); };
  const r = await WC.runChain('capture', { now, call, deadlineMs: 45000 });
  assert.ok(r.skipped.length > 0); assert.equal(r.complete, false); assert.equal(r.ok, false); assert.deepEqual(r.failed, []);
});

test('the chain report carries unknown/blocked/benign (compactChainReport) so op=health can grade them', () => {
  const { compactChainReport } = require('../lib/warm-chains-routes');
  const rep = compactChainReport({ name: 'x', complete: false, failed: [], skipped: [], unknown: ['op=a'], blocked: ['op=b'], benign: [{ op: 'op=c', reason: 'disabled' }], failDetail: [], elapsedMs: 1 }, 't');
  assert.deepEqual(rep.unknown, ['op=a']); assert.deepEqual(rep.blocked, ['op=b']); assert.deepEqual(rep.benign, [{ op: 'op=c', reason: 'disabled' }]);
  const legacy = compactChainReport({ name: 'x', complete: true, failed: [], skipped: [], failDetail: [], elapsedMs: 1 }, 't');
  assert.deepEqual(legacy.unknown, []); assert.deepEqual(legacy.blocked, []); assert.deepEqual(legacy.benign, []);
});
