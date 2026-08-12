// Screener Replay v3 — the shared engine + date-first replay contract:
// live/replay candidate parity on frozen fixtures, point-in-time immutability,
// order invariance, deterministic IDs, next-open fills, conservative
// gap-through stops, and reason-coded rejection.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ENGINE = require('../lib/swing-screener-engine');
const REPLAY = require('../lib/swing-replay-v3');
const { candidateId, candidateSetHash, makeObservation, REJECT } = require('../lib/swing-candidate-schema');
const { screenTicker } = require('../lib/screener');

// ── Synthetic market fixture ────────────────────────────────────────────────
// Deterministic daily bars: an uptrending "leader", a downtrending name, and a
// flat name, plus a benchmark. 320 bars ending 2026-07-31 (weekday-only-ish
// axis is irrelevant — the engine keys off the benchmark's own date axis).
function synthDates(n, endIso = '2026-07-31') {
  const out = [];
  let d = new Date(endIso + 'T00:00:00Z');
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() - 86400000);
  }
  return out.reverse();
}
function series(dates, { start = 50, drift = 0.001, wobble = 0.01, vol = 1e6 }) {
  const out = [];
  let px = start, prev = start;
  dates.forEach((date, i) => {
    px = px * (1 + drift + wobble * Math.sin(i / 3));
    const open = px * 0.999, close = px, high = px * 1.006, low = px * 0.993;
    // Up-days print 2.5× the volume of down-days — a clean accumulation footprint
    // (accumRatio ≥ 1.3), which is what lets the emerging-leader arm admit the
    // uptrending names even without a classic base-pattern status.
    const volume = Math.round(vol * (close >= prev ? 2.5 : 0.8)) + (i % 7) * 5e4;
    out.push({ date, open: +open.toFixed(4), high: +high.toFixed(4), low: +low.toFixed(4), close: +close.toFixed(4), volume, adjClose: +close.toFixed(4) });
    prev = close;
  });
  return out;
}
const DATES = synthDates(320);
const DATASET = new Map([
  ['UPUP', { candles: series(DATES, { start: 40, drift: 0.0015, wobble: 0.007 }), meta: { shortName: 'Up Co' } }],
  ['LEAD', { candles: series(DATES, { start: 25, drift: 0.0012, wobble: 0.006 }), meta: { shortName: 'Lead Co' } }],
  ['DOWN', { candles: series(DATES, { start: 90, drift: -0.002, wobble: 0.004 }), meta: { shortName: 'Down Co' } }],
  ['FLAT', { candles: series(DATES, { start: 30, drift: 0.0002, wobble: 0.002 }), meta: { shortName: 'Flat Co' } }],
]);
const SPY = series(DATES, { start: 400, drift: 0.0006, wobble: 0.002 });
const DECISION = DATES[280];   // leaves 39 forward sessions for outcomes

function liveStyleRows(decisionDate) {
  // Exactly what api/screener.js does live: screenTicker per name + lastBarDate.
  const spySlice = REPLAY.sliceAsOf(SPY, decisionDate);
  const spyByDate = {}; spySlice.forEach(x => { spyByDate[x.date] = x.close; });
  const rows = [];
  for (const [t, v] of DATASET) {
    const pit = REPLAY.sliceAsOf(v.candles, decisionDate);
    const r = screenTicker(pit, { ...v.meta, symbol: t }, { gate: 'relaxed', spyByDate });
    if (!r) continue;
    if (!r.ticker) r.ticker = t;
    r.lastBarDate = pit[pit.length - 1].date;
    rows.push(r);
  }
  return { rows, spySlice };
}

test('live and replay candidate IDs match on frozen fixtures (exact parity)', () => {
  const { rows, spySlice } = liveStyleRows(DECISION);
  const now = new Date(DECISION + 'T23:59:00Z');
  const live = ENGINE.selectCandidates({ rows, scope: 'large', spyCandles: spySlice, macroRiskOff: false, now });
  const liveIds = live.candidates.slice(0, live.cap).map(c =>
    candidateId({ strategyId: 'screener', scoringVersion: 'screener-v2', universeScope: 'large', ticker: c.ticker, decisionCutoff: DECISION }));

  const rep = REPLAY.replayDate({ dataset: DATASET, spyCandles: SPY, decisionDate: DECISION, scope: 'large' });
  assert.strictEqual(rep.ok, true);
  assert.deepStrictEqual(rep.candidateIds, liveIds, 'identical candidate IDs');
  assert.strictEqual(rep.candidateSetHash, candidateSetHash(liveIds), 'identical candidate-set hash — any mismatch fails parity');
});

test('candidate order is invariant to input order', () => {
  const { rows, spySlice } = liveStyleRows(DECISION);
  const now = new Date(DECISION + 'T23:59:00Z');
  const a = ENGINE.selectCandidates({ rows: [...rows], scope: 'large', spyCandles: spySlice, now });
  const b = ENGINE.selectCandidates({ rows: [...rows].reverse(), scope: 'large', spyCandles: spySlice, now });
  assert.deepStrictEqual(a.candidates.map(c => c.ticker), b.candidates.map(c => c.ticker));
});

test('mutating future bars cannot alter historical features or candidates', () => {
  const base = REPLAY.replayDate({ dataset: DATASET, spyCandles: SPY, decisionDate: DECISION, scope: 'large' });
  // Clone the dataset and violently mutate every bar AFTER the decision date.
  const mutated = new Map();
  for (const [t, v] of DATASET) {
    mutated.set(t, { ...v, candles: v.candles.map(b => b.date > DECISION ? { ...b, open: 1, high: 999, low: 0.5, close: 500, volume: 9e9 } : b) });
  }
  const after = REPLAY.replayDate({ dataset: mutated, spyCandles: SPY, decisionDate: DECISION, scope: 'large' });
  assert.deepStrictEqual(after.candidateIds, base.candidateIds, 'selection unchanged');
  assert.strictEqual(after.candidateSetHash, base.candidateSetHash, 'candidate-set hash unchanged');
  // Features on the selected observations are also byte-identical.
  const feat = (r) => r.observations.filter(o => o.status === 'selected').map(o => ({ t: o.ticker, f: o.features }));
  assert.deepStrictEqual(feat(after), feat(base));
});

test('deterministic candidate IDs: same identity → same id; changed cutoff → different id', () => {
  const idA = candidateId({ strategyId: 'screener', scoringVersion: 'screener-v2', universeScope: 'large', ticker: 'UPUP', decisionCutoff: DECISION });
  const idB = candidateId({ strategyId: 'screener', scoringVersion: 'screener-v2', universeScope: 'large', ticker: 'UPUP', decisionCutoff: DECISION });
  const idC = candidateId({ strategyId: 'screener', scoringVersion: 'screener-v2', universeScope: 'large', ticker: 'UPUP', decisionCutoff: DATES[281] });
  assert.strictEqual(idA, idB);
  assert.notStrictEqual(idA, idC);
  assert.throws(() => candidateId({ strategyId: 'screener', ticker: 'X' }), /missing required identity field/);
});

test('backtest fills at next-open (never the signal-day close) and grades conservatively', () => {
  const rep = REPLAY.replayDate({ dataset: DATASET, spyCandles: SPY, decisionDate: DECISION, scope: 'large' });
  const filled = rep.trades.filter(t => t.filled);
  assert.ok(filled.length >= 1, 'at least one candidate fills');
  for (const t of filled) {
    const bars = DATASET.get(t.ticker).candles;
    const dIdx = bars.findIndex(b => b.date === DECISION);
    assert.strictEqual(t.fillDate, bars[dIdx + 1].date, 'fill is the NEXT session');
    assert.ok(t.fillPrice >= bars[dIdx + 1].open, 'adverse slippage: long pays at or above the open');
    assert.notStrictEqual(t.fillPrice, bars[dIdx].close, 'signal-day close is never the fill');
    const h5 = t.horizons[5];
    assert.ok(h5 && Number.isFinite(h5.netBase) && h5.netBase < h5.raw, 'cost-net below raw');
    assert.ok(Number.isFinite(h5.netStressed) && h5.netStressed <= h5.netDoubled, 'stressed ≤ doubled-cost net');
    assert.ok(h5.mae <= 0 && h5.mfe >= 0, 'MAE/MFE signed correctly');
  }
});

test('gap-through stop is graded conservatively (stop before target on the same bar)', () => {
  // Synthetic: fill at 100, stop 95, target 106; the fill bar spans 94..107 —
  // BOTH levels touched; the conservative rule must count the stop first.
  const bars = [
    { date: '2026-07-01', open: 100, high: 101, low: 99, close: 100, volume: 1e6 },
    { date: '2026-07-02', open: 100, high: 107, low: 94, close: 105, volume: 1e6 },
  ];
  const path = REPLAY.planPath(bars, 1, 100, 95, 106, 5);
  assert.strictEqual(path.targetBeforeStop, false, 'ambiguous bar resolves to the stop (conservative)');
  assert.strictEqual(path.exit.kind, 'stop');
});

test('a deadline-truncated / unadjudicated cohort is marked and cannot generate promotion evidence', () => {
  const { rows } = liveStyleRows(DECISION);
  // No benchmark axis (the deadline-starved / missing-benchmark case).
  const sel = ENGINE.selectCandidates({ rows, scope: 'large', spyCandles: null, now: new Date(DECISION + 'T23:59:00Z') });
  assert.strictEqual(sel.freshness.adjudicated, false, 'cohort flagged incomplete');
  assert.ok(sel.rejections.some(r => r.reason === REJECT.MISSING_BENCHMARK), 'missing-benchmark reason recorded');
});

test('candidate cap, buffer and rejection reasons match live behavior', () => {
  const rep = REPLAY.replayDate({ dataset: DATASET, spyCandles: SPY, decisionDate: DECISION, scope: 'large' });
  assert.ok(rep.counts.selected <= ENGINE.SCOPE_CONFIG.large.cap);
  // Every cohort name is accounted for: selected + near-miss + rejected.
  assert.strictEqual(rep.counts.cohort, rep.counts.selected + rep.counts.nearMiss + rep.counts.rejected);
  // The downtrending name is rejected through the live trend/RS gates with a code.
  const downObs = rep.observations.find(o => o.ticker === 'DOWN' && o.status === 'rejected');
  assert.ok(downObs, 'rejected candidate retained as an observation');
  assert.ok([REJECT.LIVE_TREND_GATE, REJECT.RELATIVE_STRENGTH_GATE, REJECT.NO_QUALIFYING_SETUP].includes(downObs.rejectionCode));
});

test('observation schema fails closed on contract violations', () => {
  assert.throws(() => makeObservation({ strategyId: 'screener', scoringVersion: 'v1', universeScope: 'large', ticker: 'X', decisionCutoff: '2026-07-01', status: 'rejected', rejectionCode: 'because' }), /canonical rejectionCode/);
  assert.throws(() => makeObservation({ strategyId: 'screener', scoringVersion: 'v1', universeScope: 'large', ticker: 'X', decisionCutoff: '2026-07-01', status: 'weird' }), /invalid status/);
});
