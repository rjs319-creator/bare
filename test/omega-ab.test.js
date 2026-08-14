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

test('live OMEGA has no code path into the A/B', () => {
  const fs = require('node:fs');
  const omega = fs.readFileSync(require.resolve('../lib/omega-swing.js'), 'utf8');
  assert.ok(!/omega-ab/.test(omega));
  const routes = fs.readFileSync(require.resolve('../lib/omega-swing-routes.js'), 'utf8');
  assert.ok(!/omega-ab/.test(routes));
});
