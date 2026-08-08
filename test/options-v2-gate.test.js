const test = require('node:test');
const assert = require('node:assert');
const g = require('../lib/options-trade-gate-v2');
const { TRADE_STATUS, TRADE_GATE } = require('../lib/options-config-v2');

const goodAnomaly = { anomalyScore: 85, dataQuality: 90, liquidityQuality: 80, activityStatus: 'HIGHLY_UNUSUAL' };
const bullInterp = { state: 'BULLISH_PROVISIONAL', confidence: 40 };
const longSetupAtTrigger = { direction: 'long', valid: true, quality: 0.8, spot: 101, atr: 2, trigger: 100.5, invalidation: 96, target: 109.5, rr: 2 };
const longSetupBelowTrigger = { ...longSetupAtTrigger, spot: 97.5, trigger: 100.5 };

test('PRICE_CONFIRMED requires the independent price trigger to be REACHED', () => {
  const notYet = g.decideTradeStatus(goodAnomaly, bullInterp, longSetupBelowTrigger, {});
  assert.notStrictEqual(notYet.tradeStatus, TRADE_STATUS.PRICE_CONFIRMED);
  assert.ok([TRADE_STATUS.WATCH_FOR_PRICE_TRIGGER, TRADE_STATUS.READY].includes(notYet.tradeStatus));
  const confirmed = g.decideTradeStatus(goodAnomaly, bullInterp, longSetupAtTrigger, {});
  assert.strictEqual(confirmed.tradeStatus, TRADE_STATUS.PRICE_CONFIRMED);
  assert.strictEqual(confirmed.actionable, true);
  assert.strictEqual(confirmed.gateVersion, TRADE_GATE.version);
  // Honest language: options are supportive, direction unverified.
  assert.ok(confirmed.reasons.some(r => /unverified/i.test(r)));
});

test('STRESS: a price-confirmed event carries a COMPLETE plan (entry/stop/target/time stop/R:R)', () => {
  const plan = g.stockPlan(longSetupAtTrigger);
  assert.ok(plan.entryTrigger != null && plan.invalidation != null && plan.target != null);
  assert.ok(plan.rewardRisk >= TRADE_GATE.minRewardRisk);
  assert.ok(plan.timeStopSessions > 0);
  assert.strictEqual(plan.vehicle, 'stock');
});

test('options lean opposing the setup → CONTRADICTS_SETUP (never actionable)', () => {
  const r = g.decideTradeStatus(goodAnomaly, { state: 'BEARISH_PROVISIONAL', confidence: 40 }, longSetupAtTrigger, {});
  assert.strictEqual(r.tradeStatus, TRADE_STATUS.CONTRADICTS_SETUP);
  assert.strictEqual(r.actionable, false);
});

test('earnings inside the avoid window → AVOID_EVENT_RISK even with everything else perfect', () => {
  const r = g.decideTradeStatus(goodAnomaly, bullInterp, longSetupAtTrigger, { earningsInDays: 1 });
  assert.strictEqual(r.tradeStatus, TRADE_STATUS.AVOID_EVENT_RISK);
});

test('spread/hedge/mixed interpretations map to their own statuses, never a direction', () => {
  assert.strictEqual(g.decideTradeStatus(goodAnomaly, { state: 'POSSIBLE_SPREAD' }, longSetupAtTrigger, {}).tradeStatus, TRADE_STATUS.POSSIBLE_SPREAD);
  assert.strictEqual(g.decideTradeStatus(goodAnomaly, { state: 'POSSIBLE_HEDGE' }, longSetupAtTrigger, {}).tradeStatus, TRADE_STATUS.POSSIBLE_HEDGE);
  assert.strictEqual(g.decideTradeStatus(goodAnomaly, { state: 'MIXED' }, longSetupAtTrigger, {}).tradeStatus, TRADE_STATUS.MIXED);
});

test('no valid stock setup → activity is context only (ACTIVITY_ONLY / NO_DIRECTION), with "what would make this tradeable"', () => {
  const withLean = g.decideTradeStatus(goodAnomaly, bullInterp, { valid: false, direction: 'none' }, {});
  assert.strictEqual(withLean.tradeStatus, TRADE_STATUS.ACTIVITY_ONLY);
  assert.ok(withLean.whatWouldMakeTradeable.length > 0);
  const noLean = g.decideTradeStatus(goodAnomaly, { state: 'UNKNOWN' }, { valid: false, direction: 'none' }, {});
  assert.strictEqual(noLean.tradeStatus, TRADE_STATUS.NO_DIRECTION);
});

test('quality gates block confirmation: low data quality → not PRICE_CONFIRMED, blocker named', () => {
  const r = g.decideTradeStatus({ ...goodAnomaly, dataQuality: 50 }, bullInterp, longSetupAtTrigger, {});
  assert.notStrictEqual(r.tradeStatus, TRADE_STATUS.PRICE_CONFIRMED);
  assert.ok(r.whatWouldMakeTradeable.some(b => /data quality/.test(b)));
});

test('spot beyond invalidation → INVALIDATED; stale events → STALE', () => {
  const busted = g.decideTradeStatus(goodAnomaly, bullInterp, { ...longSetupAtTrigger, spot: 95 }, {});
  assert.strictEqual(busted.tradeStatus, TRADE_STATUS.INVALIDATED);
  const stale = g.decideTradeStatus(goodAnomaly, bullInterp, longSetupAtTrigger, { sessionsSinceSeen: 5 });
  assert.strictEqual(stale.tradeStatus, TRADE_STATUS.STALE);
});

test('STRESS: contract selection refuses illiquid chains (100% spreads) and says why', () => {
  const illiquid = [
    { side: 'call', strike: 100, expiry: '2026-09-18', dte: 40, bid: 1, ask: 3, lastPrice: 2, volume: 500, openInterest: 5000, contractSymbol: 'A', underlying: 100 },
  ];
  const r = g.selectOptionContract(illiquid, longSetupAtTrigger);
  assert.strictEqual(r.selected, null);
  assert.match(r.reason, /trade the stock or stand aside/i);
});

test('contract selection: long defined-risk only, right side, swing DTE, delta labeled as proxy', () => {
  const chain = [
    { side: 'call', strike: 100, expiry: '2026-09-18', dte: 40, bid: 3.0, ask: 3.2, lastPrice: 3.1, volume: 400, openInterest: 5000, contractSymbol: 'GOOD', underlying: 100 },
    { side: 'put', strike: 100, expiry: '2026-09-18', dte: 40, bid: 3.0, ask: 3.2, lastPrice: 3.1, volume: 400, openInterest: 9000, contractSymbol: 'WRONGSIDE', underlying: 100 },
    { side: 'call', strike: 100, expiry: '2026-08-10', dte: 3, bid: 1.0, ask: 1.1, lastPrice: 1.05, volume: 900, openInterest: 9000, contractSymbol: 'TOOSHORT', underlying: 100 },
  ];
  const r = g.selectOptionContract(chain, longSetupAtTrigger);
  assert.ok(r.selected);
  assert.strictEqual(r.selected.contractSymbol, 'GOOD');
  assert.strictEqual(r.selected.side, 'call');
  assert.ok(r.selected.maxDefinedLossPerContract > 0, 'defined risk, never naked short');
  assert.match(r.selected.deltaProxyNote, /proxy/i);
});
