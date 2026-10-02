'use strict';
// lib/llm-usage — token/cost ledger math + buffer/flush contract (no network, no Blob).
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/llm-usage');
const shards = require('../lib/llm-ledger-shards');

const HAIKU = 'claude-haiku-4-5-20251001';
const FABLE = 'claude-fable-5-1';
const usage = (i, o, cr = 0, cc = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc });

test.beforeEach(() => U._resetForTests());

test('priceFor: longest-prefix match handles dated ids and distinguishes fable-5 from fable-5-1', () => {
  assert.equal(U.priceFor(HAIKU).input, 1);
  assert.equal(U.priceFor('claude-fable-5-1').cacheRead, 0.25, 'Fable 5.1 cache reads are $0.25/MTok');
  assert.equal(U.priceFor('claude-fable-5').cacheRead, 1);
  assert.equal(U.priceFor('claude-fable-5-1-20270101').output, 50);
  assert.equal(U.priceFor('gpt-9'), null);
  assert.equal(U.priceFor(null), null);
});

test('estimateUsd: input + output + cache read + cache write at list prices; unpriced → null', () => {
  // Haiku: 1M input = $1, 1M output = $5
  assert.equal(U.estimateUsd(HAIKU, usage(1_000_000, 0)), 1);
  assert.equal(U.estimateUsd(HAIKU, usage(0, 1_000_000)), 5);
  // Fable 5.1: 2000 in ($0.02) + 500 out ($0.025) + 10000 cache read ($0.0025) + 4000 cache write ($0.05)
  assert.equal(U.estimateUsd(FABLE, usage(2000, 500, 10000, 4000)), 0.0975);
  assert.equal(U.estimateUsd('mystery-model', usage(10, 10)), null);
  assert.equal(U.estimateUsd(HAIKU, null), 0, 'missing usage counts as zero tokens, not an error');
});

test('normalizeUsage: floors, drops negatives/NaN, tolerates missing cache fields', () => {
  assert.deepEqual(U.normalizeUsage({ input_tokens: 12.7, output_tokens: -3 }), { input: 12, output: 0, cacheRead: 0, cacheCreation: 0 });
  assert.deepEqual(U.normalizeUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
});

test('addCall is immutable and counts unpriced models separately', () => {
  const a = U.emptyCounters();
  const b = U.addCall(a, { model: HAIKU, usage: usage(1000, 100) });
  assert.equal(a.calls, 0, 'original untouched');
  assert.equal(b.calls, 1);
  assert.equal(b.usd, 0.0015);
  const c = U.addCall(b, { model: 'unknown-x', usage: usage(1000, 100) });
  assert.equal(c.unpricedCalls, 1);
  assert.equal(c.usd, 0.0015, 'unpriced tokens add no dollars');
  assert.equal(c.tokens.input, 2000, 'but their tokens are still counted');
});

test('recordUsage accumulates per call site and per model inside one UTC day doc', () => {
  const at = Date.parse('2026-10-02T15:00:00Z');
  U.recordUsage({ callSite: 'evidence-extract', model: HAIKU, usage: usage(1000, 200), at });
  U.recordUsage({ callSite: 'evidence-extract', model: HAIKU, usage: usage(1000, 200), at });
  U.recordUsage({ callSite: 'pulse2-refine', model: FABLE, usage: usage(100, 10), at });
  const buf = U.peekBuffer();
  assert.deepEqual(buf.dirty, ['2026-10-02']);
  const day = buf.days['2026-10-02'];
  assert.equal(day.calls, 3);
  assert.equal(day.byCallSite['evidence-extract'].calls, 2);
  assert.equal(day.byCallSite['evidence-extract'].tokens.input, 2000);
  assert.equal(day.byCallSite['evidence-extract'].byModel[HAIKU].calls, 2);
  assert.equal(day.byCallSite['pulse2-refine'].usd, 0.0015);
  assert.equal(day.usd, +(0.004 + 0.0015).toFixed(6));
});

test('recordUsage: a response straddling midnight UTC lands in its own day; junk input is ignored', () => {
  U.recordUsage({ callSite: 'a', model: HAIKU, usage: usage(10, 1), at: Date.parse('2026-10-02T23:59:59Z') });
  U.recordUsage({ callSite: 'a', model: HAIKU, usage: usage(10, 1), at: Date.parse('2026-10-03T00:00:01Z') });
  assert.equal(U.recordUsage({ callSite: 'a', model: HAIKU, usage: null }), null);
  assert.equal(U.recordUsage(), null);
  assert.deepEqual(Object.keys(U.peekBuffer().days).sort(), ['2026-10-02', '2026-10-03']);
});

test('recordMessageUsage reads model + usage straight off a Messages API response', () => {
  const r = U.recordMessageUsage('news', { model: HAIKU, usage: usage(500, 50), content: [] });
  assert.equal(r.callSite, 'news');
  assert.equal(r.usd, 0.00075);
  assert.equal(U.recordMessageUsage('news', null), null);
});

test('foldShards sums shards and call sites, sorts call sites by spend', () => {
  const at = Date.now();
  const d1 = U.addToDayDoc(U.emptyDayDoc('2026-10-02', 'i1', at), { callSite: 'x', model: HAIKU, usage: usage(1_000_000, 0), at });
  const d2a = U.addToDayDoc(U.emptyDayDoc('2026-10-02', 'i2', at), { callSite: 'y', model: FABLE, usage: usage(1_000_000, 0), at });
  const d2 = U.addToDayDoc(d2a, { callSite: 'x', model: HAIKU, usage: usage(0, 1_000_000), at });
  const f = U.foldShards([d1, d2, null], '2026-10-02');
  assert.equal(f.shards, 2);
  assert.equal(f.calls, 3);
  assert.equal(f.usd, 16);
  assert.equal(f.tokens.total, 3_000_000);
  assert.deepEqual(Object.keys(f.byCallSite), ['y', 'x'], 'sorted by usd desc');
  assert.equal(f.byCallSite.x.usd, 6);
  assert.equal(f.byCallSite.x.calls, 2);
});

test('dayOverDayFlag: fires only above 2x AND above the $1 floor; ratio null without a yesterday', () => {
  assert.equal(U.dayOverDayFlag({ usd: 5 }, { usd: 2 }).flagged, true);
  assert.equal(U.dayOverDayFlag({ usd: 4 }, { usd: 2 }).flagged, false, 'exactly 2x is not a jump');
  assert.equal(U.dayOverDayFlag({ usd: 0.5 }, { usd: 0.1 }).flagged, false, 'below the floor is noise');
  const none = U.dayOverDayFlag({ usd: 5 }, { usd: 0 });
  assert.equal(none.flagged, false);
  assert.equal(none.ratio, null);
});

test('budgetFlag: $200/mo stop rule → $6.67/day pace; projection is linear', () => {
  const b = U.budgetFlag({ usd: 10 });
  assert.equal(b.monthlyStopUsd, 200);
  assert.equal(b.dailyPaceUsd, 6.67);
  assert.equal(b.todayOverPace, true);
  assert.equal(b.projectedMonthUsd, 300);
  assert.equal(U.budgetFlag({ usd: 1 }).todayOverPace, false);
  assert.equal(U.budgetFlag(null).projectedMonthUsd, 0);
});

test('flushUsage writes one cumulative shard per dirty day through the injected store, and retries failures', async () => {
  const at = Date.parse('2026-10-02T15:00:00Z');
  U.recordUsage({ callSite: 'a', model: HAIKU, usage: usage(10, 1), at });
  const writes = [];
  const okStore = { hasStore: () => true, writeJSON: async (path, doc) => { writes.push({ path, doc }); return { url: 'u' }; } };
  const r = await U.flushUsage({ store: okStore });
  assert.equal(r.flushed, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /^llm\/usage\/2026-10-02\/[a-z0-9-]+\.json$/);
  assert.equal(writes[0].doc.calls, 1);
  assert.deepEqual(U.peekBuffer().dirty, [], 'clean after a successful flush');

  U.recordUsage({ callSite: 'a', model: HAIKU, usage: usage(10, 1), at });
  const badStore = { hasStore: () => true, writeJSON: async () => { throw new Error('blob down'); } };
  const bad = await U.flushUsage({ store: badStore });
  assert.equal(bad.flushed, 0);
  assert.deepEqual(U.peekBuffer().dirty, ['2026-10-02'], 'a failed day stays dirty for the next flush');
  assert.match(U.peekBuffer().lastFlushError, /blob down/);
  // The doc is cumulative: the retried write carries BOTH calls.
  await U.flushUsage({ store: okStore });
  assert.equal(writes[1].doc.calls, 2);
});

test('flushUsage without a store is a no-op that never throws', async () => {
  U.recordUsage({ callSite: 'a', model: HAIKU, usage: usage(10, 1) });
  const r = await U.flushUsage({ store: { hasStore: () => false } });
  assert.equal(r.flushed, 0);
  assert.equal(r.errors.length, 1);
});

test('llmHealth folds today + yesterday from the store and includes the unflushed buffer', async () => {
  const now = Date.parse('2026-10-02T15:00:00Z');
  const yDoc = U.addToDayDoc(U.emptyDayDoc('2026-10-01', 'i9', now), { callSite: 'x', model: HAIKU, usage: usage(1_000_000, 0), at: now });
  const store = {
    hasStore: () => true,
    readAllByPrefix: async (prefix) => (prefix === 'llm/usage/2026-10-01/' ? [yDoc] : []),
  };
  U.recordUsage({ callSite: 'x', model: HAIKU, usage: usage(3_000_000, 0), at: now });
  const h = await U.llmHealth({ now, store });
  assert.equal(h.yesterday.usd, 1);
  assert.equal(h.today.usd, 3, 'buffered-but-unflushed spend is visible');
  assert.equal(h.flags.dayOverDayJump.flagged, true);
  assert.equal(h.flags.budget.monthlyStopUsd, 200);
});

test('shard helpers: UTC date + path shape', () => {
  assert.equal(shards.utcDate(Date.parse('2026-10-02T23:59:59Z')), '2026-10-02');
  assert.equal(shards.shardPath('llm/usage/', '2026-10-02', 'abc'), 'llm/usage/2026-10-02/abc.json');
});
