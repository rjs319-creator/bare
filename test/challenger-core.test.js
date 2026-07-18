'use strict';
const test = require('node:test');
const assert = require('node:assert');

const rank = require('../lib/challenger-rank');
const surv = require('../lib/challenger-survival');
const events = require('../lib/challenger-events');
const decision = require('../lib/challenger-decision');

// A signal shaped like decision.rankSignals output (the shared enriched-signal contract).
function mkSig(o = {}) {
  return {
    id: o.id || `screener:swing:${o.ticker || 'AAA'}`,
    ticker: o.ticker || 'AAA',
    company: o.company || null,
    source: o.source || 'screener',
    section: o.section || 'screener',
    horizon: o.horizon || 'swing',
    side: o.side || 'long',
    strategyFamily: o.strategyFamily || 'trend',
    state: o.state || 'ready',
    ageBars: o.ageBars != null ? o.ageBars : 1,
    price: o.price != null ? o.price : 100,
    entry: o.entry != null ? o.entry : 100,
    stop: o.stop != null ? o.stop : 94,
    target: o.target != null ? o.target : 112,
    rr: o.rr != null ? o.rr : 2,
    percentile: o.percentile != null ? o.percentile : 80,
    rawConfidence: o.rawConfidence != null ? o.rawConfidence : 70,
    evidence: o.evidence || { familyCount: 3, families: ['priceTrend', 'volumeAccum', 'fundamentalsRevisions'], singleFamily: false },
    expectancy: o.expectancy || { known: true, n: 20, winRate: 55, avgExcess: 1.2 },
    expectancyTilt: o.expectancyTilt || { tilt: 1.1, shrink: 0.7 },
    remainingEdge: o.remainingEdge || { rated: true, mult: 0.8, netRemainingPct: 6, realizedMovePct: 1, consumedPct: 10, extensionR: 0.3, freshness: 'fresh' },
    execution: o.execution || { quality: 0.9, penalties: [] },
    cost: o.cost || { known: true, costShare: 0.1, netMovePct: 6, penalty: 0.9 },
    regimeFit: o.regimeFit != null ? o.regimeFit : 0.85,
    liquidity: o.liquidity || { dollarVol: 1e8 },
    sectorStrength: o.sectorStrength != null ? o.sectorStrength : 0.2,
    event: o.event || null,
  };
}

// Build a mature survival cell for the swing|trend|neutral|large|ready|news-catalyst key.
function matureTable(ticker = 'AAA') {
  const parts = ['swing', 'trend', 'neutral', 'large', 'ready', 'news-catalyst'];
  const evs = [];
  for (let i = 0; i < 20; i++) {
    const barrier = i < 14 ? 'upper' : i < 18 ? 'lower' : 'time';
    evs.push({ keyParts: parts, barrier, barsToBarrier: 6, ticker });
  }
  return surv.buildSurvivalTable(evs);
}

// ---------------------------------------------------------------------------
test('rank: cross-sectional percentile ranks are scale-free and ordered', () => {
  assert.deepStrictEqual(rank.percentileRanks([10, 20, 30]), [0, 0.5, 1]);
  assert.deepStrictEqual(rank.percentileRanks([5, 5, 5]), [0.5, 0.5, 0.5]); // ties share avg rank
  const r = rank.percentileRanks([1, null, 3]);
  assert.strictEqual(r[1], null); // nulls stay null, never fabricated
});

test('rank: stronger candidate gets higher residual; weaker lower; inputs not mutated', () => {
  const strong = mkSig({ ticker: 'STRONG', percentile: 95, rawConfidence: 90 });
  const weak = mkSig({ ticker: 'WEAK', percentile: 20, rawConfidence: 30, remainingEdge: { rated: true, mult: 0.2, netRemainingPct: 0.5, consumedPct: 60, extensionR: 0.1, freshness: 'partially-consumed' } });
  const before = JSON.stringify(strong);
  const out = rank.rankCrossSection([strong, weak], { asOf: '2026-07-18' });
  const s = out.find((x) => x.ticker === 'STRONG').challengerRank;
  const w = out.find((x) => x.ticker === 'WEAK').challengerRank;
  assert.ok(s.residualScore > w.residualScore);
  assert.strictEqual(s.modelVersion, 'challenger-rank-v1');
  assert.strictEqual(s.isPrediction, true); // labeled as prediction, not validated probability
  assert.strictEqual(before, JSON.stringify(strong)); // no mutation
});

test('rank: missing feature is flagged, not fabricated', () => {
  const sig = mkSig({ ticker: 'NOFAIL' });
  sig.liquidity = null; // truly absent
  const [out] = rank.rankCrossSection([sig], { asOf: '2026-07-18' });
  assert.ok(out.challengerRank.missingFlags.includes('liquidity'));
  assert.strictEqual(out.challengerRank.features.liquidity.raw, null);
});

test('rank: deterministic', () => {
  const a = rank.rankCrossSection([mkSig({ ticker: 'A' }), mkSig({ ticker: 'B', percentile: 40 })], { asOf: 'd' });
  const b = rank.rankCrossSection([mkSig({ ticker: 'A' }), mkSig({ ticker: 'B', percentile: 40 })], { asOf: 'd' });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

// ---------------------------------------------------------------------------
test('survival: competing-risk probabilities sum to 1', () => {
  const table = matureTable();
  const out = surv.assessSurvival(mkSig(), { table, regime: { label: 'neutral' } });
  const s = out.pTargetBeforeStop + out.pStopBeforeTarget + out.pNeither;
  assert.ok(Math.abs(s - 1) < 1e-6);
});

test('survival: tiny subgroup shrinks toward prior, never extreme', () => {
  // one lopsided observation must NOT yield p≈1
  const table = surv.buildSurvivalTable([{ keyParts: ['swing', 'trend', 'neutral', 'large', 'ready', 'news-catalyst'], barrier: 'upper', barsToBarrier: 5 }]);
  const out = surv.assessSurvival(mkSig(), { table, regime: { label: 'neutral' } });
  assert.ok(out.pTargetBeforeStop < 0.75, `expected shrinkage, got ${out.pTargetBeforeStop}`);
  assert.ok(out.pTargetBeforeStop > surv.DEFAULT_PRIOR.pTarget); // moved toward observation but not all the way
});

test('survival: empty table => shrunkToPrior, low effN (honest cold start)', () => {
  const out = surv.assessSurvival(mkSig(), { table: new Map(), regime: { label: 'neutral' } });
  assert.strictEqual(out.shrunkToPrior, true);
  assert.strictEqual(out.effN, 0);
  assert.deepStrictEqual(
    [out.pTargetBeforeStop, out.pStopBeforeTarget, out.pNeither].map((x) => Math.round(x * 100) / 100),
    [surv.DEFAULT_PRIOR.pTarget, surv.DEFAULT_PRIOR.pStop, surv.DEFAULT_PRIOR.pNeither]
  );
});

test('survival: entry-state classifier covers the state machine', () => {
  assert.strictEqual(surv.classifyEntryState(mkSig({ state: 'ready', price: 100, entry: 100 })), 'ENTER_NOW');
  assert.strictEqual(surv.classifyEntryState(mkSig({ state: 'ready', price: 106, entry: 100 })), 'WAIT_FOR_PULLBACK');
  assert.strictEqual(surv.classifyEntryState(mkSig({ state: 'ready', price: 96, entry: 100 })), 'WAIT_FOR_BREAKOUT');
  assert.strictEqual(surv.classifyEntryState(mkSig({ state: 'detected', price: 99.9, entry: 100 })), 'WAIT_FOR_CONFIRMATION');
  assert.strictEqual(surv.classifyEntryState(mkSig({ state: 'failed' })), 'INVALID');
  assert.strictEqual(surv.classifyEntryState(mkSig({ state: 'extended' })), 'STALE');
  const noLevels = mkSig(); noLevels.entry = null; noLevels.stop = null;
  assert.strictEqual(surv.classifyEntryState(noLevels), 'INVALID');
});

test('survival: setup expiry derived from horizon hold window', () => {
  const out = surv.assessSurvival(mkSig({ horizon: 'swing', ageBars: 3 }), { table: new Map() });
  assert.strictEqual(out.setupExpiry.maxHoldBars, 10);
  assert.strictEqual(out.setupExpiry.sessionsRemaining, 7);
});

// ---------------------------------------------------------------------------
test('events: mechanical normalize + surprise score with missing flags', () => {
  const { record, surprise } = events.assessEvent(mkSig({ source: 'screener' }));
  assert.strictEqual(record.schemaVersion, 'event-surprise-v1');
  assert.strictEqual(record.category, 'news-catalyst');
  assert.ok(record.missingFlags.includes('earningsSurprise')); // honestly unknown, flagged
  assert.ok(surprise.score >= 0 && surprise.score <= 100);
  assert.strictEqual(surprise.degraded, true); // built from proxies -> weak prior
});

test('events: contradiction flag when long into a weak sector', () => {
  const { record } = events.assessEvent(mkSig({ side: 'long', sectorStrength: -0.5 }));
  assert.ok(record.contradictionFlags.includes('long-into-weak-sector'));
});

test('events: LLM absent => graceful null, mechanical path still works', async () => {
  const r = await events.reviewEventWithLLM(mkSig(), { apiKey: '' });
  assert.strictEqual(r, null);
  const { surprise } = events.assessEvent(mkSig(), {}, r); // r=null => mechanical
  assert.ok(surprise.score >= 0);
});

// ---------------------------------------------------------------------------
test('decision: strong mature candidate => TRADE, shadow, zero weight', () => {
  const table = matureTable('STRONG');
  const strong = mkSig({ ticker: 'STRONG', id: 'screener:swing:STRONG' });
  const filler = mkSig({ ticker: 'FILL', id: 'screener:swing:FILL', percentile: 30, rawConfidence: 40 });
  const board = decision.decideBoard([strong, filler], { asOf: '2026-07-18', regime: { label: 'neutral' }, survivalTable: table });
  const trade = board.decisions.TRADE.find((d) => d.ticker === 'STRONG');
  assert.ok(trade, 'STRONG should be TRADE');
  assert.strictEqual(trade.shadow, true);
  assert.strictEqual(trade.deploymentWeight, 0);
  assert.strictEqual(board.boardDecision, 'TRADE_AVAILABLE');
});

test('decision: attractive but extended => WAIT with trigger/invalidation/expiry', () => {
  const table = matureTable('WAITER');
  const s = mkSig({ ticker: 'WAITER', id: 'screener:swing:WAITER', state: 'ready', price: 106, entry: 100 });
  const board = decision.decideBoard([s], { asOf: '2026-07-18', regime: { label: 'neutral' }, survivalTable: table });
  const w = board.decisions.WAIT.find((d) => d.ticker === 'WAITER');
  assert.ok(w, 'WAITER should be WAIT');
  assert.ok(w.trigger && w.invalidation && w.expiry, 'WAIT must carry trigger/invalidation/expiry');
});

test('decision: negative net edge => AVOID', () => {
  const s = mkSig({ ticker: 'BAD', remainingEdge: { rated: true, mult: 0.2, netRemainingPct: -2, consumedPct: 80, extensionR: 0.2, freshness: 'late' }, cost: { known: true, costShare: 0.9, netMovePct: -2, penalty: 0.5 } });
  const board = decision.decideBoard([s], { asOf: 'd', regime: { label: 'neutral' }, survivalTable: new Map() });
  assert.ok(board.decisions.AVOID.find((d) => d.ticker === 'BAD'));
});

test('decision: cold-start (no survival history) yields zero TRADE and NO_TRADE board', () => {
  const s = mkSig({ ticker: 'COLD' });
  const board = decision.decideBoard([s], { asOf: 'd', regime: { label: 'neutral' }, survivalTable: new Map() });
  assert.strictEqual(board.counts.trade, 0);
  assert.strictEqual(board.boardDecision, 'NO_TRADE');
  assert.ok(board.noTradeCause && board.noTradeCause.cause); // normal success with a cause
});

test('decision: empty board => NO_TRADE success, not an error', () => {
  const board = decision.decideBoard([], { asOf: 'd', regime: { label: 'neutral' } });
  assert.strictEqual(board.boardDecision, 'NO_TRADE');
  assert.deepStrictEqual(board.counts, { trade: 0, wait: 0, avoid: 0, total: 0 });
  assert.strictEqual(board.version, 'challenger-decision-v1');
});

test('decision: does not mutate input signals and is deterministic', () => {
  const table = matureTable('DET');
  const inputs = [mkSig({ ticker: 'DET', id: 'screener:swing:DET' })];
  const snapshot = JSON.stringify(inputs);
  const a = decision.decideBoard(inputs, { asOf: 'd', regime: { label: 'neutral' }, survivalTable: table });
  const b = decision.decideBoard(inputs, { asOf: 'd', regime: { label: 'neutral' }, survivalTable: table });
  assert.strictEqual(snapshot, JSON.stringify(inputs)); // inputs untouched
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b)); // deterministic
});

test('decision: UI data-contract is null-safe with a minimal signal (missing optional fields)', () => {
  // A bare signal with none of the optional enrichment the UI reads.
  const board = decision.decideBoard([{ ticker: 'MIN', horizon: 'swing', side: 'long', entry: 10, stop: 9, source: 'screener' }], { asOf: 'd', regime: { label: 'neutral' }, survivalTable: new Map() });
  const all = [...board.decisions.TRADE, ...board.decisions.WAIT, ...board.decisions.AVOID];
  assert.ok(all.length === 1);
  const d = all[0];
  // Every field the today.js action cards read must be defined (null is fine; undefined would render "undefined").
  const uiKeys = ['ticker', 'decision', 'horizon', 'entry', 'stop', 'target', 'trigger', 'invalidation', 'expiry', 'expectedNetUtilityPct', 'uncertainty', 'residualScore', 'percentileRank', 'failureProb', 'executionQuality', 'regimeFit', 'primaryDriver', 'primaryRisk', 'governanceStatus'];
  for (const k of uiKeys) assert.ok(d[k] !== undefined, `${k} must not be undefined`);
  assert.strictEqual(typeof d.survival, 'object');
  assert.strictEqual(typeof d.event, 'object');
  assert.ok(Array.isArray(d.reasons));
  for (const k of ['pTargetBeforeStop', 'pStopBeforeTarget', 'pNeither', 'entryState', 'effN', 'expectedSessionsToResolution', 'edgeNowPct', 'edgeAfterWaitPct', 'basis']) assert.ok(d.survival[k] !== undefined);
  for (const k of ['category', 'score', 'degraded']) assert.ok(d.event[k] !== undefined);
});

test('decision: governance-disabled source => AVOID', () => {
  const table = matureTable('DIS');
  const s = mkSig({ ticker: 'DIS', id: 'screener:swing:DIS', source: 'daytrade' });
  const board = decision.decideBoard([s], { asOf: 'd', regime: { label: 'neutral' }, survivalTable: table, disabledSources: new Set(['daytrade']) });
  assert.ok(board.decisions.AVOID.find((d) => d.ticker === 'DIS'));
});
