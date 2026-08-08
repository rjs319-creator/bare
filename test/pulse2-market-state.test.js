'use strict';
// Market Pulse v2 — DETERMINISTIC MARKET STATE + MODE + PLAYBOOK.
// Required behavior #21: a market-state provider failure reports UNAVAILABLE (with
// reasons and degraded coverage), never a neutral-looking market. Mode derivation is
// deterministic from explicit inputs.

const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/pulse2-market-state');
const { sessionInfoAt } = require('../lib/market-session');

const REGULAR_NOW = new Date('2026-06-09T18:00:00Z');   // Tue 14:00 ET

test('#21: total provider failure → UNAVAILABLE indexes + degraded coverage + INSUFFICIENT_DATA mode', () => {
  const state = M.buildMarketState({
    intradayByTicker: {}, dailyByTicker: {},
    sessionInfo: sessionInfoAt(REGULAR_NOW), now: REGULAR_NOW,
  });
  assert.equal(state.indexes.SPY.available, false);
  assert.ok(state.indexes.SPY.reason, 'failure must carry a reason');
  assert.equal(state.mode.mode, 'INSUFFICIENT_DATA');
  assert.equal(state.coverage.degraded, true);
  assert.ok(state.coverage.failedSymbols.includes('SPY'));
  assert.equal(state.breadth.available, false);
  assert.ok(state.breadth.reason);
});

test('mode: EVENT_SHOCK on a large index move', () => {
  const r = M.deriveMarketMode({ spyRet: -2.5, qqqRet: -3.0 });
  assert.equal(r.mode, 'EVENT_SHOCK');
  assert.equal(r.inputs.spyRet, -2.5);   // inputs ride along for auditability
});

test('mode: RISK_ON_TREND vs NARROW_LEADERSHIP vs BROAD_PARTICIPATION distinguished by participation', () => {
  const base = { spyRet: 0.9, qqqRet: 1.0, spyAboveVwap: true, qqqAboveVwap: true };
  assert.equal(M.deriveMarketMode({ ...base, rspRet: 0.2, iwmRet: -0.1 }).mode, 'NARROW_LEADERSHIP');
  assert.equal(M.deriveMarketMode({ ...base, rspRet: 0.9, iwmRet: 0.5, breadthPctAbove50: 62 }).mode, 'BROAD_PARTICIPATION');
  assert.equal(M.deriveMarketMode({ ...base, rspRet: 0.6, iwmRet: 0.5, breadthPctAbove50: 50 }).mode, 'RISK_ON_TREND');
});

test('mode: RISK_OFF_TREND requires both indexes down below VWAP', () => {
  assert.equal(M.deriveMarketMode({ spyRet: -0.8, qqqRet: -1.0, spyAboveVwap: false, qqqAboveVwap: false }).mode, 'RISK_OFF_TREND');
});

test('mode: flat index + wide sector spread = ROTATION; flat + narrow = TWO_WAY_CHOP', () => {
  assert.equal(M.deriveMarketMode({ spyRet: 0.1, qqqRet: 0.0, sectorSpreadPct: 2.2 }).mode, 'ROTATION');
  assert.equal(M.deriveMarketMode({ spyRet: 0.1, qqqRet: 0.0, sectorSpreadPct: 0.8 }).mode, 'TWO_WAY_CHOP');
});

test('instrumentState: daily fallback is labeled source=daily, never dressed as intraday', () => {
  const s = M.instrumentState({
    ticker: 'SPY', intradayResult: null,
    dailyCandles: [
      { date: '2026-06-08', open: 500, close: 502 },
      { date: '2026-06-09', open: 503, close: 505 },
    ],
    now: REGULAR_NOW,
  });
  assert.equal(s.available, true);
  assert.equal(s.source, 'daily');
  assert.equal(s.vsVWAPPct, null);          // intraday-only fields stay null
  assert.equal(s.sameTimeRelVol, null);
});

test('mode change vs prior snapshot is a measured transition on the state', () => {
  const sessionInfo = sessionInfoAt(REGULAR_NOW);
  const prev = { mode: { mode: 'TWO_WAY_CHOP' } };
  const state = M.buildMarketState({ intradayByTicker: {}, sessionInfo, prevState: prev, now: REGULAR_NOW });
  // INSUFFICIENT_DATA vs TWO_WAY_CHOP counts as changed=true on the snapshot…
  assert.equal(state.mode.previous, 'TWO_WAY_CHOP');
});

// ── Playbook ────────────────────────────────────────────────────────────────
const RICH_STATE = {
  sessionState: 'regular', etDate: '2026-06-09',
  mode: { mode: 'ROTATION', why: 'sector spread', changed: false, previous: null },
  indexes: {
    SPY: { available: true, dayReturnPct: 0.1, gapPct: 0.2, aboveVWAP: true, openingRange: { high: 501, low: 499, complete: true, brokeAbove: false, brokeBelow: false } },
    QQQ: { available: true, dayReturnPct: 0.2, aboveVWAP: true, openingRange: { high: 401, low: 399, complete: true, brokeAbove: false, brokeBelow: false } },
    IWM: { available: true, dayReturnPct: -0.5 }, DIA: { available: true, dayReturnPct: 0.0 }, RSP: { available: true, dayReturnPct: -0.2 },
  },
  sectors: {
    available: true, upCount: 6, rows: [
      { sector: 'Technology', dayReturnPct: 1.2, vsSpyPct: 1.1 },
      { sector: 'Energy', dayReturnPct: -1.0, vsSpyPct: -1.1 },
    ], leading: ['Technology'], lagging: ['Energy'],
  },
  participation: { equalVsCapPct: -0.3, smallVsLargePct: -0.6 },
  breadth: { available: false, reason: 'no source' },
};

test('playbook: every line carries an explicit basis tag; measured levels come from real data', () => {
  const pb = M.buildPlaybook(RICH_STATE, { freshVerified: ['Acme verified'], triggers: ['AAA armed at 12.5'], eventRisk: ['2026-06-11: CPI release'] });
  assert.ok(M.BASIS.includes(pb.marketMode.basis));
  assert.equal(pb.marketMode.basis, 'MEASURED');
  for (const l of pb.whatChanged) assert.ok(M.BASIS.includes(l.basis));
  assert.equal(pb.favor.basis, 'MODEL_INFERENCE');       // favor/avoid are labeled inference
  assert.equal(pb.avoid.basis, 'MODEL_INFERENCE');
  // Next decision point uses the REAL unbroken opening range — a measured level.
  assert.match(pb.nextDecisionPoint.text, /QQQ opening-range 401 \/ 399/);
  assert.equal(pb.nextDecisionPoint.basis, 'MEASURED');
  assert.equal(pb.freshOpportunities[0].basis, 'VERIFIED_FACT');
  assert.equal(pb.upcomingEventRisk[0].basis, 'VERIFIED_FACT');
});

test('playbook: no fabricated levels — without an unbroken range the decision point is honest prose', () => {
  const state = { ...RICH_STATE, indexes: { ...RICH_STATE.indexes, SPY: { available: false, reason: 'x' }, QQQ: { available: false, reason: 'x' } } };
  const pb = M.buildPlaybook(state, {});
  assert.ok(!/\d+ \/ \d+/.test(pb.nextDecisionPoint.text), 'no invented numeric levels');
});
