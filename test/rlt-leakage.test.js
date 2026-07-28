'use strict';
// RLT time-travel / leakage guards — the single most important property of the
// whole system: a feature computed for decision date D must be BYTE-IDENTICAL
// whether or not the input series carries bars after D. If this ever breaks,
// every backtest silently trains on the future.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPeerUniverse } = require('../lib/rlt-universe');
const { buildLeadership } = require('../lib/rlt-leadership');
const { computeRltFeatures } = require('../lib/rlt-features');
const RES = require('../lib/atlasx-residual');

function mkBars(n, seed = 1, drift = 0.001) {
  let p = 50 + seed;
  const out = [];
  const d0 = new Date('2026-01-05');
  let day = 0;
  while (out.length < n) {
    const dt = new Date(d0.getTime() + day * 86400000); day++;
    const wd = dt.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    p = p * (1 + drift + 0.012 * Math.sin(seed + out.length * 0.7));
    out.push([dt.toISOString().slice(0, 10), p * 0.997, p * 1.008, p * 0.992, p, 1e6 + 1e4 * out.length, p]);
  }
  return out;
}

function scanAt({ extraBars = 0 } = {}) {
  const spyFull = mkBars(140 + extraBars, 0, 0.0008);
  const asOfIdx = 139;
  const asOf = spyFull[asOfIdx][0];
  const rows = Array.from({ length: 10 }, (_, i) => ({
    ticker: 'T' + i, sector: 'Technology', price: 60, dollarVol: 5e6,
    capGroup: 'large', scope: 'large', bars: mkBars(140 + extraBars, i + 1, 0.0006 + 0.0003 * i),
  }));
  const cal = RES.asOfSlice(RES.toBars(spyFull), asOf).map(b => b.date);
  const universe = buildPeerUniverse({ rows, asOf, calendarDates: cal, decisionTs: asOf + 'T21:00:00Z' });
  const leadership = buildLeadership({
    universe, spyBars: spyFull, sectorBarsFor: () => mkBars(140 + extraBars, 99, 0.0007),
  });
  const row = universe.rows.find(r => r.ticker === 'T7');
  const features = computeRltFeatures({ bars: row.bars, series: leadership.seriesByTicker.T7 });
  return { asOf, lead: leadership.byTicker.T7, features };
}

test('THE LEAKAGE GUARD: appending 21 future sessions changes NOTHING at the cutoff', () => {
  const base = scanAt({ extraBars: 0 });
  const withFuture = scanAt({ extraBars: 21 });
  assert.equal(base.asOf, withFuture.asOf, 'fixture must compare the same decision date');
  assert.deepEqual(
    JSON.parse(JSON.stringify(withFuture.lead)),
    JSON.parse(JSON.stringify(base.lead)),
    'leadership features leaked future bars');
  assert.deepEqual(
    JSON.parse(JSON.stringify(withFuture.features)),
    JSON.parse(JSON.stringify(base.features)),
    'path/turnover/setup features leaked future bars');
});

test('beta estimation is PIT: fitted only from bars at or before the cutoff', () => {
  const base = scanAt({ extraBars: 0 });
  const withFuture = scanAt({ extraBars: 40 });
  assert.equal(withFuture.lead.beta, base.lead.beta, 'beta fitted on forward observations');
  assert.equal(withFuture.lead.sectorLoading, base.lead.sectorLoading);
});

test('continuous features stay continuous — never coerced to booleans', () => {
  const { lead, features } = scanAt({});
  for (const [k, v] of Object.entries({
    pctile: lead.pctile, rankVel5: lead.rankVel5,
    smoothness: features.path.smoothness,
    turnoverPctile: features.turnover.turnoverPctile,
    compressionPctile: features.setup.compressionPctile,
  })) {
    assert.ok(v === null || (typeof v === 'number' && Number.isFinite(v)),
      `${k} should be numeric/null, got ${typeof v} ${v}`);
    assert.notEqual(typeof v, 'boolean', `${k} must not be coerced to a boolean`);
  }
});

test('evidence axes stay SEPARATE: absolute, market-residual, sector-residual, rank', () => {
  const { lead } = scanAt({});
  assert.ok('positiveAbsolute' in lead);
  assert.ok('positiveMarketResidual' in lead);
  assert.ok('positiveSectorResidual' in lead);
  assert.ok('pctile' in lead);
  assert.ok('rankVel5' in lead);
  assert.ok('leaderOnPeerWeaknessOnly' in lead, 'peer-collapse guard must exist');
});
