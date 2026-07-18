'use strict';
const test = require('node:test');
const assert = require('node:assert');

const sources = require('../lib/decision-sources');
const routes = require('../lib/challenger-routes');
const evalLib = require('../lib/challenger-eval');
const { FEATURES } = require('../lib/challenger-rank');

// A realistic op=screener payload (fromScreener needs levels.entry>0 + status).
function screenerPayload() {
  return {
    results: [
      { ticker: 'AAA', company: 'Alpha', status: 'BUY', sector: 'Tech', price: 100, levels: { entry: 100, stop: 94, target: 112, rr: 2 }, quant: { score: 80 }, factors: { dollarVol: 1e8 } },
      { ticker: 'BBB', company: 'Beta', status: 'STRONG_BUY', sector: 'Energy', price: 50, levels: { entry: 50, stop: 47, target: 58, rr: 2 }, quant: { score: 65 }, factors: { dollarVol: 3e7 } },
    ],
  };
}

test('decision-sources: buildRankedSignals normalizes + ranks a real screener payload', () => {
  const { ranked, count } = sources.buildRankedSignals({ screener: screenerPayload() }, { regime: { label: 'neutral' } });
  assert.ok(count >= 1, 'should produce at least one ranked signal');
  const s = ranked[0];
  assert.ok(s.ticker && isFinite(s.score)); // enriched with a production composite score
  assert.ok(s.evidence && typeof s.evidence.familyCount === 'number');
});

test('challenger-routes: buildChallengerBoard produces a shadow board (cold start => NO_TRADE)', async () => {
  const fetchJSON = async (path) => {
    if (path.includes('op=today')) return { regime: { label: 'neutral' }, opportunity: { decision: 'selective', reasons: [] } };
    if (path.includes('/api/screener?scope=large')) return screenerPayload();
    return null;
  };
  const board = await routes.buildChallengerBoard(fetchJSON, { asOf: '2026-07-18' });
  assert.strictEqual(board.version, 'challenger-decision-v1');
  assert.strictEqual(board.shadow, true);
  assert.strictEqual(board.deploymentWeight, 0);
  assert.ok(['TRADE_AVAILABLE', 'NO_TRADE'].includes(board.boardDecision));
  assert.ok(board.decisions && Array.isArray(board.decisions.TRADE) && Array.isArray(board.decisions.WAIT) && Array.isArray(board.decisions.AVOID));
  // Cold start: no resolved survival history => zero TRADE, board explains itself.
  assert.strictEqual(board.counts.trade, 0);
  assert.strictEqual(board.boardDecision, 'NO_TRADE');
  assert.ok(board.noTradeCause && board.noTradeCause.cause);
});

test('challenger-routes: resolveBarrier detects target / stop / timeout / open (no leakage)', () => {
  const mk = (rows) => rows.map((r, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: r[0], high: r[1], low: r[2], close: r[3] }));
  // day 0 = entry bar; forward bars only (idx+1..) are inspected.
  const target = routes.resolveBarrier(mk([[100, 100, 100, 100], [100, 113, 99, 112], [100, 100, 100, 100]]), '2026-01-01', 100, 94, 112, 'long', 10);
  assert.strictEqual(target.barrier, 'upper');
  const stop = routes.resolveBarrier(mk([[100, 100, 100, 100], [100, 101, 93, 95], [100, 100, 100, 100]]), '2026-01-01', 100, 94, 112, 'long', 10);
  assert.strictEqual(stop.barrier, 'lower');
  // flat but window not yet elapsed => still open (null), never fabricated
  const flatShort = routes.resolveBarrier(mk([[100, 100, 100, 100], [100, 101, 99, 100]]), '2026-01-01', 100, 94, 112, 'long', 10);
  assert.strictEqual(flatShort, null);
  // flat and window fully elapsed => timeout
  const flatRows = Array.from({ length: 12 }, () => [100, 101, 99, 100]);
  const timeout = routes.resolveBarrier(mk(flatRows), '2026-01-01', 100, 94, 112, 'long', 10);
  assert.strictEqual(timeout.barrier, 'time');
});

// Deterministic resolved-prediction fixture where residualScore genuinely predicts outcome.
function fixture(n = 96) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const rs = 30 + (i * 37 % 70); // spread of residual scores 30..99
    const outcome = (rs - 60) * 0.08 + ((i % 5) - 2) * 0.2; // monotone-ish in rs, with noise
    const feats = {};
    for (const f of FEATURES) feats[f.key] = { norm: ((i * (f.key.length + 3)) % 100) / 100 };
    rows.push({
      predDate: `2025-${String((i % 8) + 1).padStart(2, '0')}-15`, ticker: `T${i}`, horizon: 'swing',
      decision: 'TRADE', residualScore: rs, outcome: +outcome.toFixed(3), won: outcome > 0,
      features: feats, regimeLabel: i % 3 === 0 ? 'risk-off' : 'neutral', capTier: 'large', eventType: 'news-catalyst',
      baselineProd: 50 + (i % 40), baselineMomentum: rs - 5, baselineOmega: null,
    });
  }
  return rows;
}

test('challenger-eval: evaluate returns the full validation battery without throwing', () => {
  const ev = evalLib.evaluate(fixture(), { now: '2026-07-18' });
  assert.strictEqual(ev.version, 'challenger-eval-v1');
  assert.ok(ev.ic && typeof ev.ic.ic === 'number');
  assert.ok(ev.ic.ic > 0, 'residualScore should positively predict outcome in the fixture');
  assert.ok(ev.walkForward && Array.isArray(ev.walkForward.blocks));
  assert.ok(ev.netExpectancy && ev.netExpectancy.ci && 'lo' in ev.netExpectancy.ci);
  assert.ok(ev.byRegime && ev.leaveOneYearOut && ev.leaveLargestWinnersOut);
  assert.ok(ev.trainedShadow && 'beatsBaseline' in ev.trainedShadow);
  assert.ok(ev.baselines && ev.baselines.prod && ev.baselines.random);
});

test('challenger-eval: promotionCheck reports strict criteria, never auto-promotes on first pass', () => {
  const ev = evalLib.evaluate(fixture(), { now: '2026-07-18' });
  const promo = evalLib.promotionCheck(ev, {}); // no live-forward record supplied
  assert.strictEqual(promo.criteria.length, 10);
  assert.ok(promo.criteria.every((c) => typeof c.pass === 'boolean'));
  assert.strictEqual(typeof promo.promotable, 'boolean');
  // With no live-forward evidence, the live-shadow criterion must fail => not promotable.
  assert.ok(!promo.criteria.find((c) => /live-forward/.test(c.name)).pass);
  assert.notStrictEqual(promo.recommendedStatus, 'production'); // never straight to production
});

test('challenger-eval: empty input degrades gracefully (not-ready, not a crash)', () => {
  const ev = evalLib.evaluate([], {});
  assert.strictEqual(ev.n, 0);
  assert.ok(ev.rankQuality && ev.rankQuality.ready === false);
  const promo = evalLib.promotionCheck(ev, {});
  assert.strictEqual(promo.promotable, false);
});

test('challenger-eval: ridgeFit is deterministic', () => {
  const X = [[1, 0], [0, 1], [1, 1], [0.5, 0.5]];
  const y = [1, 2, 3, 1.5];
  assert.deepStrictEqual(evalLib.ridgeFit(X, y, 1), evalLib.ridgeFit(X, y, 1));
});
