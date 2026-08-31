'use strict';
// TARGETS: forward-return alignment, the execution convention, market/sector residualization,
// trailing-only betas, corporate-action handling and class prevalence.
//
// These are the tests that would fail if the label ever drifted off the next-open → close(d+h)
// convention the whole repo grades against, or if a beta were estimated with future data.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/forecast/targets');
const FX = require('./forecast-fixtures');

const cfg = FX.testConfig();

// A hand-built series with exact prices, so every expected number is arithmetic, not a fixture.
const CANDLES = [
  { date: '2024-01-02', open: 100, high: 101, low: 99, close: 100 },
  { date: '2024-01-03', open: 100, high: 102, low: 98, close: 101 },
  { date: '2024-01-04', open: 102, high: 106, low: 101, close: 105 },
  { date: '2024-01-05', open: 105, high: 108, low: 95, close: 96 },
  { date: '2024-01-08', open: 96, high: 110, low: 96, close: 110 },
  { date: '2024-01-09', open: 111, high: 115, low: 110, close: 112 },
];

test('forwardWindow uses the NEXT session open as the fill and close(d+h) as the exit', () => {
  // decision at idx 1 (2024-01-03). h=1 → fill at open of 01-04 (102), exit close of 01-04 (105).
  const w1 = T.forwardWindow(CANDLES, 1, 1);
  assert.equal(w1.reason, null);
  assert.equal(w1.labelStart, '2024-01-04');
  assert.equal(w1.labelEnd, '2024-01-04');
  assert.ok(Math.abs(w1.ret - (105 / 102 - 1)) < 1e-12, 'h=1 is buy-next-open, sell-that-close');

  // h=3 → fill at open of 01-04 (102), exit close of 01-08 (110).
  const w3 = T.forwardWindow(CANDLES, 1, 3);
  assert.equal(w3.labelStart, '2024-01-04');
  assert.equal(w3.labelEnd, '2024-01-08');
  assert.ok(Math.abs(w3.ret - (110 / 102 - 1)) < 1e-12);
});

test('forwardWindow never executes at the decision session close', () => {
  const w = T.forwardWindow(CANDLES, 1, 1);
  assert.notEqual(w.labelStart, CANDLES[1].date, 'the fill session must be AFTER the decision session');
  assert.ok(w.labelStart > CANDLES[1].date);
});

test('drawdown is a true peak-to-trough of the held path, measured from the fill', () => {
  // Fill at open of 01-04 = 102. Held bars: highs 106,108,110 and lows 101,95,96.
  // The running peak includes the current bar's high (daily bars do not order high vs low, and
  // the conservative reading for a long widens the drawdown), so the worst is (110-96)/110.
  const w = T.forwardWindow(CANDLES, 1, 3);
  assert.ok(Math.abs(w.maxDrawdown - (110 - 96) / 110) < 1e-12, `got ${w.maxDrawdown}`);
  assert.ok(w.maxDrawdown >= (108 - 95) / 108, 'the measured drawdown is never smaller than the strict prior-peak reading');
});

test('a truncated series yields an UNOBSERVABLE label, never a zero', () => {
  const w = T.forwardWindow(CANDLES, 4, 5);
  assert.equal(w.reason, T.UNOBSERVABLE.TRUNCATED_HISTORY);
  assert.equal(w.ret, undefined, 'no return is invented for an unobservable window');
});

test('a suspected unadjusted corporate action inside the window rejects the label', () => {
  const split = CANDLES.slice(0, 3).concat([{ date: '2024-01-05', open: 52, high: 53, low: 51, close: 52 }, { date: '2024-01-08', open: 52, high: 54, low: 51, close: 53 }]);
  const w = T.forwardWindow(split, 1, 3, { extremeOneDayMove: 0.5 });
  assert.equal(w.reason, T.UNOBSERVABLE.EXTREME_MOVE);
});

test('neutralize does not double-count market exposure through the sector leg', () => {
  const args = { fwd: 0.05, fwdMarket: 0.02, fwdSector: 0.03, betaMarket: 1.2, betaSector: 0.8, betaSectorMarket: 1.1 };
  const got = T.neutralize('residual-mkt-sector-v1', args);
  const expected = 0.05 - 1.2 * 0.02 - 0.8 * (0.03 - 1.1 * 0.02);
  assert.ok(Math.abs(got - expected) < 1e-12, `${got} != ${expected}`);
  // The sector leg is the sector's MARKET-RESIDUAL, so removing it cannot remove market twice.
  const naiveDouble = 0.05 - 1.2 * 0.02 - 0.8 * 0.03;
  assert.notEqual(+got.toFixed(10), +naiveDouble.toFixed(10));
});

test('neutralize falls back to the market-only residual when the sector leg is missing', () => {
  const got = T.neutralize('residual-mkt-sector-v1', { fwd: 0.05, fwdMarket: 0.02, fwdSector: null, betaMarket: 1.2, betaSector: null, betaSectorMarket: null });
  assert.ok(Math.abs(got - (0.05 - 1.2 * 0.02)) < 1e-12);
});

test('every alternative target definition is supported and distinct', () => {
  const a = { fwd: 0.05, fwdMarket: 0.02, fwdSector: 0.03, betaMarket: 1.2, betaSector: 0.8, betaSectorMarket: 1.1 };
  assert.equal(T.neutralize('raw-v1', a), 0.05);
  assert.ok(Math.abs(T.neutralize('market-relative-v1', a) - 0.03) < 1e-12);
  assert.ok(Math.abs(T.neutralize('sector-relative-v1', a) - 0.02) < 1e-12);
  assert.ok(Math.abs(T.neutralize('beta-market-residual-v1', a) - (0.05 - 0.024)) < 1e-12);
  assert.equal(T.neutralize('not-a-definition', a), null, 'an unknown definition fails closed');
});

test('trailing betas use ONLY bars at or before the decision index', () => {
  const panel = FX.buildPanel({ sessions: 300, names: 6, seed: 3 });
  const t = 'SYN00';
  const entry = panel.dataset.get(t);
  const date = panel.sessions[200];
  const idx = entry.idx.get(date);
  const bIdx = panel.bench.idx.get(date);
  const before = T.trailingBetas(entry.candles, idx, panel.bench.candles, bIdx, null, -1, cfg);

  // Corrupt every bar AFTER the decision index; the beta must not move by one bit.
  const poisoned = entry.candles.map((c, i) => (i > idx ? { ...c, close: c.close * 5, high: c.high * 5, low: c.low * 5 } : c));
  const pBench = panel.bench.candles.map((c, i) => (i > bIdx ? { ...c, close: c.close * 5 } : c));
  const after = T.trailingBetas(poisoned, idx, pBench, bIdx, null, -1, cfg);
  assert.equal(after.betaMarket, before.betaMarket, 'a trailing beta that moves when the FUTURE changes is not trailing');
  assert.equal(after.obs, before.obs);
});

test('betas are shrunk toward their prior and clamped to the configured range', () => {
  const c = FX.testConfig({ target: { betaShrink: 0.5, betaClamp: { market: [0.5, 1.5], sector: [-1, 1] }, betaLookback: 60, betaMinObs: 40 } });
  const panel = FX.buildPanel({ sessions: 300, names: 4, seed: 5 });
  const entry = panel.dataset.get('SYN01');
  const date = panel.sessions[200];
  const b = T.trailingBetas(entry.candles, entry.idx.get(date), panel.bench.candles, panel.bench.idx.get(date), null, -1, c);
  assert.ok(b.betaMarket >= 0.5 && b.betaMarket <= 1.5, `clamped: ${b.betaMarket}`);
  if (Number.isFinite(b.betaMarketRaw)) {
    assert.ok(Math.abs(b.betaMarket - 1) <= Math.abs(b.betaMarketRaw - 1) + 1e-9, 'shrinkage must move the estimate toward the prior of 1');
  }
});

test('too few observations refuses a beta instead of guessing one', () => {
  const panel = FX.buildPanel({ sessions: 300, names: 3, seed: 9 });
  const entry = panel.dataset.get('SYN00');
  const b = T.trailingBetas(entry.candles, 5, panel.bench.candles, 5, null, -1, cfg);
  assert.equal(b.betaMarket, null);
  assert.equal(b.reason, T.UNOBSERVABLE.INSUFFICIENT_BETA_OBS);
});

test('buildLabels emits every configured horizon with matching label intervals', () => {
  const panel = FX.buildPanel({ sessions: 320, names: 8, seed: 11 });
  const date = panel.sessions[250];
  const out = T.buildLabels({ panel, ticker: 'SYN03', date, cfg });
  for (const h of cfg.horizons) {
    const lab = out.labels[h];
    assert.ok(lab, `horizon ${h} produced no label: ${out.unobservable[h]}`);
    assert.equal(lab.horizon, h);
    const sIdx = panel.sessions.indexOf(lab.labelStart);
    const eIdx = panel.sessions.indexOf(lab.labelEnd);
    assert.equal(sIdx, panel.sessions.indexOf(date) + 1, 'labelStart is always the next session');
    assert.equal(eIdx - sIdx, h - 1, `a ${h}-session label must span exactly ${h} sessions`);
    assert.ok(Number.isFinite(lab.residualReturn));
    assert.equal(lab.benchmark, 'SPY');
  }
});

test('label intervals nest: a longer horizon always ends at or after a shorter one', () => {
  const panel = FX.buildPanel({ sessions: 320, names: 5, seed: 13 });
  const out = T.buildLabels({ panel, ticker: 'SYN01', date: panel.sessions[250], cfg });
  const ends = cfg.horizons.map((h) => out.labels[h].labelEnd);
  for (let i = 1; i < ends.length; i++) assert.ok(ends[i] > ends[i - 1], 'label ends must increase with horizon');
});

test('threshold classes are derived from the residual, drawdown from the raw held path', () => {
  const panel = FX.buildPanel({ sessions: 320, names: 5, seed: 17 });
  const out = T.buildLabels({ panel, ticker: 'SYN02', date: panel.sessions[250], cfg });
  const lab = out.labels[5];
  assert.equal(lab.classes['0'], lab.residualReturn > 0 ? 1 : 0);
  assert.equal(lab.classes['0.03'], lab.residualReturn > 0.03 ? 1 : 0);
  assert.equal(lab.classes['0.05'], lab.residualReturn > 0.05 ? 1 : 0);
  assert.equal(lab.classes.drawdown, lab.maxDrawdown > cfg.drawdownThreshold ? 1 : 0);
});

test('class prevalence is reported per horizon and threshold', () => {
  const panel = FX.buildPanel({ sessions: 330, names: 20, seed: 19 });
  const labels = [];
  for (const d of panel.sessions.slice(150, 250)) {
    for (const t of panel.dataset.keys()) {
      const o = T.buildLabels({ panel, ticker: t, date: d, cfg });
      for (const h of cfg.horizons) if (o.labels[h]) labels.push(o.labels[h]);
    }
  }
  const prev = T.classPrevalence(labels, cfg);
  for (const h of cfg.horizons) {
    assert.ok(prev[h].n > 0);
    for (const k of ['0', '0.03', '0.05', 'drawdown']) {
      assert.ok(prev[h].prevalence[k] >= 0 && prev[h].prevalence[k] <= 1);
    }
    assert.ok(prev[h].prevalence['0'] >= prev[h].prevalence['0.03'], 'P(r>0) must be >= P(r>3%)');
    assert.ok(prev[h].prevalence['0.03'] >= prev[h].prevalence['0.05'], 'P(r>3%) must be >= P(r>5%)');
  }
  assert.ok(prev[10].prevalence['0.05'] >= prev[1].prevalence['0.05'], 'a 5% move is rarer at 1 session than at 10');
});

test('the trading calendar drives the label, so a holiday gap does not shorten it', () => {
  // Remove a session from the middle of the calendar; a 3-session label must still span 3 BARS.
  const panel = FX.buildPanel({ sessions: 320, names: 4, seed: 23, skip: ['2022-07-04', '2022-11-24', '2022-12-26'] });
  const date = panel.sessions[250];
  const out = T.buildLabels({ panel, ticker: 'SYN00', date, cfg });
  const lab = out.labels[3];
  const s = panel.sessions.indexOf(lab.labelStart);
  assert.equal(panel.sessions.indexOf(lab.labelEnd) - s, 2, 'three sessions means three BARS, whatever the calendar dates are');
});
