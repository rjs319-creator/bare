'use strict';
// op=redflagstick driven end-to-end with an in-memory CAS store and canned EDGAR — stage
// order, budget truncation with PARTIAL persist, idempotent union on re-tick, state advance,
// snapshot build; op=redflags read semantics (empty state never cached, symbol filter, auth).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../lib/filing-redflags-routes');
const RFS = require('../lib/filing-redflags-store');
const RF = require('../lib/filing-redflags');

function memStore() {
  const docs = new Map();
  const dayRe = /^redflags\/v1\/(\d{4}-\d{2}-\d{2})\.json$/;
  return {
    docs,
    readAllRedflagDays: async ({ since = null, limit = null } = {}) => {
      const days = [...docs.entries()].filter(([k]) => dayRe.test(k)).map(([, v]) => v).filter((v) => !since || v.date >= since).sort((a, b) => (a.date < b.date ? -1 : 1));
      return limit ? days.slice(-limit) : days;
    },
    readState: async () => docs.get(RFS.STATE_KEY) || RF.emptyState(),
    readCurrent: async () => docs.get(RFS.CURRENT_KEY) || null,
    writeDayUnion: async (date, patch) => { const k = RFS.dayKey(date); docs.set(k, RFS.mergeDay(docs.get(k) || null, { ...patch, date })); },
    writeStateUnion: async (next) => { docs.set(RFS.STATE_KEY, RFS.mergeState(docs.get(RFS.STATE_KEY) || null, next)); },
    writeCurrent: async (snap) => { docs.set(RFS.CURRENT_KEY, snap); },
  };
}

const IDX = {
  '2026-10-01': [
    { form: 'NT 10-K', company: 'LATE CO', cik: '0000000001', dateFiled: '2026-10-01', fileName: 'f', accession: 'nt1' },
    { form: '8-K', company: 'RESTATE CO', cik: '0000000002', dateFiled: '2026-10-01', fileName: 'f', accession: 'k1' },
    { form: '8-K', company: 'EXIT CO', cik: '0000000003', dateFiled: '2026-10-01', fileName: 'f', accession: 'k2' },
    { form: '8-K', company: 'NOBODY', cik: '0000000099', dateFiled: '2026-10-01', fileName: 'f', accession: 'k9' },
  ],
};
const SUBS = {
  '0000000002': { accessionNumber: ['k1'], items: ['4.02,9.01'], primaryDocument: ['d.htm'] },
  '0000000003': { accessionNumber: ['k2'], items: ['5.02'], primaryDocument: ['e.htm'] },
};
const deps = (store, over = {}) => ({
  date: '2026-10-01', store, throttleMs: 0,
  fetchIndex: async (d) => ({ date: d, missing: !IDX[d], rows: IDX[d] || [] }),
  cikMap: async () => ({ LATE: '0000000001', RST: '0000000002', EXIT: '0000000003' }),
  fetchSubmissions: async (cik) => SUBS[cik] || null,
  fetchDoc: async () => '<p>Mr. X resigned as Chief Financial Officer effective today.</p>',
  fetchFts: async () => [{ ticker: 'LATE', cik: '0000000001', fileDate: '2026-09-30', adsh: 'gc1', form: '10-Q' }],
  history: async () => ({ candles: Array.from({ length: 80 }, (_, i) => ({ date: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`, close: 10, open: 10, volume: 600000 })) }),
  ...over,
});

test('tick: NT + 4.02 + 5.02-CFO + going-concern → four rows dated the tick day; non-ticker CIK never looked up; state advanced; snapshot built', async () => {
  const store = memStore();
  const looked = [];
  const r = await R.tickCore(deps(store, { fetchSubmissions: async (cik) => { looked.push(cik); return SUBS[cik] || null; } }));
  assert.equal(r.ok, true); assert.equal(r.partial, false); assert.deepEqual(r.stats.truncated, []);
  assert.deepEqual(looked, ['0000000002', '0000000003'], 'the CIK without a ticker is dropped before any fetch');
  const day = store.docs.get('redflags/v1/2026-10-01.json');
  assert.deepEqual(day.picks.map((p) => [p.ticker, p.flag, p.tier]).sort(), [['EXIT', 'ITEM_5_02_CXO', 'ITEM_5_02_CXO'], ['LATE', 'GOING_CONCERN_FIRST', 'GOING_CONCERN_FIRST'], ['LATE', 'NT_FIRST', 'NT_FIRST'], ['RST', 'ITEM_4_02', 'ITEM_4_02']]);
  for (const p of day.picks) { assert.equal(p.date, '2026-10-01'); assert.equal(p.entry, null); assert.equal(p.fillPolicy, 'next-session-open'); assert.equal(p.scope, 'small', 'ADV $6M → small tier stamped'); }
  assert.deepEqual(day.picks.find((p) => p.flag === 'ITEM_5_02_CXO').detail.roles, ['CFO']);
  assert.equal(day.partial, false);
  assert.deepEqual(day.indexDates.map((x) => x.missing), [true, false]);
  const state = store.docs.get(RFS.STATE_KEY);
  assert.equal(state.byTicker.LATE.NT, '2026-10-01'); assert.equal(state.byTicker.LATE.GC, '2026-09-30');
  const snap = store.docs.get(RFS.CURRENT_KEY);
  assert.deepEqual(Object.keys(snap.symbols).sort(), ['EXIT', 'LATE', 'RST']);
  assert.deepEqual(snap.symbols.LATE.flags, ['GOING_CONCERN_FIRST', 'NT_FIRST']);
});

test('tick: re-tick on the same day is an idempotent union — no duplicate rows, known accessions not refetched, state unchanged', async () => {
  const store = memStore();
  await R.tickCore(deps(store));
  const looked = [];
  const r2 = await R.tickCore(deps(store, { fetchSubmissions: async (cik) => { looked.push(cik); return SUBS[cik] || null; } }));
  assert.equal(r2.counts.rows, 0, 'nothing new on the second pass');
  assert.deepEqual(looked, [], 'stored accessions are skipped before the submissions lookup');
  const day = store.docs.get('redflags/v1/2026-10-01.json');
  assert.equal(day.picks.length, 4); assert.equal(day.stats.length, 2, 'both passes recorded');
  assert.equal(store.docs.get(RFS.STATE_KEY).byTicker.LATE.NT, '2026-10-01');
});

test('tick: a later NT by the same name inside the window is NOT a new event; after the window it is', async () => {
  const store = memStore();
  await R.tickCore(deps(store));
  const idx2 = { '2027-01-15': [{ form: 'NT 10-Q', company: 'LATE CO', cik: '0000000001', dateFiled: '2027-01-15', fileName: 'f', accession: 'nt2' }] };
  const r2 = await R.tickCore(deps(store, { date: '2027-01-15', fetchIndex: async (d) => ({ date: d, missing: !idx2[d], rows: idx2[d] || [] }), fetchFts: async () => [] }));
  assert.equal(r2.counts.rows, 0);
  const idx3 = { '2027-10-15': [{ form: 'NT 10-Q', company: 'LATE CO', cik: '0000000001', dateFiled: '2027-10-15', fileName: 'f', accession: 'nt3' }] };
  const r3 = await R.tickCore(deps(store, { date: '2027-10-15', fetchIndex: async (d) => ({ date: d, missing: !idx3[d], rows: idx3[d] || [] }), fetchFts: async () => [] }));
  assert.equal(r3.counts.byFlag.NT_FIRST, 1);
});

test('tick: budget exhaustion → the cheap stages persist, the 8-K stage is truncated, the shard is marked PARTIAL; a re-tick completes it', async () => {
  const store = memStore();
  let t = 0;
  // Every clock read advances 20s: the FTS stage spends the stage budget, 8-K items see none left.
  const r = await R.tickCore(deps(store, { budgetMs: 60_000, now: () => (t += 20_000) }));
  assert.equal(r.partial, true);
  assert.ok(r.stats.truncated.includes('8k-items'), `truncated: ${r.stats.truncated}`);
  const day = store.docs.get('redflags/v1/2026-10-01.json');
  assert.equal(day.partial, true);
  assert.ok(day.picks.some((p) => p.flag === 'NT_FIRST'), 'NT (free) persisted');
  assert.ok(!day.picks.some((p) => p.flag === 'ITEM_4_02'), '8-K stage did not run');
  assert.ok(day.picks.every((p) => p.tier === RF.EXCLUDED_TIER && p.reasons.includes('no-history')), 'no budget left for history → EXCLUDED with reason, never dropped');
  const r2 = await R.tickCore(deps(store));
  assert.equal(r2.partial, false);
  const day2 = store.docs.get('redflags/v1/2026-10-01.json');
  assert.equal(day2.partial, false);
  assert.ok(day2.picks.some((p) => p.flag === 'ITEM_4_02'), 'the re-tick filled the truncated stage');
  assert.equal(day2.picks.filter((p) => p.flag === 'NT_FIRST').length, 1, 'union — the first pass\'s row kept, not duplicated');
});

test('tick: FTS failure is recorded (partial), never fatal; a daily-index failure IS fatal (nothing written)', async () => {
  const store = memStore();
  const r = await R.tickCore(deps(store, { fetchFts: async () => { throw new Error('efts 503'); } }));
  assert.equal(r.partial, true); assert.match(r.stats.goingConcern.error, /efts 503/); assert.ok(r.stats.truncated.includes('fts'));
  const store2 = memStore();
  await assert.rejects(R.tickCore(deps(store2, { fetchIndex: async () => { throw new Error('blocked'); } })), /blocked/);
  assert.equal(store2.docs.size, 0, 'fail closed — a partial day must not be written as a quiet day');
});

// ── Handlers ─────────────────────────────────────────────────────────────────
function mockRes() {
  const r = { headers: {}, code: 200, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('op=redflags: without Blob → ok:false; symbol validation rejects junk', async () => {
  const saved = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const res = mockRes();
    await R.runRedflags({ query: {} }, res);
    assert.equal(res.body.ok, false);
    const t = mockRes();
    await R.runRedflagsTick({ query: {} }, t);
    assert.equal(t.body.ok, false); assert.equal(t.headers['Cache-Control'], 'no-store');
  } finally { if (saved) process.env.BLOB_READ_WRITE_TOKEN = saved; }
});

test('tracker: tick is privileged, read is public, both routed; chain root registered; health mutes it as background', () => {
  const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const tracker = src('api/tracker.js');
  const priv = tracker.slice(tracker.indexOf('const PRIVILEGED_OPS'), tracker.indexOf('const EXPENSIVE_OPS'));
  assert.match(priv, /'redflagstick'/);
  assert.doesNotMatch(priv, /'redflags'[,\s]/, 'the public read must not be privileged');
  assert.match(tracker, /op === 'redflags'\) return require\('\.\.\/lib\/filing-redflags-routes'\)\.runRedflags/);
  assert.match(tracker, /op === 'redflagstick'\) return require\('\.\.\/lib\/filing-redflags-routes'\)\.runRedflagsTick/);
  const WC = require('../lib/warm-chains');
  assert.deepEqual(WC.CHAINS.redflags, ['op=redflagstick']);
  assert.ok(WC.ROOT_CHAINS.includes('redflags'));
  assert.ok(WC.dispatchDelayMs(WC.ROOT_CHAINS.length - 1) <= 90000, 'the last wave must still fit the drain');
  assert.ok(require('../lib/health').BACKGROUND_CHAINS.has('redflags'));
});

test('op=redflags read: the empty state is never CDN-cached', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/filing-redflags-routes.js'), 'utf8');
  assert.match(src, /if \(snap\) cached\(res\); else noStore\(res\);/);
});
