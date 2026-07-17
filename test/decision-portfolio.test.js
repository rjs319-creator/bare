const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/decision-portfolio');

// Minimal ranked-signal shape — what rankSignals() emits, only the fields the
// portfolio layer reads.
let seq = 0;
const sig = (o = {}) => ({
  id: o.ticker + ':' + (o.horizon || 'swing') + ':' + (seq++),
  ticker: o.ticker, horizon: o.horizon || 'swing', side: o.side || 'long',
  sector: 'sector' in o ? o.sector : 'Tech',
  strategyFamily: o.strategyFamily || 'trend',
  score: o.score ?? 80,
  liquidity: o.liquidity === undefined ? { dollarVol: 5e8 } : o.liquidity,
  cost: o.cost === undefined ? { known: true, netMovePct: 9.8, penalty: 0.99 } : o.cost,
  evidence: o.evidence || null,
});

test('selects the top N when nothing violates a constraint', () => {
  const ranked = [sig({ ticker: 'A', sector: 'Tech' }), sig({ ticker: 'B', sector: 'Energy' }),
    sig({ ticker: 'C', sector: 'Health' })];
  const p = P.buildPortfolio(ranked, { size: 10 });
  assert.strictEqual(p.selected.length, 3);
  assert.strictEqual(p.excluded.length, 0);
});

test('respects the target size and excludes the overflow honestly', () => {
  const ranked = ['A', 'B', 'C', 'D'].map((t, i) => sig({ ticker: t, sector: 'S' + i, score: 90 - i }));
  const p = P.buildPortfolio(ranked, { size: 2 });
  assert.deepStrictEqual(p.selected.map(s => s.ticker), ['A', 'B']);
  assert.strictEqual(p.excluded.length, 2);
  assert.strictEqual(p.excluded[0].reason, 'size');
});

// ── sector concentration ────────────────────────────────────────────────────
test('SECTOR CAP: a high scorer is excluded once its sector is full', () => {
  const ranked = ['A', 'B', 'C', 'D'].map((t, i) => sig({ ticker: t, sector: 'Tech', score: 90 - i }));
  const p = P.buildPortfolio(ranked, { size: 10, maxPerSector: 2 });
  assert.deepStrictEqual(p.selected.map(s => s.ticker), ['A', 'B']);
  assert.strictEqual(p.excluded.length, 2);
  const ex = p.excluded[0];
  assert.strictEqual(ex.reason, 'sector-cap');
  assert.strictEqual(ex.ticker, 'C');
  // The spec requires the reason to name WHO blocked it, not just that it was blocked.
  assert.deepStrictEqual(ex.blockedBy, ['A', 'B']);
  assert.ok(/Tech/.test(ex.detail), 'detail should name the sector');
});

test('SECTOR CAP: an UNKNOWN sector is never capped (unknown is not a violation)', () => {
  const ranked = ['A', 'B', 'C'].map(t => sig({ ticker: t, sector: null }));
  const p = P.buildPortfolio(ranked, { size: 10, maxPerSector: 1 });
  assert.strictEqual(p.selected.length, 3, 'a missing sector must not bury a name');
});

// Regression: the live feed emits a literal '?' for an unknown sector, so two unrelated
// names were capped against each other as though "?" were a sector. Whether unknown means
// null or '?' is an upstream accident and must not change the decision.
test('SECTOR CAP: a PLACEHOLDER sector is unknown, not a sector called "?"', () => {
  for (const placeholder of ['?', '', '  ', 'N/A', 'Unknown', '-']) {
    const ranked = ['A', 'B', 'C'].map(t => sig({ ticker: t, sector: placeholder }));
    const p = P.buildPortfolio(ranked, { size: 10, maxPerSector: 1 });
    assert.strictEqual(p.selected.length, 3, `sector "${placeholder}" must be treated as unknown`);
    assert.deepStrictEqual(p.exposure, {}, `sector "${placeholder}" must not appear as exposure`);
  }
});

test('SECTOR CAP: a real sector is still capped, and whitespace does not fork the bucket', () => {
  const ranked = [sig({ ticker: 'A', sector: 'Tech' }), sig({ ticker: 'B', sector: ' Tech ' })];
  const p = P.buildPortfolio(ranked, { size: 10, maxPerSector: 1 });
  assert.strictEqual(p.selected.length, 1, '" Tech " and "Tech" are one sector');
});

// ── duplicate underlying ────────────────────────────────────────────────────
test('DUPLICATE: the same ticker at a second horizon is excluded, stronger one kept', () => {
  const ranked = [sig({ ticker: 'AAPL', horizon: 'swing', score: 90 }),
    sig({ ticker: 'AAPL', horizon: 'intraday', score: 70 })];
  const p = P.buildPortfolio(ranked, { size: 10 });
  assert.strictEqual(p.selected.length, 1);
  assert.strictEqual(p.selected[0].horizon, 'swing');
  assert.strictEqual(p.excluded[0].reason, 'duplicate-underlying');
  assert.deepStrictEqual(p.excluded[0].blockedBy, ['AAPL']);
});

// ── liquidity ───────────────────────────────────────────────────────────────
test('LIQUIDITY: a name below the tradeable floor is excluded with its number', () => {
  const ranked = [sig({ ticker: 'THIN', score: 99, liquidity: { dollarVol: 1e5 } })];
  const p = P.buildPortfolio(ranked, { size: 10, minDollarVol: 2e6 });
  assert.strictEqual(p.selected.length, 0);
  assert.strictEqual(p.excluded[0].reason, 'liquidity');
  assert.ok(/\$/.test(p.excluded[0].detail), 'detail should quote the measured dollar-volume');
});

test('LIQUIDITY: UNKNOWN dollar-volume is not excluded (missing feed ≠ illiquid)', () => {
  const ranked = [sig({ ticker: 'NOFEED', liquidity: { price: 30 } })];
  const p = P.buildPortfolio(ranked, { size: 10, minDollarVol: 2e6 });
  assert.strictEqual(p.selected.length, 1);
});

// ── net expected value ──────────────────────────────────────────────────────
test('NET EV: a trade whose costs exceed its target move is excluded', () => {
  const ranked = [sig({ ticker: 'DOA', score: 95, cost: { known: true, netMovePct: -0.4, penalty: 0.5 } })];
  const p = P.buildPortfolio(ranked, { size: 10 });
  assert.strictEqual(p.excluded[0].reason, 'net-ev');
  assert.ok(/-0.4/.test(p.excluded[0].detail));
});

test('NET EV: an UNKNOWN net (no target) is not excluded', () => {
  const ranked = [sig({ ticker: 'LEAD', cost: { known: false, netMovePct: null, penalty: 1 } })];
  const p = P.buildPortfolio(ranked, { size: 10 });
  assert.strictEqual(p.selected.length, 1);
});

// ── strategy-family concentration ───────────────────────────────────────────
test('FAMILY CAP: one strategy archetype cannot own the whole book', () => {
  const ranked = ['A', 'B', 'C'].map((t, i) =>
    sig({ ticker: t, sector: 'S' + i, strategyFamily: 'trend', score: 90 - i }));
  const p = P.buildPortfolio(ranked, { size: 10, maxPerFamily: 2 });
  assert.strictEqual(p.selected.length, 2);
  assert.strictEqual(p.excluded[0].reason, 'family-cap');
});

// ── contract / reporting ────────────────────────────────────────────────────
test('every exclusion carries a reason, a human label, and a detail', () => {
  const ranked = ['A', 'B', 'C'].map((t, i) => sig({ ticker: t, sector: 'Tech', score: 90 - i }));
  const p = P.buildPortfolio(ranked, { size: 10, maxPerSector: 1 });
  for (const e of p.excluded) {
    assert.ok(e.reason && P.EXCLUSION_LABEL[e.reason], `unlabelled reason: ${e.reason}`);
    assert.ok(typeof e.detail === 'string' && e.detail.length > 0);
    assert.ok(Number.isFinite(e.score), 'an excluded name keeps its score — it was strong, just not additive');
  }
});

test('selection order follows the incoming rank, and stamps a portfolio rank', () => {
  const ranked = ['A', 'B', 'C'].map((t, i) => sig({ ticker: t, sector: 'S' + i, score: 90 - i }));
  const p = P.buildPortfolio(ranked, { size: 10 });
  assert.deepStrictEqual(p.selected.map(s => s.portfolioRank), [1, 2, 3]);
});

test('reports the caps it applied so the UI never has to guess them', () => {
  const p = P.buildPortfolio([], { size: 7, maxPerSector: 2 });
  assert.strictEqual(p.caps.size, 7);
  assert.strictEqual(p.caps.maxPerSector, 2);
  assert.ok(p.method);
});

test('sector exposure is reported for the selected book', () => {
  const ranked = [sig({ ticker: 'A', sector: 'Tech' }), sig({ ticker: 'B', sector: 'Tech' }),
    sig({ ticker: 'C', sector: 'Energy' })];
  const p = P.buildPortfolio(ranked, { size: 10 });
  assert.strictEqual(p.exposure.Tech, 2);
  assert.strictEqual(p.exposure.Energy, 1);
});

test('empty in → empty out, never throws', () => {
  const p = P.buildPortfolio(null, {});
  assert.deepStrictEqual(p.selected, []);
  assert.deepStrictEqual(p.excluded, []);
});

// ── no forced quota ─────────────────────────────────────────────────────────
// Regression guard for a real defect seen on the live board: sector/family caps pushed
// down the list and back-filled slot 10 with a composite-3.6 name. A cap must be able to
// SHRINK the book, never to drag junk into it.
test('QUOTA: caps leave slots EMPTY rather than back-filling with junk', () => {
  const ranked = [
    sig({ ticker: 'A', sector: 'Tech', score: 95 }),
    sig({ ticker: 'B', sector: 'Tech', score: 94 }),
    sig({ ticker: 'C', sector: 'Tech', score: 93 }), // capped out
    sig({ ticker: 'JUNK', sector: 'Energy', score: 4 }),  // would back-fill without a floor
  ];
  const p = P.buildPortfolio(ranked, { size: 10, maxPerSector: 2 });
  assert.deepStrictEqual(p.selected.map(s => s.ticker), ['A', 'B'], 'junk must not be promoted');
  assert.strictEqual(p.unfilled, 8, 'the book honestly reports it is under size');
  const junk = p.excluded.find(e => e.ticker === 'JUNK');
  assert.strictEqual(junk.reason, 'quality-floor');
});

test('QUOTA: the quality floor is configurable and reported', () => {
  const ranked = [sig({ ticker: 'MID', score: 55 })];
  assert.strictEqual(P.buildPortfolio(ranked, { minScore: 50 }).selected.length, 1);
  assert.strictEqual(P.buildPortfolio(ranked, { minScore: 60 }).selected.length, 0);
  assert.strictEqual(P.buildPortfolio(ranked, { minScore: 60 }).caps.minScore, 60);
});

test('CONTEXT: sector-context rows never occupy a position slot', () => {
  const ranked = [sig({ ticker: 'MPC', strategyFamily: 'context', score: 99 })];
  const p = P.buildPortfolio(ranked, { size: 10 });
  assert.strictEqual(p.selected.length, 0, 'you cannot hold "the tape is strong"');
  assert.strictEqual(p.excluded[0].reason, 'not-a-position');
});
