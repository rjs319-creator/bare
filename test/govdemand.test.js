'use strict';
// 🏛️ GOV-DEMAND shadow vertical — deterministic tests (no network: fetch mocked).
const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeRecipient, mapRecipient, scanRoster } = require('../lib/govdemand-map');
const collect = require('../lib/govdemand-collect');
const { ACTIONS, classifyAction, looksRoutine, computeMateriality } = require('../lib/govdemand-materiality');
const { addToQuarters, cadenceBaseline, expectationSurprise, quarterOf } = require('../lib/govdemand-expect');
const { assembleEvent, priceConsumedGate, qualify, STATUS, MIN_MATERIALITY } = require('../lib/govdemand-events');

// ── Recipient mapping ────────────────────────────────────────────────────────
test('normalizes recipient names (suffixes, punctuation, hyphens)', () => {
  assert.equal(normalizeRecipient('The Boeing Company'), 'BOEING');
  assert.equal(normalizeRecipient('CACI, INC.-FEDERAL'), 'CACI FEDERAL');
  assert.equal(normalizeRecipient('Curtiss-Wright Corp.'), 'CURTISS WRIGHT');
});

test('maps parent and subsidiary recipients with evidence', () => {
  const parent = mapRecipient('LOCKHEED MARTIN CORPORATION');
  assert.equal(parent.ticker, 'LMT');
  assert.equal(parent.via, 'parent');
  assert.ok(parent.evidence.length > 0);
  const sub = mapRecipient('SIKORSKY AIRCRAFT CORPORATION');
  assert.equal(sub.ticker, 'LMT');
  assert.equal(sub.via, 'subsidiary');
});

test('effective-dated mapping: Sikorsky is not LMT before the 2015 acquisition', () => {
  assert.equal(mapRecipient('SIKORSKY AIRCRAFT CORPORATION', '2014-06-01'), null);
  assert.equal(mapRecipient('SIKORSKY AIRCRAFT CORPORATION', '2016-06-01').ticker, 'LMT');
});

test('single-token patterns cannot false-positive on unrelated companies', () => {
  assert.equal(mapRecipient('ORACLE ELEVATOR COMPANY'), null);       // NOT Oracle Corp
  assert.equal(mapRecipient('ORACLE CORPORATION').ticker, 'ORCL');
  assert.equal(mapRecipient('ORACLE AMERICA INC').ticker, 'ORCL');   // generic corporate arm
  assert.equal(mapRecipient('GRANITE TELECOMMUNICATIONS LLC'), null); // NOT Granite Construction
});

test('unmapped recipients return null, never a guess', () => {
  assert.equal(mapRecipient('CARAHSOFT TECHNOLOGY CORP'), null);
  assert.equal(mapRecipient(''), null);
  assert.equal(mapRecipient(null), null);
});

test('scan roster has one query per ticker and no duplicates', () => {
  const roster = scanRoster();
  const tickers = roster.map(r => r.ticker);
  assert.equal(new Set(tickers).size, tickers.length);
  assert.ok(roster.length >= 40);
  for (const r of roster) assert.ok(r.query && r.query.length >= 3);
});

// ── Collector: identity, revisions, PIT separation ──────────────────────────
const row = (over = {}) => ({
  'Award ID': 'W1234', Mod: '0', 'Recipient Name': 'LOCKHEED MARTIN CORPORATION',
  'Action Date': '2026-07-20', 'Transaction Amount': 5e6,
  'Awarding Agency': 'DoD', 'Awarding Sub Agency': 'Army', 'Award Type': 'DEFINITIVE CONTRACT',
  'Transaction Description': 'RADAR UNITS', generated_internal_id: 'CONT_AWD_W1234', ...over,
});

test('txnKey identity = award id + modification number (mod dedup)', () => {
  assert.equal(collect.txnKey(row()), 'CONT_AWD_W1234|mod=0');
  assert.notEqual(collect.txnKey(row({ Mod: 'P00001' })), collect.txnKey(row()));
});

test('mergeObservations separates eventTime from observedAt/availableAt (PIT)', () => {
  const { fresh } = collect.mergeObservations({}, [row()], { ticker: 'LMT' }, '2026-07-30');
  assert.equal(fresh[0].eventTime, '2026-07-20');       // government action date
  assert.equal(fresh[0].observedAt, '2026-07-30');      // when WE saw it
  assert.equal(fresh[0].availableAt, '2026-07-30');     // availability = observation, never action date
});

test('revision preservation: amount change appends a vintage, never overwrites', () => {
  const first = collect.mergeObservations({}, [row()], { ticker: 'LMT' }, '2026-07-25');
  const again = collect.mergeObservations(first.seen, [row()], { ticker: 'LMT' }, '2026-07-30');
  assert.equal(again.fresh.length, 0);                  // duplicate coverage deduped
  assert.equal(again.revised.length, 0);
  const changed = collect.mergeObservations(first.seen, [row({ 'Transaction Amount': 6e6 })], { ticker: 'LMT' }, '2026-07-30');
  assert.equal(changed.revised.length, 1);
  assert.equal(changed.revised[0].prevAmountUSD, 5e6);
  const rec = changed.seen[collect.txnKey(row())];
  assert.equal(rec.firstObservedAt, '2026-07-25');      // original vintage preserved
  assert.equal(rec.revisions.length, 1);
  assert.equal(first.seen[collect.txnKey(row())].revisions.length, 0); // input not mutated
});

test('collectBatch survives provider failure without throwing (safe failure)', async () => {
  const fetchImpl = async () => { throw new Error('socket hang up'); };
  const out = await collect.collectBatch({
    roster: [{ ticker: 'LMT', company: 'Lockheed', query: 'LOCKHEED MARTIN' }],
    state: {}, todayIso: '2026-07-30', fetchImpl,
  });
  assert.equal(out.fresh.length, 0);
  assert.equal(out.errors.length, 1);
});

test('pruneSeen drops only stale keys', () => {
  const seen = {
    old: { firstObservedAt: '2025-01-01', amount: 1, revisions: [] },
    fresh: { firstObservedAt: '2026-07-01', amount: 2, revisions: [] },
  };
  const pruned = collect.pruneSeen(seen, '2026-07-30');
  assert.deepEqual(Object.keys(pruned), ['fresh']);
});

test('fiscal quarters convert to calendar quarters (FY starts Oct 1)', () => {
  assert.equal(collect.fiscalToCalendarQuarter('2024', '1'), '2023Q4');
  assert.equal(collect.fiscalToCalendarQuarter('2024', '2'), '2024Q1');
  assert.equal(collect.fiscalToCalendarQuarter('2024', '4'), '2024Q3');
  assert.equal(collect.fiscalToCalendarQuarter('bad', '9'), null);
});

// ── Action classification ────────────────────────────────────────────────────
const obs = (over = {}) => ({
  amountUSD: 5e6, mod: '0', description: 'RADAR UNITS', awardType: 'DEFINITIVE CONTRACT', ...over,
});

test('classifies new awards, mods, options, de-obligations, admin zeros', () => {
  assert.equal(classifyAction(obs()), ACTIONS.NEW_AWARD);
  assert.equal(classifyAction(obs({ mod: 'P00003' })), ACTIONS.MODIFICATION);
  assert.equal(classifyAction(obs({ mod: 'P00003', description: 'EXERCISE OPTION YEAR TWO' })), ACTIONS.OPTION_EXERCISE);
  assert.equal(classifyAction(obs({ amountUSD: -2e6, mod: 'P00009' })), ACTIONS.DE_OBLIGATION);
  assert.equal(classifyAction(obs({ amountUSD: 0 })), ACTIONS.ADMIN_ZERO);
  assert.equal(classifyAction(obs({ amountUSD: null })), ACTIONS.UNKNOWN);
});

test('IDV ceiling vehicles are never treated as obligated revenue', () => {
  assert.equal(classifyAction(obs({ awardType: 'INDEFINITE DELIVERY / INDEFINITE QUANTITY' })), ACTIONS.IDV_CEILING);
});

test('recompete/bridge language reads as routine continuation', () => {
  assert.ok(looksRoutine(obs({ description: 'BRIDGE CONTRACT FOR CONTINUED SUPPORT' })));
  assert.ok(looksRoutine(obs({ description: 'FOLLOW-ON PRODUCTION LOT 7' })));
  assert.ok(!looksRoutine(obs()));
});

// ── Materiality arithmetic ───────────────────────────────────────────────────
test('materiality = obligation / TTM revenue, with full provenance', () => {
  const m = computeMateriality({ obligatedUSD: 50e6, trailingRevenueUSD: 1e9 });
  assert.equal(m.value, 0.05);
  assert.equal(m.unit, 'fraction-of-ttm-revenue');
  assert.equal(m.measuredOrModeled, 'modeled');
  assert.ok(m.formula.includes('obligatedUSD'));
});

test('materiality is null — never zero — when an input is missing', () => {
  assert.equal(computeMateriality({ obligatedUSD: 50e6, trailingRevenueUSD: null }).value, null);
  assert.equal(computeMateriality({ obligatedUSD: null, trailingRevenueUSD: 1e9 }).value, null);
  assert.equal(computeMateriality({ obligatedUSD: 1, trailingRevenueUSD: 0 }).value, null);
  const m = computeMateriality({ obligatedUSD: 50e6, trailingRevenueUSD: null, revenueFailures: ['finnhub http:429'] });
  assert.ok(m.failureReasons.includes('finnhub http:429'));
});

// ── Cadence expectation ──────────────────────────────────────────────────────
test('addToQuarters aggregates immutably and bounds state', () => {
  const q1 = addToQuarters({}, '2026-01-15', 10);
  const q2 = addToQuarters(q1, '2026-02-15', 5);
  assert.equal(q2['2026Q1'], 15);
  assert.equal(q1['2026Q1'], 10);                        // input not mutated
  assert.equal(addToQuarters(q2, '2026-03-01', -5)['2026Q1'], 15); // negatives ignored
});

test('insufficient history → null expectation, null surprise (unknowable ≠ unexpected)', () => {
  const e = expectationSurprise({ amountUSD: 5e6, ticker: 'KTOS', asOf: '2026-07-30', quarters: {} });
  assert.equal(e.expectedQuarterlyFlowUSD, null);
  assert.equal(e.isUnexpected, null);
  assert.equal(e.confidence, 'insufficient-history');
});

test('surprise = award rivals a typical quarter; current quarter excluded', () => {
  const quarters = { '2025Q3': 10e6, '2025Q4': 12e6, '2026Q1': 8e6, '2026Q2': 11e6, '2026Q3': 1e9 };
  const base = cadenceBaseline(quarters, '2026-07-30');
  assert.equal(base.expectedQuarterlyFlowUSD, 10.5e6);   // 2026Q3 (current) excluded
  const big = expectationSurprise({ amountUSD: 30e6, ticker: 'X', asOf: '2026-07-30', quarters });
  assert.equal(big.isUnexpected, true);
  const routine = expectationSurprise({ amountUSD: 2e6, ticker: 'X', asOf: '2026-07-30', quarters });
  assert.equal(routine.isUnexpected, false);
});

test('quarterOf is UTC-stable', () => {
  assert.equal(quarterOf('2026-01-01'), '2026Q1');
  assert.equal(quarterOf('2026-12-31'), '2026Q4');
});

// ── Price-consumed gate ──────────────────────────────────────────────────────
const candlesFrom = (pairs) => pairs.map(([date, close]) => ({ date, close }));

test('price gate: consumed only past the SPY-excess threshold; missing data is null', () => {
  const spy = candlesFrom([['2026-07-20', 100], ['2026-07-30', 100]]);
  const flat = priceConsumedGate({
    candles: candlesFrom([['2026-07-20', 50], ['2026-07-30', 51]]),
    spyCandles: spy, eventTime: '2026-07-20', asOf: '2026-07-30',
  });
  assert.equal(flat.consumed, false);
  const ripped = priceConsumedGate({
    candles: candlesFrom([['2026-07-20', 50], ['2026-07-30', 60]]),
    spyCandles: spy, eventTime: '2026-07-20', asOf: '2026-07-30',
  });
  assert.equal(ripped.consumed, true);
  const noData = priceConsumedGate({ candles: null, spyCandles: spy, eventTime: '2026-07-20', asOf: '2026-07-30' });
  assert.equal(noData.consumed, null);                   // UNAVAILABLE, not "not consumed"
});

// ── Event assembly + gate cascade ────────────────────────────────────────────
const fullObs = (over = {}) => ({
  key: 'CONT_AWD_W1|mod=0', rosterTicker: 'KTOS', recipientName: 'KRATOS DEFENSE & SECURITY SOLUTIONS INC',
  awardId: 'W1', generatedInternalId: 'CONT_AWD_W1', mod: '0',
  eventTime: '2026-07-20', observedAt: '2026-07-30', availableAt: '2026-07-30',
  amountUSD: 40e6, awardType: 'DEFINITIVE CONTRACT', agency: 'DoD', subAgency: 'Air Force',
  description: 'NEW HYPERSONIC TEST VEHICLES', primarySource: 'usaspending.gov',
  sourceIds: ['usaspending:CONT_AWD_W1|mod=0'], ...over,
});
const goodInputs = () => ({
  obs: fullObs(),
  action: ACTIONS.NEW_AWARD,
  mapped: { ticker: 'KTOS', company: 'Kratos', via: 'parent', matchedPattern: 'KRATOS', evidence: 'e', verificationStatus: 'verified-static' },
  materiality: computeMateriality({ obligatedUSD: 40e6, trailingRevenueUSD: 1e9 }),   // 4%
  expectation: expectationSurprise({ amountUSD: 40e6, ticker: 'KTOS', asOf: '2026-07-30', quarters: { '2025Q4': 10e6, '2026Q1': 12e6, '2026Q2': 9e6 } }),
  priceGate: { excessMovePct: 1.2, consumed: false },
});

test('a clean unexpected material un-consumed event is ACTIONABLE_SHADOW', () => {
  const ev = assembleEvent(goodInputs());
  assert.equal(ev.status, STATUS.ACTIONABLE_SHADOW);
  assert.equal(ev.qualifies, true);
  assert.ok(Array.isArray(ev.causalSteps) && ev.causalSteps.length >= 3);
  assert.ok(Array.isArray(ev.invalidatingMeasurements) && ev.invalidatingMeasurements.length >= 2);
  assert.equal(ev.eventTime, '2026-07-20');
  assert.equal(ev.availableAt, '2026-07-30');            // PIT triplet survives assembly
});

test('gate cascade rejects with the first honest reason', () => {
  const g = goodInputs();
  assert.equal(qualify({ ...g, mapped: null }).status, STATUS.MAPPING_UNCERTAIN);
  assert.equal(qualify({ ...g, action: ACTIONS.IDV_CEILING }).status, STATUS.RAW_OBSERVATION);
  assert.equal(qualify({ ...g, action: ACTIONS.DE_OBLIGATION }).status, STATUS.RAW_OBSERVATION);
  assert.equal(qualify({ ...g, obs: fullObs({ description: 'RECOMPETE OF EXPIRING CONTRACT' }) }).status, STATUS.RAW_OBSERVATION);
  assert.equal(qualify({ ...g, materiality: computeMateriality({ obligatedUSD: 1e6, trailingRevenueUSD: 1e9 }) }).status, STATUS.NO_INCREMENTAL_EDGE);
  assert.equal(qualify({ ...g, materiality: computeMateriality({ obligatedUSD: 1e6, trailingRevenueUSD: null }) }).status, STATUS.DATA_UNAVAILABLE);
  assert.equal(qualify({ ...g, expectation: { isUnexpected: null } }).status, STATUS.EVIDENCE_BUILDING);
  assert.equal(qualify({ ...g, expectation: { isUnexpected: false } }).status, STATUS.RAW_OBSERVATION);
  assert.equal(qualify({ ...g, priceGate: { excessMovePct: 9.1, consumed: true } }).status, STATUS.MOVE_CONSUMED);
  assert.equal(qualify({ ...g, priceGate: { excessMovePct: null, consumed: null } }).status, STATUS.EXPECTATION_SURPRISE);
});

test('future-information invariance: only pre-asOf quarters shape the baseline', () => {
  // An award judged as-of July must see the same baseline whether or not
  // LATER quarters exist in the store (they cannot exist PIT, but guard anyway).
  const past = { '2025Q4': 10e6, '2026Q1': 12e6 };
  const withFuture = { ...past, '2026Q4': 900e6 };
  const a = cadenceBaseline(past, '2026-07-30');
  const b = cadenceBaseline(withFuture, '2026-07-30');
  assert.equal(a.expectedQuarterlyFlowUSD, b.expectedQuarterlyFlowUSD);
});

test('MIN_MATERIALITY is the frozen prereg constant', () => {
  assert.equal(MIN_MATERIALITY, 0.02);
});

// ── Shadow isolation ─────────────────────────────────────────────────────────
test('routes module exposes shadow-only governance flags on its ops', () => {
  const routes = require('../lib/govdemand-routes');
  assert.deepEqual(routes.HORIZONS, [5, 21, 63]);
  assert.equal(typeof routes.runGovDemand, 'function');
  assert.equal(typeof routes.runGovDemandTick, 'function');
  assert.equal(typeof routes.runGovDemandResolve, 'function');
});

test('production decision sources never import govdemand', () => {
  // Shadow isolation at the dependency level: the live ranking path
  // (lib/decision-sources.js + lib/decision.js) must not require this vertical.
  const fs = require('node:fs');
  for (const f of ['lib/decision-sources.js', 'lib/decision.js', 'lib/decision-routes.js']) {
    const src = fs.readFileSync(require('node:path').join(__dirname, '..', f), 'utf8');
    assert.ok(!src.includes('govdemand'), `${f} must not reference govdemand`);
  }
});
