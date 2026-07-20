'use strict';
// EXPERIMENT #3 harness tests. The point of these is leakage: the baseline must not see
// future bars, the outcome must be a real elapsed forward fill (not a truncated one), and
// the insider signal must be invisible until its Form 4 is FILED. If any of these leak, a
// "no-edge" verdict could hide a real edge — or, worse, invent one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/nsl/insider-incremental');

// Weekday-aware series: close moves by `step`/day from `start`.
function series(from, n, start = 100, step = 1) {
  const out = []; const d = new Date(from + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const close = start + i * step;
    out.push({ date: d.toISOString().slice(0, 10), open: close, high: close + 0.5, low: close - 0.5, close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const CFG = { lookbackBars: 20, skipBars: 2, horizonBars: 5 };

// ── momentum baseline (PIT) ──────────────────────────────────────────────────
test('momentumScore is positive for a riser, negative for a faller', () => {
  const up = series('2026-01-05', 60, 100, 1), down = series('2026-01-05', 60, 100, -1);
  assert.ok(H.momentumScore(up, '2026-03-01', CFG) > 0);
  assert.ok(H.momentumScore(down, '2026-03-01', CFG) < 0);
});

test('momentumScore returns null without enough trailing history (never looks ahead)', () => {
  const c = series('2026-01-05', 60, 100, 1);
  // Too early — fewer than lookbackBars sessions exist before this date.
  assert.equal(H.momentumScore(c, '2026-01-07', CFG), null);
});

test('momentumScore uses only bars on/before the decision date', () => {
  const c = series('2026-01-05', 60, 100, 1);
  // Appending a wild future bar must not change a past decision's momentum.
  const withFuture = [...c, { date: '2026-12-31', open: 9999, high: 9999, low: 9999, close: 9999 }];
  assert.equal(H.momentumScore(c, '2026-03-01', CFG), H.momentumScore(withFuture, '2026-03-01', CFG));
});

// ── forward outcome (real elapsed fill) ──────────────────────────────────────
test('forwardReturn enters at the NEXT open and matches the held move', () => {
  const c = series('2026-01-05', 60, 100, 1);      // +1/session, open==close
  const r = H.forwardReturn(c, '2026-02-02', CFG);
  assert.ok(r && Number.isFinite(r.outcome));
  assert.ok(r.outcome > 0, 'a rising series is a positive forward return');
  assert.ok(r.labelEndDate > '2026-02-02');
});

test('forwardReturn returns null when the horizon has not fully elapsed (purge, not truncate)', () => {
  const c = series('2026-01-05', 30, 100, 1);
  // A date near the end of the data cannot have 5 forward sessions — must drop.
  const lastDate = c[c.length - 1].date;
  assert.equal(H.forwardReturn(c, lastDate, CFG), null);
});

// ── insider signal (the leakage guard) ───────────────────────────────────────
// An opportunistic buy transacted 03-10, FILED 03-11.
const opp = (over = {}) => ({ date: '2026-03-10', code: 'P', value: 600000, owner: 'CEO',
  filingDate: '2026-03-11', isOfficer: true, isDirector: false, isTenPct: false, ...over });
// An older, already-public routine filing — makes the name a KNOWN filer at every date below,
// so signal reads 0 (no recent conviction) rather than null (unknown), isolating the leak test.
const older = { date: '2025-06-02', code: 'P', value: 20000, owner: 'DIR',
  filingDate: '2025-06-03', isOfficer: false, isDirector: true, isTenPct: false };

test('insiderSignal is invisible before the Form 4 is FILED, visible after', () => {
  const txs = [older, opp()];
  // As-of 03-10 the opportunistic filing does not yet exist publicly → known filer, but no
  // window activity → 0. It must NOT leak the not-yet-filed buy.
  assert.equal(H.insiderSignal(txs, '2026-03-10'), 0, 'a not-yet-filed trade must not leak');
  // As-of 03-20 the filing is public and within the window → positive conviction.
  const after = H.insiderSignal(txs, '2026-03-20');
  assert.ok(after > 0, `filed opportunistic buy should read positive, got ${after}`);
});

test('insiderSignal is null for a non-filer (excluded) and 0 for a filer with no window activity', () => {
  assert.equal(H.insiderSignal([], '2026-03-20'), null, 'no Form 4 history at all → excluded');
  // Only a stale filing far outside the 90-day window → known filer, empty window → 0.
  assert.equal(H.insiderSignal([older], '2026-03-20'), 0);
});

// ── panel assembly ───────────────────────────────────────────────────────────
test('assembleSamples emits one complete PIT row per (date,ticker) and drops incomplete ones', () => {
  const candles = series('2026-01-05', 90, 100, 1);
  const tickerData = [
    { ticker: 'AAA', candles, txs: [older, opp()] },  // known filer at both dates
    { ticker: 'BBB', candles, txs: [] },              // non-filer → dropped (noSignal)
  ];
  const dates = ['2026-03-02', '2026-03-30'];
  const { samples, diagnostics } = H.assembleSamples(tickerData, dates, CFG);
  // AAA contributes both dates (03-02 signal 0, 03-30 signal > 0); BBB contributes none.
  assert.equal(samples.length, 2);
  assert.ok(samples.every(s => s.ticker === 'AAA'));
  const s0330 = samples.find(s => s.date === '2026-03-30');
  assert.ok(s0330.signal > 0, 'the opportunistic buy shows once filed');
  assert.equal(samples.find(s => s.date === '2026-03-02').signal, 0, 'no window activity yet');
  assert.ok(diagnostics.dropped.noSignal >= 2, 'the non-filer is dropped for lack of signal');
  assert.ok(samples.every(s => Number.isFinite(s.baseline) && Number.isFinite(s.signal) && Number.isFinite(s.outcome)));
});

test('runInsiderIncremental returns an evaluation (insufficient on a tiny panel, honestly)', () => {
  const candles = series('2026-01-05', 90, 100, 1);
  const tickerData = [{ ticker: 'AAA', candles, txs: [older, opp()] }];
  const r = H.runInsiderIncremental(tickerData, ['2026-03-02'], CFG, { minPerDate: 8, minDates: 8 });
  assert.ok(r.evaluation.insufficient, 'one name on one date cannot support a cross-sectional IC');
  assert.equal(typeof r.nSamples, 'number');
});
