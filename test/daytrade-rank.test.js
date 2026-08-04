'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assignRelScores, buildBestOpportunities, stampGate } = require('../lib/screener-routes');
const { SCANS, passesScan } = require('../lib/daytrade');
const { pcarryPriceFeatures } = require('../lib/pcarry');

// Build pcarry price features (_cf) from a synthetic candle series ending on the signal day.
// `todayPct` = today's % move, `adrPct` = typical daily range %, `nearHighFrac` = close vs 5d high.
const cfFor = (todayPct, adrPct = 4, nearHighFrac = 0.99) => {
  const c = [];
  let px = 100;
  for (let i = 0; i < 25; i++) { const h = px * (1 + adrPct / 200), l = px * (1 - adrPct / 200); c.push({ close: px, high: h, low: l }); }
  const prev = c[c.length - 1].close;
  const close = prev * (1 + todayPct / 100);
  const high5 = close / nearHighFrac;
  c.push({ close, high: Math.max(high5, close), low: close * 0.98 });
  return pcarryPriceFeatures(c);
};

// These fixtures exercise the best-gate-v2 RANKING. Admission is intraday-validated (the
// full lifecycle envelope + a live plan + execution gate) — carry/overextension only rank.
const LIVE_PLAN_FIX = { basis: 'live-intraday', entry: 10, stop: 9.5, target: 11, rr: 2, riskPct: 5, expiresAt: '2099-01-01T00:00:00Z' };
const mk = (ticker, relVol, pctChange, excessPct, extra = {}) => ({
  ticker, relVol, pctChange, excessPct, last: 10, score: relVol * 10 + pctChange,
  barIsToday: true, freshness: { freshnessStatus: 'FRESH_TODAY', barIsToday: true },
  // best-gate-v2 admission envelope (the live route stamps these after Stage-2 validation).
  actionable: true, lifecycleState: 'ACTIONABLE_NOW', currentSessionFresh: true,
  thesisValid: true, planValid: true, livePlan: { ...LIVE_PLAN_FIX },
  execution: { gate: { blocked: false, reasons: [] } },
  ...extra,
});

test('assignRelScores: assigns 0-100 with the strongest pick at 100 and weakest at 0', () => {
  const ml = [mk('A', 5, 12, 11), mk('B', 1.3, 3, 2)];
  const es = [mk('C', 3, 20, 19)];
  assignRelScores([ml, es]);
  const all = [...ml, ...es];
  assert.ok(all.every(p => p.relScore >= 0 && p.relScore <= 100), 'scores in range');
  const top = all.reduce((a, b) => (a.relScore > b.relScore ? a : b));
  const bot = all.reduce((a, b) => (a.relScore < b.relScore ? a : b));
  assert.equal(top.relScore, 100);
  assert.equal(bot.relScore, 0);
  assert.equal(top.ticker, 'C', 'the strongest mover scores highest');
});

test('assignRelScores: single pick gets a valid score, no divide-by-zero', () => {
  const one = [mk('X', 2, 5, 4)];
  assignRelScores([one]);
  assert.ok(Number.isFinite(one[0].relScore));
});

test('12. pcarry (a 3-session multi-day model) can NO LONGER suppress a valid intraday setup', () => {
  // best-gate-v2: a below-base-rate carry name with a fully-validated intraday setup is
  // ADMITTED and merely ranks lower — the old hard carry floor was a multi-day model
  // vetoing a same-day question.
  const pool = [
    mk('LIQCLEAN', 4, 9, 8, { scan: 'momentum_liquid', tier: 'A', carry: 55 }),
    mk('EXPWEAK', 3, 12, 10, { scan: 'explosive_small', carry: 45 }),
  ];
  assignRelScores([pool]);
  const best = buildBestOpportunities(pool);
  assert.deepEqual(best.map(b => b.ticker), ['LIQCLEAN', 'EXPWEAK'], 'both admitted; carry only ranks');
  assert.equal(best[0].gateVersion, 'best-gate-v2');
});

test('buildBestOpportunities: overextension DISCOUNTS the rank; dilution/M&A pops stay excluded', () => {
  const pool = [
    mk('CLEAN', 3, 7, 6, { scan: 'momentum_liquid', tier: 'A', carry: 55 }),
    mk('BLOWOFF', 6, 30, 28, { scan: 'momentum_liquid', tier: 'A', carry: 55, overextended: true }),
    mk('DILUTE', 3, 8, 7, { scan: 'momentum_liquid', tier: 'A', carry: 55, catalyst: 'FADE_OFFERING' }),
    mk('MERGER', 3, 8, 7, { scan: 'momentum_liquid', tier: 'A', carry: 55, catalyst: 'MA' }),
  ];
  assignRelScores([pool]);
  const best = buildBestOpportunities(pool);
  assert.deepEqual(best.map(b => b.ticker), ['CLEAN', 'BLOWOFF'], 'blow-off admitted but ranked below; fade catalysts excluded');
});

test('buildBestOpportunities: unknown carry ranks at the base rate; the lifecycle envelope is the admission', () => {
  const pool = [
    mk('UP', 3, 7, 6, { scan: 'momentum_liquid', tier: 'A', carry: 52 }),
    mk('NOCARRY', 3, 5, 4, { scan: 'momentum_liquid', tier: 'A', carry: null }),   // unknown → base-rate rank, still admitted
    mk('LOWCARRY', 3, 5, 4, { scan: 'momentum_liquid', tier: 'A', carry: 48 }),
    // No lifecycle envelope (never Stage-2 validated) → excluded regardless of daily flags.
    { ticker: 'UNVALIDATED', relVol: 3, pctChange: 9, excessPct: 8, last: 10, barIsToday: true, carry: 60 },
  ];
  assignRelScores([pool.filter(p => p.relScore === undefined)]);
  const best = buildBestOpportunities(pool);
  assert.deepEqual(best.map(b => b.ticker), ['UP', 'NOCARRY', 'LOWCARRY'], 'carry orders; envelope admits');
});

test('buildBestOpportunities: an unvalidated pool returns [] (honest empty state) and a blocked execution gate excludes', () => {
  // Picks with no lifecycle envelope (never Stage-2 validated) cannot enter the actionable
  // lane no matter how bullish the daily numbers — an honest empty state, never a backfill.
  const unvalidated = [
    { ticker: 'X', relVol: 5, pctChange: 25, excessPct: 24, last: 10, barIsToday: true, carry: 60 },
    { ticker: 'Y', relVol: 3, pctChange: 6, excessPct: 5, last: 10, barIsToday: true, carry: 55 },
  ];
  assert.deepEqual(buildBestOpportunities(unvalidated), [], 'no envelope → empty, not backfilled');
  // A validated name whose EXECUTION gate blocked (risk too small vs costs, spread, ...) is
  // excluded from buy language even with a green signal gate.
  const blocked = mk('BLOCKED', 3, 6, 5, { scan: 'momentum_liquid', tier: 'A', carry: 60, execution: { gate: { blocked: true, reasons: ['plan risk 20bps < 3× round-trip cost 30bps'] } } });
  assert.deepEqual(buildBestOpportunities([blocked]), [], 'execution-blocked → excluded from Best Opportunities');
});

test('buildBestOpportunities: ranks #1..N by carry odds and caps the list', () => {
  // all above the carry floor so the cap (not the gate) governs the length
  const pool = Array.from({ length: 12 }, (_, i) => mk('T' + i, 2 + i * 0.3, 4 + i, 3 + i, { scan: 'momentum_liquid', tier: 'A', carry: 50 + i }));
  assignRelScores([pool]);
  const best = buildBestOpportunities(pool, 8);
  assert.equal(best.length, 8);
  assert.deepEqual(best.map(b => b.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (let i = 1; i < best.length; i++) assert.ok(best[i - 1].carry >= best[i].carry, 'sorted by carry desc');
});

test('stampGate: flags a clean, near-high, non-overextended momentum name as gated', () => {
  const cf = cfFor(5, 4, 0.99);   // +5% today, normal range, holding near the 5d high
  const g = stampGate({ scan: 'momentum_liquid', pctChange: 5, _cf: cf }, 'neutral');
  assert.equal(typeof g.gated, 'boolean');
  assert.ok(g.carry >= 50, 'above-base-rate carry');
  assert.equal(g.overextended, false);
  assert.equal(g.gated, true);
});

test('stampGate: flags an overextended blow-off as NOT gated', () => {
  const cf = cfFor(28, 4, 0.99);  // +28% on a ~4% ADR = extADR ~7 = blow-off
  const g = stampGate({ scan: 'momentum_liquid', pctChange: 28, _cf: cf }, 'neutral');
  assert.equal(g.overextended, true);
  assert.equal(g.gated, false);
});

test('stampGate: explosive small-cap base rate keeps a marginal name below the gate', () => {
  const cf = cfFor(9, 5, 0.99);
  const g = stampGate({ scan: 'explosive_small', pctChange: 9, _cf: cf }, 'neutral');
  assert.ok(g.carry < 50, 'explosive base-rate offset pushes carry below the floor');
  assert.equal(g.gated, false);
});

test('stampGate: missing pcarry features degrades gracefully (not gated)', () => {
  const g = stampGate({ scan: 'momentum_liquid', pctChange: 5 }, 'neutral');
  assert.deepEqual(g, { carry: null, overextended: null, gated: false });
});

test('SCANS.momentum_building is a real relaxation of momentum_liquid (surfaces more picks)', () => {
  const b = SCANS.momentum_building, a = SCANS.momentum_liquid;
  assert.ok(b.minRelVol < a.minRelVol && b.minPct < a.minPct, 'looser thresholds');
  // a mid-strength mover clears building but not the strict liquid bar
  const m = { last: 20, avgVol: 2e6, avgDollarVol: 4e7, relVol: 1.3, pctChange: 3.5 };
  assert.equal(passesScan(m, a), false, 'fails strict');
  assert.equal(passesScan(m, b), true, 'passes building');
});
