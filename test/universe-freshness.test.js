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
const { gateCohort, classifyBarDate, resolveDecisionSession, countSessionsBetween, FRESHNESS_CLASS } = require('../lib/cohort-freshness');

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
  assert.deepStrictEqual(gate.counts, { current: 1, 'prior-session': 1, stale: 1, 'ahead-of-benchmark': 0, 'future-dated': 1, missing: 1 });
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

// ── A LAGGING BENCHMARK MUST NOT REDEFINE "TODAY" ───────────────────────────
// Reproduces prod on 2026-08-18: the provider had no 2026-08-17 SPY bar, so the gate
// adjudicated all 514 names to 2026-08-14 and discarded the only two names that DID
// carry Monday's bar as `future-dated` — the freshest data in the scan, thrown out as
// bogus, with nothing on the response to say the scan was a session behind.
const LAGGING_SPY = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
const TUE_PREMARKET = new Date('2026-08-18T13:22:00Z');   // 09:22 ET Tuesday

test('a benchmark behind the exchange calendar is DECLARED stale, not silently authoritative', () => {
  const ctx = resolveDecisionSession({ benchmarkDates: LAGGING_SPY, now: TUE_PREMARKET });
  assert.strictEqual(ctx.calendarSession, '2026-08-17', 'the calendar knows Monday completed');
  assert.strictEqual(ctx.benchmarkStale, true);
  assert.strictEqual(ctx.sessionsBehind, 1);
  assert.strictEqual(ctx.source, 'benchmark-stale');
});

test('a real session the lagging benchmark has not reached is NOT condemned as future-dated', () => {
  const ctx = resolveDecisionSession({ benchmarkDates: LAGGING_SPY, now: TUE_PREMARKET });
  // Monday's bar is real data the benchmark simply lacks — excluded from a 08-14 cohort
  // (admitting it would re-mix vintages) but never labelled bogus.
  assert.strictEqual(classifyBarDate('2026-08-17', ctx), FRESHNESS_CLASS.AHEAD_OF_BENCHMARK);
  // A date the exchange calendar cannot justify at all is still bogus.
  assert.strictEqual(classifyBarDate('2026-08-25', ctx), FRESHNESS_CLASS.FUTURE_DATED);
  assert.strictEqual(classifyBarDate('2026-08-14', ctx), FRESHNESS_CLASS.CURRENT);
});

test('the stale verdict travels on the gate so a scan can report how far behind it is', () => {
  const rows = [
    { ticker: 'STALE_MAJORITY', lastBarDate: '2026-08-14' },
    { ticker: 'HUBB', lastBarDate: '2026-08-17' },
    { ticker: 'MNST', lastBarDate: '2026-08-17' },
  ];
  const gate = gateCohort(rows, { benchmarkDates: LAGGING_SPY, now: TUE_PREMARKET });
  assert.strictEqual(gate.benchmarkStale, true);
  assert.strictEqual(gate.sessionsBehind, 1);
  assert.strictEqual(gate.calendarSession, '2026-08-17');
  assert.strictEqual(gate.counts['ahead-of-benchmark'], 2);
  assert.strictEqual(gate.counts['future-dated'], 0, 'no longer misfiled as corrupt data');
  const reasons = Object.fromEntries(gate.excluded.map(e => [e.ticker, e.reason]));
  assert.strictEqual(reasons.HUBB, 'ahead-of-benchmark');
});

test('a healthy benchmark is unchanged: no lag flag, and a genuinely bogus date still fails', () => {
  const ctx = resolveDecisionSession({ benchmarkDates: SPY_DATES, now: NOW });
  assert.strictEqual(ctx.benchmarkStale, false);
  assert.strictEqual(ctx.sessionsBehind, 0);
  assert.strictEqual(ctx.source, 'benchmark-latest');
  assert.strictEqual(classifyBarDate('2026-08-05', ctx), FRESHNESS_CLASS.FUTURE_DATED);
  assert.strictEqual(classifyBarDate('2026-07-31', ctx), FRESHNESS_CLASS.CURRENT);
});

test('an in-progress partial bar stays CURRENT and is never reclassified by the lag logic', () => {
  // Tuesday 10:30 ET, benchmark carries the in-progress bar — the healthy open-market case.
  const nowOpen = new Date('2026-07-28T14:30:00Z');
  const ctx = resolveDecisionSession({ benchmarkDates: ['2026-07-24', '2026-07-27', '2026-07-28'], now: nowOpen });
  assert.strictEqual(ctx.benchmarkStale, false, 'a benchmark at the live session is not behind');
  assert.strictEqual(classifyBarDate('2026-07-28', ctx), FRESHNESS_CLASS.CURRENT);
});

test('sessions behind counts TRADING sessions, skipping the weekend', () => {
  // Fri 08-14 → Tue 08-18: Mon 08-17 and Tue 08-18 are sessions; Sat/Sun are not.
  assert.strictEqual(countSessionsBetween('2026-08-14', '2026-08-17'), 1);
  assert.strictEqual(countSessionsBetween('2026-08-14', '2026-08-18'), 2);
  assert.strictEqual(countSessionsBetween('2026-08-17', '2026-08-17'), 0);
  assert.strictEqual(countSessionsBetween('2026-08-18', '2026-08-17'), 0, 'never negative');
});

// ── A HOLE IN THE MIDDLE IS AS STALE AS A SHORT TAIL ────────────────────────
// Later on 2026-08-18 the SPY axis read ...08-13, 08-14, 08-18: Monday absent, today's
// partial bar present. The NEWEST bar was therefore today and every day-based freshness
// check went green — while the session the rankings were actually computed on was still
// Friday. Judging staleness by the newest bar calls that healthy.
const AXIS_WITH_HOLE = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-18'];
const TUE_OPEN = new Date('2026-08-18T14:02:00Z');   // 10:02 ET, regular session

test('a missing mid-series session is caught even though the newest bar is today', () => {
  const ctx = resolveDecisionSession({ benchmarkDates: AXIS_WITH_HOLE, now: TUE_OPEN });
  assert.strictEqual(ctx.latest, '2026-08-18', 'newest bar looks perfectly fresh');
  assert.strictEqual(ctx.session, '2026-08-14', 'but the decision session is still Friday');
  assert.strictEqual(ctx.benchmarkStale, true, 'judged on the SESSION, not the newest bar');
  assert.strictEqual(ctx.sessionsBehind, 1);
});

test('a lagging benchmark never blanks the app: an all-ahead cohort fails open with a flag', () => {
  // Shape of a warm rebuild that picked up the new session for the constituents but not
  // the index. Excluding every name would leave the user staring at an empty screener.
  const rows = ['A', 'B', 'C'].map(t => ({ ticker: t, lastBarDate: '2026-08-18' }));
  const gate = gateCohort(rows, { benchmarkDates: AXIS_WITH_HOLE, now: TUE_OPEN });
  assert.strictEqual(gate.admitted.length, 3, 'admitted rather than collapsed to nothing');
  assert.strictEqual(gate.cohortAheadOfBenchmark, true);
  assert.strictEqual(gate.sessionSource, 'cohort-ahead-of-benchmark');
  assert.strictEqual(gate.benchmarkStale, true, 'still honestly flagged as behind');
  assert.deepStrictEqual(gate.excluded, [], 'nothing left excluded once we fail open');
});

test('a MINORITY ahead of a lagging benchmark is still excluded, not admitted wholesale', () => {
  const rows = [
    { ticker: 'MAJ1', lastBarDate: '2026-08-14' },
    { ticker: 'MAJ2', lastBarDate: '2026-08-14' },
    { ticker: 'AHEAD', lastBarDate: '2026-08-18' },
  ];
  const gate = gateCohort(rows, { benchmarkDates: AXIS_WITH_HOLE, now: TUE_OPEN });
  assert.deepStrictEqual(gate.admitted.map(r => r.ticker), ['MAJ1', 'MAJ2'], 'same-vintage cohort preserved');
  assert.strictEqual(gate.cohortAheadOfBenchmark, false);
  assert.strictEqual(gate.excluded.length, 1);
  assert.strictEqual(gate.excluded[0].reason, 'ahead-of-benchmark');
});

test('a healthy open market is untouched by the lag logic', () => {
  const ctx = resolveDecisionSession({ benchmarkDates: ['2026-07-24', '2026-07-27', '2026-07-28'], now: new Date('2026-07-28T14:30:00Z') });
  assert.strictEqual(ctx.session, '2026-07-27');
  assert.strictEqual(ctx.benchmarkStale, false, 'an in-progress bar is not a missing session');
  assert.strictEqual(ctx.sessionsBehind, 0);
});
