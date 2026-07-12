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
  // Every top signal has a rank, score, state, evidence.
  for (const s of p.top) { assert.ok(s.rank >= 1); assert.ok('score' in s); assert.ok(s.state); assert.ok(s.evidence); }
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
