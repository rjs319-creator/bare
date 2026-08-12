'use strict';
// quant-redesign-3 Phase-6 battery: central fail-closed eligibility.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EL = require('../lib/eligibility');
const { buildToday } = require('../lib/decision-routes');
const { SOURCES } = require('../test/fixtures/today-sources');

const NOW = Date.parse('2026-07-24T12:00:00Z');
// Freshness is TWO proofs since gov-v2.1: the governance WRITE time (savedAt) and the
// underlying Scoreboard EVIDENCE time (scoreboardGeneratedAt) — both must be current.
// A still-production, non-Day-Trade registry id to stand in for the "cleared source"
// cases below. DERIVED rather than hardcoded: `ghost` and `downday` previously played
// these roles and were demoted to shadow on 2026-08-11, which broke three tests that
// were not actually about either strategy. Deriving keeps them meaningful across future
// status flips instead of pinning whichever strategy happens to be live today.
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const DT_ID = /^(daytrade|gapgo|gapdown|ignition|lowfloat|intraday)/;
const CLEARED_ENTRY = STRATEGY_REGISTRY.find(e =>
  e.maturity === 'production' && e.kind === 'signal' && e.id !== 'screener' && !DT_ID.test(e.id)) || {};
const CLEARED = CLEARED_ENTRY.id;
// The governance doc's version must MATCH the registry's scoringVersion or eligibility
// fails closed with VERSION_MISMATCH — a scoring change resets earned evidence. Derived
// for the same reason the id is.
const CLEARED_VERSION = CLEARED_ENTRY.scoringVersion;

test('fixture sanity: a non-Day-Trade production strategy exists to stand in for cleared sources', () => {
  // If this ever fails, every "cleared source" case below is vacuous rather than wrong —
  // so it must fail loudly rather than silently testing nothing.
  assert.ok(CLEARED, 'no non-Day-Trade production strategy remains in the registry');
});

const freshGov = (strategies) => ({ savedAt: '2026-07-24T00:00:00.000Z', scoreboardGeneratedAt: '2026-07-23T22:00:00.000Z', strategies });
const GOV_PROD = freshGov([
  { id: 'screener', status: 'production', weight: 1, version: 'screener-v2' },
  { id: 'gapgo', status: 'production', weight: 1, version: 'gapgo-v1' },
  { id: CLEARED, status: 'probation', weight: 0.25, version: CLEARED_VERSION },
  { id: 'coil', status: 'probation', weight: 0.25, version: 'coil-v1' },   // irrelevant now: static shadow gates first
  { id: 'biotech', status: 'paper', weight: 0, version: 'biotech-v1' },
  // Demoted 2026-08-11 — retained here to prove the STATIC registry status gates ahead
  // of a stale governance clearance that still says production.
  { id: 'downday', status: 'production', weight: 1, version: 'downday-v1' },
  { id: 'ghost', status: 'production', weight: 1, version: 'ghost-v1' },
]);

test('missing governance state ⇒ NOT trade-eligible (fail closed), even for production sources', () => {
  const g = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long' }], { governance: null, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, false);
  assert.match(g.perSource.screener.reasons.join(' '), /no governance state/);
});

test('stale governance ⇒ NOT trade-eligible (fail closed)', () => {
  const stale = { savedAt: '2026-06-01T00:00:00.000Z', scoreboardGeneratedAt: '2026-06-01T00:00:00.000Z', strategies: GOV_PROD.strategies };
  const g = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long' }], { governance: stale, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, false);
  assert.match(g.perSource.screener.reasons.join(' '), /stale/);
});

test('a FRESH governance write over a STALE Scoreboard ⇒ NOT trade-eligible — savedAt cannot launder old evidence', () => {
  const laundered = { savedAt: '2026-07-24T00:00:00.000Z', scoreboardGeneratedAt: '2026-05-01T00:00:00.000Z', strategies: GOV_PROD.strategies };
  const g = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long' }], { governance: laundered, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, false);
  assert.match(g.perSource.screener.reasons.join(' '), /cannot make old evidence current/i);
});

test('a governance doc with NO evidence timestamp at all ⇒ NOT trade-eligible (evidence age unprovable)', () => {
  const noEvid = { savedAt: '2026-07-24T00:00:00.000Z', strategies: GOV_PROD.strategies };
  const g = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long' }], { governance: noEvid, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, false);
});

test('a governance record with NO scoring version cannot clear a versioned strategy (legacy-unversioned fails closed)', () => {
  const gov = freshGov([{ id: 'screener', status: 'production', weight: 1, version: null }]);
  const g = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long' }], { governance: gov, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, false);
  assert.match(g.perSource.screener.reasons.join(' '), /NO scoring version/i);
});

test('three-class taxonomy: ACTIONABLE (cleared+sizable), QUALIFIED_LEAD (cleared, not sizable), RESEARCH (uncleared)', () => {
  const g = EL.gateSignals([
    { source: 'screener', ticker: 'AAA', side: 'long', entry: 1, stop: 0.9, target: 1.3, liquidity: { dollarVol: 5e7 } },
    { source: 'screener', ticker: 'BBB', side: 'long', liquidity: { dollarVol: 5e7 } },   // no plan → lead only
    { source: 'coil', ticker: 'EEE', side: 'long', entry: 1, stop: 0.9, target: 1.3, liquidity: { dollarVol: 5e7 } },
  ], { governance: GOV_PROD, nowMs: NOW });
  assert.equal(g.annotated[0].eligibility.signalClass, 'ACTIONABLE');
  assert.equal(g.annotated[1].eligibility.signalClass, 'QUALIFIED_LEAD');
  assert.equal(g.annotated[1].eligibility.sizingWeight, 0, 'a qualified lead can never be sized');
  assert.equal(g.annotated[2].eligibility.signalClass, 'RESEARCH');
});

test('scoring-version mismatch between governance evidence and registry ⇒ fail closed', () => {
  const gov = freshGov([{ id: 'screener', status: 'production', weight: 1, version: 'screener-v0-OLD' }]);
  const g = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long' }], { governance: gov, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, false);
  assert.match(g.perSource.screener.reasons.join(' '), /scoring version/);
});

test('production static + fresh cleared governance ⇒ trade-eligible with governance sizing weight', () => {
  // 2026-08 reconciliation: coil/biotech are registered SHADOW (watchlist detector /
  // lead-only research), so they can never be trade-eligible regardless of governance.
  // The probation case uses CLEARED — a still-production id derived from the registry.
  const g = EL.gateSignals([
    { source: 'screener', ticker: 'AAA', side: 'long', entry: 1, stop: 0.9, target: 1.3, liquidity: { dollarVol: 5e7 } },
    { source: CLEARED, ticker: 'DDD', side: 'long', entry: 1, stop: 0.9, target: 1.3, liquidity: { dollarVol: 5e7 } },
    { source: 'coil', ticker: 'EEE', side: 'long', entry: 1, stop: 0.9, target: 1.3, liquidity: { dollarVol: 5e7 } },
    { source: 'biotech', ticker: 'AGIO', side: 'long' },
    { source: 'ghost', ticker: 'GGG', side: 'long', entry: 1, stop: 0.9, target: 1.3, liquidity: { dollarVol: 5e7 } },
  ], { governance: GOV_PROD, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, true);
  assert.equal(g.perSource.screener.sizingWeight, 1);
  assert.equal(g.perSource[CLEARED].tradeEligible, true);    // probation = cleared, reduced
  assert.equal(g.perSource[CLEARED].sizingWeight, 0.25);
  assert.equal(g.perSource.coil.tradeEligible, false);       // shadow static maturity — fail closed
  assert.equal(g.perSource.biotech.tradeEligible, false);    // shadow static maturity — fail closed
  // Demoted 2026-08-11: the STATIC registry status must gate ahead of a governance doc
  // that still carries a stale production clearance for it.
  assert.equal(g.perSource.ghost.tradeEligible, false);
  assert.match(g.perSource.ghost.reasons.join(' '), /not production/);
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
  // The borrow gate keys off SC.borrowRequired(source), and after the 2026-08-11
  // demotion EVERY borrow-requiring strategy (downday, fade, gapdown, chartpattern,
  // optionsflow) is shadow — so this scenario is currently unreachable against the live
  // registry. That is a real consequence, asserted separately below; here we inject a
  // registry where the source IS production so the test isolates its actual subject:
  // the borrow gate, not the maturity gate.
  const REG = [{ ...STRATEGY_REGISTRY.find(e => e.id === 'downday'), maturity: 'production' }];
  const sig = { source: 'downday', ticker: 'HOT', side: 'short', entry: 205, stop: 216, target: 188, liquidity: { dollarVol: 6e7 } };
  const g1 = EL.gateSignals([sig], { registry: REG, governance: GOV_PROD, nowMs: NOW });
  assert.equal(g1.annotated[0].eligibility.tradeEligible, false);
  assert.match(g1.annotated[0].eligibility.reasons.join(' '), /borrow/);
  // With an observed borrow record for the name, the same short becomes eligible.
  const g2 = EL.gateSignals([sig], { registry: REG, governance: GOV_PROD, nowMs: NOW, borrowFeed: { HOT: { available: true, feeBps: 80 } } });
  assert.equal(g2.annotated[0].eligibility.tradeEligible, true);
});

test('after the 2026-08-11 demotion, no borrow-requiring strategy is production', () => {
  // Consequence of demoting downday: every strategy whose contract requires borrow is
  // now shadow, so no live short can be originated at all. Stated rather than left as
  // an accident — and it will fail if one is ever promoted without a borrow feed.
  const SC = require('../lib/strategy-contracts');
  const live = STRATEGY_REGISTRY.filter(e => SC.borrowRequired(e.id) && e.maturity === 'production');
  assert.deepEqual(live.map(e => e.id), [],
    'a borrow-requiring strategy went production while lib/eligibility still has no borrow feed');
});

test('LONGS from the same cleared source are unaffected by the borrow gate', () => {
  const g = EL.gateSignals([{ source: CLEARED, ticker: 'RVL', side: 'long', entry: 56, stop: 53, target: 61, liquidity: { dollarVol: 9e6 } }],
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
// `dataGate: null` in the governance suites: the shared fixture carries no source
// timestamps, so the (separately tested) pre-ranking data gate would block every source
// before governance was ever consulted. These tests are about GOVERNANCE clearance.
const NO_DATA_GATE = { dataGate: null };

test('FAIL-CLOSED DEFAULT: with no mode set the board is ENFORCED, not annotated', () => {
  const def = buildToday(SOURCES, null, null, null, NO_DATA_GATE);
  assert.equal(def.governanceGate.mode, 'enforce');
  assert.equal(def.governanceGate.diagnosticOverride, false);
  assert.equal(EL.DEFAULT_MODE, 'enforce');
  // No governance doc ⇒ nothing but the pinned Day Trade source clears.
  const sources = new Set(Object.values(def.horizons).flat().map(x => x.source));
  assert.deepEqual([...sources], ['daytrade']);
});

test('annotate is an EXPLICIT diagnostic override: board ungated, every signal classed, shadow comparison present', () => {
  const off = buildToday(SOURCES, null, null, null, { eligibilityMode: 'off', ...NO_DATA_GATE });
  const ann = buildToday(SOURCES, null, null, null, { eligibilityMode: 'annotate', ...NO_DATA_GATE });
  assert.equal(ann.counts.signals, off.counts.signals);
  const flatTop = (pl) => Object.values(pl.topByHorizon).flat();
  assert.deepEqual(flatTop(ann).map(x => x.id), flatTop(off).map(x => x.id));
  assert.ok(flatTop(ann).every(x => x.eligibility && typeof x.eligibility.tradeEligible === 'boolean'));
  assert.ok(flatTop(ann).every(x => ['ACTIONABLE', 'QUALIFIED_LEAD', 'RESEARCH'].includes(x.evidenceClass)),
    'every card carries one of the three safety classes');
  assert.ok(ann.governanceGate && ann.governanceGate.mode === 'annotate');
  assert.equal(ann.governanceGate.diagnosticOverride, true);
  assert.match(ann.governanceGate.note, /DIAGNOSTIC OVERRIDE/);
  assert.ok(ann.governanceGate.shadowComparison);
  assert.equal(off.governanceGate, null);
});

test('the annotate override still builds the portfolio + opportunity density from ACTIONABLE rows only', () => {
  const ann = buildToday(SOURCES, null, null, null, { eligibilityMode: 'annotate', ...NO_DATA_GATE });
  assert.equal(ann.portfolio.universe.basis, 'ACTIONABLE + sizing-eligible only');
  for (const p of ann.portfolio.selected) {
    assert.equal(p.evidenceClass, 'ACTIONABLE', `${p.id} is not actionable but reached the book`);
    assert.equal(p.eligibility.sizingEligible, true);
  }
  assert.ok(ann.opportunity.activeCount <= ann.portfolio.universe.considered + 0,
    'opportunity density reads the sizing set, not the display board');
});

test('QUALIFIED_LEAD survives end to end as its own lane and never enters the book', () => {
  const gov = freshGov([{ id: 'screener', status: 'production', weight: 1, version: 'screener-v2' }]);
  const p = buildToday(SOURCES, null, null, null, { governance: gov, nowMs: NOW, ...NO_DATA_GATE });
  const leads = Object.values(p.qualifiedLeadsByHorizon || {}).flat();
  const book = new Set(p.portfolio.selected.map(x => x.id));
  for (const l of leads) {
    assert.equal(l.evidenceClass, 'QUALIFIED_LEAD');
    assert.equal(l.eligibility.sizingEligible, false);
    assert.ok(!book.has(l.id), `${l.id} is a qualified lead but reached the portfolio`);
  }
  // and it is never relabeled as actionable
  for (const a of Object.values(p.actionableByHorizon || {}).flat()) {
    assert.equal(a.evidenceClass, 'ACTIONABLE');
  }
});

test('enforce: shadow sources can neither ORIGINATE a board row nor BOOST one via merged evidence', () => {
  const gov = freshGov([
    { id: 'screener', status: 'production', weight: 1, version: 'screener-v2' },
    { id: 'gapgo', status: 'production', weight: 1, version: 'gapgo-v1' },
  ]);
  // nowMs pinned to the fixture epoch: freshGov pins savedAt, so an unpinned real
  // clock makes the governance doc read as stale once the calendar moves on (this
  // exact test started failing 6 days after it was written).
  const p = buildToday(SOURCES, null, null, null, { eligibilityMode: 'enforce', governance: gov, nowMs: NOW, ...NO_DATA_GATE });
  const boardSources = new Set(Object.values(p.topByHorizon).flat().concat(...Object.values(p.horizons)).flatMap(x => x.sources || [x.source]));
  // Shadow/ungoverned sources must be absent everywhere on the tradeable board.
  // 2026-08 reconciliation: gapgo joins the shadow set (unproven prospective
  // challenger) — a governance record alone can no longer clear it, because the
  // registry's static maturity gates first.
  for (const shadowSrc of ['gapdown', 'readthrough', 'anomaly', 'secondwave', 'crossasset', 'toneshift', 'coremo', 'optionsflow', 'biotech', 'coil', 'gapgo', 'downday']) {
    assert.ok(!boardSources.has(shadowSrc), `${shadowSrc} must not reach the enforced board`);
  }
  // Cleared + pinned sources remain:
  assert.ok(boardSources.has('screener'));
  assert.ok(boardSources.has('daytrade'));
  // The exclusions are reported, not silently dropped:
  assert.ok(p.governanceGate.excludedCount > 0);
  assert.ok(p.governanceGate.excluded.every(e => e.reason));
});

test('enforce: the research cross-section still records the FULL ungated candidate set (selection-bias guard)', () => {
  const gov = freshGov([{ id: 'screener', status: 'production', weight: 1, version: 'screener-v2' }]);
  const p = buildToday(SOURCES, null, null, null, { eligibilityMode: 'enforce', governance: gov, nowMs: NOW, ...NO_DATA_GATE });
  assert.ok(p.research && Array.isArray(p.research.predictions));
  const researchTickers = new Set(p.research.predictions.map(r => r.ticker));
  // A name enforcement excluded from the board must still be observed by research:
  assert.ok(researchTickers.has('ZZZ') || researchTickers.has('EEE') || researchTickers.has('MMM'),
    'excluded candidates must remain in the research snapshot');
});

test('enforce + Day Trade: daytrade rows survive with identical scores (frozen behavior)', () => {
  const ann = buildToday(SOURCES, null, null, null, { eligibilityMode: 'annotate', ...NO_DATA_GATE });
  const enf = buildToday(SOURCES, null, null, null, { eligibilityMode: 'enforce', governance: null, ...NO_DATA_GATE });
  const dtAnn = Object.values(ann.horizons).flat().filter(x => x.source === 'daytrade');
  const dtEnf = Object.values(enf.horizons).flat().filter(x => x.source === 'daytrade');
  assert.equal(dtEnf.length, dtAnn.length);
  for (const row of dtEnf) {
    const ref = dtAnn.find(x => x.id === row.id);
    assert.ok(ref, `daytrade row ${row.id} must survive enforcement`);
    assert.equal(row.score, ref.score, 'daytrade composite score must be unchanged by enforcement');
  }
});

test('abstention is first-class: abstained flag + full rejection-reason histogram on the gate payload', () => {
  // Arrange/Act — no governance doc ⇒ nothing non-pinned clears, so the board abstains.
  const def = buildToday(SOURCES, null, null, null, NO_DATA_GATE);
  const gg = def.governanceGate;

  // Assert — the flag is explicit, and the histogram covers EVERY excluded row
  // (excluded[] itself is truncated to 50, so counts are the only complete view).
  assert.equal(typeof gg.abstained, 'boolean');
  assert.equal(gg.abstained, gg.actionableCount === 0);
  assert.ok(gg.rejectionReasonCounts && typeof gg.rejectionReasonCounts === 'object');
  const totalCounted = Object.values(gg.rejectionReasonCounts).reduce((a, n) => a + n, 0);
  assert.equal(totalCounted, gg.excludedCount, 'histogram must count all excluded rows, not the truncated sample');
});
