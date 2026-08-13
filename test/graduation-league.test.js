'use strict';
// Acceptance tests for the graduation-league P0/P1 repairs (2026-08-12):
// shadow-strategy influence stripped from user surfaces, grading-spine breaks
// (noHistory projection, degenerate sector control, cheapest-tier costing),
// execution honesty (gap-through exits, exit-leg friction, >100% exposure),
// PIT honesty (Form 4 publication gating), and registry consistency.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── F-05: unknown-liquidity sections must not assume the cheapest cost tier ──
test('tierForPick: unstamped lead-only sections default to their universe tier, not liquid', () => {
  const { tierForPick, roundTripCostPct } = require('../lib/costs');
  // Anomaly scans MICRO_CAPS by design.
  assert.equal(tierForPick({ section: 'Anomaly', ticker: 'X' }), 'micro');
  // Mixed-universe narrative sleeves default to small, never liquid.
  for (const section of ['SecondWave', 'CrossAsset', 'ReadThrough', 'ToneShift', 'Tone', 'Attention', 'Evidence', 'CERN', 'Gridlock']) {
    assert.equal(tierForPick({ section }), 'small', `${section} must not grade at the liquid tier`);
  }
  // A stamped scope always wins, in both directions.
  assert.equal(tierForPick({ section: 'Anomaly', scope: 'large' }), 'liquid');
  assert.equal(tierForPick({ section: 'screener', scope: 'micro' }), 'micro');
  // Genuinely large-cap sections keep the liquid default.
  assert.equal(tierForPick({ section: 'screener' }), 'liquid');
  assert.ok(roundTripCostPct('micro') > roundTripCostPct('liquid'));
});

// ── EA-10: a session opening beyond a barrier fills at the OPEN, not the barrier ──
test('resolveTrade: gap-through stop realizes the open, not the stop price', () => {
  const { resolveTrade } = require('../lib/outcome');
  const candles = [
    { date: '2026-01-02', open: 100, high: 101, low: 99, close: 100 },
    // Opens 10% below the 95 stop — the stop price never traded.
    { date: '2026-01-03', open: 85.5, high: 86, low: 84, close: 85 },
  ];
  const r = resolveTrade(candles, '2026-01-02', 100, 95, 110, 10);
  assert.equal(r.outcome, 'LOSS');
  // Realized exit must be the open (85.5), i.e. −14.5%, NOT the clipped −5%.
  assert.ok(Math.abs(r.r - (85.5 / 100 - 1)) < 1e-9, `expected the gapped open, got ${r.r}`);
  assert.equal(r.gapThrough, true);
});

test('resolveTrade: gap-up through target fills at the open (favorable), and non-gapped exits keep barrier prices', () => {
  const { resolveTrade } = require('../lib/outcome');
  const gapUp = [
    { date: '2026-01-02', open: 100, high: 101, low: 99, close: 100 },
    { date: '2026-01-03', open: 115, high: 116, low: 114, close: 115 },
  ];
  const w = resolveTrade(gapUp, '2026-01-02', 100, 95, 110, 10);
  assert.equal(w.outcome, 'WIN');
  assert.ok(Math.abs(w.r - 0.15) < 1e-9, 'a limit target gapped through fills at the better open');
  const intraday = [
    { date: '2026-01-02', open: 100, high: 101, low: 99, close: 100 },
    { date: '2026-01-03', open: 100, high: 100.5, low: 94, close: 96 },
  ];
  const l = resolveTrade(intraday, '2026-01-02', 100, 95, 110, 10);
  assert.equal(l.outcome, 'LOSS');
  assert.ok(Math.abs(l.r - (95 / 100 - 1)) < 1e-9, 'an intraday touch still fills at the stop');
});

// ── data-lineage F-1: Form 4 knowledge is gated on the FILING date ──
test('aggregateInsider: a transaction filed after asOf is not yet public knowledge', () => {
  const { aggregateInsider } = require('../lib/edgar');
  const tx = { date: '2026-08-01', filingDate: '2026-08-05', code: 'P', value: 500000, shares: 1000, owner: 'CEO' };
  // asOf between transaction and filing: excluded (was included before the fix).
  assert.equal(aggregateInsider([tx], { asOf: '2026-08-03' }), null);
  // asOf on/after the filing date: included.
  const after = aggregateInsider([tx], { asOf: '2026-08-05' });
  assert.ok(after && after.buys && after.buys.tx === 1);
});

// ── RT-09/F3/F-13 + F2: registry consistency ──
test('strategy registry: only screener (and pinned DT) are production; orphans are registered', () => {
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  const prod = STRATEGY_REGISTRY.filter(e => e.maturity === 'production').map(e => e.id).sort();
  assert.deepEqual(prod, ['daytrade', 'screener'], 'production set must match the declared posture');
  const ids = new Set(STRATEGY_REGISTRY.map(e => e.id));
  assert.ok(ids.has('evolve'), 'EVOLVE must have a registry identity (census F2)');
  assert.ok(ids.has('govdemand'), 'govdemand must have a registry identity (census F2)');
  const ignition = STRATEGY_REGISTRY.find(e => e.id === 'ignition');
  assert.equal(ignition.maturity, 'shadow');
});

// ── PR-02: every canonical strategy id reachable from a Scoreboard section must
// resolve to an evidence family (a silent null means FULL independence credit) ──
test('SOURCE_FAMILY covers every SECTION_TO_ID value', () => {
  const { SOURCE_FAMILY } = require('../lib/decision');
  const { SECTION_TO_ID } = require('../lib/strategy-contracts');
  const missing = [...new Set(Object.values(SECTION_TO_ID))].filter(id => !SOURCE_FAMILY[id]);
  assert.deepEqual(missing, [], `unmapped canonical ids get prior credit 1.0: ${missing.join(', ')}`);
});

// ── QM-5/EA-7: portfolio sim daily exposure can never exceed 100% ──
test('simulatePortfolio: turnover-day overlap renormalizes weights (Σweights ≤ 1)', () => {
  const { simulatePortfolio } = require('../api/backtest');
  const axis = ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07'];
  const cm = { A: { '2026-01-02': 100, '2026-01-05': 110, '2026-01-06': 110, '2026-01-07': 110 },
               B: { '2026-01-02': 100, '2026-01-05': 100, '2026-01-06': 105, '2026-01-07': 105 } };
  // A exits on the same day B enters, at maxPos=1 — the audited >100% shape.
  const accepted = [
    { name: 'A', entryDate: '2026-01-02', exitDate: '2026-01-05', entry: 100, r: 0.10 },
    { name: 'B', entryDate: '2026-01-05', exitDate: '2026-01-07', entry: 100, r: 0.05 },
  ];
  const sim = simulatePortfolio(accepted, axis, cm, 1);
  // Average exposure over 3 daily steps must be ≤ 1 with the overlap day renormalized.
  assert.ok(sim.exposSum / 3 <= 1 + 1e-9, `avg exposure ${(sim.exposSum / 3).toFixed(3)} exceeds 1`);
  assert.ok(Number.isFinite(sim.eq));
});

// ── EA-6: the exit leg is no longer friction-free ──
test('simAtrTrade: a flat zero-edge series realizes ≈ −(round trip), not 0', () => {
  const bt = require('../api/backtest');
  const { perSideSlippagePct } = require('../lib/execution-policy');
  const n = 30;
  const c = Array.from({ length: n }, (_, i) => ({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, open: 100, high: 100.01, low: 99.99, close: 100 }));
  const closes = c.map(x => x.close), highs = c.map(x => x.high), lows = c.map(x => x.low);
  const t = bt.simAtrTrade(c, closes, highs, lows, 0.5, 0, 'liquid');
  assert.ok(t, 'trade must fill');
  const s = perSideSlippagePct('liquid');
  // Entry pays one side (fill above open), exit pays the other: ≈ −2s total.
  assert.ok(t.r < 0, 'zero-edge trade must lose the friction');
  assert.ok(Math.abs(t.r - (100 / (100 * (1 + s)) - 1 - s)) < 1e-6, `expected ≈ −2×perSide, got ${t.r}`);
});

// ── F-02/F-03: sector control prefers the cost-net channel and labels its basis ──
test('gradeTrack: sector baseline uses the NET channel when present, labeled', () => {
  const { gradeTrack } = require('../lib/maturity');
  const track = {
    excessN: 60, avgExcess: 2, beatMktRate: 60, netExcessN: 60, avgNetExcess: 1.4, netBeatMktRate: 55,
    secExcN: 60, avgSecExcess: 2.0, beatSecRate: 58,
    netSecExcN: 60, avgNetSecExcess: -0.2, netBeatSecRate: 45,
    dates: 30,
  };
  const g = gradeTrack(track, { fillVerified: false, noHistoryRate: 0 });
  assert.equal(g.stats.baselines.sector.basis, 'net');
  assert.equal(g.stats.baselines.sector.avgExcess, -0.2, 'gross +2.0 must not mask a net-negative sector record');
  assert.equal(g.stats.baselines.market.basis, 'net');
});

// ── F-01: the persisted scoreboard summary must carry the survivorship counter ──
test('scoreboard summary projection retains noHistory (source contract)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/apex-routes.js'), 'utf8');
  const proj = src.match(/groups: out\.map\(g => \(\{[^}]+\}\)\)/);
  assert.ok(proj, 'summary projection not found');
  assert.match(proj[0], /noHistory/, 'projection must persist noHistory — maturity derives the ungradeable ceiling from it');
  // And the market channel prefers the independent SPY series (F-02).
  assert.match(src, /x\.mktExc != null && Number\.isFinite\(x\.mktExc\)\) \? x\.mktExc : x\.exc/);
  assert.match(src, /netSecExc/, 'cost-net sector channel must exist');
});

// ── RT-02: a shadow Apex read may not add 'for' weight in WHY NOW ──
test('whynow: apex/conviction contribute context, not verdict weight, while shadow', () => {
  const { composeWhyNow } = require('../lib/whynow');
  const r = composeWhyNow({
    ticker: 'TEST',
    apex: { tier: 'apex', score: 90 },
    ghost: null,
    conviction: { sleeveA: true, score: 88, pctile: 95 },
    macro: null,
  });
  const forKeys = (r.forCase || []).map(x => x.key);
  assert.ok(!forKeys.some(k => String(k).startsWith('Apex:')), 'shadow Apex must not sit in the for-column');
  assert.ok(!forKeys.includes('Conviction:sleeveA'), 'shadow conviction must not sit in the for-column');
});

// ── RT-01/RT-03 (source contracts on client/server surfaces) ──
test('client surfaces: no shadow-strategy weight in the Opportunities rank; gapgo size gated', () => {
  const opp = fs.readFileSync(path.join(__dirname, '../public/js/opportunities.js'), 'utf8');
  const rank = opp.slice(opp.indexOf('export function rankOpportunities'), opp.indexOf('function smartMoney'));
  assert.ok(!/conviction\?\.score|GHOST_VAL\[/.test(rank), 'rank must be invariant to conviction/ghost inputs');
  assert.ok(!/relWeight\(|\* healthFactor/.test(rank), 'rank must not carry reliability/drift scalars');
  assert.ok(!/opp-sleevea/.test(opp), 'the conviction sleeveA badge may not render while shadow');
  const sr = fs.readFileSync(path.join(__dirname, '../lib/screener-routes.js'), 'utf8');
  assert.match(sr, /gapgoSizeEligible/, 'gapgo suggestedRiskPct must be registry-gated');
  const scr = fs.readFileSync(path.join(__dirname, '../api/screener.js'), 'utf8');
  assert.match(scr, /apexBadgeEligible/, 'the Prime standout badge must be registry-gated');
});

// ── EA-1/EA-2: Core Performance carries MTM and net lanes ──
test('aggregatePerformance: open positions are marked and costs are charged', () => {
  const core = require('../lib/stablecore');
  const signals = [
    { ticker: 'AAA', date: '2026-01-05', quarter: '2026-Q1', entry: 100 },
    { ticker: 'BBB', date: '2026-01-05', quarter: '2026-Q1', entry: 50 },
  ];
  const resolved = { 'AAA|2026-01-05': { outcome: 'WIN', r: 0.10 } };
  const marks = new Map([['BBB|2026-01-05', 55]]); // open, +10%
  const perf = core.aggregatePerformance(signals, resolved, null, 63, { costPct: 0.6, marks });
  assert.equal(perf.mtm.openN, 1);
  assert.equal(perf.mtm.openMarked, 1);
  assert.ok(Math.abs(perf.mtm.openAvg - 0.10) < 1e-9);
  assert.ok(Math.abs(perf.mtm.openAvgNet - (0.10 - 0.006)) < 1e-9);
  assert.ok(Math.abs(perf.mtm.combinedAvg - 0.10) < 1e-9);
  assert.ok(Math.abs(perf.totals.meanReturnNet - (0.10 - 0.006)) < 1e-9);
  // Resolved-only fields unchanged (additive contract).
  assert.equal(perf.totals.resolved, 1);
  assert.ok(Math.abs(perf.totals.meanReturn - 0.10) < 1e-9);
});
