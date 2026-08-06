'use strict';
// HTTP surface: public reads are read-only and non-mutating, the writers are behind
// the CRON_SECRET bearer, the payload is versioned, and cache headers keep an
// actionable board from being served long and stale.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const RT = require('../lib/tech-command-routes');
const EVAL = require('../lib/tech-command-evaluation');
const BUILD = require('../lib/tech-command-build');

// Minimal res double.
function mockRes() {
  return {
    headers: {}, statusCode: 200, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const req = (query = {}) => ({ query, headers: {}, method: 'GET' });

// ── Non-mutation: the ONLY writer is the tick ───────────────────────────────
test('public reads never call a store write', async (t) => {
  const store = require('../lib/store');
  const original = store.writeJSON;
  let writes = 0;
  store.writeJSON = async (...a) => { writes++; return original(...a); };
  t.after(() => { store.writeJSON = original; });

  for (const op of ['techcommand', 'techcommandticker', 'techcommandhealth']) {
    const res = mockRes();
    const handler = op === 'techcommand' ? RT.runTechCommand
      : op === 'techcommandticker' ? RT.runTechCommandTicker : RT.runTechCommandHealth;
    await handler(req({ ticker: 'NVDA' }), res);
    assert.equal(writes, 0, `${op} performed a store WRITE — public reads must never mutate`);
  }
});

test('the public board payload is versioned, read-only and self-describing', async () => {
  const res = mockRes();
  await RT.runTechCommand(req(), res);
  const b = res.body;
  assert.ok(b, 'a payload must always be returned, even in failure');
  assert.equal(b.readOnly, true);
  assert.ok(b.schema === BUILD.SNAPSHOT_VERSION || b.schema === BUILD.SNAPSHOT_VERSION);
  assert.ok(b.generatedAt, 'every payload is timestamped');
  if (!b.degraded && b.ok !== false) {
    assert.equal(b.authority, 'read-only-projection');
    assert.ok(b.disclosures, 'evidence disclosures must always ship with the board');
    assert.ok(b.dataHealth, 'data health must always ship with the board');
  }
});

test('actionable content is NOT served with a long stale-while-revalidate window', async () => {
  const res = mockRes();
  await RT.runTechCommand(req(), res);
  const cc = res.headers['cache-control'] || '';
  if (/no-store/.test(cc)) return;   // an error path is allowed to be uncacheable
  const sMaxAge = /s-maxage=(\d+)/.exec(cc);
  const swr = /stale-while-revalidate=(\d+)/.exec(cc);
  assert.ok(sMaxAge && Number(sMaxAge[1]) <= 60, `s-maxage too long for actionable content: ${cc}`);
  assert.ok(swr && Number(swr[1]) <= 300, `stale-while-revalidate too long for actionable content: ${cc}`);
});

test('an invalid ticker is rejected before any work happens', async () => {
  const res = mockRes();
  await RT.runTechCommandTicker(req({ ticker: '"; DROP TABLE--' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('the tick refuses to pretend it persisted anything without a store', async () => {
  const res = mockRes();
  const prior = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await RT.runTechCommandTick(req(), res);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.skipped, 'no-store');
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally { if (prior) process.env.BLOB_READ_WRITE_TOKEN = prior; }
});

test('health reports honestly when nothing has been persisted yet', async () => {
  const res = mockRes();
  await RT.runTechCommandHealth(req(), res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.readOnly, true);
  assert.ok('storeConfigured' in res.body);
  assert.ok(res.body.disclosures.evidenceLadder.length > 0);
  if (!res.body.snapshot.present) {
    assert.match(res.body.snapshot.note, /No snapshot has been persisted yet/);
  }
});

// ── Writer authentication ───────────────────────────────────────────────────
test('the mutating ops are registered as PRIVILEGED and the read ops are not', () => {
  const src = require('node:fs').readFileSync(require.resolve('../api/tracker.js'), 'utf8');
  const privBlock = src.slice(src.indexOf('const PRIVILEGED_OPS'), src.indexOf('const EXPENSIVE_OPS'));
  assert.ok(privBlock.includes("'techcommandtick'"), 'op=techcommandtick must require the CRON_SECRET bearer');
  assert.ok(privBlock.includes("'techcommandresolve'"), 'op=techcommandresolve must require the CRON_SECRET bearer');
  assert.ok(!privBlock.includes("'techcommand'"), 'the public board read must not be privileged');
  // …and the browser-triggerable read is throttled.
  const expBlock = src.slice(src.indexOf('const EXPENSIVE_OPS'), src.indexOf('const EXPENSIVE_LIMIT'));
  assert.ok(expBlock.includes("'techcommand'"), 'the public read must be rate-limited against cache-busting abuse');
});

test('every tech-command op is dispatched by api/tracker', () => {
  const src = require('node:fs').readFileSync(require.resolve('../api/tracker.js'), 'utf8');
  for (const op of ['techcommand', 'techcommandticker', 'techcommandhealth', 'techcommandtick', 'techcommandresolve']) {
    assert.ok(src.includes(`req.query.op === '${op}'`), `op=${op} is not wired into the dispatcher`);
  }
});

// ── Snapshot freshness contract ─────────────────────────────────────────────
test('freshness: a mid-session snapshot goes stale quickly, a closed-market one does not', () => {
  const duringSession = new Date('2026-08-05T15:00:00Z');   // Wednesday 11:00 ET
  const closed = new Date('2026-08-08T15:00:00Z');          // Saturday
  const mk = mins => ({ generatedAt: new Date(duringSession.getTime() - mins * 60000).toISOString() });
  assert.equal(RT.isFresh(mk(5), duringSession), true);
  assert.equal(RT.isFresh(mk(60), duringSession), false, 'an hour-old board must not be served as live during a session');
  const closedSnap = { generatedAt: new Date(closed.getTime() - 60 * 60000).toISOString() };
  assert.equal(RT.isFresh(closedSnap, closed), true, 'a post-close build stays valid while the market is shut');
  assert.equal(RT.isFresh(null, duringSession), false);
  assert.equal(RT.isFresh({ generatedAt: 'nonsense' }, duringSession), false);
});

// ── Lifecycle row projection ────────────────────────────────────────────────
test('lifecycle rows are derived per horizon and never merged', () => {
  const snapshot = {
    daytrade: { rows: [{ ticker: 'AAAA', action: 'TRIGGERED', subsector: 'semiconductors', currentSessionFresh: true, catalyst: 'guide raise' }] },
    swing: { rows: [{ ticker: 'AAAA', action: 'ENTER', subsector: 'semiconductors', whyNow: 'breakout', contradicting: [] }, { ticker: 'BBBB', persisted: true, action: 'HOLD' }] },
    longterm: { rows: [{ ticker: 'AAAA', action: 'ACCUMULATE', subsector: 'semiconductors', coreThesis: 'growing fast', contradicting: [] }] },
    options: { rows: [{ ticker: 'AAAA', state: 'CONFIRMS_BULLISH_SETUP' }] },
    sentiment: { rows: [{ ticker: 'AAAA', state: 'STICKY_ATTENTION' }] },
  };
  const rows = RT.lifecycleRowsOf(snapshot);
  assert.equal(rows.daytrade[0].action, 'TRIGGERED');
  assert.equal(rows.swing[0].action, 'ENTER');
  assert.equal(rows.longterm[0].action, 'ACCUMULATE');
  assert.equal(rows.swing.length, 1, 'a carried-forward row must not be re-recorded as a fresh decision');
  assert.equal(rows.daytrade[0].optionsState, 'CONFIRMS_BULLISH_SETUP');
  assert.equal(rows.daytrade[0].attentionState, 'STICKY_ATTENTION');
});

// ── Evaluation ledger contract ──────────────────────────────────────────────
test('the evaluation ledger claims no edge and names its inference requirements', async () => {
  const s = await EVAL.status();
  assert.equal(s.edgeClaim, false);
  assert.match(s.edgeNote, /Software tests do not prove investment alpha/);
  assert.deepEqual(s.swingHorizons, [5, 10, 21]);
  assert.deepEqual(s.longtermHorizons, [63, 126, 252]);
});

test('no-fill and gap-skip are recorded as outcomes, not as flat returns', async () => {
  const candles = [
    { date: '2026-08-05', open: 100, high: 101, low: 99, close: 100 },
    { date: '2026-08-06', open: 130, high: 135, low: 128, close: 132 },   // huge gap through the trigger
    ...Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, open: 132, high: 133, low: 131, close: 132 })),
  ];
  const candlesFor = async () => candles;
  const gapped = await EVAL.resolveSwing(
    { ticker: 'AAAA', selected: true, side: 'long', trigger: 105, invalidation: 95, target: 125, benchmark: 'SMH' },
    '2026-08-05', candlesFor,
  );
  assert.equal(gapped.status, 'NO_FILL_GAP_SKIP');
  assert.equal(gapped.fillPrice, null);
  assert.match(gapped.note, /not as a flat return/);

  const notTaken = await EVAL.resolveSwing(
    { ticker: 'AAAA', selected: true, side: 'long', trigger: 200, invalidation: 95, target: 250 },
    '2026-08-05', candlesFor,
  );
  assert.equal(notTaken.status, 'NO_FILL_TRIGGER_NOT_TAKEN');
});

test('a security with no retrievable history resolves UNRESOLVABLE, never to zero', async () => {
  const r = await EVAL.resolveSwing({ ticker: 'GONE', selected: true, side: 'long', trigger: 10 }, '2026-08-05', async () => null);
  assert.equal(r.status, 'UNRESOLVABLE_NO_DATA');
  assert.match(r.note, /delisted or renamed/);
  assert.ok(!('grossPct' in r));
});

test('rejected candidates are recorded too — the ledger keeps what it did NOT pick', async () => {
  const r = await EVAL.resolveSwing({ ticker: 'AAAA', selected: false, rejectedBecause: ['trigger has not occurred'] }, '2026-08-05', async () => null);
  assert.equal(r.status, 'NOT_SELECTED');
  assert.deepEqual(r.rejectedBecause, ['trigger has not occurred']);
});

test('costs are charged at base, doubled and stressed severities', () => {
  const c = EVAL.costScenarios(5);
  assert.equal(c.base, 4.8);
  assert.equal(c.doubled, 4.6);
  assert.equal(c.stressed, 4.2);
  assert.ok(c.stressed < c.doubled && c.doubled < c.base);
});

test('path outcomes record the exit reason, MFE, MAE and drawdown', () => {
  const path = [
    { date: 'd0', open: 100, high: 100, low: 100, close: 100 },
    { date: 'd1', open: 101, high: 108, low: 100, close: 107 },
    { date: 'd2', open: 107, high: 112, low: 94, close: 95 },   // stop at 96 trades through
  ];
  const o = EVAL.pathOutcome({ path, fill: 100, long: true, invalidation: 96, target: 130, bench: null, sub: null });
  assert.equal(o.exitReason, 'stop');
  assert.equal(o.exitPrice, 96);
  assert.ok(o.mfePct >= 12);
  assert.ok(o.maePct <= -6);
  assert.ok(o.grossPct < 0);
  assert.equal(o.vsQqqPct, null, 'a missing benchmark is null, never zero');
});

test('benchmark-relative return is computed against the same window', () => {
  const bench = [
    { date: 'd0', close: 100 }, { date: 'd1', close: 102 }, { date: 'd2', close: 104 },
  ];
  assert.equal(EVAL.relativeTo(bench, 'd0', 'd2', 10), 6);
  assert.equal(EVAL.relativeTo(null, 'd0', 'd2', 10), null);
});
