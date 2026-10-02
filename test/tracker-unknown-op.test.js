'use strict';
// UNKNOWN-OP FALL-THROUGH. `GET /api/tracker?op=<typo>` used to fall off the end of the op
// router into the DEFAULT handler and return the full scoreboard payload (~6.7 MB on
// 2026-10-02) — a silent, expensive wrong answer. An unrecognised op is now a small 400 JSON
// error that is never CDN-cached. The default path (no op, or the legacy `op=scoreboard`
// alias that public/js/app.js fetchScoreboard relies on via a bare `/api/tracker`) is kept.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_OP, isDefaultOp, respondUnknownOp } = require('../lib/tracker-default-op');

const TRACKER = fs.readFileSync(path.join(__dirname, '..', 'api/tracker.js'), 'utf8');

function mockRes() {
  const headers = {};
  const out = { headers, statusCode: 200, body: null };
  out.setHeader = (k, v) => { headers[k.toLowerCase()] = String(v); };
  out.status = (c) => { out.statusCode = c; return out; };
  out.json = (b) => { out.body = b; return out; };
  return out;
}

test('isDefaultOp: no op, empty op and the legacy scoreboard alias all take the default path', () => {
  assert.equal(DEFAULT_OP, 'scoreboard');
  for (const op of [undefined, null, '', 'scoreboard']) assert.equal(isDefaultOp(op), true, `op=${String(op)}`);
});

test('isDefaultOp: anything else is NOT the default path (including arrays and near-misses)', () => {
  for (const op of ['nope', 'Scoreboard', ' scoreboard', ['scoreboard'], 'scoreboards', 0, {}]) {
    assert.equal(isDefaultOp(op), false, `op=${JSON.stringify(op)}`);
  }
});

test('respondUnknownOp: small 400 JSON naming the op, never CDN-cached', () => {
  const res = mockRes();
  respondUnknownOp({ query: { op: 'scoreboad' } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: 'unknown op', op: 'scoreboad' });
  assert.match(res.headers['cache-control'], /no-store/);
  assert.ok(JSON.stringify(res.body).length < 200, 'the body must be tiny — this replaced a 6.7 MB payload');
});

test('respondUnknownOp: a hostile op string is truncated and stringified, not echoed raw', () => {
  const res = mockRes();
  respondUnknownOp({ query: { op: ['a', 'b'] } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(typeof res.body.op, 'string');
  const long = mockRes();
  respondUnknownOp({ query: { op: 'x'.repeat(5000) } }, long);
  assert.ok(long.body.op.length <= 80, 'the echoed op is bounded');
});

test('api/tracker routing tail: default path still goes to runScoreboard; everything else is the 400', () => {
  const tail = TRACKER.slice(TRACKER.lastIndexOf("if (req.query.op === 'patternresearch')"));
  assert.match(tail, /if \(isDefaultOp\(req\.query\.op\)\) return runScoreboard\(req, res\);/, 'the default path must be explicit');
  assert.match(tail, /return respondUnknownOp\(req, res\);\s*\n\};?\s*$/, 'the LAST statement of the router must be the unknown-op 400');
  assert.doesNotMatch(tail, /^\s*return runScoreboard\(req, res\);\s*$/m, 'no unconditional scoreboard fall-through remains');
});

test('api/tracker end to end: an unknown op gets the 400 without touching any handler', async () => {
  const handler = require('../api/tracker');
  const res = mockRes();
  await handler({ method: 'GET', query: { op: 'definitely-not-an-op' }, headers: {}, socket: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: 'unknown op', op: 'definitely-not-an-op' });
  assert.match(res.headers['cache-control'], /no-store/);
});

test('the browser still calls the default path with no op (the contract this fix must not break)', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
  assert.match(APP, /fetchJSON\('\/api\/tracker'\)/, 'fetchScoreboard fetches the bare endpoint');
});
