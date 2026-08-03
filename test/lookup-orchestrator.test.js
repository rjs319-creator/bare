'use strict';
const test = require('node:test');
const assert = require('node:assert');
const O = require('../lib/lookup-orchestrator');

// ── Fixtures (override-factory pattern) ─────────────────────────────────────
const swingBuy = (over = {}) => ({
  version: 'swing-v1', available: true, action: 'BUY', setup: 'trend-continuation',
  signedScore: 0.4, evidenceStrength: 6,
  reasons: ['Uptrend intact.', 'Positive excess return vs SPY.'],
  counter: [], risks: [],
  factors: { medDollarVol: 5e7 },
  families: { trend: 0.5, relativeStrength: 0.4, participation: 0.2 },
  plan: { side: 'long', setupType: 'breakout-hold', trigger: 105, invalidation: 96, objective: 118, window: '2–12 weeks' },
  ...over,
});
const swingWait = (over = {}) => swingBuy({ action: 'WAIT', evidenceStrength: 6, plan: null, ...over });
const ltRead = (over = {}) => ({
  available: true, trend: 'bullish', score: 6, composite: 0.6,
  reasons: ['Above the 200-day.'], factors: { sma200: 88.5, rs6mPct: 12 },
  ...over,
});
const intradayLive = (over = {}) => ({
  available: true, action: 'BUY', freshness: 'live', evidenceStrength: 7,
  reasons: ['Above VWAP (buyers in control)', 'Above-avg volume on up bar'], counter: [],
  levels: { entry: '100.00', stop: '97.00', target: '105.00' },
  ...over,
});
const sessionLive = (over = {}) => ({
  marketSession: 'regular', freshnessState: 'live', dataAsOf: '2026-08-03T14:30:00.000Z',
  ageSeconds: 60, executionAllowed: true, provisional: false, ...over,
});
const sessionClosed = (over = {}) => sessionLive({
  marketSession: 'closed', freshnessState: 'closed', executionAllowed: false, ...over,
});

// ── Swing: setup vs trigger ─────────────────────────────────────────────────
test('swing BUY with trigger ABOVE price is WATCH, never TRIGGERED', () => {
  const r = O.orchestrate({ horizon: 'swing', swing: swingBuy(), price: 100, dailyBarComplete: true });
  assert.strictEqual(r.action, 'WATCH');
  assert.strictEqual(r.direction, 'bullish');
  assert.match(r.nextStep, /daily close above \$105/i);
});

test('high-evidence untriggered swing BUY is READY (armed), still not an entry', () => {
  const r = O.orchestrate({ horizon: 'swing', swing: swingBuy({ evidenceStrength: 8 }), price: 100 });
  assert.strictEqual(r.action, 'READY');
});

test('price beyond trigger on a FORMING daily bar is READY — a forming candle is not a close', () => {
  const r = O.orchestrate({ horizon: 'swing', swing: swingBuy(), price: 106, dailyBarComplete: false });
  assert.strictEqual(r.action, 'READY');
  assert.match(r.explanation, /has not closed/i);
});

test('confirmed daily close beyond trigger is TRIGGERED', () => {
  const r = O.orchestrate({ horizon: 'swing', swing: swingBuy(), price: 106, dailyBarComplete: true });
  assert.strictEqual(r.action, 'TRIGGERED');
  assert.strictEqual(r.setupState, 'triggered');
  assert.match(r.nextStep, /invalidation \$96/i);
});

test('swing WAIT with real evidence still produces a useful WATCH plan', () => {
  const r = O.orchestrate({ horizon: 'swing', swing: swingWait(), price: 100 });
  assert.strictEqual(r.action, 'WATCH');
  assert.ok(r.nextStep.length > 10, 'watch guidance present, not an empty shrug');
});

test('swing SELL: avoiding a long ≠ exiting a long ≠ opening a short', () => {
  const s = swingBuy({ action: 'SELL', signedScore: -0.4, plan: { side: 'bearish', setupType: 'breakdown', trigger: 95, invalidation: 104, objective: 84 } });
  assert.strictEqual(O.orchestrate({ horizon: 'swing', swing: s, price: 100, positionState: 'new' }).action, 'AVOID');
  assert.strictEqual(O.orchestrate({ horizon: 'swing', swing: s, price: 100, positionState: 'holding' }).action, 'EXIT');
  const short = O.orchestrate({ horizon: 'swing', swing: s, price: 100, positionState: 'short' });
  assert.ok(['WATCH', 'READY'].includes(short.action), 'short above trigger is a watch, not an instant entry');
});

test('swing UNAVAILABLE is reported as data failure, not neutral', () => {
  const r = O.orchestrate({ horizon: 'swing', swing: { action: 'UNAVAILABLE' } });
  assert.strictEqual(r.action, 'UNAVAILABLE');
  assert.match(r.nextStep, /data failure|retry/i);
});

// ── Intraday: session gates ─────────────────────────────────────────────────
test('closed market can never emit an actionable intraday recommendation', () => {
  const r = O.orchestrate({ horizon: 'intraday', intraday: intradayLive({ freshness: 'closed', action: 'HOLD', priorBias: 'bullish' }), sessionMeta: sessionClosed() });
  assert.strictEqual(r.action, 'NO_TRADE');
  assert.match(r.headline, /closed/i);
});

test('stale intraday data is STALE, not a signal', () => {
  const r = O.orchestrate({ horizon: 'intraday', intraday: intradayLive({ freshness: 'stale', action: 'HOLD' }), sessionMeta: sessionLive({ freshnessState: 'stale', executionAllowed: false }) });
  assert.strictEqual(r.action, 'STALE');
});

test('live regular-session intraday BUY is TRIGGERED with a plan', () => {
  const r = O.orchestrate({ horizon: 'intraday', intraday: intradayLive(), sessionMeta: sessionLive() });
  assert.strictEqual(r.action, 'TRIGGERED');
  assert.strictEqual(r.plan.invalidation, 97);
});

test('premarket intraday read is READY/provisional, never TRIGGERED', () => {
  const r = O.orchestrate({
    horizon: 'intraday',
    intraday: intradayLive({ freshness: 'premarket' }),
    sessionMeta: sessionLive({ marketSession: 'premarket', freshnessState: 'live-extended', executionAllowed: false, provisional: true }),
  });
  assert.strictEqual(r.action, 'READY');
  assert.match(r.headline, /provisional/i);
});

test('bearish intraday tape: new-position seeker gets AVOID, holder gets EXIT', () => {
  const bear = intradayLive({ action: 'SELL' });
  assert.strictEqual(O.orchestrate({ horizon: 'intraday', intraday: bear, sessionMeta: sessionLive(), positionState: 'new' }).action, 'AVOID');
  assert.strictEqual(O.orchestrate({ horizon: 'intraday', intraday: bear, sessionMeta: sessionLive(), positionState: 'holding' }).action, 'EXIT');
});

// ── Long-term: trend-state semantics ────────────────────────────────────────
test('bullish long-term thesis invalidates on LOSING support', () => {
  const r = O.orchestrate({ horizon: 'longterm', longTerm: ltRead() });
  assert.match(r.nextStep, /LOSS of the 200-day/);
  assert.strictEqual(r.action, 'WATCH');
});

test('bearish long-term thesis invalidates on RECLAIMING resistance, never "below support"', () => {
  const r = O.orchestrate({ horizon: 'longterm', longTerm: ltRead({ trend: 'bearish', reasons: ['Below the 200-day.'] }) });
  assert.match(r.nextStep, /RECLAIM/);
  assert.doesNotMatch(r.nextStep, /invalidated on a sustained loss/i);
  assert.strictEqual(r.action, 'AVOID');
});

test('neutral long-term shows the conditions to resolve either way', () => {
  const r = O.orchestrate({ horizon: 'longterm', longTerm: ltRead({ trend: 'neutral' }) });
  assert.match(r.nextStep, /bullish.*bearish|hold above.*loss/i);
});

test('long-term never emits TRIGGERED — it is a trend state, not an entry engine', () => {
  for (const trend of ['bullish', 'bearish', 'neutral']) {
    const r = O.orchestrate({ horizon: 'longterm', longTerm: ltRead({ trend }) });
    assert.notStrictEqual(r.action, 'TRIGGERED');
  }
});

// ── Cross-horizon honesty ───────────────────────────────────────────────────
test('contradictions are surfaced, not averaged away', () => {
  const r = O.orchestrate({
    horizon: 'swing', swing: swingBuy(), price: 100,
    longTerm: ltRead({ trend: 'bearish' }),
  });
  assert.ok(r.contradicting.some(c => /long-term.*bearish/i.test(c)), `got: ${r.contradicting}`);
});

test('calibratedProbability is always null (no artifact exists) with an explicit note', () => {
  const r = O.orchestrate({ horizon: 'swing', swing: swingBuy(), price: 100 });
  assert.strictEqual(r.calibratedProbability, null);
  assert.match(r.probabilityNote, /NOT a probability/i);
});

test('correlated intraday indicators are ONE price-trend family, not four votes', () => {
  const fams = O.intradayFamilies(intradayLive());
  const priceFams = fams.filter(f => f.family === 'price-trend');
  assert.strictEqual(priceFams.length, 1);
  assert.match(priceFams[0].detail, /counted once/i);
});

test('extras can contradict but can never upgrade the primary action', () => {
  const extra = {
    engine: 'patterns', horizon: 'swing', direction: 'bearish', setupState: 'failed',
    explanation: 'Failed bull flag', eventRisks: [], warnings: [],
  };
  const r = O.orchestrate({ horizon: 'swing', swing: swingBuy(), price: 100, extras: [extra] });
  assert.strictEqual(r.action, 'WATCH', 'extras never change the action');
  assert.ok(r.contradicting.some(c => /Failed bull flag/.test(c)));
});

test('deterministic — identical inputs give identical output', () => {
  const args = { horizon: 'swing', swing: swingBuy(), price: 100, longTerm: ltRead() };
  assert.deepStrictEqual(O.orchestrate(args), O.orchestrate(args));
});

test('result is frozen', () => {
  const r = O.orchestrate({ horizon: 'swing', swing: swingBuy(), price: 100 });
  assert.ok(Object.isFrozen(r));
  assert.throws(() => { 'use strict'; r.action = 'TRIGGERED'; });
});
