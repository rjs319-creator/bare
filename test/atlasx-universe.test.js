'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildUniverse, capGroupFor } = require('../lib/atlasx-universe');
const { candidatesToSignals, isEpisodeCandidate, buildAtlasEpisodes } = require('../lib/atlasx-episodes');

function mkCandles(n, base, drift = 1.005) {
  const out = []; let c = base;
  const d = new Date(Date.UTC(2024, 0, 2));
  for (let i = 0; i < n; i++) {
    c *= drift;
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    out.push([d.toISOString().slice(0, 10), c, c * 1.01, c * 0.99, c, 1_000_000, c]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function doc(map, updatedAt = 0, builtDate = '2024-02-01') {
  const data = {};
  for (const [t, c] of Object.entries(map)) data[t] = { m: [t, t + ' Inc', 'NMS'], c };
  return { updatedAt, builtDate, n: Object.keys(data).length, data };
}

test('universe: unions current + episodes + near-miss, bounded & deterministic', () => {
  const d = doc({ AAA: mkCandles(40, 10), BBB: mkCandles(40, 20, 1.01), CCC: mkCandles(40, 5, 1.008) });
  const today = { horizons: { swing: [{ ticker: 'AAA', sector: 'Tech', score: 80, rank: 1, price: 12 }] } };
  const u1 = buildUniverse({ todayData: today, prevEpisodes: [], candleDocs: { large: d }, opts: { nowMs: 0 } });
  const u2 = buildUniverse({ todayData: today, prevEpisodes: [], candleDocs: { large: d }, opts: { nowMs: 0 } });
  assert.deepEqual(u1.evalTickers, u2.evalTickers, 'deterministic');
  assert.ok(u1.evalTickers.includes('AAA'), 'current candidate included');
  assert.ok(u1.sources.nearMiss.length > 0, 'near-miss drawn from cache pool');
  assert.ok(!u1.sources.nearMiss.includes('AAA'), 'near-miss excludes already-selected');
});

test('universe: honest coverage — no cache means NOT a full-market scan', () => {
  const today = { horizons: { swing: [{ ticker: 'AAA', sector: 'Tech', score: 80, rank: 1, price: 12 }] } };
  const u = buildUniverse({ todayData: today, prevEpisodes: [], candleDocs: {}, opts: {} });
  assert.equal(u.coverage.universeSize, 0);
  assert.match(u.coverage.note, /NOT a full-market scan/);
  assert.ok(u.coverage.scopesMissing.length > 0);
  assert.equal(u.coverage.partial, true);
});

test('universe: stale scope is disclosed, not hidden', () => {
  const d = doc({ AAA: mkCandles(40, 10), BBB: mkCandles(40, 20) }, 1); // updatedAt=1ms, now huge → stale
  const today = { horizons: { swing: [] } };
  const u = buildUniverse({ todayData: today, prevEpisodes: [], candleDocs: { large: d }, opts: { nowMs: 1e13 } });
  assert.ok(u.coverage.scopesStale.includes('large'));
  assert.equal(u.coverage.partial, true);
});

test('universe: cap bounds the evaluation set', () => {
  const map = {};
  for (let i = 0; i < 50; i++) map['T' + i] = mkCandles(40, 10 + i, 1.006);
  const today = { horizons: { swing: [] } };
  const u = buildUniverse({ todayData: today, prevEpisodes: [], candleDocs: { large: doc(map) }, opts: { cap: 10, nowMs: 0 } });
  assert.ok(u.evalTickers.length <= 10, 'respects cap');
  assert.equal(u.coverage.evaluable, u.evalTickers.length);
});

test('capGroupFor buckets by dollar volume', () => {
  assert.equal(capGroupFor(200e6), 'large');
  assert.equal(capGroupFor(30e6), 'mid');
  assert.equal(capGroupFor(5e6), 'small');
  assert.equal(capGroupFor(500e3), 'micro');
  assert.equal(capGroupFor(null), 'unknown');
});

// ── episode adapter ─────────────────────────────────────────────────────────
test('episodes: only ENTER/WAIT_* candidates become episodes; AVOID/NO_TRADE excluded', () => {
  assert.equal(isEpisodeCandidate({ entry: { action: 'ENTER_NEXT_OPEN' } }), true);
  assert.equal(isEpisodeCandidate({ entry: { action: 'WAIT_PULLBACK' } }), true);
  assert.equal(isEpisodeCandidate({ entry: { action: 'AVOID' } }), false);
  assert.equal(isEpisodeCandidate({ entry: { action: 'NO_TRADE' } }), false);
  assert.equal(isEpisodeCandidate({ entry: { action: 'DO_NOT_CHASE' } }), false);
});

test('episodes: candidate→signal maps expert to strategyFamily and stamps atlasx source', () => {
  const c = {
    ticker: 'AAA', side: 'long', price: 12, sector: 'Tech', sectorEtf: 'XLK',
    router: { selectedExpert: 'firstPullback' }, contributingExperts: ['breakoutContinuation'],
    entry: { action: 'ENTER_NEXT_OPEN', entryPrice: 12, invalidation: 11, target: 14, remainingRR: 2 },
    distribution: { p10: 0, median: 0.03, p90: 0.06 }, score: 0.03,
    prosecutor: { failureModes: [{ mode: 'gap-dependence' }], failureScore: 0.2 },
  };
  const [sig] = candidatesToSignals([c]);
  assert.equal(sig.source, 'atlasx');
  assert.equal(sig.strategyFamily, 'firstPullback');
  assert.equal(sig.side, 'long');
  assert.equal(sig.stop, 11);
  assert.ok(sig.sources.includes('breakoutContinuation'));
  assert.deepEqual(sig.risks, ['gap-dependence']);
});

test('episodes: long and short of the same ticker are distinct signals', () => {
  const base = (side) => ({ ticker: 'AAA', side, price: 12, entry: { action: 'ENTER_NEXT_OPEN', entryPrice: 12, invalidation: side === 'long' ? 11 : 13, target: side === 'long' ? 14 : 10 } });
  const sigs = candidatesToSignals([base('long'), base('short')]);
  assert.equal(sigs.length, 2);
  assert.notEqual(sigs[0].side, sigs[1].side);
});

test('episodes: buildAtlasEpisodes folds a fresh candidate through the shared supervisor', () => {
  const candles = mkCandles(60, 10).map(([date, o, h, l, cl, v, adj]) => ({ date, open: o, high: h, low: l, close: cl, volume: v, adjClose: adj }));
  const lastDate = candles[candles.length - 1].date;
  const cand = { ticker: 'AAA', side: 'long', price: candles[candles.length - 1].close, sector: 'Tech',
    router: { selectedExpert: 'compressionRelease' },
    entry: { action: 'ENTER_NEXT_OPEN', entryPrice: candles[candles.length - 1].close, invalidation: candles[candles.length - 1].close * 0.95, target: candles[candles.length - 1].close * 1.1, remainingRR: 2 } };
  const priceBundle = { map: { AAA: candles }, bench: { SPY: candles } };
  const ctx = { date: lastDate, generatedAt: '2024-03-01T00:00:00Z', regime: 'neutral', regimeRiskOff: false, isHoliday: () => false, cooldownSessions: 3 };
  const result = buildAtlasEpisodes({ prevEpisodes: [], candidates: [cand], priceBundle, ctx });
  assert.ok(result.episodes.length >= 1, 'produced an episode');
  const ep = result.episodes.find(e => e.origin.ticker === 'AAA');
  assert.ok(ep, 'AAA episode exists');
  assert.equal(ep.origin.sourceStrategy, 'atlasx');
  assert.equal(ep.origin.strategyFamily, 'compressionRelease');
});
