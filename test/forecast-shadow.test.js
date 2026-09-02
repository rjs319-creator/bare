'use strict';
// CFR PROSPECTIVE SHADOW — pure-logic guard tests: frozen prespecification honesty,
// deterministic primary ordering, shard-row field discipline (point vs rank kept
// apart; betas frozen), no-trade-band parity with the REAL backtest selector,
// turnover/cost accounting, tie-aware Spearman IC, and frozen-beta outcome math.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/forecast-shadow');

// ── frozen prespecification ─────────────────────────────────────────────────

test('FROZEN prespecifies the gate before any outcome exists, and keeps the two arms apart', () => {
  const g = S.FROZEN.prospectiveGate;
  assert.equal(g.minResolvedDates, 80);
  assert.equal(g.fdrAlpha, 0.1);
  assert.equal(g.minPositiveBlocks, 3);
  assert.match(g.promotion, /annotation, never selection/);
  assert.match(S.FROZEN.arms.primary.lineage, /cfr-walkforward-2026-08/);
  assert.match(S.FROZEN.arms.secondary.lineage, /NO backtest evidence/);
  assert.match(S.FROZEN.book.role, /NOT the gate/);
  assert.match(S.FROZEN.providerSplit, /FMP.*Yahoo/s);
  assert.match(S.FROZEN.outcome.betas, /never recomputes/);
});

// ── primary ordering ────────────────────────────────────────────────────────

test('primaryOrder ranks eligible rows by the ridge point desc, ties broken by ticker', () => {
  const rows = [
    { ticker: 'CCC', eligible: true, expectedResidualReturn: 0.02 },
    { ticker: 'AAA', eligible: true, expectedResidualReturn: 0.05 },
    { ticker: 'DDD', eligible: false, expectedResidualReturn: 0.99 },     // ineligible: out
    { ticker: 'EEE', eligible: true, expectedResidualReturn: NaN },       // no point: out
    { ticker: 'BBB', eligible: true, expectedResidualReturn: 0.02 },      // tie with CCC
  ];
  const out = S.primaryOrder(rows);
  assert.deepStrictEqual(out.map((r) => r.ticker), ['AAA', 'BBB', 'CCC']);
  assert.deepStrictEqual(out.map((r) => r.primaryRank), [1, 2, 3]);
});

// ── shard rows ──────────────────────────────────────────────────────────────

test('buildShardRows keeps the point and the xs rank as distinct fields and freezes all three betas', () => {
  const scored = [
    { ticker: 'AAA', eligible: true, expectedResidualReturn: 0.03, rank: 2, marketBeta: 1.1, sectorBeta: 0.4, sector: 'Technology', estimatedCostFraction: 0.0012 },
    { ticker: 'BBB', eligible: true, expectedResidualReturn: 0.01, rank: 1, marketBeta: 0.9, sectorBeta: null, sector: 'Energy', estimatedCostFraction: 0.002 },
  ];
  const betas = new Map([
    ['AAA', { betaMarket: 1.12, betaSector: 0.41, betaSectorMarket: 0.95, sectorEtf: 'XLK' }],
  ]);
  const rows = S.buildShardRows(scored, betas);
  const a = rows.find((r) => r.ticker === 'AAA');
  // the dataset row (which carries betaSectorMarket) wins over the scored row's copy
  assert.equal(a.betaMarket, 1.12);
  assert.equal(a.betaSectorMarket, 0.95);
  assert.equal(a.sectorEtf, 'XLK');
  assert.equal(a.primaryRank, 1);          // higher point
  assert.equal(a.xsRank, 2);               // served ranking disagrees — both recorded
  const b = rows.find((r) => r.ticker === 'BBB');
  assert.equal(b.betaMarket, 0.9);         // falls back to the scored row
  assert.equal(b.betaSectorMarket, null);  // never fabricated
  assert.equal(b.primaryRank, 2);
  assert.equal(b.xsRank, 1);
});

// ── no-trade band: parity with the real backtest selector ───────────────────

function sleeveParityCase({ n, prevTickers, topK = 5, sectorOf = () => 'S1' }) {
  const F = require('../lib/forecast');
  const cfg = F.config.resolveConfig({});
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ticker = `T${String(i).padStart(3, '0')}`;
    rows.push({ ticker, sector: sectorOf(i), score: n - i, label: { rawReturn: 0 }, adv: 5e7 });
  }
  const previous = prevTickers.map((t) => ({ ticker: t, weight: 1 / prevTickers.length }));
  const real = F.backtest.selectSleeve(rows, cfg, { topK, weighting: 'equal', previous: previous.length ? previous : null });
  const mine = S.carrySleeve(
    rows.map((r) => ({ ticker: r.ticker, sector: r.sector })),
    prevTickers,
    { topK, noTradeBand: cfg.portfolio.noTradeBand, maxWeightPerSector: cfg.portfolio.maxWeightPerSector },
  );
  assert.deepStrictEqual(mine.book, real.members.map((m) => m.ticker), 'carrySleeve must match backtest selectSleeve');
}

test('carrySleeve matches backtest selectSleeve: fresh book, incumbents inside the band, incumbents outside it', () => {
  sleeveParityCase({ n: 30, prevTickers: [] });                              // fresh book
  sleeveParityCase({ n: 30, prevTickers: ['T007', 'T002'] });                // held inside band (topK*2)
  sleeveParityCase({ n: 30, prevTickers: ['T025', 'T001'] });                // T025 outside band at topK=5: dropped
  sleeveParityCase({ n: 30, prevTickers: ['T000', 'T001', 'T002', 'T003', 'T004'] });  // unchanged top
  sleeveParityCase({ n: 40, prevTickers: ['T009'], sectorOf: (i) => (i < 8 ? 'S1' : `S${i}`) });  // sector cap binds
});

// ── turnover and cost accounting ────────────────────────────────────────────

test('bookTurnover: first book 1, unchanged 0, one swap in N is 1/N', () => {
  assert.equal(S.bookTurnover([], ['A', 'B']), 1);
  assert.equal(S.bookTurnover(['A', 'B'], ['A', 'B']), 0);
  const prev = Array.from({ length: 20 }, (_, i) => `P${i}`);
  const next = [...prev.slice(0, 19), 'NEW'];
  assert.ok(Math.abs(S.bookTurnover(prev, next) - 1 / 20) < 1e-12);
  assert.equal(S.bookTurnover(['A'], []), null);
});

test('chargeFor is 0.5 x sum|dw| x round trip IN FRACTIONS: full turnover pays one round trip, a swap pays c/N', () => {
  const c = () => 0.003;   // uniform 30bps round trip, as a FRACTION (estimatedCostFraction's unit)
  // entering a fresh book = buy leg only = half a round trip
  assert.ok(Math.abs(S.chargeFor([], ['A', 'B'], c).chargedCost - 0.0015) < 1e-12);
  assert.equal(S.chargeFor(['A', 'B'], ['A', 'B'], c).chargedCost, 0);
  const prev = Array.from({ length: 20 }, (_, i) => `P${i}`);
  const next = [...prev.slice(0, 19), 'NEW'];
  assert.ok(Math.abs(S.chargeFor(prev, next, c).chargedCost - 0.003 / 20) < 1e-12);
  // unknown costs fall back to the median of priced moves and say how much was priced
  const partial = S.chargeFor([], ['A', 'B'], (t) => (t === 'A' ? 0.003 : NaN));
  assert.ok(Math.abs(partial.chargedCost - 0.0015) < 1e-12);
  assert.equal(partial.pricedFraction, 0.5);
  assert.equal(S.chargeFor([], ['A'], () => NaN).chargedCost, null);
});

// ── Spearman IC ─────────────────────────────────────────────────────────────

test('spearmanIC: monotone +1, inverse -1, tie-averaged, non-finite pairs dropped, degenerate null', () => {
  assert.equal(S.spearmanIC([1, 2, 3, 4], [10, 20, 30, 40]).ic, 1);
  assert.equal(S.spearmanIC([1, 2, 3, 4], [40, 30, 20, 10]).ic, -1);
  const tied = S.spearmanIC([1, 2, 2, 4], [1, 2, 3, 4]);
  assert.ok(tied.ic > 0.9 && tied.ic < 1, 'ties average, correlation stays below 1');
  const dropped = S.spearmanIC([1, NaN, 3, 4], [10, 20, null, 40]);
  assert.equal(dropped.n, 2);
  assert.equal(dropped.ic, null, 'n < 3 refuses to report');
  assert.equal(S.spearmanIC([1, 1, 1], [1, 2, 3]).ic, null, 'constant side refuses');
});

// ── frozen-beta outcomes ────────────────────────────────────────────────────

function mkCandles(n, { base = 100, drift = 0 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = base + drift * i;
    out.push({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 });
  }
  return out;
}

test('residualOutcome applies the FROZEN betas via targets.neutralize, with the market-only fallback flagged', () => {
  const name = mkCandles(20, { base: 100, drift: 1 });     // rises 1/day
  const spy = mkCandles(20, { base: 500, drift: 1 });      // rises 0.2%/day-ish
  const sec = mkCandles(20, { base: 200, drift: 0 });      // flat
  const betas = { betaMarket: 1, betaSector: 0.5, betaSectorMarket: 0 };
  const full = S.residualOutcome({ candles: name, idx: 5, h: 5, bench: spy, benchIdx: 5, sector: sec, sectorIdx: 5, betas });
  assert.equal(full.reason, null);
  assert.ok(full.sectorApplied);
  const fwd = name[10].close / name[6].open - 1;
  const mkt = spy[10].close / spy[6].open - 1;
  const secR = sec[10].close / sec[6].open - 1;
  const expected = fwd - 1 * mkt - 0.5 * (secR - 0 * mkt);
  assert.ok(Math.abs(full.residual - expected) < 1e-12);

  const noSec = S.residualOutcome({ candles: name, idx: 5, h: 5, bench: spy, benchIdx: 5, betas });
  assert.equal(noSec.sectorApplied, false, 'missing sector leg falls back to market-only and says so');
  assert.ok(Math.abs(noSec.residual - (fwd - mkt)) < 1e-12);

  const noBeta = S.residualOutcome({ candles: name, idx: 5, h: 5, bench: spy, benchIdx: 5, betas: {} });
  assert.equal(noBeta.residual, null, 'no frozen market beta = unobservable, never coerced');
  assert.equal(noBeta.reason, 'no-market-beta');

  const truncated = S.residualOutcome({ candles: name, idx: 18, h: 5, bench: spy, benchIdx: 18, betas });
  assert.ok(truncated.reason, 'a window past the end of the series is unobservable');
});

// ── per-date resolution ─────────────────────────────────────────────────────

test('resolveHorizon: better rank pairing with higher residual yields positive IC; the book channel stays descriptive', () => {
  const shard = [
    { ticker: 'AAA', eligible: true, primaryRank: 1, xsRank: 3 },
    { ticker: 'BBB', eligible: true, primaryRank: 2, xsRank: 2 },
    { ticker: 'CCC', eligible: true, primaryRank: 3, xsRank: 1 },
    { ticker: 'DDD', eligible: false, primaryRank: null, xsRank: null },  // ineligible: excluded from IC
  ];
  const outcomes = new Map([
    ['AAA', { residual: 0.03, raw: 0.05, reason: null }],
    ['BBB', { residual: 0.01, raw: 0.02, reason: null }],
    ['CCC', { residual: -0.02, raw: -0.01, reason: null }],
    ['DDD', { residual: 9, raw: 9, reason: null }],
  ]);
  const r = S.resolveHorizon(shard, outcomes, { book: ['AAA', 'BBB'], chargedCost: 0.005 });
  assert.equal(r.primaryIC, 1, 'primary ordering was perfectly right');
  assert.equal(r.xsIC, -1, 'served ordering was perfectly wrong');
  assert.equal(r.scored, 3);
  assert.equal(r.n, 3);
  assert.ok(Math.abs(r.book.grossMeanRaw - 0.035) < 1e-9);
  assert.ok(Math.abs(r.book.netMeanRaw - (0.035 - 0.005)) < 1e-9, 'charged cost and returns share the same fraction unit');
});

// ── route/wiring guards (source-level, matching the stbull template's test style) ──

const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('registration: ops routed, tick/resolve PRIVILEGED, chain in ROOT_CHAINS with two steps', () => {
  const tracker = read('api/tracker.js');
  for (const op of ['forecastshadow', 'forecastshadowtick', 'forecastshadowresolve']) {
    assert.ok(tracker.includes(`op === '${op}'`), `${op} must be routed`);
  }
  const priv = tracker.slice(tracker.indexOf('PRIVILEGED_OPS'), tracker.indexOf('])'));
  assert.match(priv, /'forecastshadowtick'/, 'tick writes the ledger — bearer only');
  assert.match(priv, /'forecastshadowresolve'/, 'resolve writes the ledger — bearer only');
  const WC = require('../lib/warm-chains');
  assert.ok(WC.ROOT_CHAINS.includes('forecastshadow'), 'dispatched as its own shallow root chain (the challengerlog chain-depth lesson)');
  assert.deepStrictEqual(WC.CHAINS.forecastshadow, ['op=forecastshadowtick', 'op=forecastshadowresolve']);
  assert.equal(WC.ROOT_CHAINS.filter((r) => r === 'forecastshadow').length, 1);
});

test('routes: fail-closed semantics — index via blobExists, write-once day docs, no partial-horizon days', () => {
  const src = read('lib/forecast-shadow-routes.js');
  assert.match(src, /blobExists\(INDEX_KEY\)/, 'index read must probe existence fail-closed');
  assert.match(src, /blobExists\(dayKey\(/, 'day doc must be write-once');
  assert.match(src, /re-indexed, not overwritten|re-indexed, never overwritten/i);
  assert.match(src, /All four horizons or nothing|all four horizons or nothing/i, 'a partial-horizon day would corrupt the FDR family');
  assert.match(src, /previous ledger day .* unreadable|prevDoc\)/s, 'carried-book baseline fails closed');
  assert.match(src, /isTradingDay/, 'trading-day gate');
  assert.match(src, /no-store/, 'ticks never cached');
});

test('routes: the resolver reads FROZEN betas from the shard and never recomputes them', () => {
  const src = read('lib/forecast-shadow-routes.js');
  assert.match(src, /betas: \{ betaMarket: r\.betaMarket, betaSector: r\.betaSector, betaSectorMarket: r\.betaSectorMarket \}/,
    'outcome betas come from the write-once shard row');
  assert.ok(!/trailingBetas/.test(src), 'recomputing betas at resolution time would leak the future into the ledger');
});

test('routes: provenance records the ordering field and the provider split', () => {
  const src = read('lib/forecast-shadow-routes.js');
  assert.match(src, /orderingField: 'expectedResidualReturn'/, 'the primary board must be the evidenced ridge point, not the unbenchmarked ridge-xs rankerScore');
  assert.match(src, /yahoo-live/, 'live provider recorded');
  assert.match(src, /2026-07-06/, 'benchmark data cutoff disclosed');
});

test('serving-mode universe: the latest session admits names (no entry bar demanded), training still requires it', () => {
  const F = require('../lib/forecast');
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ date: `d${String(i).padStart(3, '0')}`, open: 100, high: 101, low: 99, close: 100, volume: 5e6 }));
  const candles = mk(400);
  const entry = { candles, idx: new Map(candles.map((b, i) => [b.date, i])) };
  const cfg = F.config.resolveConfig({ universe: { minAvgDollarVolume: 1e5, minHistorySessions: 300 } });
  const last = candles[candles.length - 1].date;
  const serving = F.universe.eligibilityAt(entry, last, cfg, { requireEntryBar: false });
  const training = F.universe.eligibilityAt(entry, last, cfg, { requireEntryBar: true });
  assert.equal(serving.eligible, true, 'a serving caller must be able to score the latest session');
  assert.equal(training.eligible, false);
  assert.equal(training.reason, 'no-next-session-open', 'training keeps the tradability rule');
});

test('resolveHorizon drops unobservable outcomes instead of coercing them', () => {
  const shard = [
    { ticker: 'AAA', eligible: true, primaryRank: 1, xsRank: 1 },
    { ticker: 'BBB', eligible: true, primaryRank: 2, xsRank: 2 },
    { ticker: 'CCC', eligible: true, primaryRank: 3, xsRank: 3 },
  ];
  const outcomes = new Map([
    ['AAA', { residual: 0.03, raw: 0.05, reason: null }],
    ['BBB', { residual: null, raw: null, reason: 'truncated-history' }],
    ['CCC', { residual: -0.02, raw: -0.01, reason: null }],
  ]);
  const r = S.resolveHorizon(shard, outcomes, null);
  assert.equal(r.scored, 2);
  assert.equal(r.primaryIC, null, 'two points cannot support a rank correlation');
  assert.equal(r.book, null);
});
