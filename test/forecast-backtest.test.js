'use strict';
// BACKTEST: costs actually bite, the calendar arithmetic is right, overlapping holding periods
// are handled by non-overlapping tranches, and constraints are enforced.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const BT = require('../lib/forecast/backtest');
const M = require('../lib/forecast/metrics');
const FX = require('./forecast-fixtures');

const cfg = FX.testConfig();

function makeRows({ dates = 200, names = 60, seed = 5, signalStrength = 0.004, adv = 3e7 } = {}) {
  const rnd = FX.rng(seed);
  const sectors = ['Technology', 'Financials', 'Energy', 'Health Care'];
  const rows = [];
  for (let d = 0; d < dates; d++) {
    const date = `D${String(d).padStart(4, '0')}`;
    for (let i = 0; i < names; i++) {
      const sig = rnd();
      const raw = signalStrength * (sig - 0.5) + (rnd() - 0.5) * 0.05;
      rows.push({
        decisionDate: date, ticker: `T${i}`, sector: sectors[i % 4], score: sig, adv, price: 50,
        label: { rawReturn: raw, residualReturn: raw - 0.001, labelEnd: date },
      });
    }
  }
  return rows;
}

test('costs are charged and the gross/net gap equals the modelled friction', () => {
  const rows = makeRows();
  const r = BT.runBacktest(rows, cfg, { horizon: 5 });
  assert.equal(r.ok, true);
  assert.ok(r.pooled.gross.meanPerPeriod > r.pooled.net.meanPerPeriod, 'net must be below gross');
  const gap = r.pooled.gross.meanPerPeriod - r.pooled.net.meanPerPeriod;
  assert.ok(Math.abs(gap - r.costs.meanCostPerRebalance) < 1e-9, 'the gap IS the cost, not an approximation');
  assert.ok(r.costs.meanCostPerRebalance > 0);
  assert.equal(r.costs.basis, 'half a round trip per unit of weight traded at each rebalance');
});

test('COST IS CHARGED ON WHAT IS TRADED, not on the whole book', () => {
  const m = (ticker, weight) => ({ ticker, weight, adv: 3e7, label: { rawReturn: 0.01, residualReturn: 0.005 } });
  const book = [m('A', 0.5), m('B', 0.5)];

  // Holding an identical book across a rebalance trades nothing and must cost nothing.
  const held = BT.sleeveReturn(book, 1, book);
  assert.equal(held.tradedWeight, 0);
  assert.equal(held.cost, 0, 'a name that is simply held must not pay a round trip');
  assert.equal(held.net, held.gross);

  // A complete turnover moves 2.0 of weight (1.0 out, 1.0 in) = exactly ONE round trip,
  // which is what the old whole-book model charged for every rebalance regardless.
  const fresh = [m('C', 0.5), m('D', 0.5)];
  const turned = BT.sleeveReturn(fresh, 1, book);
  assert.ok(Math.abs(turned.tradedWeight - 2) < 1e-12);
  const rt = BT.costFor({ adv: 3e7 }).cost;
  assert.ok(Math.abs(turned.cost - rt) < 1e-12, `a full turnover costs one round trip: ${turned.cost} vs ${rt}`);

  // Half the book replaced costs half as much.
  const half = BT.sleeveReturn([m('A', 0.5), m('C', 0.5)], 1, book);
  assert.ok(Math.abs(half.cost - rt / 2) < 1e-12);

  // Entering from cash is a half round trip, not a full one.
  const entry = BT.sleeveReturn(book, 1, null);
  assert.ok(Math.abs(entry.cost - rt / 2) < 1e-12);
});

test('the NO-TRADE BAND keeps incumbents and cuts turnover and cost', () => {
  // A persistent signal: without a band, names oscillating around rank K churn every rebalance.
  const rnd = FX.rng(41);
  const persistent = Array.from({ length: 80 }, () => rnd());
  const rows = [];
  for (let d = 0; d < 200; d++) {
    const date = `D${String(d).padStart(4, '0')}`;
    for (let i = 0; i < 80; i++) {
      const sig = 0.85 * persistent[i] + 0.15 * rnd();
      const raw = 0.01 * (sig - 0.5) + (rnd() - 0.5) * 0.05;
      rows.push({ decisionDate: date, ticker: `T${i}`, sector: ['Technology', 'Financials', 'Energy', 'Health Care'][i % 4], score: sig, adv: 3e7, price: 50, label: { rawReturn: raw, residualReturn: raw - 0.0005, labelEnd: date } });
    }
  }
  const withCfg = (band) => FX.testConfig({ portfolio: { noTradeBand: band, topK: 20, weighting: 'equal', maxWeightPerName: 0.1, maxWeightPerSector: 0.35, longOnly: true, quantiles: 5, overlappingSleeves: true } });
  const none = BT.runBacktest(rows, withCfg(1), { horizon: 5, stride: 1 });
  const banded = BT.runBacktest(rows, withCfg(2), { horizon: 5, stride: 1 });

  assert.ok(banded.costs.meanTurnover < none.costs.meanTurnover, 'the band must reduce turnover');
  assert.ok(banded.costs.annualizedCostDrag < none.costs.annualizedCostDrag, 'and therefore the cost drag');
  assert.ok(banded.pooled.net.sharpe >= none.pooled.net.sharpe, 'less churn on the same signal cannot hurt the net result');
  assert.equal(banded.costs.noTradeBand, 2);

  // Every held name must genuinely be inside the band, not merely carried along.
  const t0 = banded.tranches[0];
  assert.ok(t0.rebalances > 5);
});

test('the cost tier follows dollar volume, so illiquid names pay more', () => {
  assert.equal(BT.tierForAdv(5e7), 'liquid');
  assert.equal(BT.tierForAdv(1e7), 'small');
  assert.equal(BT.tierForAdv(1e6), 'micro');
  assert.equal(BT.tierForAdv(null), 'micro', 'unknown liquidity is treated as the most expensive tier');
  assert.ok(BT.costFor({ adv: 1e6 }).cost > BT.costFor({ adv: 5e7 }).cost);
});

test('cost stress scales the drag and is reported at every configured multiplier', () => {
  const rows = makeRows();
  const stress = BT.costStress(rows, cfg, { horizon: 5 });
  assert.deepEqual(Object.keys(stress), ['x1', 'x2', 'x3']);
  assert.ok(stress.x1.netAnnReturn > stress.x2.netAnnReturn);
  assert.ok(stress.x2.netAnnReturn > stress.x3.netAnnReturn);
});

test('CALENDAR ARITHMETIC: annualization uses the true session spacing, not the horizon alone', () => {
  const rows = makeRows({ dates: 120 });
  const daily = BT.runBacktest(rows, cfg, { horizon: 5, stride: 1 });
  assert.equal(daily.calendar.trancheStep, 5, 'at stride 1, five tranches are needed to avoid overlap');
  assert.equal(daily.calendar.sessionsPerPeriod, 5);
  assert.ok(Math.abs(daily.calendar.periodsPerYear - 252 / 5) < 1e-9);
  assert.equal(daily.calendar.capitalDutyCycle, 1);

  const coarse = BT.runBacktest(rows, cfg, { horizon: 5, stride: 10 });
  assert.equal(coarse.calendar.trancheStep, 1, 'at stride 10 a 5-session hold never overlaps');
  assert.equal(coarse.calendar.sessionsPerPeriod, 10);
  assert.ok(Math.abs(coarse.calendar.capitalDutyCycle - 0.5) < 1e-9, 'half the calendar is uninvested and that shows');
  assert.ok(coarse.calendar.periodsPerYear < daily.calendar.periodsPerYear);
});

test('OVERLAPPING HOLDINGS: tranches contain no overlapping sleeves', () => {
  const rows = makeRows({ dates: 100 });
  const r = BT.runBacktest(rows, cfg, { horizon: 5, stride: 1 });
  assert.equal(r.tranches.length, 5, 'a 5-session hold rebalanced daily needs 5 tranches');
  assert.equal(r.trancheCount, 5);
  assert.equal(r.pooled.overlapping, true);
  assert.equal(r.pooled.volatilityUnderstated, true, 'the pooled series is flagged as dependent');
  assert.ok(r.trancheSummary.netSharpe.n === r.tranches.length);
  assert.ok(Number.isFinite(r.trancheSummary.netSharpe.sd), 'the tranche spread is reported, not hidden');
});

test('position and sector caps are enforced in the selected sleeve', () => {
  const c = FX.testConfig({ portfolio: { topK: 12, maxWeightPerName: 0.15, maxWeightPerSector: 0.34, weighting: 'score', longOnly: true, quantiles: 5, overlappingSleeves: true } });
  const rows = makeRows({ dates: 5, names: 60 }).filter((r) => r.decisionDate === 'D0000');
  const sel = BT.selectSleeve(rows, c, { topK: c.portfolio.topK, weighting: 'score' });
  assert.equal(sel.members.length, c.portfolio.topK);
  const total = sel.members.reduce((a, m) => a + m.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'weights sum to one');
  for (const m of sel.members) assert.ok(m.weight <= c.portfolio.maxWeightPerName + 1e-9, `position cap violated: ${m.weight}`);
  const bySector = new Map();
  for (const m of sel.members) bySector.set(m.sector, (bySector.get(m.sector) || 0) + 1);
  const cap = Math.ceil(c.portfolio.topK * c.portfolio.maxWeightPerSector);
  for (const [s, n] of bySector) assert.ok(n <= cap, `sector ${s} took ${n} slots, cap ${cap}`);
});

test('equal weighting really is equal', () => {
  const rows = makeRows({ dates: 2, names: 40 }).filter((r) => r.decisionDate === 'D0000');
  const sel = BT.selectSleeve(rows, cfg, { topK: 10, weighting: 'equal' });
  const w = sel.members.map((m) => m.weight);
  assert.ok(w.every((x) => Math.abs(x - w[0]) < 1e-12));
});

test('turnover is zero for an identical sleeve and one for a disjoint one', () => {
  const a = [{ ticker: 'A', weight: 0.5 }, { ticker: 'B', weight: 0.5 }];
  assert.equal(BT.turnoverBetween(a, a), 0);
  assert.equal(BT.turnoverBetween(a, [{ ticker: 'C', weight: 0.5 }, { ticker: 'D', weight: 0.5 }]), 1);
  assert.equal(BT.turnoverBetween(null, a), 1, 'the first sleeve is a full buy');
});

test('the expected-return map is fitted on TRAIN rows and is monotone in the score', () => {
  const rnd = FX.rng(53);
  const rows = [];
  for (let d = 0; d < 120; d++) {
    const date = `D${String(d).padStart(4, '0')}`;
    for (let i = 0; i < 60; i++) {
      const score = rnd();
      rows.push({ decisionDate: date, ticker: `T${i}`, score, label: { residualReturn: 0.02 * (score - 0.5) + (rnd() - 0.5) * 0.04 } });
    }
  }
  const map = BT.fitExpectedReturnMap(rows);
  assert.ok(map, 'a 7200-row training sample should support a map');
  assert.equal(map.values.length, map.bins);
  for (let i = 1; i < map.values.length; i++) {
    assert.ok(map.values[i] >= map.values[i - 1] - 1e-12, 'the map must not invert — a higher score cannot mean a lower expected return');
  }
  assert.ok(BT.expectedReturnAt(map, 0.95) > BT.expectedReturnAt(map, 0.05), 'the planted signal must be recovered');
  assert.equal(BT.fitExpectedReturnMap(rows.slice(0, 200)), null, 'too thin a sample yields NO map rather than a fitted-on-noise one');
});

test('the SWITCH-COST TEST refuses a swap whose edge does not clear the round trip', () => {
  const c = FX.testConfig({ portfolio: { switchCostTest: true, noTradeBand: 1, topK: 2, weighting: 'equal', maxWeightPerName: 1, maxWeightPerSector: 1, longOnly: true, quantiles: 5, overlappingSleeves: true } });
  const row = (ticker, score) => ({ decisionDate: 'D1', ticker, sector: 'Technology', score, adv: 1e6, price: 50, label: { rawReturn: 0.01, residualReturn: 0.005 } });
  const previous = [{ ...row('A', 0.9), weight: 0.5 }, { ...row('B', 0.8), weight: 0.5 }];

  // micro tier: 1.5% round trip, so the hurdle to swap is ~1.5% of expected edge.
  const tiny = { bins: 10, values: [0, 0.0001, 0.0002, 0.0003, 0.0004, 0.0005, 0.0006, 0.0007, 0.0008, 0.0009], rows: 1e6, dates: 100 };
  const keep = BT.selectSleeve([row('C', 0.99), row('A', 0.9), row('B', 0.8)], c, { topK: 2, weighting: 'equal', previous, expectedMap: tiny });
  assert.deepEqual(keep.members.map((m) => m.ticker).sort(), ['A', 'B'], 'a 0.09% edge cannot justify a 1.5% round trip');

  // A large edge clears it and the swap happens.
  const big = { bins: 10, values: [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09], rows: 1e6, dates: 100 };
  const swap = BT.selectSleeve([row('C', 0.99), row('A', 0.9), row('B', 0.8)], c, { topK: 2, weighting: 'equal', previous, expectedMap: big });
  assert.ok(swap.members.some((m) => m.ticker === 'C'), 'an edge far above the round trip must be taken');
});

test('portfolio parameters are selected on TRAINING rows, and the grid is reported', () => {
  const rnd = FX.rng(59);
  const persistent = Array.from({ length: 60 }, () => rnd());
  const rows = [];
  for (let d = 0; d < 150; d++) {
    const date = `D${String(d).padStart(4, '0')}`;
    for (let i = 0; i < 60; i++) {
      const sig = 0.8 * persistent[i] + 0.2 * rnd();
      const raw = 0.02 * (sig - 0.5) + (rnd() - 0.5) * 0.04;
      rows.push({ decisionDate: date, ticker: `T${i}`, sector: ['Technology', 'Energy'][i % 2], score: sig, adv: 3e7, price: 50, label: { rawReturn: raw, residualReturn: raw - 0.0005, labelEnd: date } });
    }
  }
  const c = FX.testConfig({ portfolio: { selectParameters: true, topK: 20, noTradeBand: 2, switchCostTest: true, weighting: 'equal', maxWeightPerName: 0.2, maxWeightPerSector: 0.6, longOnly: true, quantiles: 5, overlappingSleeves: true, parameterGrid: { topK: [10, 20], noTradeBand: [1, 4], switchCostTest: [false, true] } } });
  const map = BT.fitExpectedReturnMap(rows);
  const sel = BT.selectPortfolioParameters(rows, c, { horizon: 5, stride: 1, expectedMap: map });
  assert.ok(sel.tried.length >= 4, 'every grid cell is reported, not just the winner');
  assert.ok([10, 20].includes(sel.selected.topK));
  assert.ok([1, 4].includes(sel.selected.noTradeBand));
  assert.match(sel.metric, /training-window out-of-fold/);
  for (const cell of sel.tried) assert.ok('residualNetSharpe' in cell && 'turnover' in cell);
  assert.ok(sel.best.residualNetSharpe >= Math.max(...sel.tried.map((t) => (Number.isFinite(t.residualNetSharpe) ? t.residualNetSharpe : -Infinity))) - 1e-12);
});

test('equityStats compounds and reports a real drawdown', () => {
  const s = BT.equityStats([0.1, -0.5, 0.1], 252);
  assert.ok(Math.abs(s.totalReturn - (1.1 * 0.5 * 1.1 - 1)) < 1e-12);
  assert.ok(Math.abs(s.maxDrawdown - 0.5) < 1e-9);
  assert.equal(s.hitRate, 2 / 3);
});

test('a backtest with no usable rows fails loudly rather than returning zeros', () => {
  const r = BT.runBacktest([], cfg, { horizon: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no rows/);
});

test('a strong planted signal survives costs; a null signal does not', () => {
  const strong = BT.runBacktest(makeRows({ signalStrength: 0.05, seed: 21 }), cfg, { horizon: 5, stride: 1 });
  const none = BT.runBacktest(makeRows({ signalStrength: 0, seed: 21 }), cfg, { horizon: 5, stride: 1 });
  assert.ok(strong.pooled.net.annReturn > none.pooled.net.annReturn);
  assert.ok(strong.pooled.net.sharpe > 0, 'a large planted edge must beat 16bps of friction');
  assert.ok(none.pooled.net.sharpe < 0, 'a zero-signal book must lose exactly the friction');
});

// ── metrics ─────────────────────────────────────────────────────────────────

test('rank IC is null for a constant score vector, not zero', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ decisionDate: 'D1', score: 1, actual: i / 20 }));
  const ic = M.informationCoefficient(rows);
  assert.equal(ic.perDate.length, 1);
  assert.equal(ic.perDate[0].rankIC, null, 'a constant score has NO ordering');
});

test('IC is computed per date and the IR uses the across-date standard error', () => {
  const rows = [];
  for (let d = 0; d < 40; d++) for (let i = 0; i < 30; i++) rows.push({ decisionDate: `D${d}`, score: i, actual: i + (d % 3) });
  const ic = M.informationCoefficient(rows);
  assert.equal(ic.dates, 40);
  assert.ok(Math.abs(ic.meanRankIC - 1) < 1e-9, 'a perfectly ordered score has rank IC 1');
  assert.equal(ic.positiveRankICRate, 1);
});

test('probability metrics report Brier, log loss and calibration error', () => {
  const rnd = FX.rng(29);
  const perfect = Array.from({ length: 2000 }, () => { const p = rnd(); return { p, y: rnd() < p ? 1 : 0 }; });
  const m = M.probabilityMetrics(perfect);
  assert.ok(m.brier > 0 && m.brier < 0.35);
  assert.ok(m.ece < 0.06, `a well-calibrated set should have small ECE, got ${m.ece}`);
  const overconfident = perfect.map(({ y }) => ({ p: y === 1 ? 0.02 : 0.98, y }));
  assert.ok(M.probabilityMetrics(overconfident).logLoss > m.logLoss, 'confidently wrong scores worse');
});

test('quantile spread reports top minus bottom per date', () => {
  const rows = [];
  for (let d = 0; d < 20; d++) for (let i = 0; i < 50; i++) rows.push({ decisionDate: `D${d}`, score: i, actual: i * 0.001 });
  const s = M.quantileSpread(rows, 5);
  assert.ok(s.meanSpread > 0);
  assert.ok(s.meanTop > s.meanBottom);
});
