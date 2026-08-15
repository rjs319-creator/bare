'use strict';
// OMEGA A/B tick — resolve-loop accounting (review 2026-08-15).
//
// Two loop defects, both of the "silently ages out" family the tick's own comments
// promise against:
//   1. The per-tick resolve budget was burned by dates that made NO progress (null
//      history / immature / absent from SPY), so permanently-stuck old dates consumed
//      the whole budget every tick and newer resolvable dates starved forever behind
//      them — the 100-date verdict gate starved silently.
//   2. A day-doc written resolved:true whose seriesPoint() is null (one arm
//      all-UNRESOLVABLE) was appended to neither points nor stuckDates — it vanished
//      from all accounting and was re-read every tick forever. A null day-doc read
//      likewise skipped the stuckDates push.
//
// Store and screener are stubbed in require.cache (no Blob, no network) — the routes
// module runs its REAL loop against them.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// requireTrusted fail-opens outside production when CRON_SECRET is unset.
delete process.env.CRON_SECRET;

const state = { data: new Map(), reads: [], writes: [], histories: new Map() };
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

const storePath = require.resolve('../lib/store');
require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true,
  exports: {
    hasStore: () => true,
    readJSON: async (key, fallback) => { state.reads.push(key); return state.data.has(key) ? clone(state.data.get(key)) : fallback; },
    writeJSON: async (key, val) => { state.writes.push(key); state.data.set(key, clone(val)); },
  },
};
const screenerPath = require.resolve('../lib/screener');
require.cache[screenerPath] = {
  id: screenerPath, filename: screenerPath, loaded: true,
  exports: {
    fetchDailyHistory: async (t) => (state.histories.has(t) ? { candles: clone(state.histories.get(t)) } : null),
    screenTicker: async () => null,
  },
};

const AB = require('../lib/omega-ab');
const R = require('../lib/omega-ab-routes');

const mkRes = () => {
  const res = { headers: {}, code: null, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.code = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
};
const tick = async () => { const res = mkRes(); await R.runOmegaAbTick({ query: {}, headers: {} }, res); return res; };
const read = async () => { const res = mkRes(); await R.runOmegaAb({ query: {}, headers: {} }, res); return res; };

function candlesFrom(date, n, price = 500) {
  const d0 = Date.parse(`${date}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const p = price + i;
    return { date: new Date(d0 + i * 86_400_000).toISOString().slice(0, 10), open: p, high: p + 1, low: p - 1, close: p + 0.5, volume: 1e6 };
  });
}

// A valid decision doc for `date` whose 20 tickers carry `prefix`.
function dayDoc(date, prefix) {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    ticker: `${prefix}${String(i).padStart(2, '0')}`, lastBarDate: date,
    score: 90 - i, r10: i / 100, dollarVol: 5e8, costPct: 0.16,
  }));
  const doc = AB.buildDecisionDoc({ date, rows, createdAt: 'now' });
  assert.ok(doc, 'fixture doc must build');
  return doc;
}

// SPY: 15 daily bars 2026-06-01..2026-06-15. today = 2026-06-15 (a completed past
// session under the real clock), and it is pre-listed in the index so the stamp path
// skips and only the resolve loop runs.
const SPY_START = '2026-06-01';
const TODAY = '2026-06-15';
const RESOLVABLE = '2026-06-02';   // matured (13 days), 13 sessions of SPY after it

function resetState({ indexDates, docs }) {
  state.data = new Map();
  state.reads = [];
  state.writes = [];
  state.histories = new Map();
  state.histories.set('SPY', candlesFrom(SPY_START, 15));
  state.data.set(R.INDEX_KEY, { dates: [...indexDates].sort() });
  for (const [date, doc] of Object.entries(docs || {})) state.data.set(R.dayKey(date), doc);
}

test('no-progress stuck dates do not burn the resolve budget — newer dates still resolve', async () => {
  // 31 old dates (> MAX_RESOLVE_PER_TICK=30) whose decision date is ABSENT from the 2y
  // SPY window: resolution can attempt nothing, forever. Before the fix each one
  // decremented the budget, so the newer resolvable date was never reached on any tick.
  const stuck = Array.from({ length: 31 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
  const docs = {};
  for (const [i, d] of stuck.entries()) docs[d] = dayDoc(d, `S${i}x`);   // no histories → null fetch
  docs[RESOLVABLE] = dayDoc(RESOLVABLE, 'R');
  resetState({ indexDates: [...stuck, RESOLVABLE, TODAY], docs });
  for (let i = 0; i < 20; i++) state.histories.set(`R${String(i).padStart(2, '0')}`, candlesFrom(SPY_START, 15, 100 + i));

  const res = await tick();
  assert.equal(res.code, 200);
  assert.ok(res.body.resolved.some((r) => r.date === RESOLVABLE && r.pending === 0),
    `the newer date must resolve in the SAME tick, got resolved=${JSON.stringify(res.body.resolved)}`);
  for (const d of stuck) assert.ok(res.body.stuckDates.includes(d), `${d} must be surfaced as stuck`);
  assert.ok(!res.body.stuckDates.includes(RESOLVABLE));
  const summary = state.data.get(R.SUMMARY_KEY);
  assert.equal(summary.points.length, 1, 'the resolved point must land in the persisted series');
  assert.equal(summary.points[0].date, RESOLVABLE);
  assert.deepEqual(summary.stuckDates, stuck, 'stuck dates persist in the summary doc');
});

// A resolved-but-degenerate doc: arms are disjoint (score descends over i, r10 ascends),
// and every selectedR10 row is terminal UNRESOLVABLE → seriesPoint() is null.
function degenerateDoc(date) {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    ticker: `D${String(i).padStart(2, '0')}`, lastBarDate: date,
    score: 90 - i, r10: i / 100, dollarVol: 5e8, costPct: 0.16,
  }));
  const doc = AB.buildDecisionDoc({ date, rows, createdAt: 'now' });
  const settled = doc.rows.map((r) => (r.selectedR10
    ? { ...r, outcomeStatus: 'UNRESOLVABLE', attempts: AB.FROZEN.maxResolveAttempts }
    : { ...r, outcomeStatus: 'RESOLVED', netResidualReturn: 0.5, rawReturn: 1, benchmarkReturn: 0.34, residualReturn: 0.66 }));
  const out = { ...doc, rows: settled, resolved: true, resolvedAt: 'earlier' };
  assert.equal(AB.seriesPoint(out), null, 'fixture must be resolved-but-degenerate');
  return out;
}

test('a resolved-but-degenerate day gets explicit accounting and is never re-read', async () => {
  const D = '2026-06-02';
  resetState({ indexDates: [D, TODAY], docs: { [D]: degenerateDoc(D) } });

  const res1 = await tick();
  assert.deepEqual(res1.body.degenerateDates, [D], 'the tick must NAME the degenerate day');
  assert.ok(!res1.body.stuckDates.includes(D), 'degenerate is settled, not stuck');
  assert.equal(res1.body.resolvedTotal, 0, 'a degenerate day contributes NO series point (verdict gate untouched)');
  const summary = state.data.get(R.SUMMARY_KEY);
  assert.deepEqual(summary.degenerateDates, [D], 'recorded in the summary doc so it is not re-read every tick');
  assert.deepEqual(summary.points, []);

  const dayReadsAfter1 = state.reads.filter((k) => k === R.dayKey(D)).length;
  const res2 = await tick();
  const dayReadsAfter2 = state.reads.filter((k) => k === R.dayKey(D)).length;
  assert.equal(dayReadsAfter2, dayReadsAfter1, 'the degenerate day-doc must NOT be re-read on the next tick');
  assert.deepEqual(res2.body.degenerateDates, [D], 'still accounted for on every tick response');

  // And the public read surfaces it — "nothing silently ages out" holds end to end.
  const pub = await read();
  assert.deepEqual(pub.body.degenerateDates, [D]);
  assert.deepEqual(pub.body.stuckDates, []);
});

test('a null/unreadable day-doc read lands in stuckDates, not in the void', async () => {
  const D = '2026-06-03';
  resetState({ indexDates: [D, TODAY], docs: {} });   // index names the day; no doc exists

  const res = await tick();
  assert.ok(res.body.stuckDates.includes(D), 'an unreadable day is a STUCK day, not a skipped iteration');
  assert.ok(res.body.errors.some((e) => e.includes(D)), 'and the read failure is reported');
  assert.deepEqual(state.data.get(R.SUMMARY_KEY).stuckDates, [D], 'persisted so the public read surfaces it');
});
