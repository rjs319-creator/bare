'use strict';
// audit #6: portfolio accounting must (a) include the fill-day open→close P&L and (b) realize
// barrier exits at the stop/target price, not the day's close — and trade-level fills must reconcile
// to portfolio P&L.

const test = require('node:test');
const assert = require('node:assert');
const BT = require('../api/backtest');

const AXIS = ['2022-01-03', '2022-01-04', '2022-01-05', '2022-01-06', '2022-01-07'];
const CM = { A: { '2022-01-03': 100, '2022-01-04': 110, '2022-01-05': 105, '2022-01-06': 120, '2022-01-07': 118 } };
// A trade filled at 108 (next-open+slippage on 01-04) that realizes r = +10% at a barrier on 01-06.
const TRADE = { name: 'A', entryDate: '2022-01-04', exitDate: '2022-01-06', tier: 'Breakout', entry: 108, r: 0.10 };

test('positionDailyReturn: fill day runs from the MODELED fill price, not the prior close', () => {
  const cm = CM.A;
  const rEntry = BT.positionDailyReturn(TRADE, '2022-01-04', '2022-01-03', cm);
  assert.ok(Math.abs(rEntry - (110 / 108 - 1)) < 1e-12, 'uses entry (108), captures fill-day open→close');
  assert.ok(Math.abs(rEntry - (110 / 100 - 1)) > 1e-6, 'does NOT use the prior close (100)');
});

test('positionDailyReturn: exit day is realized at the BARRIER price, not the close', () => {
  const cm = CM.A;                                    // exitPrice = 108*1.10 = 118.8, close on 01-06 = 120
  const rExit = BT.positionDailyReturn(TRADE, '2022-01-06', '2022-01-05', cm);
  assert.ok(Math.abs(rExit - (118.8 / 105 - 1)) < 1e-12, 'uses barrier exit 118.8');
  assert.ok(Math.abs(rExit - (120 / 105 - 1)) > 1e-6, 'does NOT use the exit-day close (120)');
});

test('simulatePortfolio: a single trade in a single slot compounds to exactly the trade r', () => {
  const port = BT.simulatePortfolio([TRADE], AXIS, CM, 1);
  assert.ok(Math.abs((port.eq - 1) - TRADE.r) < 1e-9, `portfolio total (${port.eq - 1}) == trade r (${TRADE.r})`);
});

test('simulatePortfolio: reconciliation.maxAbsError is ~0 for fully-in-window trades', () => {
  const port = BT.simulatePortfolio([TRADE], AXIS, CM, 1);
  assert.equal(port.reconciliation.checked, 1);
  assert.ok(Number(port.reconciliation.maxAbsError) < 1e-9, 'trade-level fills reconcile to portfolio P&L');
});

test('simulatePortfolio: multiple concurrent trades reconcile independently', () => {
  const cm = { A: CM.A, B: { '2022-01-03': 50, '2022-01-04': 52, '2022-01-05': 49, '2022-01-06': 55, '2022-01-07': 54 } };
  const t2 = { name: 'B', entryDate: '2022-01-04', exitDate: '2022-01-06', tier: 'Setup', entry: 51, r: -0.05 };
  const port = BT.simulatePortfolio([TRADE, t2], AXIS, cm, 2);
  assert.equal(port.reconciliation.checked, 2);
  assert.ok(Number(port.reconciliation.maxAbsError) < 1e-9);
});
