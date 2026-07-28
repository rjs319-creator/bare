'use strict';
// RLT peer universe — fail-closed eligibility, labeled fallbacks, PIT hygiene.
// Guards the failure modes the phase spec names: fabricated sectors, silent
// sector fallbacks, false-precision percentiles on tiny peer groups, and
// stale/anomalous bars slipping into the cross-section.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPeerUniverse, EXCLUSION, GROUPING } = require('../lib/rlt-universe');
const { percentileWithTies, percentileUncertainty } = require('../lib/rlt-residual');

function mkBars(n, { startPrice = 50, drift = 0.001, lastDate = null, anomalyAt = null } = {}) {
  let p = startPrice;
  const out = [];
  const d0 = new Date('2026-01-05');
  let day = 0;
  while (out.length < n) {
    const dt = new Date(d0.getTime() + day * 86400000); day++;
    const wd = dt.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    p = p * (1 + (anomalyAt === out.length ? 0.9 : drift));
    out.push([dt.toISOString().slice(0, 10), p * 0.997, p * 1.006, p * 0.994, p, 1e6, p]);
  }
  if (lastDate) return out.filter(b => b[0] <= lastDate);
  return out;
}

const CAL = mkBars(80).map(b => b[0]);
const ASOF = CAL[CAL.length - 1];
const okRow = (ticker, over = {}) => ({
  ticker, sector: 'Technology', price: 60, dollarVol: 5e6, capGroup: 'large',
  scope: 'large', bars: mkBars(80), ...over,
});

function build(rows) {
  return buildPeerUniverse({ rows, asOf: ASOF, calendarDates: CAL, decisionTs: ASOF + 'T21:00:00Z' });
}

test('eligibility fails closed on each named condition', () => {
  const uni = build([
    okRow('OK1'), okRow('OK2'), okRow('OK3'), okRow('OK4'),
    okRow('THIN', { bars: mkBars(10) }),
    okRow('STALE', { bars: mkBars(80, { lastDate: CAL[CAL.length - 6] }) }),
    okRow('CHEAP', { price: 0.5 }),
    okRow('ILLIQ', { dollarVol: 100 }),
    okRow('SPLITY', { bars: mkBars(80, { anomalyAt: 70 }) }),
    okRow('DELIST', { nonTradable: true }),
  ]);
  const by = Object.fromEntries(uni.rows.map(r => [r.ticker, r]));
  assert.equal(by.OK1.eligible, true);
  assert.ok(by.THIN.exclusions.includes(EXCLUSION.NO_BARS));
  assert.ok(by.STALE.exclusions.includes(EXCLUSION.STALE));
  assert.ok(by.CHEAP.exclusions.includes(EXCLUSION.NO_PRICE));
  assert.ok(by.ILLIQ.exclusions.includes(EXCLUSION.NO_LIQUIDITY));
  assert.ok(by.SPLITY.exclusions.includes(EXCLUSION.ANOMALY));
  assert.ok(by.DELIST.exclusions.includes(EXCLUSION.NON_TRADABLE));
});

test('missing sector is a MASK, not an exclusion — market-only shadow observation', () => {
  const rows = Array.from({ length: 10 }, (_, i) => okRow('T' + i));
  rows.push(okRow('NOSEC', { sector: null }));
  const uni = build(rows);
  const nosec = uni.rows.find(r => r.ticker === 'NOSEC');
  assert.equal(nosec.eligible, true, 'missing sector must not exclude');
  assert.ok(nosec.missing.includes('sector'));
  assert.equal(nosec.groupingLevel, GROUPING.MARKET);
  assert.match(nosec.groupingFallback, /market-only/);
  assert.equal(nosec.sector, null, 'never fabricate a sector');
});

test('peer-group fallback hierarchy is labeled, never silent', () => {
  // 9 Tech large (>= minPeers 8) → sector-band; 3 Tech micro → falls back to
  // sector (12 members); 3 Energy names → sector too small → market.
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => okRow('TL' + i)),
    ...Array.from({ length: 3 }, (_, i) => okRow('TM' + i, { capGroup: 'micro' })),
    ...Array.from({ length: 3 }, (_, i) => okRow('EN' + i, { sector: 'Energy' })),
  ];
  const uni = build(rows);
  const by = Object.fromEntries(uni.rows.map(r => [r.ticker, r]));
  assert.equal(by.TL0.groupingLevel, GROUPING.SECTOR_BAND);
  assert.equal(by.TL0.groupingFallback, null);
  assert.equal(by.TM0.groupingLevel, GROUPING.SECTOR);
  assert.match(by.TM0.groupingFallback, /fell back to sector/);
  assert.equal(by.EN0.groupingLevel, GROUPING.MARKET);
  assert.match(by.EN0.groupingFallback, /fell back to market/);
});

test('universe snapshot id is deterministic over identical inputs', () => {
  const rows = Array.from({ length: 10 }, (_, i) => okRow('T' + i));
  const a = build(rows);
  const b = build(rows.map(r => ({ ...r })));
  assert.equal(a.universeSnapshotId, b.universeSnapshotId);
});

test('percentile ties resolve by average rank, never false precision', () => {
  // Three-way tie in a 5-name group: all tied names share one percentile.
  const vals = [1, 2, 2, 2, 3];
  const p = percentileWithTies(vals, 2);
  assert.ok(p > 0.4 && p < 0.6, `tied percentile should sit mid-pack, got ${p}`);
  assert.equal(percentileWithTies([5], 5), null, 'a group of one has no rank');
});

test('small peer groups carry LARGER percentile uncertainty', () => {
  const small = percentileUncertainty(0.8, 8);
  const large = percentileUncertainty(0.8, 80);
  assert.ok(small > large, 'uncertainty must shrink with peer-group size');
});
