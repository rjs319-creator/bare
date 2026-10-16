'use strict';
// OPTIONS — a delayed snapshot is research, not an executable quote (review prompt 7,
// findings P7-O1/O2/O3).
//
// The live defect: Friday's delayed quotes, viewed on Saturday, read
// "Executable liquidity … OK · size not evaluated · a limit between mid and ask should
// fill". `state` now describes SNAPSHOT spread quality only; whether anything is
// executable is a separate answer that needs a current quote AND an evaluated size.

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../lib/options-execution-v2');
const observe = require('../lib/options-observe-v2');
const gate = require('../lib/options-trade-gate-v2');

// Fixture clock: a Friday regular session and the Saturday after it.
const FRI_QUOTE_MS = Date.parse('2026-10-02T19:59:00Z');     // 15:59 ET Friday
const FRI_PRINT_SEC = Date.parse('2026-10-02T19:50:00Z') / 1000;
const SAT_MS = Date.parse('2026-10-03T16:00:00Z');
const SUN_MS = Date.parse('2026-10-04T16:00:00Z');

const contract = (o = {}) => ({
  side: 'call', strike: 110, expiry: '2026-11-20',
  bid: 2.00, ask: 2.08, lastPrice: 2.05, lastTradeTs: FRI_PRINT_SEC,
  volume: 900, openInterest: 4000, ...o,
});
const delayedSaturday = (o = {}) => ({ nowMs: SAT_MS, session: 'closed', delayedByMin: 15, quoteObservedAtMs: FRI_QUOTE_MS, source: 'cboe-delayed', ...o });

test('SATURDAY: a delayed Friday quote keeps its snapshot spread quality but makes NO current-fill claim', () => {
  const r = e.contractLiquidity({ contract: contract(), contracts: null, ...delayedSaturday() });
  assert.equal(r.state, 'OK', 'the snapshot spread was tight — that observation stands');
  assert.equal(r.snapshotOnly, true);
  assert.equal(r.executable, false);
  assert.equal(r.requoteRequired, true);
  assert.equal(r.executableFraction, 0);
  assert.deepEqual(r.currency, {
    delayClass: 'delayed', delayedByMin: 15, session: 'closed',
    quoteObservedAt: '2026-10-02T19:59:00.000Z', currentQuote: false, source: 'cboe-delayed',
  });
  assert.doesNotMatch(r.limitRule.rule, /should fill/i);
  assert.match(r.limitRule.rule, /re-quote/i);
  assert.match(r.limitRule.rule, /not a fill/i);
  assert.match(r.notExecutableBecause.join(' | '), /delayed/i);
  assert.match(r.notExecutableBecause.join(' | '), /session/i);
  assert.match(r.notExecutableBecause.join(' | '), /size/i);
});

test('SATURDAY vs SUNDAY: the same snapshot reads the same — print age is measured at the snapshot, not on the wall clock', () => {
  const sat = e.contractLiquidity({ contract: contract(), ...delayedSaturday() });
  const sun = e.contractLiquidity({ contract: contract(), ...delayedSaturday({ nowMs: SUN_MS }) });
  assert.equal(sat.state, 'OK');
  assert.equal(sun.state, 'OK');
  assert.equal(sun.checks.printFreshness.stale, false);
  assert.equal(sun.executable, false);
});

test('no text anywhere in the record promises a fill, on any book', () => {
  for (const c of [contract(), contract({ bid: 1.8, ask: 2.2 }), contract({ bid: 1, ask: 3 }), contract({ bid: 0, ask: 0.05 })]) {
    for (const ctx of [delayedSaturday(), { nowMs: FRI_QUOTE_MS + 5000, session: 'regular', delayedByMin: 0, quoteObservedAtMs: FRI_QUOTE_MS, source: 'rt' }]) {
      const r = e.contractLiquidity({ contract: c, contracts: 5, ...ctx });
      assert.doesNotMatch(JSON.stringify(r), /should fill|will fill|guaranteed/i);
    }
  }
});

test('WIDE SPREAD + UNKNOWN SIZE are reported as two SEPARATE limits on a real contract', () => {
  const r = e.contractLiquidity({ contract: contract({ bid: 1.85, ask: 2.15 }), contracts: null, ...delayedSaturday() });
  // Dimension 1 — spread quality of the snapshot.
  assert.equal(r.checks.quote.available, true);
  assert.equal(r.checks.quote.workable, true);
  assert.ok(r.checks.quote.spreadPctOfMid > 5);
  assert.match(r.limitRule.rule, /Do NOT lift the offer/i);
  // Dimension 2 — size / fill uncertainty, unevaluated and said so.
  assert.equal(r.checks.size.available, false);
  assert.match(r.checks.size.reason, /NOT been evaluated/i);
  assert.equal(r.sizeEvaluated, false);
  assert.equal(r.executable, false);
});

test('MISSING contract or quote can never be executable', () => {
  const none = e.contractLiquidity({ contract: null, ...delayedSaturday() });
  assert.equal(none.state, 'UNKNOWN');
  assert.equal(none.executable, false);
  assert.equal(none.executableFraction, 0);
  const oneSided = e.contractLiquidity({ contract: contract({ ask: null }), contracts: 5, nowMs: FRI_QUOTE_MS + 1000, session: 'regular', delayedByMin: 0, quoteObservedAtMs: FRI_QUOTE_MS });
  assert.equal(oneSided.checks.quote.available, false);
  assert.equal(oneSided.executable, false);
  assert.equal(oneSided.limitRule.available, false);
});

test('ZERO BID is a real illiquid observation: it says "no bid" and cannot support a ready-liquidity claim', () => {
  const r = e.contractLiquidity({ contract: contract({ bid: 0, ask: 0.05 }), contracts: 5, ...delayedSaturday() });
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.checks.quote.noBid, true);
  assert.match(r.blocking.join(' '), /no bid/i);
  assert.doesNotMatch(r.blocking.join(' '), /% wide/);
  assert.equal(r.executable, false);
  assert.equal(r.limitRule.available, false);
});

test('CROSSED, locked and negative quotes are explicitly ineligible', () => {
  for (const q of [{ bid: 3, ask: 2 }, { bid: 2, ask: 2 }, { bid: -1, ask: 2 }]) {
    const r = e.contractLiquidity({ contract: contract(q), contracts: 5, ...delayedSaturday() });
    assert.equal(r.state, 'BLOCKED', JSON.stringify(q));
    assert.equal(r.executable, false);
  }
});

test('EXPIRED contract is flagged and blocked', () => {
  const r = e.contractLiquidity({ contract: contract({ expiry: '2026-09-18' }), contracts: 5, ...delayedSaturday() });
  assert.equal(r.expired, true);
  assert.equal(r.state, 'BLOCKED');
  assert.match(r.blocking.join(' '), /expired/i);
  assert.equal(e.contractLiquidity({ contract: contract(), ...delayedSaturday() }).expired, false);
  // A row already flagged by the observation layer is honoured.
  assert.equal(e.contractLiquidity({ contract: contract({ expired: true }), ...delayedSaturday() }).state, 'BLOCKED');
});

test('observation rows flag an expired contract instead of presenting it as 0 DTE', () => {
  const nowMs = SAT_MS;
  const expiredRow = observe.contractRow({ strike: 100, expiration: Date.parse('2026-09-18T00:00:00Z') / 1000, bid: 1, ask: 1.1, volume: 10 }, 'call', 100, nowMs);
  assert.equal(expiredRow.expired, true);
  const liveRow = observe.contractRow({ strike: 100, expiration: Date.parse('2026-11-20T00:00:00Z') / 1000, bid: 1, ask: 1.1, volume: 10 }, 'call', 100, nowMs);
  assert.equal(liveRow.expired, false);
  // Expiry day itself is not yet expired.
  const today = observe.contractRow({ strike: 100, expiration: Date.parse('2026-10-03T00:00:00Z') / 1000, bid: 1, ask: 1.1, volume: 10 }, 'call', 100, nowMs);
  assert.equal(today.expired, false);
});

test('the trade gate never selects an expired row', () => {
  const cfg = { minDte: 0, maxDte: 60, minOpenInterest: 1, minVolume: 1, maxSpreadPct: 50 };
  const row = { side: 'call', dte: 0, openInterest: 100, volume: 100, bid: 1, ask: 1.05, strike: 100, underlying: 100 };
  assert.equal(gate.passesLiquidityScreen(row, 'call', cfg), true);
  assert.equal(gate.passesLiquidityScreen({ ...row, expired: true }, 'call', cfg), false);
});

test('ONLY a current regular-session quote with an evaluated, comfortable size is executable', () => {
  const live = { nowMs: FRI_QUOTE_MS + 5000, session: 'regular', delayedByMin: 0, quoteObservedAtMs: FRI_QUOTE_MS, source: 'realtime' };
  const ok = e.contractLiquidity({ contract: contract(), contracts: 10, ...live });
  assert.equal(ok.currency.currentQuote, true);
  assert.equal(ok.snapshotOnly, false);
  assert.equal(ok.requoteRequired, false);
  assert.equal(ok.executable, true);
  assert.equal(ok.executableFraction, 1);
  // Same quote, no size → not executable.
  assert.equal(e.contractLiquidity({ contract: contract(), contracts: null, ...live }).executable, false);
  // Same quote, delayed feed → not executable.
  assert.equal(e.contractLiquidity({ contract: contract(), contracts: 10, ...live, delayedByMin: 15 }).executable, false);
  // Same quote, after hours → not executable.
  assert.equal(e.contractLiquidity({ contract: contract(), contracts: 10, ...live, session: 'afterhours' }).executable, false);
});

test('unknown delay / session / quote time fail closed and stay null — never the wall clock', () => {
  const r = e.contractLiquidity({ contract: contract(), contracts: 10, nowMs: FRI_QUOTE_MS + 5000 });
  assert.deepEqual(r.currency, { delayClass: 'unknown', delayedByMin: null, session: null, quoteObservedAt: null, currentQuote: false, source: null });
  assert.equal(r.snapshotOnly, true);
  assert.equal(r.executable, false);
  assert.equal(r.executableFraction, 0);
});

test('snapshotLiquidityFraction preserves the pre-existing spread-quality scalar for ranking consumers', () => {
  assert.equal(e.contractLiquidity({ contract: contract(), contracts: null, ...delayedSaturday() }).snapshotLiquidityFraction, 1);
  assert.equal(e.contractLiquidity({ contract: contract({ bid: 1, ask: 3 }), ...delayedSaturday() }).snapshotLiquidityFraction, 0);
});

test('the selected-contract description echoes the multiplier it used', () => {
  const d = gate.describeSelected({ contractSymbol: 'ABC261120C00110000', side: 'call', strike: 110, expiry: '2026-11-20', dte: 48, bid: 2, ask: 2.1, openInterest: 100, volume: 10 }, { deltaBasis: 'moneyness-proxy' });
  assert.equal(d.contractMultiplier, 100);
  assert.equal(d.maxDefinedLossPerContract, 205);
});

test('decision adapter: the utility liquidity input is numerically unchanged (reads the snapshot scalar, not executability)', () => {
  const da = require('../lib/decision-adapters');
  const base = { eventId: 'o1', ticker: 'AAA', tradeStatus: 'WATCH_FOR_PRICE_TRIGGER', anomalyScore: 80, dataQuality: 0.9 };
  // New-shape record: a tight delayed snapshot (state OK → 1) that is NOT executable (0).
  const liq = e.contractLiquidity({ contract: contract(), contracts: null, ...delayedSaturday() });
  assert.equal(liq.executableFraction, 0);
  const d = da.fromOptionsEvent({ ...base, contractLiquidity: liq });
  assert.equal(d.utility.components.liquidity.value, 1, 'the same 1 the pre-change executableFraction produced for an OK state');
  // Old-shape persisted record (no snapshotLiquidityFraction) still reads executableFraction.
  const old = da.fromOptionsEvent({ ...base, contractLiquidity: { state: 'DEGRADED', executableFraction: 0.5, estimatedSlippageFrac: 0.02 } });
  assert.equal(old.utility.components.liquidity.value, 0.5);
  // Everything else about the decision is unchanged by the liquidity record's new fields.
  const before = da.fromOptionsEvent({ ...base, contractLiquidity: { state: 'OK', executableFraction: 1, estimatedSlippageFrac: liq.estimatedSlippageFrac } });
  assert.equal(d.utility.score, before.utility.score);
  assert.equal(d.state, before.state);
});

test('the radar card carries the quote currency it was judged on (threaded from the observation)', () => {
  const routes = require('../lib/optionsflow-v2-routes');
  const item = {
    ticker: 'ABC', underlying: 100, contracts: [contract()], anomaly: { componentCoverage: 1 }, interpretation: { state: 'UNKNOWN' },
    gate: { tradeStatus: 'WATCH_FOR_PRICE_TRIGGER' }, earningsInDays: null, isIndex: false, fullChainConcentration: null, atmIVNow: null, ivHistory: null,
  };
  routes.attachEvidenceLayers(item, {
    nowMs: SAT_MS, capabilities: {},
    quote: { providerTimestamp: FRI_QUOTE_MS / 1000, delayedByMin: 15, source: 'cboe-delayed' }, session: 'closed',
  });
  assert.equal(item.contractLiquidity.currency.quoteObservedAt, '2026-10-02T19:59:00.000Z');
  assert.equal(item.contractLiquidity.currency.delayedByMin, 15);
  assert.equal(item.contractLiquidity.currency.session, 'closed');
  assert.equal(item.contractLiquidity.snapshotOnly, true);
  assert.equal(item.contractLiquidity.executable, false);
  // Without a quote block nothing is invented: timestamps stay null.
  const bare = { ...item, contractLiquidity: null };
  routes.attachEvidenceLayers(bare, { nowMs: SAT_MS, capabilities: {} });
  assert.equal(bare.contractLiquidity.currency.quoteObservedAt, null);
  assert.equal(bare.contractLiquidity.currency.delayClass, 'unknown');
});
