'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('../lib/decision-normalizers');
const { buildToday } = require('../lib/decision-routes');

// Realistic-shaped fixtures (trimmed from live prod responses).
const SCREENER = {
  regime: { indexAbove200: true, breadthPct: 69, bearish: false, riskOn: true, condition: 'mixed' },
  results: [
    { ticker: 'AAA', company: 'Alpha', sector: 'Technology', status: 'Setup', price: 100,
      levels: { entry: 102, stop: 96, target: 120, rr: 3 }, factors: { dollarVol: 5e8, mom63: 40 },
      ghost: { tier: 'GHOST', score: 90 }, quant: { score: 82 } },
    { ticker: 'BBB', company: 'Beta', sector: 'Energy', status: 'Early', price: 20,
      levels: { entry: 21, stop: 19, target: 27, rr: 3 }, factors: { dollarVol: 1e6, mom63: 10 },
      ghost: { tier: 'WATCH', score: 55 }, quant: { score: 60 } },
  ],
};
const GAPGO = { strong: [{ ticker: 'AAA', sector: 'Technology', last: 101, tier: 'STRONG', continuationScore: 75,
  avgDollarVol: 4e7, plan: { trigger: 103, stop: 98, target: 112, rr: 2 }, nextEarnings: null, cause: 'NEWS' }] };
const DAYTRADE = { bestOpportunities: [{ ticker: 'CCC', sector: 'Health Care', last: 30, tier: 'B', relScore: 67,
  entry: 30.2, stop: 28.5, target: 34, rr: 2, source: 'Momentum & Liquid', catalyst: 'GUIDE' }] };
const COIL = { picks: [{ ticker: 'DDD', company: 'Delta', sector: 'Utilities', price: 70, decile: 10, band: 'high',
  entry: 70.6, stop: 69, target: 76, rr: 3.2 }] };
const SECTORS = { sectors: [{ name: 'Technology', changePct: 1.5 }, { name: 'Energy', changePct: 0.2 }, { name: 'Utilities', changePct: -0.9 }] };
const SCOREBOARD = { groups: [{ section: 'screener', tier: 'Setup', horizons: { '5d': { avgExcess: 3, winRate: 58, n: 30 } } }] };
const AI = { rt: { items: [{ beneficiary_ticker: 'EEE', mechanism: 'reads through from AAA', directness: 70, moved: { alreadyMoved: false } }] } };

const GAPDOWN = { strong: [{ ticker: 'ZZZ', sector: 'Technology', last: 13, tier: 'STRONG', side: 'short', continuationScore: 60,
  avgDollarVol: 4e7, plan: { trigger: 11.5, stop: 14.2, target: 6.2, rr: 2, side: 'short' }, nextEarnings: null }] };
const BIOTECH = { items: [{ ticker: 'AGIO', tier: 'Hot', score: 85, last: 44, relVol: 2.3, classification: 'FDA', catalyst_timing: 'Ahead' },
  { ticker: 'WCH', tier: 'Watch', score: 40, last: 5 }] };

test('fromGapDown: intraday SHORT with inverted levels', () => {
  const s = N.fromGapDown(GAPDOWN)[0];
  assert.equal(s.side, 'short');
  assert.equal(s.horizon, 'intraday');
  assert.equal(s.target < s.entry, true); // short: target below entry
  assert.equal(s.section, 'GapDown');
});

test('fromBiotech: only Hot/Emerging, catalyst family, no levels', () => {
  const b = N.fromBiotech(BIOTECH);
  assert.equal(b.length, 1);            // Watch excluded
  assert.equal(b[0].ticker, 'AGIO');
  assert.ok(b[0].evidenceFamilies.includes('catalystForcedFlow'));
  assert.equal(b[0].entry, undefined);  // no published levels
});

test('fromCoreMomentum: fills the portfolio horizon with rank→percentile confidence', () => {
  const c = N.fromCoreMomentum({ book: [
    { ticker: 'MMM', sector: 'Industrials', price: 100, rank: 1, marketCap: 5e9 },
    { ticker: 'NNN', sector: 'Energy', price: 40, rank: 2, marketCap: 2e9 },
  ] });
  assert.equal(c.length, 2);
  assert.equal(c[0].horizon, 'portfolio');
  assert.equal(c[0].percentile, 100);            // rank 1 of 2 → top
  assert.ok(c[0].rawConfidence > c[1].rawConfidence, 'higher rank → higher confidence');
  assert.ok(c[0].evidenceFamilies.includes('priceTrend'));
  assert.equal(c[0].entry, undefined);           // no intraday levels — quarterly hold
});

test('buildToday: Core Momentum populates the portfolio bucket', () => {
  const p = buildToday({ coremo: { book: [{ ticker: 'MMM', sector: 'Industrials', price: 100, rank: 1, marketCap: 5e9 }] }, scoreboard: SCOREBOARD });
  assert.ok(p.horizons.portfolio.find(x => x.ticker === 'MMM'), 'MMM in portfolio horizon');
});

test('buildToday: gap-down shorts rank ABOVE longs in risk-off (validated lever)', () => {
  const off = { ...SCREENER, regime: { ...SCREENER.regime, bearish: true, riskOn: false } };
  const p = buildToday({ screener: off, gapdown: GAPDOWN, sectors: SECTORS, scoreboard: SCOREBOARD });
  const zzz = p.horizons.intraday.find(x => x.ticker === 'ZZZ');
  const aaa = p.horizons.swing.find(x => x.ticker === 'AAA');
  assert.ok(zzz, 'short present in risk-off');
  assert.ok(zzz.score > aaa.score, 'short outranks a long in risk-off');
});

test('fromScreener: attaches breakout + ghost + fundamentals evidence families', () => {
  const sigs = N.fromScreener(SCREENER);
  assert.equal(sigs.length, 2);
  const aaa = sigs.find(s => s.ticker === 'AAA');
  assert.deepEqual(aaa.evidenceFamilies, ['priceTrend', 'volumeAccum']); // GHOST tier adds volume family
  assert.equal(aaa.horizon, 'swing');
  assert.equal(aaa.section, 'screener');
  assert.equal(aaa.liquidity.dollarVol, 5e8);
});

test('fromGapGo / fromDayTrade / fromCoil map levels + horizon correctly', () => {
  assert.equal(N.fromGapGo(GAPGO)[0].horizon, 'intraday');
  assert.equal(N.fromGapGo(GAPGO)[0].entry, 103);
  assert.equal(N.fromDayTrade(DAYTRADE)[0].horizon, 'intraday');
  assert.equal(N.fromCoil(COIL)[0].horizon, 'swing');
  assert.ok(N.fromCoil(COIL)[0].rawConfidence >= 75); // decile 10
});

test('sectorStrength: ranks leading/weakening and scores names -1..1', () => {
  const s = N.sectorStrength(SECTORS);
  assert.equal(s.leading[0].name, 'Technology');
  assert.equal(s.weakening[0].name, 'Utilities');
  assert.equal(s.byName['Technology'], 1);
  assert.equal(s.byName['Utilities'], -1);
});

test('buildToday: merges AAA across screener+gapgo into one multi-family signal', () => {
  const p = buildToday({ screener: SCREENER, gapgo: GAPGO, daytrade: DAYTRADE, coil: COIL, sectors: SECTORS, scoreboard: SCOREBOARD, ai: AI });
  // AAA appears in screener(swing) and gapgo(intraday) — different horizons, so NOT merged,
  // but its swing copy carries priceTrend+volumeAccum (breakout+ghost).
  const swingAAA = p.horizons.swing.find(x => x.ticker === 'AAA');
  assert.ok(swingAAA.evidence.familyCount >= 2);
  assert.equal(p.horizons.intraday.some(x => x.ticker === 'AAA'), true); // gapgo intraday
  assert.equal(p.horizons.intraday.some(x => x.ticker === 'CCC'), true); // daytrade
});

test('buildToday: horizon buckets are disjoint and regime/sectors populated', () => {
  const p = buildToday({ screener: SCREENER, gapgo: GAPGO, daytrade: DAYTRADE, coil: COIL, sectors: SECTORS, scoreboard: SCOREBOARD, ai: AI });
  assert.equal(p.regime.label, 'Risk-on');
  assert.equal(p.sectors.leading[0].name, 'Technology');
  assert.equal(p.counts.byHorizon.swing, p.horizons.swing.length);
  // Every top signal has a rank, score, state, evidence, and a hold window.
  for (const s of p.top) { assert.ok(s.rank >= 1); assert.ok('score' in s); assert.ok(s.state); assert.ok(s.evidence); assert.ok(s.holdWindow); }
});

test('buildToday: top shortlist is the single ranked list, capped at 10 and rank-ordered', () => {
  const p = buildToday({ screener: SCREENER, gapgo: GAPGO, daytrade: DAYTRADE, coil: COIL, sectors: SECTORS, scoreboard: SCOREBOARD, ai: AI });
  assert.ok(p.top.length <= 10);
  for (let i = 1; i < p.top.length; i++) assert.ok(p.top[i - 1].rank <= p.top[i].rank); // ascending rank
  assert.ok(p.lanes.resolved !== undefined); // resolved lane always present (rendered on Today)
});

test('buildToday: risk-off buries longs (validated lever) + all-new lane on day 1', () => {
  const off = { ...SCREENER, regime: { ...SCREENER.regime, bearish: true, riskOn: false } };
  const on = buildToday({ screener: SCREENER, sectors: SECTORS, scoreboard: SCOREBOARD });
  const offP = buildToday({ screener: off, sectors: SECTORS, scoreboard: SCOREBOARD });
  const onAAA = on.horizons.swing.find(x => x.ticker === 'AAA');
  const offAAA = offP.horizons.swing.find(x => x.ticker === 'AAA');
  assert.ok(offAAA.score < onAAA.score * 0.6);
  assert.equal(on.lanes.new.length, on.horizons.swing.length); // day 1: no prev → all new
});

test('buildToday: lanes diff against a previous snapshot', () => {
  const first = buildToday({ screener: SCREENER, sectors: SECTORS, scoreboard: SCOREBOARD });
  const prevRow = first.horizons.swing.map(x => ({ id: x.id, state: x.state, rank: x.rank, score: x.score - 20 }));
  const second = buildToday({ screener: SCREENER, sectors: SECTORS, scoreboard: SCOREBOARD }, { ids: prevRow });
  assert.equal(second.lanes.new.length, 0);                 // all were in prev
  assert.ok(second.lanes.upgraded.length >= 1);             // score rose ≥8 vs prev
});

test('buildToday: remaining-edge (§3) re-ranks a run-up name and emits the model meta', () => {
  // A single name with a wide stop so it stays ACTIVE (triggered, <1R extended) while having
  // consumed ~half its advertised move ($10 origin → $15 now, $10→$20 target).
  const RUNUP = { regime: { riskOn: true, bearish: false, breadthPct: 60 }, results: [
    { ticker: 'RUN', company: 'R', sector: 'Technology', status: 'Setup', price: 15,
      levels: { entry: 10, stop: 4, target: 20, rr: 1.67 }, factors: { dollarVol: 5e8, mom63: 40 }, quant: { score: 80 } },
  ] };
  const base = buildToday({ screener: RUNUP, sectors: SECTORS, scoreboard: SCOREBOARD });
  const runId = base.horizons.swing.find(x => x.ticker === 'RUN').id;
  const origins = { [runId]: { firstPrice: 10, entry: 10, stop: 4, target: 20, side: 'long', horizon: 'swing', bars: 0 } };
  const withOrigins = buildToday({ screener: RUNUP, sectors: SECTORS, scoreboard: SCOREBOARD }, null, null, origins);

  const baseRun = base.horizons.swing.find(x => x.ticker === 'RUN');
  const reRun = withOrigins.horizons.swing.find(x => x.ticker === 'RUN');
  assert.equal(base.remainingEdge.active, false, 'no origins → model dormant');
  assert.equal(withOrigins.remainingEdge.active, true, 'origins → model active');
  assert.equal(baseRun.remainingEdge, null, 'no per-signal report without origins');
  assert.ok(reRun.remainingEdge && reRun.remainingEdge.consumedPct >= 45 && reRun.remainingEdge.consumedPct <= 55);
  assert.equal(reRun.remainingEdge.freshness, 'partially-consumed');
  assert.ok(reRun.score < baseRun.score, `run-up name must be demoted: ${reRun.score} < ${baseRun.score}`);
});

test('classifyEarnings: binary inside window, scheduled beyond, passed if negative', () => {
  assert.equal(N.classifyEarnings(5, '2026-07-16', 'swing').kind, 'binary');   // 5d <= 21d window
  assert.equal(N.classifyEarnings(60, '2026-09-01', 'swing').kind, 'scheduled'); // 60d > 21d
  assert.equal(N.classifyEarnings(-2, '2026-07-09', 'swing').kind, 'passed');
  assert.equal(N.classifyEarnings(null, null, 'swing'), null);
  assert.equal(N.classifyEarnings(5, null, 'intraday').kind, 'scheduled');      // intraday window 3, 5>3 → scheduled
  assert.equal(N.classifyEarnings(2, null, 'intraday').kind, 'binary');         // 2 <= 3 → binary
});
