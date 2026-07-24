'use strict';
// HIMS REGRESSION SUITE — the deterministic reproduction of the production defect and its fix.
//
// The motivating failure: HIMS was +3.35% on heavy volume the PRIOR session, then fell ~10–14%
// the CURRENT session. The card's live quote updated, but its membership / momentum class /
// carry / trade levels / buy-language stayed based on yesterday's bullish daily bar. These
// tests pin every path that must now refuse to present that stale, contradicted, or invalidated
// state as an actionable buy — across the actionability engine, timing, Best Opportunities, and
// the downstream Today normalizer. Pure fixtures (no network): intraday evidence is injected as
// `evByTicker`, exactly as the live Stage-2 revalidation would produce it.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyPool, bucketLanes } = require('../lib/daytrade-actionability');
const { advanceLifecycle, STATES } = require('../lib/opportunity-lifecycle');
const { scoreTiming } = require('../lib/timing');
const { buildBestOpportunities } = require('../lib/screener-routes');
const N = require('../lib/decision-normalizers');

const NOW = '2026-07-24T15:00:00Z';   // 11:00 ET, regular session
const BAR = '2026-07-24T14:59:00Z';   // a fresh current-session 5-min bar

// The HIMS daily-cache candidate: discovered on YESTERDAY's +3.35% bar (the scan reads a
// pre-open cache), so barIsToday=false and the newest evidence is a prior session.
function himsDaily(over = {}) {
  return {
    ticker: 'HIMS', scan: 'momentum_liquid', tier: 'A', sector: 'Health Care',
    last: 100, entry: 100, stop: 95, target: 110, rr: 2, riskPct: 5,
    pctChange: 3.35, relVol: 3, carry: 60, overextended: false, catalyst: 'NONE',
    relScore: 100, avgVol: 5_000_000, candidateDate: '2026-07-23', date: '2026-07-23',
    orb: { trigger: 101, stop: 92.5, target: 118, rr: 2, atr: 3 },
    freshness: { candidateDate: '2026-07-23', dailyBarAsOf: '2026-07-23', freshnessStatus: 'PRIOR_SESSION', barIsToday: false },
    ...over,
  };
}

// A fresh intraday collapse ev (down ~10%, below the old stop, closes below VWAP) — what Stage-2
// produces for HIMS on the CURRENT session.
function collapseEv(over = {}) {
  return {
    ticker: 'HIMS', now: NOW, session: 'regular',
    freshness: { candidateDate: '2026-07-24', intradayBarAsOf: BAR, quoteAsOf: BAR, freshnessStatus: 'FRESH_TODAY', barIsToday: true },
    aboveVwap: false, stopBreached: true, lossFromDetectionAtr: 3.3, closesBelowVwap: 3,
    momentumOk: false, residualOk: false,
    metrics: { last: 90, vwap: 89, mom15: -0.02, residualVsSpy: -8 },
    ...over,
  };
}

// ── Scenario 1: prior-session HIMS — visible, but NEVER actionable ─────────────
test('1. prior-session HIMS (D-1 +3.35%, D collapse) cannot enter Actionable/Best/Today; stays visible in Prior-Session Watch', () => {
  const byT = classifyPool([himsDaily()], { now: NOW });
  const { lanes, counts } = bucketLanes(byT);
  assert.equal(byT.HIMS.record.state, STATES.PRIOR_SESSION_WATCH);
  assert.equal(byT.HIMS.card.actionable, false);
  assert.equal(counts.actionableNow, 0, 'never actionable on a stale prior-session bar');
  assert.equal(counts.priorSessionWatch, 1, 'still visible — historical continuity preserved');
  // Best Opportunities excludes it even though carry/relScore look great on the stale bar.
  assert.deepEqual(buildBestOpportunities(lanes.actionableNow), []);
  assert.deepEqual(buildBestOpportunities([himsDaily()]), [], 'stale row excluded from Best Opps directly too');
});

// ── Scenario 2: down 10% but slightly above VWAP — timing cannot go green ───────
test('2. down ~10% but just above old VWAP: the original plan is invalid and timing cannot return a green 8/10', () => {
  // Old plan entry 100 / stop 85 / target 110; current 90, VWAP 89 → nominal R:R looks fine and
  // price sits above VWAP, so the RAW mechanical grade could be misleadingly high...
  const snap = { price: 90, dayOpen: 99, dayHigh: 99.5, dayLow: 88, prevClose: 100, vwap: 89, rvol: 2, marketState: 'REGULAR' };
  const levels = { stop: 85, target: 110, trigger: 100 };
  // ...but with the thesis context (down 3.3 ATR from detection → invalidated) it is NOT eligible.
  const gated = scoreTiming(snap, levels, undefined, { thesisValid: false, lifecycleState: 'FAILED', currentSessionFresh: true, lossFromDetectionAtr: 3.3 });
  assert.equal(gated.notEligible, true);
  assert.equal(gated.score, null);
  assert.notEqual(gated.light, 'green');
  // Even a stop breach alone caps it out of green.
  const breached = scoreTiming({ ...snap, price: 84 }, levels, undefined, { lifecycleState: 'ACTIONABLE_NOW', stopBreached: true });
  assert.notEqual(breached.light, 'green');
});

// ── Scenario 3: prior-session candle + current quote → membership updates too ──
test('3. a prior-session candidate re-evaluated with fresh intraday evidence changes MEMBERSHIP, not just price', () => {
  const dailyOnly = classifyPool([himsDaily()], { now: NOW });
  assert.equal(dailyOnly.HIMS.record.state, STATES.PRIOR_SESSION_WATCH);   // watchlist, not a buy
  const revalidated = classifyPool([himsDaily({ freshness: { candidateDate: '2026-07-24', barIsToday: false } })], { now: NOW, evByTicker: { HIMS: collapseEv() } });
  assert.equal(revalidated.HIMS.record.state, STATES.FAILED, 'live evidence moves it to Retired, not merely a new price');
  assert.equal(revalidated.HIMS.card.actionable, false);
  assert.equal(revalidated.HIMS.card.lossFromDetectionPct, -10);
});

// ── Scenario 4: stop breach → immediate FAILED, no buy language ────────────────
test('4. a stop breach retires the name immediately (FAILED) with no buy language', () => {
  const byT = classifyPool([himsDaily()], { now: NOW, evByTicker: { HIMS: collapseEv({ closesBelowVwap: 0, lossFromDetectionAtr: 0 }) } });
  assert.equal(byT.HIMS.record.state, STATES.FAILED);
  assert.equal(byT.HIMS.card.thesisValid, false);
  assert.equal(byT.HIMS.card.stopBreached, true);
});

// ── Scenario 5: two confirmed VWAP closes → FAILED, retained under Retired ─────
test('5. two confirmed closes below VWAP retire the name (FAILED), kept under Retired Today', () => {
  const byT = classifyPool([himsDaily()], { now: NOW, evByTicker: { HIMS: collapseEv({ stopBreached: false, lossFromDetectionAtr: 0, closesBelowVwap: 2 }) } });
  const { lanes } = bucketLanes(byT);
  assert.equal(byT.HIMS.record.state, STATES.FAILED);
  assert.equal(lanes.retiredToday.length, 1);
});

// ── Scenario 6: one noisy VWAP wick → do NOT overreact (hysteresis) ────────────
test('6. a single close below VWAP does NOT retire the name (confirmation/hysteresis preserved)', () => {
  const oneWick = {
    ticker: 'HIMS', now: NOW, session: 'regular',
    freshness: { candidateDate: '2026-07-24', intradayBarAsOf: BAR, quoteAsOf: BAR, freshnessStatus: 'FRESH_TODAY', barIsToday: true },
    aboveVwap: true, stopBreached: false, lossFromDetectionAtr: 0, closesBelowVwap: 1,
    momentumOk: true, residualOk: true, relVolOk: true, triggerConfirmed: true, remainingRR: 2, extensionAtr: 0.8,
    metrics: { last: 101, vwap: 100.5 },
  };
  const byT = classifyPool([himsDaily({ freshness: { candidateDate: '2026-07-24', barIsToday: true } })], { now: NOW, evByTicker: { HIMS: oneWick } });
  assert.notEqual(byT.HIMS.record.state, STATES.FAILED, 'one wick must not retire a valid setup');
});

// ── Scenario 7: valid new reclaim is a SEPARATE, independently-validated setup ──
test('7. the failed original stays failed; only a separate REVERSAL_RECLAIM (fully confirmed) can become actionable', () => {
  // The original momentum record is FAILED and is NOT revived by the normal gate.
  const failed = advanceLifecycle(null, { strategy: 'daytrade', ...collapseEv() }, {});
  assert.equal(failed.state, STATES.FAILED);

  // A reclaim evaluation that is NOT fully confirmed → honest "reclaim not confirmed" (STALLING).
  const reclaimBase = {
    ticker: 'HIMS', now: NOW, session: 'regular', archetype: 'reversal_reclaim',
    freshness: { candidateDate: '2026-07-24', intradayBarAsOf: BAR, quoteAsOf: BAR, freshnessStatus: 'FRESH_TODAY', barIsToday: true },
    aboveVwap: true, momentumOk: true, residualOk: true, relVolOk: true, triggerConfirmed: true,
    reclaimConfirmed: false, newPlan: true, remainingRR: 2,
  };
  const unconfirmed = advanceLifecycle(null, { strategy: 'reclaim', ...reclaimBase }, {});
  assert.equal(unconfirmed.state, STATES.STALLING);
  assert.match(unconfirmed.history.at(-1).explanation, /reclaim not confirmed/i);

  // A FULLY confirmed reclaim (fresh VWAP reclaim + new trigger + new plan + acceptable R:R).
  const confirmed = advanceLifecycle(null, { strategy: 'reclaim', ...reclaimBase, reclaimConfirmed: true }, {});
  assert.equal(confirmed.state, STATES.REVERSAL_RECLAIM);
  // The original stale momentum stop must NOT be reused — the reclaim requires an explicit newPlan.
  const noNewPlan = advanceLifecycle(null, { strategy: 'reclaim', ...reclaimBase, reclaimConfirmed: true, newPlan: false }, {});
  assert.notEqual(noNewPlan.state, STATES.REVERSAL_RECLAIM);
});

// ── Scenario 8: stale / missing intraday data → fail closed ───────────────────
test('8. missing/stale current-session evidence fails closed — never green/actionable', () => {
  // No intraday ev at all (Stage-2 unavailable) → daily fallback → prior-session watch, not actionable.
  const noIntraday = classifyPool([himsDaily()], { now: NOW });
  assert.equal(noIntraday.HIMS.card.actionable, false);
  assert.equal(noIntraday.HIMS.card.currentSessionFresh, false);
  // An intraday ev whose bar is TOO OLD (beyond the tolerance) is not actionable-fresh.
  const staleBar = {
    ticker: 'HIMS', now: NOW, session: 'regular',
    freshness: { candidateDate: '2026-07-24', intradayBarAsOf: '2026-07-24T14:30:00Z', freshnessStatus: 'FRESH_TODAY', barIsToday: true },
    aboveVwap: true, momentumOk: true, residualOk: true, relVolOk: true, triggerConfirmed: true, remainingRR: 2, extensionAtr: 0.5,
    metrics: { last: 101, vwap: 100 },
  };
  const byT = classifyPool([himsDaily({ freshness: { candidateDate: '2026-07-24', barIsToday: true } })], { now: NOW, evByTicker: { HIMS: staleBar } });
  assert.equal(byT.HIMS.card.currentSessionFresh, false, 'a 30-min-old bar is past the actionable-fresh tolerance');
  // Timing on stale data is not eligible.
  const t = scoreTiming({ price: 101, dayHigh: 102, dayLow: 99, prevClose: 100, vwap: 100, rvol: 1.5, marketState: 'REGULAR' }, {}, undefined, { currentSessionFresh: false });
  assert.equal(t.notEligible, true);
});

// ── Scenario 9: the downstream Today normalizer refuses stale/retired rows ─────
test('9. a stale or retired daytrade row cannot become a Today long even with relScore=100 / high carry', () => {
  const stale = { ticker: 'HIMS', entry: 100, stop: 95, target: 110, rr: 2, last: 100, relScore: 100, carry: 65,
    lifecycleState: 'PRIOR_SESSION_WATCH', actionable: false, currentSessionFresh: false, thesisValid: null };
  assert.deepEqual(N.fromDayTrade({ bestOpportunities: [stale] }), [], 'prior-session row never becomes a Today long');
  const retired = { ...stale, lifecycleState: 'FAILED', thesisValid: false };
  assert.deepEqual(N.fromDayTrade({ bestOpportunities: [retired] }), []);
  // A genuinely actionable row DOES pass — and relScore is carried as a PERCENTILE, not confidence.
  const live = { ticker: 'AAA', entry: 20, stop: 19, target: 23, rr: 2, last: 21, relScore: 100, carry: 60,
    lifecycleState: 'ACTIONABLE_NOW', actionable: true, currentSessionFresh: true, thesisValid: true, planValid: true };
  const [sig] = N.fromDayTrade({ bestOpportunities: [live] });
  assert.equal(sig.ticker, 'AAA');
  assert.equal(sig.rawConfidence, 55, 'confidence is a modest base, NOT the relScore percentile');
  assert.equal(sig.percentile, 100, 'relScore is preserved as a within-pool percentile');
});

// ── Scenario 10: RTH — stale cache/CDN data cannot masquerade as actionable ────
test('10. during RTH a stale prior-session name is never actionable regardless of carry/relScore', () => {
  // Simulate a whole pool of prior-session movers (the RTH default off the pre-open cache).
  const pool = [himsDaily(), himsDaily({ ticker: 'ZZZ', relScore: 99, carry: 64, candidateDate: '2026-07-23',
    freshness: { candidateDate: '2026-07-23', dailyBarAsOf: '2026-07-23', freshnessStatus: 'PRIOR_SESSION', barIsToday: false } })];
  const { lanes, counts } = bucketLanes(classifyPool(pool, { now: NOW }));
  assert.equal(counts.actionableNow, 0, 'nothing actionable off a stale cache during RTH');
  assert.equal(counts.priorSessionWatch, 2);
  assert.deepEqual(buildBestOpportunities(lanes.actionableNow), [], 'Best Opportunities is empty, not backfilled with stale names');
});
