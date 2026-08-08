const test = require('node:test');
const assert = require('node:assert');
const anomaly = require('../lib/options-anomaly-v2');
const { observeTicker } = require('../lib/options-observe-v2');
const cfg = require('../lib/options-config-v2');

const DAY = 86400;
const nowMs = Date.parse('2026-08-06T21:30:00Z');
const nowSec = nowMs / 1000;

function chain(expDte, { callVol = 100, putVol = 100, oi = 500, last = 2, bid = 1.9, ask = 2.1, strikes = [100, 105], iv = 0.5 } = {}) {
  const expiration = Math.floor(nowSec + expDte * DAY);
  const mk = (strike, side, vol) => ({
    contractSymbol: `T${expDte}${side}${strike}`, strike, expiration,
    bid, ask, lastPrice: last, volume: vol, openInterest: oi,
    impliedVolatility: iv, lastTradeDate: Math.floor(nowSec - 3600),
  });
  return {
    expirationDate: expiration,
    calls: strikes.map(s => mk(s, 'C', callVol)),
    puts: strikes.map(s => mk(s, 'P', putVol)),
  };
}
function result(chains, { price = 100, vol = 5e6 } = {}) {
  return { quote: { regularMarketPrice: price, regularMarketVolume: vol, regularMarketTime: nowSec, exchangeDataDelayedBy: 15 }, options: chains, expirationDates: chains.map(c => c.expirationDate) };
}
function historyDays(n, chainOpts = {}) {
  const days = [];
  for (let d = n; d >= 1; d--) {
    const session = new Date((nowSec - d * DAY) * 1000).toISOString().slice(0, 10);
    const obs = observeTicker('TST', result([chain(5, chainOpts), chain(32, chainOpts)]), { nowMs: nowMs - d * DAY * 1000, session, sessionFraction: 1 });
    days.push({ date: session, session, tickers: { TST: obs } });
  }
  return days;
}
const TODAY = '2026-08-06';

test('robust stats: winsorization + MAD, midrank percentile handles constant series', () => {
  const s = anomaly.robustStats([10, 10, 10, 10, 10, 10, 10, 10]);
  assert.strictEqual(s.median, 10);
  // A value equal to a constant baseline reads ~50th percentile, never 100th.
  const p = anomaly.percentileOf(10, s);
  assert.ok(p >= 45 && p <= 55, `midrank percentile of tie = ${p}`);
  assert.ok(anomaly.percentileOf(11, s) === 100);
  // Bounded robust z even when MAD is 0.
  const z = anomaly.robustZ(1e9, s);
  assert.ok(Number.isFinite(z) && z <= 10);
});

test('STRESS: 100x vol/OI spike with SMALL absolute premium qualifies on the relative door', () => {
  const hist = historyDays(12, { callVol: 20, putVol: 20, oi: 2000, last: 0.3, bid: 0.28, ask: 0.32 });
  const base = anomaly.buildBaselines(hist, { beforeSession: TODAY }).tickers.get('TST');
  // Today: tiny prices (small notional) but 100x the volume on thin OI.
  const spike = observeTicker('TST', result([chain(5, { callVol: 3000, putVol: 60, oi: 30, last: 0.32, bid: 0.28, ask: 0.32 }), chain(32, { callVol: 2500, putVol: 50, oi: 25, last: 0.32, bid: 0.28, ask: 0.32 })]), { nowMs, session: TODAY, sessionFraction: 1 });
  const a = anomaly.scoreTicker(spike, base);
  assert.ok(a.features.totalNotional < 1_000_000, `premium is small (${a.features.totalNotional})`);
  assert.notStrictEqual(a.activityStatus, cfg.ACTIVITY_STATUS.NORMAL, `relative spike must qualify (got ${a.activityStatus}, score ${a.anomalyScore})`);
  assert.ok(a.anomalyPercentile >= 90);
});

test('STRESS: multimillion-dollar activity with WEAK relative volume is not called highly unusual', () => {
  // History: this name ALWAYS trades huge option volume (a mega-cap profile).
  const big = { callVol: 50_000, putVol: 40_000, oi: 200_000, last: 5, bid: 4.9, ask: 5.1 };
  const hist = historyDays(12, big);
  const base = anomaly.buildBaselines(hist, { beforeSession: TODAY }).tickers.get('TST');
  const today = observeTicker('TST', result([chain(5, big), chain(32, big)]), { nowMs, session: TODAY, sessionFraction: 1 });
  const a = anomaly.scoreTicker(today, base);
  assert.ok(a.features.totalNotional > 5_000_000, 'absolutely large');
  // Relative read is ordinary → never HIGHLY_UNUSUAL/EXCEPTIONAL; the absolute door
  // may admit it as plain UNUSUAL, and the size lives in absoluteSizeTier.
  assert.ok(![cfg.ACTIVITY_STATUS.HIGHLY_UNUSUAL, cfg.ACTIVITY_STATUS.EXCEPTIONAL].includes(a.activityStatus),
    `big-but-normal must not be highly unusual (got ${a.activityStatus})`);
  assert.ok(['exceptional', 'very-large'].includes(a.absoluteSizeTier));
});

test('immature baseline: relative door closed, warning attached, absolute door still works', () => {
  const hist = historyDays(3);   // below minBaselineSessions
  const base = anomaly.buildBaselines(hist, { beforeSession: TODAY }).tickers.get('TST');
  const spike = observeTicker('TST', result([chain(5, { callVol: 9000, oi: 100, last: 8, bid: 7.9, ask: 8.1 }), chain(32, { callVol: 8000, oi: 100, last: 8, bid: 7.9, ask: 8.1 })]), { nowMs, session: TODAY, sessionFraction: 1 });
  const a = anomaly.scoreTicker(spike, base);
  assert.strictEqual(a.baselineScored, false);
  assert.ok(a.warnings.some(w => /baseline immature/i.test(w)));
  // Huge notional (very-large tier) + good quality → admitted via the absolute door.
  assert.notStrictEqual(a.activityStatus, cfg.ACTIVITY_STATUS.NORMAL);
});

test('baselines are point-in-time: the scored session is excluded even if present in history', () => {
  const hist = historyDays(10);
  const todayObs = observeTicker('TST', result([chain(5, { callVol: 99_999 })]), { nowMs, session: TODAY, sessionFraction: 1 });
  const withToday = [...hist, { date: TODAY, session: TODAY, tickers: { TST: todayObs } }];
  const b1 = anomaly.buildBaselines(withToday, { beforeSession: TODAY });
  const b2 = anomaly.buildBaselines(hist, { beforeSession: TODAY });
  assert.strictEqual(b1.tickers.get('TST').sessions, b2.tickers.get('TST').sessions, 'today must not leak into its own baseline');
});

test('data quality is a SEPARATE gate: unusual + low quality = UNUSUAL_LOW_QUALITY, score unchanged', () => {
  const hist = historyDays(12, { callVol: 20, putVol: 20 });
  const base = anomaly.buildBaselines(hist, { beforeSession: TODAY }).tickers.get('TST');
  // Spike with NO usable quotes (bid/ask missing) → low data quality.
  const noQuotes = { callVol: 4000, putVol: 50, oi: 40, last: 0.5, bid: null, ask: null };
  const spike = observeTicker('TST', result([chain(5, noQuotes), chain(32, noQuotes)]), { nowMs: nowMs, session: TODAY, sessionFraction: 0.2 });
  const a = anomaly.scoreTicker(spike, base);
  assert.ok(a.dataQuality < cfg.ANOMALY_CONFIG.minDataQuality, `dq=${a.dataQuality}`);
  if (a.anomalyScore >= cfg.ANOMALY_CONFIG.thresholds.unusual) {
    assert.strictEqual(a.activityStatus, cfg.ACTIVITY_STATUS.UNUSUAL_LOW_QUALITY);
  }
});

test('RANKING FAIRNESS: per-ticker retention caps hundreds of qualifying contracts at the configured max', () => {
  const contracts = [];
  for (let i = 0; i < 300; i++) {
    contracts.push({ contractSymbol: `HOG${i}`, side: i % 2 ? 'call' : 'put', strike: 100 + i, expiry: '2026-09-18', dte: 40, bid: 1, ask: 1.1, lastPrice: 1.05, volume: 500 + i, openInterest: 10, estNotional: 100_000 + i * 1000, underlying: 100 });
  }
  const kept = anomaly.rankContractsWithinTicker(contracts);
  assert.strictEqual(kept.length, cfg.RANKING.maxContractsPerTicker);
  // And they are the best-scored ones, not arbitrary.
  assert.ok(kept.every(k => k.contractScore >= kept[kept.length - 1].contractScore));
});

test('challenger scores are computed alongside the champion (shadow, never replacing it)', () => {
  const hist = historyDays(12, { callVol: 20, putVol: 20 });
  const base = anomaly.buildBaselines(hist, { beforeSession: TODAY }).tickers.get('TST');
  const spike = observeTicker('TST', result([chain(5, { callVol: 3000, oi: 30 })]), { nowMs, session: TODAY, sessionFraction: 1 });
  const a = anomaly.scoreTicker(spike, base);
  assert.ok(Array.isArray(a.challengerScores) && a.challengerScores.length >= 2);
  for (const c of a.challengerScores) assert.ok(typeof c.id === 'string');
  assert.strictEqual(a.configId, cfg.ANOMALY_CONFIG.id);
});

test('anomaly output never claims probability language', () => {
  const hist = historyDays(12);
  const base = anomaly.buildBaselines(hist, { beforeSession: TODAY }).tickers.get('TST');
  const spike = observeTicker('TST', result([chain(5, { callVol: 5000, oi: 50 })]), { nowMs, session: TODAY, sessionFraction: 1 });
  const a = anomaly.scoreTicker(spike, base);
  const text = JSON.stringify(a.reasons) + JSON.stringify(a.warnings);
  assert.doesNotMatch(text, /probability|likely to rise|chance of/i);
});
