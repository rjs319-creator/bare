'use strict';
// DAILY NAV LEDGER — accounting-identity and fail-closed coverage tests.
// The repair under test: Core Performance may only headline a since-inception number
// that marks EVERY position daily; missing marks must fail closed with the exact gap,
// never be silently dropped from the return.
const test = require('node:test');
const assert = require('node:assert');
const { buildNavLedger } = require('../lib/nav-ledger');

const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
const candles = closes => D.map((d, i) => ({ date: d, close: closes[i] })).filter(c => c.close != null);
const BENCH = candles([100, 100, 102, 104]);

// Two-position book: A resolves WIN at +20% on day 3 (barrier 120); B stays open.
function fixture() {
  return {
    signals: [
      { ticker: 'AAA', date: D[0], entry: 100, weight: 0.5, quarter: '2026Q1' },
      { ticker: 'BBB', date: D[0], entry: 200, weight: 0.5, quarter: '2026Q1' },
    ],
    resolved: { 'AAA|2026-01-05': { outcome: 'WIN', r: 0.20, exitDate: D[2] } },
    histories: { AAA: candles([100, 110, 120, 130]), BBB: candles([200, 190, 180, 185]) },
  };
}
const PER_SIDE = 0.5; // percent

test('every daily row preserves the identity NAV = cash + Σ shares×mark', () => {
  const f = fixture();
  const led = buildNavLedger(f.signals, f.resolved, f.histories, { perSidePct: PER_SIDE, bench: BENCH });
  assert.equal(led.available, true);
  assert.equal(led.complete, true);
  assert.equal(led.curve.length, 4);
  // served values are rounded to 6dp independently, so the identity holds to 2e-6
  for (const row of led.curve) assert.ok(Math.abs(row.nav - (row.cash + row.invested)) < 2e-6, `${row.date}: nav ≠ cash + invested`);
});

test('ΔNAV reconciles to realized + unrealized P&L − costs paid (the ledger self-check holds)', () => {
  const f = fixture();
  const led = buildNavLedger(f.signals, f.resolved, f.histories, { perSidePct: PER_SIDE, bench: BENCH });
  assert.equal(led.reconciliation.holds, true);
  assert.ok(led.reconciliation.maxAbsError < 1e-9);
});

test('a resolved trade realizes at the OUTCOME-recorded price and pays the exit-side cost', () => {
  const f = fixture();
  const led = buildNavLedger(f.signals, f.resolved, f.histories, { perSidePct: PER_SIDE, bench: BENCH });
  // hand-computed: entry spends 0.5 each, fee 0.0025 each → sharesA = 0.4975/100
  const sharesA = 0.4975 / 100, sharesB = 0.4975 / 200;
  const exitProceeds = sharesA * 120;               // barrier price from r=0.20, NOT that day's close (120 vs 120 here; costs make it observable)
  const exitFee = exitProceeds * PER_SIDE / 100;
  const expectedCash = 0 + exitProceeds - exitFee;  // all cash was invested on day 1
  const day3 = led.curve.find(r => r.date === D[2]);
  assert.ok(Math.abs(day3.cash - expectedCash) < 1e-12);
  assert.ok(Math.abs(day3.invested - sharesB * 180) < 1e-12);
  assert.ok(Math.abs(led.totals.costPaid - (0.0025 * 2 + exitFee)) < 1e-12);
  assert.equal(led.totals.openPositions, 1);
  assert.equal(led.totals.closedPositions, 1);
});

test('benchmark NAV rides the same daily axis', () => {
  const f = fixture();
  const led = buildNavLedger(f.signals, f.resolved, f.histories, { perSidePct: PER_SIDE, bench: BENCH });
  assert.ok(Math.abs(led.totals.benchReturn - 0.04) < 1e-9);
  assert.equal(led.curve[0].bench, 1);
});

test('FAIL-CLOSED: a missing mid-series mark truncates the series at the last covered day and names the gap', () => {
  const f = fixture();
  f.histories.BBB = candles([200, 190, null, null]);   // B unmarkable from day 3
  const led = buildNavLedger(f.signals, f.resolved, f.histories, { perSidePct: PER_SIDE, bench: BENCH });
  assert.equal(led.available, true);
  assert.equal(led.complete, false);
  assert.equal(led.throughDate, D[1]);                 // day 3+4 withheld, not guessed
  assert.equal(led.curve.length, 2);
  assert.equal(led.coverage.gaps.length, 1);
  assert.equal(led.coverage.gaps[0].ticker, 'BBB');
  assert.equal(led.coverage.gaps[0].missingOn, D[2]);
});

test('FAIL-CLOSED: a position with no history at all yields NO nav, not a partial one', () => {
  const f = fixture();
  delete f.histories.BBB;
  const led = buildNavLedger(f.signals, f.resolved, f.histories, { perSidePct: PER_SIDE, bench: BENCH });
  assert.equal(led.available, false);
  assert.match(led.reason, /first required mark is already missing/);
});

test('FAIL-CLOSED: a corporate-action basis mismatch (logged entry vs adjusted closes) is a declared gap', () => {
  const f = fixture();
  f.histories.BBB = candles([20, 19, 18, 18.5]);       // 10:1 adjusted feed vs entry 200
  const led = buildNavLedger(f.signals, f.resolved, f.histories, { perSidePct: PER_SIDE, bench: BENCH });
  assert.equal(led.available, false);
  assert.ok(led.coverage.gaps.some(g => g.ticker === 'BBB' && /corporate-action/.test(g.why)));
});

test('FAIL-CLOSED: a resolved outcome without an exitDate cannot be placed on the axis', () => {
  const f = fixture();
  f.resolved['AAA|2026-01-05'] = { outcome: 'WIN', r: 0.20 };  // no exitDate
  const led = buildNavLedger(f.signals, f.resolved, f.histories, { perSidePct: PER_SIDE, bench: BENCH });
  assert.equal(led.available, false);
  assert.match(led.reason, /no exitDate/);
});

test('THE HEADLINE BUG: resolved-only averaging looks positive while the daily NAV is under water', () => {
  // Winner resolves early at +20%; the still-open name has been cut in half. A
  // resolved-only compound reports +20%-flavored numbers; the NAV tells the truth.
  const signals = [
    { ticker: 'WIN1', date: D[0], entry: 100, weight: 0.5 },
    { ticker: 'BAGH', date: D[0], entry: 100, weight: 0.5 },
  ];
  const resolved = { 'WIN1|2026-01-05': { outcome: 'WIN', r: 0.20, exitDate: D[1] } };
  const histories = { WIN1: candles([100, 120, 120, 120]), BAGH: candles([100, 80, 60, 50]) };
  const led = buildNavLedger(signals, resolved, histories, { perSidePct: 0, bench: BENCH });
  const resolvedOnlyMean = 0.20;                        // what the legacy lane would report
  assert.ok(resolvedOnlyMean > 0);
  assert.ok(led.totals.navReturn < 0, `NAV should be under water, got ${led.totals.navReturn}`);
  // exact: 0.5 grew to 0.6 (realized), 0.5 marked at 0.25 → NAV 0.85
  assert.ok(Math.abs(led.totals.navReturn - (-0.15)) < 1e-9);
});

test('missing weights default to equal weight within the signal-date cohort', () => {
  const f = fixture();
  for (const s of f.signals) delete s.weight;
  const led = buildNavLedger(f.signals, f.resolved, f.histories, { perSidePct: 0, bench: BENCH });
  assert.equal(led.available, true);
  // equal weight ⇒ day-1 invested = full NAV, split 50/50
  assert.ok(Math.abs(led.curve[0].invested - 1) < 1e-9);
});

test('empty/garbage signal rows fail safely with a reason, never a crash or a fake NAV', () => {
  assert.equal(buildNavLedger([], {}, {}, {}).available, false);
  assert.equal(buildNavLedger([{ ticker: 'X', date: '2026-01-05', entry: 0 }], {}, {}, {}).available, false);
  assert.equal(buildNavLedger(null, null, null, null).available, false);
});
