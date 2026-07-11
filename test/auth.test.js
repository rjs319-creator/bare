const { test } = require('node:test');
const assert = require('node:assert');
const {
  isTrusted, requireTrusted, requireMethod, ingestAuthorized,
  internalHeaders, stripForceParams, isValidTicker, sanitizeTickers,
} = require('../lib/auth');

// Minimal req/res doubles.
function mkReq({ headers = {}, query = {}, method = 'GET' } = {}) {
  return { headers, query, method };
}
function mkRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function withSecret(secret, fn) {
  const prev = process.env.CRON_SECRET;
  if (secret == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
  try { fn(); } finally {
    if (prev == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  }
}

// ── isTrusted / requireTrusted ──────────────────────────────────────────────
test('isTrusted: false when CRON_SECRET unset, even with a bearer', () => {
  withSecret(null, () => {
    assert.equal(isTrusted(mkReq({ headers: { authorization: 'Bearer anything' } })), false);
  });
});

test('isTrusted: true only for the matching bearer when secret is set', () => {
  withSecret('s3cr3t', () => {
    assert.equal(isTrusted(mkReq({ headers: { authorization: 'Bearer s3cr3t' } })), true);
    assert.equal(isTrusted(mkReq({ headers: { authorization: 'Bearer wrong' } })), false);
    assert.equal(isTrusted(mkReq()), false);
  });
});

test('requireTrusted: fails OPEN (allows) when CRON_SECRET is unset — deploy-safe', () => {
  withSecret(null, () => {
    const res = mkRes();
    assert.equal(requireTrusted(mkReq(), res), true);
    assert.equal(res.statusCode, 200);
  });
});

test('requireTrusted: 401s an unauthenticated call once the secret is set', () => {
  withSecret('s3cr3t', () => {
    const res = mkRes();
    assert.equal(requireTrusted(mkReq(), res), false);
    assert.equal(res.statusCode, 401);
  });
});

test('requireTrusted: allows the cron bearer once the secret is set', () => {
  withSecret('s3cr3t', () => {
    const res = mkRes();
    assert.equal(requireTrusted(mkReq({ headers: { authorization: 'Bearer s3cr3t' } }), res), true);
  });
});

// ── requireMethod ───────────────────────────────────────────────────────────
test('requireMethod: 405 on a disallowed method with an Allow header', () => {
  const res = mkRes();
  assert.equal(requireMethod(mkReq({ method: 'GET' }), res, ['POST']), false);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'POST');
});

test('requireMethod: proceeds on an allowed method', () => {
  const res = mkRes();
  assert.equal(requireMethod(mkReq({ method: 'POST' }), res, ['POST']), true);
});

// ── ingestAuthorized (fail-closed once configured) ──────────────────────────
test('ingestAuthorized: open when neither token nor CRON_SECRET is set (bootstrap)', () => {
  withSecret(null, () => {
    const prev = process.env.ALERTS_INGEST_TOKEN; delete process.env.ALERTS_INGEST_TOKEN;
    assert.equal(ingestAuthorized(mkReq(), 'ALERTS_INGEST_TOKEN'), true);
    if (prev != null) process.env.ALERTS_INGEST_TOKEN = prev;
  });
});

test('ingestAuthorized: rejects unauthenticated once a token is configured (closes fail-open hole)', () => {
  withSecret(null, () => {
    process.env.ALERTS_INGEST_TOKEN = 'tok';
    assert.equal(ingestAuthorized(mkReq(), 'ALERTS_INGEST_TOKEN'), false);
    assert.equal(ingestAuthorized(mkReq({ headers: { 'x-ingest-token': 'tok' } }), 'ALERTS_INGEST_TOKEN'), true);
    assert.equal(ingestAuthorized(mkReq({ query: { token: 'tok' } }), 'ALERTS_INGEST_TOKEN'), true);
    delete process.env.ALERTS_INGEST_TOKEN;
  });
});

test('ingestAuthorized: the CRON_SECRET bearer authorizes ingest even with no dedicated token', () => {
  withSecret('s3cr3t', () => {
    const prev = process.env.INSIDER_INGEST_TOKEN; delete process.env.INSIDER_INGEST_TOKEN;
    assert.equal(ingestAuthorized(mkReq({ headers: { authorization: 'Bearer s3cr3t' } }), 'INSIDER_INGEST_TOKEN'), true);
    assert.equal(ingestAuthorized(mkReq(), 'INSIDER_INGEST_TOKEN'), false); // secret set → no longer open
    if (prev != null) process.env.INSIDER_INGEST_TOKEN = prev;
  });
});

// ── internalHeaders ─────────────────────────────────────────────────────────
test('internalHeaders: always carries x-warm; adds bearer only when secret set', () => {
  withSecret(null, () => {
    const h = internalHeaders();
    assert.equal(h['x-warm'], '1');
    assert.equal(h['authorization'], undefined);
  });
  withSecret('s3cr3t', () => {
    const h = internalHeaders();
    assert.equal(h['authorization'], 'Bearer s3cr3t');
  });
});

// ── stripForceParams ────────────────────────────────────────────────────────
test('stripForceParams: removes force/refresh/reset for untrusted callers', () => {
  withSecret('s3cr3t', () => {
    const req = mkReq({ query: { force: '1', refresh: '1', reset: '1', scope: 'large' } });
    stripForceParams(req);
    assert.equal(req.query.force, undefined);
    assert.equal(req.query.refresh, undefined);
    assert.equal(req.query.reset, undefined);
    assert.equal(req.query.scope, 'large'); // unrelated params preserved
  });
});

test('stripForceParams: leaves params intact for a trusted caller', () => {
  withSecret('s3cr3t', () => {
    const req = mkReq({ headers: { authorization: 'Bearer s3cr3t' }, query: { force: '1' } });
    stripForceParams(req);
    assert.equal(req.query.force, '1');
  });
});

// ── ticker validation ───────────────────────────────────────────────────────
test('isValidTicker: accepts real symbols, rejects junk and path-injection', () => {
  for (const t of ['AAPL', 'BRK.B', 'brk.b', 'RDS-A', 'F']) assert.equal(isValidTicker(t), true, t);
  for (const t of ['', 'TOOLONGSYMBOL', 'AAPL/../x', 'A B', 'a;drop', null, 42]) assert.equal(isValidTicker(t), false, String(t));
});

test('sanitizeTickers: uppercases, drops invalid, caps length', () => {
  assert.deepEqual(sanitizeTickers('aapl, msft , bad/x, brk.b'), ['AAPL', 'MSFT', 'BRK.B']);
  assert.equal(sanitizeTickers('a,b,c,d,e', 3).length, 3);
  assert.deepEqual(sanitizeTickers(null), []);
});
