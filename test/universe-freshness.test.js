// Defect 3 — mixed-vintage expanded universe. A freshly-compiled document that
// contains an OLD shard must never make the old shard's tickers read as current:
// per-entry provenance survives the merge, the merge is deterministic, and the
// cross-sectional cohort gate excludes anything that doesn't reach the one
// authoritative decision session.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mergeShards } = require('../lib/universe-routes');
const { encode, decodeEntry } = require('../lib/candle-cache');
const { gateCohort, classifyBarDate, resolveDecisionSession, FRESHNESS_CLASS } = require('../lib/cohort-freshness');

// Synthetic candle helper: n bars ending at endDate (ISO date strings, ~daily).
function bars(endDate, n = 5) {
  const end = new Date(endDate + 'T00:00:00Z');
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10);
    out.push({ date: d, open: 10, high: 11, low: 9, close: 10, volume: 1000, adjClose: 10 });
  }
  return out;
}
function shard(at, entries) {
  const map = new Map(Object.entries(entries).map(([t, endDate]) => [t, { candles: bars(endDate), meta: { shortName: t } }]));
  return { data: encode(map, { fetchedAt: at, generatedAt: at, scope: 'expanded' }), at, count: map.size };
}

// A post-close Friday evaluation instant (ET) — market closed, so the decision
// session is the benchmark's own latest bar.
const NOW = new Date('2026-07-31T23:30:00Z');          // 19:30 ET Friday
const SPY_DATES = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'];

test('a newly compiled document containing an old shard does NOT make the old ticker current', () => {
  const oldShard = shard('2026-07-17T22:05:00Z', { STALE1: '2026-07-17' });
  const newShard = shard('2026-07-31T22:05:00Z', { FRESH1: '2026-07-31' });
  const { data } = mergeShards([oldShard, newShard]);

  // Compile keeps the old entry — retained for diagnostics — but its provenance
  // still says July 17, regardless of the compile happening "today".
  const stale = decodeEntry(data.STALE1);
  assert.strictEqual(stale.provenance.lastBarDate, '2026-07-17');
  assert.strictEqual(stale.provenance.sourceFetchedAt, '2026-07-17T22:05:00Z');

  const rows = Object.keys(data).map(t => ({ ticker: t, lastBarDate: decodeEntry(data[t]).provenance.lastBarDate }));
  const gate = gateCohort(rows, { benchmarkDates: SPY_DATES, now: NOW });
  assert.strictEqual(gate.decisionSession, '2026-07-31');
  assert.deepStrictEqual(gate.admitted.map(r => r.ticker), ['FRESH1']);
  assert.deepStrictEqual(gate.excluded, [{ ticker: 'STALE1', lastBarDate: '2026-07-17', reason: 'stale' }]);
  assert.strictEqual(gate.counts.current, 1);
  assert.strictEqual(gate.counts.stale, 1);
});

test('merge is deterministic: newer last bar wins a ticker conflict regardless of shard order', () => {
  const a = shard('2026-07-20T22:05:00Z', { DUP: '2026-07-20' });
  const b = shard('2026-07-31T22:05:00Z', { DUP: '2026-07-31' });
  const m1 = mergeShards([a, b]);
  const m2 = mergeShards([b, a]);
  assert.strictEqual(decodeEntry(m1.data.DUP).provenance.lastBarDate, '2026-07-31');
  assert.deepStrictEqual(m1.data.DUP, m2.data.DUP, 'order-invariant');
  assert.strictEqual(m1.stats.conflicts, 1);
});

test('legacy shard entries without provenance inherit the SHARD fetch time — never the compile time', () => {
  const map = new Map([['LEG', { candles: bars('2026-07-10'), meta: {} }]]);
  const legacyShard = { data: encode(map), at: '2026-07-10T22:05:00Z' };   // no prov stamped (old format)
  const { data } = mergeShards([legacyShard]);
  const d = decodeEntry(data.LEG);
  assert.strictEqual(d.provenance.sourceFetchedAt, '2026-07-10T22:05:00Z');
  assert.strictEqual(d.provenance.lastBarDate, '2026-07-10');
});

test('backward-compatible decode: an old cache entry without `p` derives lastBarDate from its final candle', () => {
  const map = new Map([['OLD', { candles: bars('2026-07-29'), meta: { shortName: 'Old Co' } }]]);
  const enc = encode(map);   // legacy: no provenance argument
  const d = decodeEntry(enc.OLD);
  assert.strictEqual(d.provenance.lastBarDate, '2026-07-29');
  assert.strictEqual(d.provenance.sourceFetchedAt, null);
  assert.strictEqual(d.provenance.sourceScope, null);
});

test('mixed-date rows cannot enter one percentile cohort: only session-matching rows are admitted', () => {
  const rows = [
    { ticker: 'CUR', lastBarDate: '2026-07-31' },
    { ticker: 'PRI', lastBarDate: '2026-07-30' },
    { ticker: 'STA', lastBarDate: '2026-07-20' },
    { ticker: 'FUT', lastBarDate: '2026-08-05' },
    { ticker: 'MIS', lastBarDate: null },
  ];
  const gate = gateCohort(rows, { benchmarkDates: SPY_DATES, now: NOW });
  assert.deepStrictEqual(gate.admitted.map(r => r.ticker), ['CUR']);
  assert.deepStrictEqual(gate.counts, { current: 1, 'prior-session': 1, stale: 1, 'future-dated': 1, missing: 1 });
  const reasons = Object.fromEntries(gate.excluded.map(e => [e.ticker, e.reason]));
  assert.strictEqual(reasons.PRI, 'prior-session');
  assert.strictEqual(reasons.STA, 'stale');
  assert.strictEqual(reasons.FUT, 'future-dated');
  assert.strictEqual(reasons.MIS, 'missing');
});

test('during an open market the completed prior session is authoritative and a partial current bar stays admissible', () => {
  // Tuesday 10:30 ET: SPY carries a partial bar for the in-progress session.
  const nowOpen = new Date('2026-07-28T14:30:00Z');
  const ctx = resolveDecisionSession({ benchmarkDates: ['2026-07-24', '2026-07-27', '2026-07-28'], now: nowOpen });
  assert.strictEqual(ctx.session, '2026-07-27', 'completed session, not the in-progress bar');
  assert.strictEqual(ctx.source, 'benchmark-completed');
  // Cached names carrying Monday's completed bar are current; a live partial Tuesday
  // bar is also current (same floor) — the cohort is never split by a mid-session read.
  assert.strictEqual(classifyBarDate('2026-07-27', ctx), FRESHNESS_CLASS.CURRENT);
  assert.strictEqual(classifyBarDate('2026-07-28', ctx), FRESHNESS_CLASS.CURRENT);
  assert.strictEqual(classifyBarDate('2026-07-24', ctx), FRESHNESS_CLASS.PRIOR_SESSION);
});

test('no benchmark axis → gate reports unavailable and adjudicated:false instead of guessing', () => {
  const gate = gateCohort([{ ticker: 'X', lastBarDate: '2026-07-31' }], { benchmarkDates: [], now: NOW });
  assert.strictEqual(gate.adjudicated, false);
  assert.strictEqual(gate.sessionSource, 'unavailable');
  assert.strictEqual(gate.admitted.length, 1, 'fail-open with the flag, never a silent empty scan');
});

test('cohort admission is invariant to input order', () => {
  const rows = [
    { ticker: 'A', lastBarDate: '2026-07-31' },
    { ticker: 'B', lastBarDate: '2026-07-20' },
    { ticker: 'C', lastBarDate: '2026-07-31' },
  ];
  const g1 = gateCohort(rows, { benchmarkDates: SPY_DATES, now: NOW });
  const g2 = gateCohort([...rows].reverse(), { benchmarkDates: SPY_DATES, now: NOW });
  assert.deepStrictEqual(new Set(g1.admitted.map(r => r.ticker)), new Set(g2.admitted.map(r => r.ticker)));
  assert.deepStrictEqual(g1.counts, g2.counts);
});
