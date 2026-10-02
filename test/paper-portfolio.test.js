'use strict';
// lib/paper-portfolio — the simulated house book: Session Board A/B rows → exec-v1 next-open
// fills with tier slippage → stop/target/horizon exits → Activities ledger → equity.
// Every expected number is derived by hand in the comment next to it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PP = require('../lib/paper-portfolio');
const { roundTripCostPct } = require('../lib/costs');

const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c, volume: 1e6 });
// Sept 2026 sessions: Mon 14, Tue 15, Wed 16, Thu 17, Fri 18, Mon 21 … Wed 30.
const D = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30'];
const SMALL_SLIP = 0.003;    // (15 + 15) bps one leg, small tier
const LIQUID_SLIP = 0.0008;  // (3 + 5) bps one leg, liquid tier
const NOTIONAL = PP.NOTIONAL_PER_POSITION_USD;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !== ${b}`);

const item = (ticker, letter, horizon, over = {}) => ({
  id: `${over.section || 'Ignition'}:${horizon}:${ticker}`, ticker, side: 'long', horizon, timeframe: { key: horizon },
  section: over.section || 'Ignition', tier: over.tier || 'IGNITION', grade: { letter, score: 70 },
  levels: { entry: null, stop: over.stop ?? null, target: over.target ?? null }, flags: { heldOut: false }, ...over.extra,
});

// Generated at 17:00 ET on Mon 09-14 (after the close) → signal date 09-14.
const SNAPSHOT = {
  version: 'session-board-v1', generatedAt: '2026-09-14T21:00:00Z', session: { phase: 'afterhours', etDate: '2026-09-14' },
  items: [
    item('ABC', 'A', 'swing', { stop: 95, target: 115 }),                         // small tier
    item('DEF', 'B', 'intraday', { section: 'daytrade', tier: 'A' }),              // liquid tier, no levels
    item('GHI', 'C', 'swing'),                                                       // below B → skipped
    { ...item('JKL', 'A', 'swing', { section: 'Fade', tier: 'SHORT' }), side: 'short' }, // short → skipped
    item('MNO', 'B', 'position', { section: 'CERN', tier: 'INDEX_DELETE', stop: 80, target: 130 }), // stays open
  ],
};

const PRICES = {
  ABC: [bar(D[0], 99, 101, 98, 100), bar(D[1], 100, 103, 99, 102), bar(D[2], 102, 106, 101, 105), bar(D[3], 105, 116, 104, 114), bar(D[4], 114, 115, 112, 113)],
  DEF: [bar(D[0], 49, 50, 48, 50), bar(D[1], 50, 52, 49, 51), bar(D[2], 51, 52, 50, 51.5), bar(D[3], 51, 52, 50, 51), bar(D[4], 51, 52, 50, 51)],
  MNO: [bar(D[0], 99, 101, 98, 100), bar(D[1], 101, 102, 99, 101), bar(D[2], 101, 103, 100, 102), bar(D[3], 102, 104, 101, 103), bar(D[4], 103, 104, 101, 103)],
  SPY: [bar(D[0], 499, 501, 498, 500), bar(D[1], 500, 502, 499, 501), bar(D[2], 501, 503, 500, 502), bar(D[3], 502, 504, 501, 503), bar(D[4], 503, 505, 502, 504)],
};
const AS_OF = D[4];

test('rowsFromSnapshot: A/B long rows only, signal date = last completed session, skips are named', () => {
  const r = PP.rowsFromSnapshot(SNAPSHOT);
  assert.equal(r.signalDate, '2026-09-14');
  assert.equal(r.snapshotId, SNAPSHOT.generatedAt);
  assert.deepEqual(r.rows.map((x) => x.ticker), ['ABC', 'DEF', 'MNO']);
  assert.deepEqual(r.skipped.map((s) => [s.ticker, s.reason]), [['GHI', 'grade-below-B'], ['JKL', 'short-side']]);
  const abc = r.rows[0];
  assert.equal(abc.horizonSessions, PP.HORIZON_SESSIONS.swing);
  assert.equal(abc.costTier, 'small', 'Ignition section → small tier (lib/costs SECTION_TIER_DEFAULT)');
  assert.equal(r.rows[1].costTier, 'liquid');
  assert.deepEqual(abc.source, { sessionboardSnapshotId: SNAPSHOT.generatedAt, rowId: 'Ignition:swing:ABC', grade: 'A', timeframe: 'swing', section: 'Ignition', tier: 'IGNITION', signalDate: '2026-09-14' });
  // A premarket board carries the PRIOR session's signal.
  const pre = PP.rowsFromSnapshot({ ...SNAPSHOT, generatedAt: '2026-09-15T12:30:00Z', session: { phase: 'premarket', etDate: '2026-09-15' } });
  assert.equal(pre.signalDate, '2026-09-14');
  assert.deepEqual(PP.rowsFromSnapshot(null), { rows: [], skipped: [], signalDate: null, snapshotId: null });
});

test('houseBookStep: fills at next open + slippage, exits at target / same-bar close, marks the rest', () => {
  const out = PP.houseBookStep(SNAPSHOT, null, PRICES, { asOfDate: AS_OF });
  const s = out.state;
  assert.equal(out.noop, false);
  assert.equal(s.version, PP.VERSION);
  assert.deepEqual(s.ingestedSnapshotIds, [SNAPSHOT.generatedAt]);
  assert.deepEqual(s.pending, []);
  assert.equal(s.lastSessionDate, AS_OF);

  // ABC: fill Tue open 100 × 1.003 = 100.3; Thu high 116 ≥ target 115 (open 105 below) → exit 115 × 0.997.
  const abc = s.closed.find((p) => p.symbol === 'ABC');
  close(abc.fillPrice, 100.3);
  assert.equal(abc.fillDate, D[1]);
  close(abc.quantity, NOTIONAL / 100.3);
  assert.equal(abc.exit.reason, 'target');
  assert.equal(abc.exit.date, D[3]);
  close(abc.exit.price, 115 * (1 - SMALL_SLIP));
  close(abc.netReturnPct, (115 * (1 - SMALL_SLIP) / 100.3 - 1) * 100);
  close(abc.realizedPnl, (NOTIONAL / 100.3) * (115 * (1 - SMALL_SLIP) - 100.3));

  // DEF: intraday (1 session) → fill Tue open 50 × 1.0008, exit the SAME bar's close 51 × 0.9992.
  const def = s.closed.find((p) => p.symbol === 'DEF');
  close(def.fillPrice, 50 * (1 + LIQUID_SLIP));
  assert.equal(def.exit.reason, 'horizon');
  assert.equal(def.exit.date, D[1]);
  close(def.exit.price, 51 * (1 - LIQUID_SLIP));

  // MNO: position horizon (21) — only 4 bars elapsed, neither 80 nor 130 touched → open, marked at Fri close 103.
  const mno = Object.values(s.positions);
  assert.equal(mno.length, 1);
  assert.equal(mno[0].symbol, 'MNO');
  close(mno[0].fillPrice, 101 * (1 + SMALL_SLIP));
  close(mno[0].mark.price, 103);
  assert.equal(mno[0].mark.date, AS_OF);

  // Activities ledger (Ghostfolio-style schema): 3 BUYs + 2 SELLs, USD, deterministic ids.
  const types = s.activities.map((a) => `${a.type}:${a.symbol}`).sort();
  assert.deepEqual(types, ['BUY:ABC', 'BUY:DEF', 'BUY:MNO', 'SELL:ABC', 'SELL:DEF']);
  for (const a of s.activities) {
    assert.equal(a.currency, 'USD');
    assert.equal(a.fee, 0);
    assert.ok(a.id && a.date && a.quantity > 0 && a.unitPrice > 0);
    assert.equal(a.source.sessionboardSnapshotId, SNAPSHOT.generatedAt);
  }
  assert.deepEqual(out.fills.map((f) => f.symbol), ['ABC', 'DEF', 'MNO']);
  assert.deepEqual(out.exits.map((e) => `${e.symbol}:${e.reason}`).sort(), ['ABC:target', 'DEF:horizon']);

  // Cash: 1,000,000 − 3 × 5,000 + ABC proceeds + DEF proceeds.
  const abcProceeds = NOTIONAL * (115 * (1 - SMALL_SLIP)) / 100.3;
  const defProceeds = NOTIONAL * (51 * (1 - LIQUID_SLIP)) / (50 * (1 + LIQUID_SLIP));
  close(s.cash, PP.INITIAL_CASH_USD - 3 * NOTIONAL + abcProceeds + defProceeds, 1e-6);
  // Equity point: cash + MNO marked at 103, SPY close stamped for the benchmark leg.
  const mnoValue = (NOTIONAL / (101 * (1 + SMALL_SLIP))) * 103;
  close(out.point.equity, s.cash + mnoValue, 1e-6);
  assert.deepEqual([out.point.date, out.point.openPositions, out.point.spyClose], [AS_OF, 1, 504]);
  // Skips are counted by reason and sampled.
  assert.deepEqual(s.skipped.counts, { 'grade-below-B': 1, 'short-side': 1 });
});

test('houseBookStep: idempotent — the same snapshot and as-of date twice yields an identical state', () => {
  const once = PP.houseBookStep(SNAPSHOT, null, PRICES, { asOfDate: AS_OF });
  const twice = PP.houseBookStep(SNAPSHOT, once.state, PRICES, { asOfDate: AS_OF });
  assert.deepEqual(twice.state, once.state);
  assert.equal(twice.noop, true);
  assert.deepEqual(twice.fills, []);
  assert.deepEqual(twice.exits, []);
  // Inputs are never mutated.
  assert.deepEqual(Object.keys(once.state.positions), Object.keys(twice.state.positions));
});

test('houseBookStep: a ticker with an open position is not bought again (one episode at a time)', () => {
  const first = PP.houseBookStep(SNAPSHOT, null, PRICES, { asOfDate: AS_OF });
  const next = { ...SNAPSHOT, generatedAt: '2026-09-15T21:00:00Z', session: { phase: 'afterhours', etDate: '2026-09-15' }, items: [item('MNO', 'A', 'position', { section: 'CERN', tier: 'INDEX_DELETE' })] };
  const out = PP.houseBookStep(next, first.state, PRICES, { asOfDate: AS_OF });
  assert.equal(Object.keys(out.state.positions).length, 1);
  assert.equal(out.state.skipped.counts['already-open'], 1);
  assert.equal(out.state.activities.filter((a) => a.type === 'BUY' && a.symbol === 'MNO').length, 1);
});

test('houseBookStep: a stop that gaps through fills at the (worse) open; a swing horizon exits at the 10th close', () => {
  const snap = { ...SNAPSHOT, items: [item('XYZ', 'A', 'swing', { stop: 95, target: 150 }), item('FLAT', 'A', 'swing')] };
  const flat = D.map((d) => bar(d, 100, 101, 99, 100));
  const prices = {
    XYZ: [bar(D[0], 100, 101, 99, 100), bar(D[1], 100, 101, 99, 100), bar(D[2], 90, 92, 88, 91), bar(D[3], 91, 92, 90, 91)],
    FLAT: flat, SPY: flat,
  };
  const out = PP.houseBookStep(snap, null, prices, { asOfDate: D[12] });
  const xyz = out.state.closed.find((p) => p.symbol === 'XYZ');
  assert.equal(xyz.exit.reason, 'stop');
  assert.equal(xyz.exit.gapThrough, true);
  assert.equal(xyz.exit.date, D[2]);
  close(xyz.exit.price, 90 * (1 - SMALL_SLIP), 1e-9);
  const fl = out.state.closed.find((p) => p.symbol === 'FLAT');
  assert.equal(fl.exit.reason, 'horizon');
  assert.equal(fl.fillDate, D[1]);
  assert.equal(fl.exit.date, D[10], 'fill bar + 9 = the 10th session held');
});

test('houseBookStep: pending rows wait for the next session and expire if no bar ever arrives', () => {
  // As-of the signal day itself: nothing has opened yet → everything pending, nothing bought.
  const same = PP.houseBookStep(SNAPSHOT, null, PRICES, { asOfDate: D[0] });
  assert.equal(same.state.pending.length, 3);
  assert.equal(same.state.activities.length, 0);
  // A ticker with no price series at all stays pending, then expires after the calendar grace.
  const noData = PP.houseBookStep(SNAPSHOT, null, { SPY: PRICES.SPY }, { asOfDate: AS_OF });
  assert.equal(noData.state.pending.length, 3);
  const expired = PP.houseBookStep(null, noData.state, { SPY: PRICES.SPY }, { asOfDate: '2026-09-30' });
  assert.equal(expired.state.pending.length, 0);
  assert.equal(expired.state.skipped.counts['stale-unfilled'], 3);
});

test('houseBookStep: insufficient cash skips the row with a named reason', () => {
  const out = PP.houseBookStep(SNAPSHOT, PP.initialState({ initialCash: 2 * NOTIONAL }), PRICES, { asOfDate: AS_OF });
  assert.equal(out.fills.length, 2);
  assert.equal(out.state.skipped.counts['insufficient-cash'], 1);
});

test('applyActivities: replays the ledger to the same cash and equity the step tracked (identity check)', () => {
  const out = PP.houseBookStep(SNAPSHOT, null, PRICES, { asOfDate: AS_OF });
  const book = PP.applyActivities(out.state.activities, PRICES, { asOfDate: AS_OF, initialCash: PP.INITIAL_CASH_USD });
  close(book.cash, out.state.cash, 1e-6);
  close(book.equity, out.point.equity, 1e-6);
  assert.equal(Object.keys(book.positions).length, 1);
  close(book.equity, PP.INITIAL_CASH_USD + book.realizedPnl + book.unrealizedPnl, 1e-6, 'cash-flow equity equals P&L equity');
  // Per-date equity series for a client book: one point per SPY session from the first fill.
  const series = PP.equitySeries(out.state.activities, PRICES, { asOfDate: AS_OF, initialCash: PP.INITIAL_CASH_USD });
  assert.deepEqual(series.map((p) => p.date), [D[1], D[2], D[3], D[4]]);
  close(series[3].equity, out.point.equity, 1e-6);
  assert.deepEqual(PP.applyActivities([], PRICES, { asOfDate: AS_OF }).positions, {});
});

test('appendEquityPoint: append-only by date, replaces a same-date point, stays sorted', () => {
  const a = PP.appendEquityPoint(null, { date: D[1], equity: 1 });
  const b = PP.appendEquityPoint(a, { date: D[0], equity: 2 });
  const c = PP.appendEquityPoint(b, { date: D[1], equity: 3 });
  assert.deepEqual(c.points.map((p) => [p.date, p.equity]), [[D[0], 2], [D[1], 3]]);
  assert.equal(c.version, PP.VERSION);
  assert.notEqual(c, b, 'returns a new object');
});

test('reconcile: horizon exits agree with the Scoreboard method within the cost tier; dupes and gaps are flagged', () => {
  const out = PP.houseBookStep(SNAPSHOT, null, PRICES, { asOfDate: AS_OF });
  const summary = { groups: [{ section: 'daytrade', tier: 'A' }, { section: 'Ignition', tier: 'IGNITION' }] };
  const rc = PP.reconcile(out.state, PRICES, { summary, asOfDate: AS_OF });
  // DEF is the only horizon exit: Scoreboard method = (51/50 − 1)·100 − 0.16 = 1.84; book = (51·0.9992/50.04 − 1)·100.
  assert.equal(rc.rows, 1);
  close(rc.scoreboardMeanNetPct, 2 - roundTripCostPct('liquid'));
  close(rc.bookMeanNetPct, (51 * (1 - LIQUID_SLIP) / (50 * (1 + LIQUID_SLIP)) - 1) * 100);
  assert.ok(rc.divergencePct < rc.tolerancePct);
  assert.equal(rc.tolerancePct, roundTripCostPct('liquid'));
  assert.equal(rc.duplicateBuys, 0);
  assert.ok(rc.ledgerIdentityGapUsd < 1e-6);
  assert.deepEqual(rc.rowsMissingInScoreboard, [{ ticker: 'MNO', section: 'CERN' }], 'a traded section the Scoreboard does not grade');
  assert.deepEqual(rc.rowsMissingInBook.counts, { 'grade-below-B': 1, 'short-side': 1 });
  assert.equal(rc.status, 'ok');
  assert.equal(rc.version, PP.RECONCILE_VERSION);

  // A duplicated BUY for the same row/date (the dedup bug class) flips the status.
  const dup = out.state.activities.find((a) => a.type === 'BUY' && a.symbol === 'ABC');
  const bad = { ...out.state, activities: [...out.state.activities, { ...dup, id: `${dup.id}:dup` }] };
  const rc2 = PP.reconcile(bad, PRICES, { summary, asOfDate: AS_OF });
  assert.equal(rc2.duplicateBuys, 1);
  assert.equal(rc2.status, 'divergent');
  assert.match(rc2.problems.join(' '), /duplicate/);

  // No Scoreboard summary → the missing-rows check is reported as unavailable, not as zero.
  const rc3 = PP.reconcile(out.state, PRICES, { summary: null, asOfDate: AS_OF });
  assert.equal(rc3.rowsMissingInScoreboard, null);
  // No horizon exits yet → no-data, never a false alarm.
  const early = PP.houseBookStep(SNAPSHOT, null, PRICES, { asOfDate: D[0] });
  assert.equal(PP.reconcile(early.state, PRICES, { summary, asOfDate: D[0] }).status, 'no-data');
});

test('reconcile: divergence above the tier tolerance is a problem the health banner can show', () => {
  const out = PP.houseBookStep(SNAPSHOT, null, PRICES, { asOfDate: AS_OF });
  const def = out.state.closed.find((p) => p.symbol === 'DEF');
  const tampered = { ...out.state, closed: out.state.closed.map((p) => (p === def ? { ...p, exit: { ...p.exit, price: p.exit.price * 1.05 } } : p)) };
  const rc = PP.reconcile(tampered, PRICES, { summary: null, asOfDate: AS_OF });
  assert.equal(rc.status, 'divergent');
  assert.ok(rc.divergencePct > rc.tolerancePct);
  assert.match(rc.problems.join(' '), /divergence/);
});
