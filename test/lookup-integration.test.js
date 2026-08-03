'use strict';
// INTEGRATION GUARDS for the ticker-search redesign — each test pins one of the
// forbidden states from the redesign spec so a regression cannot ship silently.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MS = require('../lib/market-session');
const { classifyIntradayFreshness, shapeIntradayHorizon } = require('../lib/signal');
const { orchestrate } = require('../lib/lookup-orchestrator');
const { synthesizeHorizons } = require('../lib/horizon-synthesis');
const { verdictOf } = require('../lib/whynow');
const { makeSignal } = require('../lib/lookup-contract');

const TKL_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ticker-lookup.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

const liveBuy = () => ({
  action: 'BUY', label: 'Buy', score: 5, confidence: 7, bullish: true,
  reasons: ['Above VWAP'], counter: [], rsi: 60, vwap: 100,
  levels: { entry: '100.00', target: '105.00', stop: '97.00', riskReward: '1:2.5', atr: '2.00' },
});
const swingBuy = (over = {}) => ({
  available: true, action: 'BUY', setup: 'trend-continuation', signedScore: 0.4, evidenceStrength: 6,
  reasons: ['Uptrend intact.'], counter: [], risks: [], factors: { medDollarVol: 5e7 },
  families: { trend: 0.5, relativeStrength: 0.4, participation: 0.2 },
  plan: { side: 'long', setupType: 'breakout-hold', trigger: 105, invalidation: 96, objective: 118 },
  ...over,
});

// 1. Closed-market intraday BUY/SELL is impossible.
test('FORBIDDEN 1: no closed-market intraday BUY/SELL anywhere in the chain', () => {
  const SAT = new Date('2026-08-01T12:00:00-04:00');
  const f = MS.assessFreshness({ sourceKind: 'intraday', barTimestamp: Math.floor(SAT / 1000) - 600, now: SAT });
  assert.strictEqual(f.executionAllowed, false);
  const live = liveBuy();
  const h = shapeIntradayHorizon(live, 'yahoo', 'CLOSED', 'closed', '2026-07-31', f);
  assert.strictEqual(h.action, 'HOLD');
  const rec = orchestrate({ horizon: 'intraday', intraday: h, sessionMeta: f });
  assert.ok(!['TRIGGERED', 'READY'].includes(rec.action), `got ${rec.action}`);
});

// 2. Stale premarket/after-hours BUY/SELL is impossible.
test('FORBIDDEN 2: stale extended-hours data cannot produce BUY/SELL', () => {
  const now = 1_700_000_000;
  for (const state of ['PRE', 'POST']) {
    assert.strictEqual(classifyIntradayFreshness('yahoo', state, now - 3 * 3600, now), 'stale');
  }
  const live = liveBuy();
  const h = shapeIntradayHorizon(live, 'yahoo', 'PRE', 'stale', '2026-08-03');
  assert.strictEqual(h.action, 'HOLD');
});

// 3. "Nothing actionable" can never sit beside a live primary recommendation.
test('FORBIDDEN 3: whynow quiet verdict is screener-scoped, never "nothing to act on"', () => {
  const v = verdictOf([]);
  assert.doesNotMatch(v.summary, /nothing to act on/i);
  assert.match(v.summary, /screener/i);
  assert.ok(/currentPrimary\(\)/.test(TKL_SRC), 'UI reconciles whynow against the primary rec');
});

// 4. "Horizons disagree" beside "the horizons agree" is impossible.
test('FORBIDDEN 4: conflict note and agreement note are mutually exclusive', () => {
  const s = synthesizeHorizons({
    intraday: { available: true, action: 'BUY' },
    swing: { available: true, action: 'SELL' },
    longTerm: { available: true, trend: 'neutral' },
  });
  assert.ok(s.conflicts.length >= 1);
  assert.doesNotMatch(s.note, /horizons agree/i);
});

// 5. One available bullish horizon is never "fully aligned".
test('FORBIDDEN 5: single-horizon reads cannot claim alignment', () => {
  const s = synthesizeHorizons({
    intraday: { available: true, action: 'BUY' },
    swing: { available: false, action: 'UNAVAILABLE' },
    longTerm: { available: false },
  });
  assert.notStrictEqual(s.overall, 'aligned-bullish');
});

// 6. BUY/TRIGGERED with an unmet future trigger is impossible.
test('FORBIDDEN 6: untriggered setups are WATCH/READY, never TRIGGERED', () => {
  const rec = orchestrate({ horizon: 'swing', swing: swingBuy(), price: 100, dailyBarComplete: true });
  assert.ok(['WATCH', 'READY'].includes(rec.action));
  const contract = makeSignal({ ticker: 'X', horizon: 'swing', action: 'TRIGGERED', setupState: 'forming', executionAllowed: true });
  assert.notStrictEqual(contract.action, 'TRIGGERED');
});

// 7. Raw call=bullish/put=bearish inference is gone from the lookup surface.
test('FORBIDDEN 7: lookup no longer infers direction from call/put sentiment', () => {
  assert.ok(!/s\.sentiment === 'bullish'/.test(TKL_SRC), 'raw sentiment check removed');
  assert.ok(/directionState/.test(TKL_SRC), 'interpreted direction states consumed');
  assert.ok(/DIRECTION_UNKNOWN/.test(TKL_SRC), 'direction-unknown state rendered');
});

// 8. Failed patterns contributing positively → covered structurally here too.
test('FORBIDDEN 8: reconcile excludes FAILED from positive alignment (source guard)', () => {
  const rec = require('../lib/patterns/reconcile');
  const det = { family: 'flag', label: 'x', timeframe: '20d', direction: 'LONG', phase: 'FAILED', structuralValidity: 0.9, plan: { rr: 2, quality: 'good' }, structurallyInvalid: false };
  const out = rec.reconcileDetections([det]);
  assert.strictEqual(out.primary, null);
});

// 9. A short trigger can never read as a buy.
test('FORBIDDEN 9: short-side recommendations never say "buy"', () => {
  const s = swingBuy({ action: 'SELL', signedScore: -0.4, plan: { side: 'bearish', setupType: 'breakdown', trigger: 95, invalidation: 104, objective: 84 } });
  const rec = orchestrate({ horizon: 'swing', swing: s, price: 100, positionState: 'short' });
  assert.doesNotMatch(`${rec.headline} ${rec.explanation} ${rec.nextStep}`, /\bbuy\b/i);
});

// 10. Probability without an artifact never displays.
test('FORBIDDEN 10: no calibrated probability without a valid OOS artifact', () => {
  const s = makeSignal({ ticker: 'X', horizon: 'swing', calibratedProbability: 0.7 });
  assert.strictEqual(s.calibratedProbability, null);
  const rec = orchestrate({ horizon: 'swing', swing: swingBuy(), price: 100 });
  assert.strictEqual(rec.calibratedProbability, null);
  assert.match(rec.probabilityNote, /NOT a probability/);
});

// 11. A forming daily candle is never a confirmed close.
test('FORBIDDEN 11: forming candle demotes confirmation to READY', () => {
  const rec = orchestrate({ horizon: 'swing', swing: swingBuy(), price: 106, dailyBarComplete: false });
  assert.strictEqual(rec.action, 'READY');
});

// 12. Bearish long-term invalidation uses reclaim language.
test('FORBIDDEN 12: bearish LT invalidation is a RECLAIM, in engine and UI', () => {
  const rec = orchestrate({ horizon: 'longterm', longTerm: { available: true, trend: 'bearish', reasons: [], factors: { sma200: 88 } } });
  assert.match(rec.nextStep, /RECLAIM/i);
  assert.ok(/Reclaims 200-day/.test(TKL_SRC), 'UI card uses side-correct language');
});

// 13. Mixed data ages must be disclosed.
test('FORBIDDEN 13: every side-section carries its own as-of stamp', () => {
  assert.ok(/sectionStamp/.test(TKL_SRC));
  assert.ok(/not auto-refreshed while open/.test(TKL_SRC));
});

// 14. Correlated technical models can't count as independent votes.
test('FORBIDDEN 14: LT second-opinions tally is family-deduped', () => {
  assert.ok(/priceVotes/.test(APP_SRC) && /by family/.test(APP_SRC));
});

// 15. WATCH/READY swing setups keep a real plan.
test('FORBIDDEN 15: WATCH recs carry actionable next steps', () => {
  const rec = orchestrate({ horizon: 'swing', swing: swingBuy(), price: 100 });
  assert.ok(rec.nextStep && rec.nextStep.length > 20);
  assert.ok(rec.plan && rec.plan.trigger != null && rec.plan.invalidation != null);
});

// ── End-to-end fixture sweeps ───────────────────────────────────────────────
test('fixture: bullish long-term + weak short-term surfaces the contradiction', () => {
  const rec = orchestrate({
    horizon: 'longterm',
    longTerm: { available: true, trend: 'bullish', reasons: ['Above the 200-day.'], factors: { sma200: 88, rs6mPct: 10 } },
    intraday: { available: true, action: 'SELL', freshness: 'live', evidenceStrength: 6, reasons: [], counter: [] },
    sessionMeta: { marketSession: 'regular', freshnessState: 'live', executionAllowed: true },
  });
  assert.strictEqual(rec.direction, 'bullish');
  assert.ok(rec.contradicting.some(c => /intraday.*bearish/i.test(c)), `got ${rec.contradicting}`);
});

test('fixture: partial API failure reads as UNAVAILABLE, never as neutral', () => {
  for (const horizon of ['intraday', 'swing', 'longterm']) {
    const rec = orchestrate({ horizon });
    assert.strictEqual(rec.action, 'UNAVAILABLE', horizon);
    assert.notStrictEqual(rec.direction, 'neutral');
  }
});

test('fixture: insufficient history yields a WAIT-family state with an explanation', () => {
  const { swingRead } = require('../lib/swingread');
  const bars = Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, open: 100, high: 101, low: 99, close: 100, volume: 1e6 }));
  const swing = swingRead(bars, null, {});
  assert.strictEqual(swing.insufficient, true);
  const rec = orchestrate({ horizon: 'swing', swing, price: 100 });
  assert.ok(['NO_TRADE', 'WATCH'].includes(rec.action));
  assert.ok(rec.explanation.length > 10);
});

test('fixture: ambiguous options extras add context without flipping the action', () => {
  const extra = makeSignal({
    ticker: 'X', horizon: 'swing', engine: 'optionsflow', direction: 'unknown', setupState: 'none',
    action: 'NO_TRADE', explanation: 'Large activity, direction unknown (suspected spread)',
    eventRisks: ['Earnings in ~5 sessions before expiry'], executionAllowed: false,
  });
  const rec = orchestrate({ horizon: 'swing', swing: swingBuy(), price: 100, extras: [extra] });
  assert.ok(['WATCH', 'READY'].includes(rec.action));
  assert.ok(rec.eventRisks.some(e => /earnings/i.test(e)));
});

test('fixture: conflicting social evidence lands in contradicting, not supporting', () => {
  const extra = makeSignal({
    ticker: 'X', horizon: 'swing', engine: 'social', direction: 'bearish', setupState: 'none',
    action: 'AVOID', explanation: 'Coordinated bearish chatter', executionAllowed: false,
  });
  const rec = orchestrate({ horizon: 'swing', swing: swingBuy(), price: 100, extras: [extra] });
  assert.ok(rec.contradicting.some(c => /Coordinated bearish/i.test(c)));
  assert.ok(!rec.supporting.some(c => /Coordinated bearish/i.test(c)));
});
