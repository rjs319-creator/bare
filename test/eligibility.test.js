'use strict';
// quant-redesign-3 Phase-6 battery: central fail-closed eligibility.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EL = require('../lib/eligibility');
const { buildToday } = require('../lib/decision-routes');
const { SOURCES } = require('../test/fixtures/today-sources');

const NOW = Date.parse('2026-07-24T12:00:00Z');
const freshGov = (strategies) => ({ savedAt: '2026-07-24T00:00:00.000Z', strategies });
const GOV_PROD = freshGov([
  { id: 'screener', status: 'production', weight: 1, version: 'screener-v1' },
  { id: 'gapgo', status: 'production', weight: 1, version: 'gapgo-v1' },
  { id: 'downday', status: 'production', weight: 1, version: 'downday-v1' },
  { id: 'coil', status: 'probation', weight: 0.25, version: 'coil-v1' },
  { id: 'biotech', status: 'paper', weight: 0, version: 'biotech-v1' },
]);

test('missing governance state ⇒ NOT trade-eligible (fail closed), even for production sources', () => {
  const g = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long' }], { governance: null, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, false);
  assert.match(g.perSource.screener.reasons.join(' '), /no governance state/);
});

test('stale governance ⇒ NOT trade-eligible (fail closed)', () => {
  const stale = { savedAt: '2026-06-01T00:00:00.000Z', strategies: GOV_PROD.strategies };
  const g = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long' }], { governance: stale, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, false);
  assert.match(g.perSource.screener.reasons.join(' '), /stale/);
});

test('scoring-version mismatch between governance evidence and registry ⇒ fail closed', () => {
  const gov = freshGov([{ id: 'screener', status: 'production', weight: 1, version: 'screener-v0-OLD' }]);
  const g = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long' }], { governance: gov, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, false);
  assert.match(g.perSource.screener.reasons.join(' '), /scoring version/);
});

test('production static + fresh cleared governance ⇒ trade-eligible with governance sizing weight', () => {
  const g = EL.gateSignals([
    { source: 'screener', ticker: 'AAA', side: 'long', entry: 1, stop: 0.9, target: 1.3, liquidity: { dollarVol: 5e7 } },
    { source: 'coil', ticker: 'DDD', side: 'long', entry: 1, stop: 0.9, target: 1.3, liquidity: { dollarVol: 5e7 } },
    { source: 'biotech', ticker: 'AGIO', side: 'long' },
  ], { governance: GOV_PROD, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, true);
  assert.equal(g.perSource.screener.sizingWeight, 1);
  assert.equal(g.perSource.coil.tradeEligible, true);       // probation = cleared, reduced
  assert.equal(g.perSource.coil.sizingWeight, 0.25);
  assert.equal(g.perSource.biotech.tradeEligible, false);   // paper = zero clearance
});

test('shadow static maturity ⇒ never trade-eligible regardless of governance', () => {
  const gov = freshGov([{ id: 'gapdown', status: 'production', weight: 1, version: 'gapdown-v1' }]);
  const g = EL.gateSignals([{ source: 'gapdown', ticker: 'ZZZ', side: 'short' }], { governance: gov, nowMs: NOW });
  assert.equal(g.perSource.gapdown.tradeEligible, false);
  assert.match(g.perSource.gapdown.reasons.join(' '), /not production/);
});

test('unregistered source (fabricated id) fails closed centrally', () => {
  const g = EL.gateSignals([{ source: 'brand-new-thing', ticker: 'X', side: 'long' }], { governance: GOV_PROD, nowMs: NOW });
  assert.equal(g.perSource['brand-new-thing'].tradeEligible, false);
});

test('SHORT without observed borrow fails closed even when its source is cleared', () => {
  const sig = { source: 'downday', ticker: 'HOT', side: 'short', entry: 205, stop: 216, target: 188, liquidity: { dollarVol: 6e7 } };
  const g1 = EL.gateSignals([sig], { governance: GOV_PROD, nowMs: NOW });
  assert.equal(g1.annotated[0].eligibility.tradeEligible, false);
  assert.match(g1.annotated[0].eligibility.reasons.join(' '), /borrow/);
  // With an observed borrow record for the name, the same short becomes eligible.
  const g2 = EL.gateSignals([sig], { governance: GOV_PROD, nowMs: NOW, borrowFeed: { HOT: { available: true, feeBps: 80 } } });
  assert.equal(g2.annotated[0].eligibility.tradeEligible, true);
});

test('LONGS from the same cleared source are unaffected by the borrow gate', () => {
  const g = EL.gateSignals([{ source: 'downday', ticker: 'RVL', side: 'long', entry: 56, stop: 53, target: 61, liquidity: { dollarVol: 9e6 } }],
    { governance: GOV_PROD, nowMs: NOW });
  assert.equal(g.annotated[0].eligibility.tradeEligible, true);
});

test('sizing discipline: missing plan levels or unknown liquidity ⇒ NOT sizingEligible (unknown never gets full confidence)', () => {
  const gov = GOV_PROD;
  const noPlan = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long', liquidity: { dollarVol: 5e7 } }], { governance: gov, nowMs: NOW });
  assert.equal(noPlan.annotated[0].eligibility.tradeEligible, true);
  assert.equal(noPlan.annotated[0].eligibility.sizingEligible, false);
  const noLiq = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long', entry: 1, stop: 0.9, target: 1.2, liquidity: { price: 10 } }], { governance: gov, nowMs: NOW });
  assert.equal(noLiq.annotated[0].eligibility.sizingEligible, false);
  assert.equal(noLiq.annotated[0].eligibility.sizingWeight, 0);
});

test('DAY TRADE PIN: daytrade keeps its existing behavior — production static status alone, governance never consulted', () => {
  const g = EL.gateSignals([{ source: 'daytrade', ticker: 'CCC', side: 'long' }], { governance: null, nowMs: NOW });
  assert.equal(g.perSource.daytrade.pinned, true);
  assert.equal(g.perSource.daytrade.tradeEligible, true);
});

// ── buildToday integration ───────────────────────────────────────────────────
test('annotate (default): board unchanged, every active signal carries an eligibility verdict, shadow comparison present', () => {
  const off = buildToday(SOURCES, null, null, null, { eligibilityMode: 'off' });
  const ann = buildToday(SOURCES, null, null, null, {});
  assert.equal(ann.counts.signals, off.counts.signals);
  const flatTop = (pl) => Object.values(pl.topByHorizon).flat();
  assert.deepEqual(flatTop(ann).map(x => x.id), flatTop(off).map(x => x.id));
  assert.ok(flatTop(ann).every(x => x.eligibility && typeof x.eligibility.tradeEligible === 'boolean'));
  assert.ok(flatTop(ann).every(x => x.evidenceClass === 'ACTIONABLE' || x.evidenceClass === 'RESEARCH'),
    'every card carries the unmistakable ACTIONABLE vs RESEARCH class');
  assert.ok(ann.governanceGate && ann.governanceGate.mode === 'annotate');
  assert.ok(ann.governanceGate.shadowComparison);
  assert.equal(off.governanceGate, null);
});

test('enforce: shadow sources can neither ORIGINATE a board row nor BOOST one via merged evidence', () => {
  const gov = freshGov([
    { id: 'screener', status: 'production', weight: 1, version: 'screener-v1' },
    { id: 'gapgo', status: 'production', weight: 1, version: 'gapgo-v1' },
  ]);
  // nowMs pinned to the fixture epoch: freshGov pins savedAt, so an unpinned real
  // clock makes the governance doc read as stale once the calendar moves on (this
  // exact test started failing 6 days after it was written).
  const p = buildToday(SOURCES, null, null, null, { eligibilityMode: 'enforce', governance: gov, nowMs: NOW });
  const boardSources = new Set(Object.values(p.topByHorizon).flat().concat(...Object.values(p.horizons)).flatMap(x => x.sources || [x.source]));
  // Shadow/ungoverned sources must be absent everywhere on the tradeable board:
  for (const shadowSrc of ['gapdown', 'readthrough', 'anomaly', 'secondwave', 'crossasset', 'toneshift', 'coremo', 'optionsflow', 'biotech', 'coil', 'downday']) {
    assert.ok(!boardSources.has(shadowSrc), `${shadowSrc} must not reach the enforced board`);
  }
  // Cleared + pinned sources remain:
  assert.ok(boardSources.has('screener'));
  assert.ok(boardSources.has('gapgo'));
  assert.ok(boardSources.has('daytrade'));
  // The exclusions are reported, not silently dropped:
  assert.ok(p.governanceGate.excludedCount > 0);
  assert.ok(p.governanceGate.excluded.every(e => e.reason));
});

test('enforce: the research cross-section still records the FULL ungated candidate set (selection-bias guard)', () => {
  const gov = freshGov([{ id: 'screener', status: 'production', weight: 1, version: 'screener-v1' }]);
  const p = buildToday(SOURCES, null, null, null, { eligibilityMode: 'enforce', governance: gov, nowMs: NOW });
  assert.ok(p.research && Array.isArray(p.research.predictions));
  const researchTickers = new Set(p.research.predictions.map(r => r.ticker));
  // A name enforcement excluded from the board must still be observed by research:
  assert.ok(researchTickers.has('ZZZ') || researchTickers.has('EEE') || researchTickers.has('MMM'),
    'excluded candidates must remain in the research snapshot');
});

test('enforce + Day Trade: daytrade rows survive with identical scores (frozen behavior)', () => {
  const ann = buildToday(SOURCES, null, null, null, {});
  const enf = buildToday(SOURCES, null, null, null, { eligibilityMode: 'enforce', governance: null });
  const dtAnn = Object.values(ann.horizons).flat().filter(x => x.source === 'daytrade');
  const dtEnf = Object.values(enf.horizons).flat().filter(x => x.source === 'daytrade');
  assert.equal(dtEnf.length, dtAnn.length);
  for (const row of dtEnf) {
    const ref = dtAnn.find(x => x.id === row.id);
    assert.ok(ref, `daytrade row ${row.id} must survive enforcement`);
    assert.equal(row.score, ref.score, 'daytrade composite score must be unchanged by enforcement');
  }
});
