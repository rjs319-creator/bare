'use strict';
// OMEGA R10-vs-SCORE prospective shadow A/B — decision immutability, resolution math,
// fail-closed gates, auth, and live-OMEGA isolation.
const { test } = require('node:test');
const assert = require('node:assert');
const AB = require('../lib/omega-ab');

const D = '2026-08-14';
const row = (ticker, score, r10, over = {}) => ({ ticker, lastBarDate: D, score, r10, dollarVol: 5e8, costPct: 0.16, ...over });
const mkRows = (n = 30) => Array.from({ length: n }, (_, i) => row(`T${String(i).padStart(2, '0')}`, 90 - i, (n - i) / 100));

function candlesFrom(date, opens, closes) {
  const d0 = Date.parse(`${date}T00:00:00Z`);
  return opens.map((o, i) => ({ date: new Date(d0 + i * 86_400_000).toISOString().slice(0, 10), open: o, high: Math.max(o, closes[i]) + 1, low: Math.min(o, closes[i]) - 1, close: closes[i], volume: 1e6 }));
}

test('decision doc stamps both arms before any outcome exists', () => {
  const doc = AB.buildDecisionDoc({ date: D, rows: mkRows(), createdAt: 'now' });
  assert.strictEqual(doc.armScoreTop.length, AB.FROZEN.topK);
  assert.strictEqual(doc.armR10Top.length, AB.FROZEN.topK);
  assert.ok(doc.rows.every((r) => r.outcomeStatus === 'PENDING' && r.entryDate === null && r.netResidualReturn === null));
  assert.strictEqual(doc.resolved, false);
  assert.strictEqual(doc.provenance, 'prospective_frozen_shadow');
  // Ranks are deterministic with the ticker tiebreak.
  const tied = AB.buildDecisionDoc({ date: D, rows: [...mkRows(25), row('AAA', 90, 0.01), row('ZZZ', 90, 0.01)], createdAt: 'now' });
  const aaa = tied.rows.find((r) => r.ticker === 'AAA'), zzz = tied.rows.find((r) => r.ticker === 'ZZZ');
  assert.ok(aaa.scoreRank < zzz.scoreRank);
});

test('both arms rank the identical row set (no per-arm exclusions)', () => {
  const rows = mkRows(28);
  rows[5] = { ...rows[5], r10: NaN };            // invalid row must vanish from BOTH arms
  const doc = AB.buildDecisionDoc({ date: D, rows, createdAt: 'now' });
  assert.strictEqual(doc.evaluated, 27);
  assert.ok(!doc.rows.some((r) => r.ticker === rows[5].ticker));
});

test('a thin cross-section refuses to stamp a decision', () => {
  assert.strictEqual(AB.buildDecisionDoc({ date: D, rows: mkRows(AB.FROZEN.minRows - 1), createdAt: 'now' }), null);
});

test('rows whose last bar is not the decision bar are excluded', () => {
  const rows = mkRows(25);
  rows[0] = { ...rows[0], lastBarDate: '2026-08-13' };
  const doc = AB.buildDecisionDoc({ date: D, rows, createdAt: 'now' });
  assert.strictEqual(doc.evaluated, 24);
});

test('resolution fills outcomes with next-open entry and 5th-session close exit — decisions untouched', () => {
  const doc = AB.buildDecisionDoc({ date: D, rows: mkRows(25), createdAt: 'now' });
  // Candles: decision bar at index 0 → entry open index 1 (=101), exit close index 5 (=115).
  const opens = [100, 101, 102, 103, 104, 105, 106];
  const closes = [100, 108, 109, 110, 111, 115, 116];
  const histories = new Map(doc.rows.map((r) => [r.ticker, candlesFrom(D, opens, closes)]));
  const spy = candlesFrom(D, [500, 500, 500, 500, 500, 500, 500], [500, 500, 500, 500, 500, 505, 505]);
  const { doc: next, pending } = AB.resolveDecisionDoc(doc, { histories, spy, resolvedAt: 'later' });
  assert.strictEqual(pending, 0);
  assert.strictEqual(next.resolved, true);
  const r = next.rows[0];
  assert.strictEqual(r.entryOpen, 101);
  assert.strictEqual(r.exitClose, 115);
  const raw = (115 / 101 - 1) * 100, bench = (505 / 500 - 1) * 100;
  assert.ok(Math.abs(r.rawReturn - raw) < 1e-3);
  assert.ok(Math.abs(r.benchmarkReturn - bench) < 1e-3);
  assert.ok(Math.abs(r.netResidualReturn - (raw - bench - 0.16)) < 1e-3);
  // Decision fields byte-identical before/after resolution.
  for (const [a, b] of next.rows.map((x, i) => [x, doc.rows[i]])) {
    for (const k of ['ticker', 'score', 'r10', 'scoreRank', 'r10Rank', 'selectedScore', 'selectedR10', 'cost']) {
      assert.deepStrictEqual(a[k], b[k]);
    }
  }
});

test('an immature series stays PENDING — outcomes are never fabricated', () => {
  const doc = AB.buildDecisionDoc({ date: D, rows: mkRows(25), createdAt: 'now' });
  const shortHist = new Map(doc.rows.map((r) => [r.ticker, candlesFrom(D, [100, 101, 102], [100, 101, 102])]));
  const spy = candlesFrom(D, [500, 500, 500, 500, 500, 500, 500], [500, 500, 500, 500, 500, 505, 505]);
  const { doc: next, pending } = AB.resolveDecisionDoc(doc, { histories: shortHist, spy, resolvedAt: 'later' });
  assert.ok(pending > 0);
  assert.strictEqual(next.resolved, false);
  assert.ok(next.rows.every((r) => r.outcomeStatus === 'PENDING'));
});

test('seriesPoint reads only fully resolved docs and diffs r10 minus score arms', () => {
  const doc = AB.buildDecisionDoc({ date: D, rows: mkRows(25), createdAt: 'now' });
  assert.strictEqual(AB.seriesPoint(doc), null);   // unresolved → no point
  const opens = [100, 100, 100, 100, 100, 100, 100];
  const histories = new Map(doc.rows.map((r, i) => [r.ticker, candlesFrom(D, opens, [100, 100, 100, 100, 100, 100 + i, 100 + i])]));
  const spy = candlesFrom(D, opens, [100, 100, 100, 100, 100, 100, 100]);
  const { doc: next } = AB.resolveDecisionDoc(doc, { histories, spy, resolvedAt: 'later' });
  const p = AB.seriesPoint(next);
  assert.ok(p && Number.isFinite(p.scoreArm) && Number.isFinite(p.r10Arm));
  assert.ok(Math.abs(p.diff - (p.r10Arm - p.scoreArm)) < 1e-9);
});

test('the verdict can never leave INSUFFICIENT_DATA before 100 resolved dates', () => {
  const good = Array.from({ length: 99 }, (_, i) => ({ date: `d${i}`, scoreArm: 0, r10Arm: 1, diff: 1 }));
  const a = AB.assessAb(good);
  assert.strictEqual(a.verdict, 'INSUFFICIENT_DATA');
  const b = AB.assessAb([...good, { date: 'd99', scoreArm: 0, r10Arm: 1, diff: 1 }]);
  assert.notStrictEqual(b.verdict, 'INSUFFICIENT_DATA');
});

test('prospective gates: positive mean + CI above zero + 3/4 blocks, else NO_INCREMENTAL_ALPHA', () => {
  let s = 7;
  const rnd = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 2 ** 32; };
  const noisyPositive = Array.from({ length: 120 }, (_, i) => { const d = 0.5 + (rnd() - 0.5) * 0.4; return { date: `d${i}`, scoreArm: 0, r10Arm: d, diff: d }; });
  const pass = AB.assessAb(noisyPositive);
  assert.strictEqual(pass.verdict, 'PROMOTION_REVIEW_REQUIRED');
  assert.ok(pass.diffCi95.lo > 0);
  const flat = Array.from({ length: 120 }, (_, i) => { const d = (rnd() - 0.5) * 2; return { date: `d${i}`, scoreArm: 0, r10Arm: d, diff: d }; });
  const fail = AB.assessAb(flat);
  assert.strictEqual(fail.verdict, 'NO_INCREMENTAL_ALPHA');
  assert.ok(fail.verdictReasons.length > 0);
});

test('the bootstrap is deterministic under the frozen seed', () => {
  let s = 11;
  const rnd = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 2 ** 32; };
  const series = Array.from({ length: 110 }, () => (rnd() - 0.5) * 2);
  assert.deepStrictEqual(AB.bootstrapCI(series), AB.bootstrapCI(series));
});

test('authentication protects the tick', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'ab-test-secret';
  try {
    delete require.cache[require.resolve('../lib/omega-ab-routes')];
    const R = require('../lib/omega-ab-routes');
    const res = { headers: {}, code: null, body: null, setHeader(k, v) { res.headers[k] = v; }, status(c) { res.code = c; return res; }, json(o) { res.body = o; return res; } };
    await R.runOmegaAbTick({ query: {}, headers: {} }, res);
    assert.strictEqual(res.code, 401);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    delete require.cache[require.resolve('../lib/omega-ab-routes')];
  }
});

test('tracker + warm chains wiring: omegaabtick privileged, chain registered and rooted', () => {
  const src = require('node:fs').readFileSync(require.resolve('../api/tracker.js'), 'utf8');
  assert.ok(/op === 'omegaab'/.test(src) && /op === 'omegaabtick'/.test(src));
  assert.ok(/'omegaabtick'/.test(src.match(/PRIVILEGED_OPS = new Set\(\[([\s\S]*?)\]\)/)[1]));
  const WC = require('../lib/warm-chains');
  assert.deepStrictEqual(WC.CHAINS.omegaab, ['op=omegaabtick']);
  assert.ok(WC.ROOT_CHAINS.includes('omegaab'));
});

// ── resolution robustness (audit 2026-08-14) ────────────────────────────────
// A row must never flip terminal UNRESOLVABLE off ONE night's bad fetch: a truncated
// provider series that lost the decision bar tonight may serve it fine tomorrow. The
// row stays PENDING with an additive `attempts` counter and only becomes UNRESOLVABLE
// after >= FROZEN.maxResolveAttempts failed attempts on different runs.

test('a lost decision bar keeps the row PENDING with an attempts counter — terminal only after 3 runs', () => {
  const doc = AB.buildDecisionDoc({ date: D, rows: mkRows(25), createdAt: 'now' });
  // Every series LOST the decision bar (history starts the day after).
  const lost = new Map(doc.rows.map((r) => [r.ticker,
    candlesFrom('2026-08-15', [100, 101, 102, 103, 104, 105, 106], [100, 101, 102, 103, 104, 105, 106])]));
  const spy = candlesFrom(D, [500, 500, 500, 500, 500, 500, 500], [500, 500, 500, 500, 500, 505, 505]);
  assert.strictEqual(AB.FROZEN.maxResolveAttempts, 3);
  let cur = doc;
  for (let run = 1; run < AB.FROZEN.maxResolveAttempts; run++) {
    const { doc: next, pending } = AB.resolveDecisionDoc(cur, { histories: lost, spy, resolvedAt: 'later' });
    assert.ok(next.rows.every((r) => r.outcomeStatus === 'PENDING' && r.attempts === run),
      `run ${run}: rows must stay PENDING with attempts=${run}`);
    assert.ok(pending > 0, 'failed-but-retryable rows count as pending');
    assert.strictEqual(next.resolved, false);
    cur = next;
  }
  const { doc: final } = AB.resolveDecisionDoc(cur, { histories: lost, spy, resolvedAt: 'later' });
  assert.ok(final.rows.every((r) => r.outcomeStatus === 'UNRESOLVABLE' && r.attempts === AB.FROZEN.maxResolveAttempts));
  assert.strictEqual(final.resolved, true, 'all-settled after the attempts budget is exhausted');
});

test('an immature series accrues NO attempts — waiting is not failing', () => {
  const doc = AB.buildDecisionDoc({ date: D, rows: mkRows(25), createdAt: 'now' });
  const shortHist = new Map(doc.rows.map((r) => [r.ticker, candlesFrom(D, [100, 101, 102], [100, 101, 102])]));
  const spy = candlesFrom(D, [500, 500, 500, 500, 500, 500, 500], [500, 500, 500, 500, 500, 505, 505]);
  const { doc: next } = AB.resolveDecisionDoc(doc, { histories: shortHist, spy, resolvedAt: 'later' });
  assert.ok(next.rows.every((r) => r.outcomeStatus === 'PENDING' && !(r.attempts > 0)),
    'immaturity must not burn the attempts budget');
});

// ── waiting-state grace (review 2026-08-15) ─────────────────────────────────
// "Waiting is not failing" left a hole: a DELISTED ticker's history is null forever,
// so its rows never burned attempts and its date could never terminate — it consumed
// the tick's resolve budget every night while newer dates starved. Waiting states now
// burn attempts once the doc is > horizon + missingHistoryGraceSessions SPY sessions
// past the decision, so such rows eventually reach terminal UNRESOLVABLE.

test('null history WITHIN the grace window accrues NO attempts — still just waiting', () => {
  const doc = AB.buildDecisionDoc({ date: D, rows: mkRows(25), createdAt: 'now' });
  // 12 SPY bars → 11 sessions past the decision ≤ horizon(5) + grace(10).
  const flat = Array.from({ length: 12 }, () => 500);
  const spy = candlesFrom(D, flat, flat);
  const { doc: next } = AB.resolveDecisionDoc(doc, { histories: new Map(), spy, resolvedAt: 'later' });
  assert.ok(next.rows.every((r) => r.outcomeStatus === 'PENDING' && !(r.attempts > 0)),
    'within grace, missing history must not burn the attempts budget');
});

test('persistent null history PAST the grace window burns attempts and reaches UNRESOLVABLE', () => {
  const doc = AB.buildDecisionDoc({ date: D, rows: mkRows(25), createdAt: 'now' });
  // 20 SPY bars → 19 sessions past the decision > horizon(5) + grace(10).
  const flat = Array.from({ length: 20 }, () => 500);
  const spy = candlesFrom(D, flat, flat);
  let cur = doc;
  for (let run = 1; run < AB.FROZEN.maxResolveAttempts; run++) {
    const { doc: next } = AB.resolveDecisionDoc(cur, { histories: new Map(), spy, resolvedAt: 'later' });
    assert.ok(next.rows.every((r) => r.outcomeStatus === 'PENDING' && r.attempts === run),
      `run ${run}: expired waiting must burn one attempt per run`);
    cur = next;
  }
  const { doc: final } = AB.resolveDecisionDoc(cur, { histories: new Map(), spy, resolvedAt: 'later' });
  assert.ok(final.rows.every((r) => r.outcomeStatus === 'UNRESOLVABLE'),
    'a delisted ticker must eventually terminate instead of pending forever');
  assert.strictEqual(final.resolved, true);
  // Both arms all-UNRESOLVABLE → the resolved doc yields NO series point (degenerate):
  // the tick must account for it explicitly, never fold it into the series.
  assert.strictEqual(AB.seriesPoint(final), null);
});

test('a series that stays short of the horizon past grace is likewise terminal, not immortal', () => {
  const doc = AB.buildDecisionDoc({ date: D, rows: mkRows(25), createdAt: 'now' });
  const flat = Array.from({ length: 20 }, () => 500);
  const spy = candlesFrom(D, flat, flat);
  // History EXISTS and contains the decision bar, but never grows past 3 bars.
  const short = new Map(doc.rows.map((r) => [r.ticker, candlesFrom(D, [100, 101, 102], [100, 101, 102])]));
  const { doc: next } = AB.resolveDecisionDoc(doc, { histories: short, spy, resolvedAt: 'later' });
  assert.ok(next.rows.every((r) => r.attempts === 1),
    'a stuck-short series past grace must burn attempts like missing history does');
});

test('a legacy doc without attempts fields still resolves normally', () => {
  const doc = AB.buildDecisionDoc({ date: D, rows: mkRows(25), createdAt: 'now' });
  const legacy = { ...doc, rows: doc.rows.map(({ attempts, ...r }) => r) };   // pre-audit shape
  const opens = [100, 101, 102, 103, 104, 105, 106];
  const closes = [100, 108, 109, 110, 111, 115, 116];
  const histories = new Map(legacy.rows.map((r) => [r.ticker, candlesFrom(D, opens, closes)]));
  const spy = candlesFrom(D, [500, 500, 500, 500, 500, 500, 500], [500, 500, 500, 500, 500, 505, 505]);
  const { doc: next, pending } = AB.resolveDecisionDoc(legacy, { histories, spy, resolvedAt: 'later' });
  assert.strictEqual(pending, 0);
  assert.strictEqual(next.resolved, true);
});

// ── forming-bar guard (audit 2026-08-14) ────────────────────────────────────
// Only cron timing used to keep a decision from being stamped off a forming intraday
// SPY bar. The guard is now code-level: the bar date must be strictly before the
// current NY calendar date, or equal to it with NY time >= 16:05.

test('isCompletedSessionBar: prior session yes, forming session no, post-16:05 yes, future never', () => {
  // 2026-08-14 is EDT (UTC-4): 18:00Z = 14:00 NY (RTH, forming).
  assert.strictEqual(AB.isCompletedSessionBar('2026-08-14', new Date('2026-08-14T18:00:00Z')), false);
  // 20:04Z = 16:04 NY — one minute early is still forming.
  assert.strictEqual(AB.isCompletedSessionBar('2026-08-14', new Date('2026-08-14T20:04:00Z')), false);
  // 20:05Z = 16:05 NY — session complete.
  assert.strictEqual(AB.isCompletedSessionBar('2026-08-14', new Date('2026-08-14T20:05:00Z')), true);
  // A prior session's bar is always complete, whatever the clock says.
  assert.strictEqual(AB.isCompletedSessionBar('2026-08-13', new Date('2026-08-14T14:00:00Z')), true);
  // A future-dated bar is never acceptable.
  assert.strictEqual(AB.isCompletedSessionBar('2026-08-15', new Date('2026-08-14T21:00:00Z')), false);
  // Garbage input fails closed.
  assert.strictEqual(AB.isCompletedSessionBar('not-a-date', new Date('2026-08-14T21:00:00Z')), false);
  assert.strictEqual(AB.isCompletedSessionBar(null, new Date('2026-08-14T21:00:00Z')), false);
});

test('the tick guards the stamp, retries ALL matured unresolved days oldest-first, and surfaces stuckDates', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/omega-ab-routes.js'), 'utf8');
  // Guard runs BEFORE the decision write.
  const guardIdx = src.indexOf('isCompletedSessionBar');
  const stampIdx = src.indexOf('writeJSON(dayKey(today)');
  assert.ok(guardIdx > -1, 'the forming-bar guard must be applied in the tick');
  assert.ok(stampIdx > -1 && guardIdx < stampIdx, 'the guard must run before the decision is stamped');
  // The 30-day retry window silently dropped days stuck pending longer than 30 matured
  // days. All unresolved matured days are retried (bounded, oldest first) and anything
  // left over is surfaced instead of dropped.
  assert.ok(!/matured\.slice\(-30\)/.test(src), 'the silent 30-day retry window must not return');
  assert.match(src, /MAX_RESOLVE_PER_TICK/, 'per-tick resolution work stays bounded');
  assert.match(src, /stuckDates/, 'days stuck unresolved must be surfaced, not dropped');
});

test('live OMEGA has no code path into the A/B', () => {
  const fs = require('node:fs');
  const omega = fs.readFileSync(require.resolve('../lib/omega-swing.js'), 'utf8');
  assert.ok(!/omega-ab/.test(omega));
  const routes = fs.readFileSync(require.resolve('../lib/omega-swing-routes.js'), 'utf8');
  assert.ok(!/omega-ab/.test(routes));
});
