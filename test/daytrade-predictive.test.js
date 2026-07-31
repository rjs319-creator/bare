'use strict';
// PREDICTIVE-DISCOVERY REDESIGN — tests for the discovery→Stage-2 handoff repairs, the
// lane-budgeted deep-pool selection, the frozen live plan (mechanical R:R fix), the
// same-board-cycle discovery consumption, and premarket/session separation.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mergeDiscoveryEvidence, isStateFresh, loadOrRunDiscovery, cusumStep } = require('../lib/intraday-discovery');
const { selectDeepPoolDetailed, selectDeepPool, discoveryPriority, computeLivePlan, stampActivePlan } = require('../lib/daytrade-actionability');
const { buildIntradayFeatures } = require('../lib/intraday-features');
const { STATES } = require('../lib/opportunity-lifecycle');
const CFG = require('../lib/daytrade-config');

const NOW = '2026-07-08T14:29:00Z';   // 10:29 ET, a Wednesday (regular session)

// Accelerating riser: 5-min bars from the 13:30Z open; each close gains more than the last.
function risingBars(n = 11, start = '2026-07-08T13:30:00Z') {
  const t0 = Date.parse(start);
  const bars = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    const gain = 0.1 + 0.08 * i;   // accelerating
    const o = c; c = +(c + gain).toFixed(3);
    bars.push({ t: new Date(t0 + i * 5 * 60000).toISOString(), o, h: c + 0.05, l: o - 0.05, c, v: 40000 + 4000 * i });
  }
  return bars;
}

// ── 1. Discovery evidence merges into an existing scan ticker ────────────────
test('1. a discovery anomaly on a ticker already in a scan MERGES (never discarded)', () => {
  const picks = [{ ticker: 'AAA', relVol: 2, pctChange: 4 }, { ticker: 'CCC', relVol: 1, pctChange: 1 }];
  const anomalies = [
    { ticker: 'AAA', cusum: 6.2, z: 3.1, intervalRet: 0.8, quoteAsOf: NOW, discoveredAt: NOW, discoveryAgeMin: 1.5, sessionBucket: 'midday' },
    { ticker: 'BBB', cusum: 5.0, z: 2.0 },
  ];
  const fresh = mergeDiscoveryEvidence(picks, anomalies);
  assert.deepEqual(fresh.map(a => a.ticker), ['BBB'], 'only genuinely new names remain as the discovery lane');
  assert.equal(picks[0].discovery.cusum, 6.2, 'existing pick annotated with the CUSUM evidence');
  assert.equal(picks[0].discovery.z, 3.1);
  assert.equal(picks[0].discovery.discoveryAgeMin, 1.5);
  assert.equal(picks[1].discovery, undefined, 'non-flagged picks untouched');
});

// ── 2. CUSUM / shock / freshness influence Stage-2 selection ─────────────────
test('2. discovery evidence (cusum, z, freshness) raises Stage-2 priority', () => {
  const withEvidence = discoveryPriority({ cusum: 8, z: 3, quoteAsOf: NOW }, Date.parse(NOW) + 60000);
  const stale = discoveryPriority({ cusum: 8, z: 3, quoteAsOf: '2026-07-08T13:00:00Z' }, Date.parse(NOW));
  assert.ok(withEvidence > stale, 'a fresh alarm outranks the same alarm 90 minutes old');
  assert.equal(discoveryPriority(null), 0, 'no evidence → no boost');

  const base = { relVol: 2, pctChange: 3, excessPct: 2 };
  const plain = { ...base, ticker: 'PLAIN' };
  const flagged = { ...base, ticker: 'FLAG', discovery: { cusum: 9, z: 3.5, quoteAsOf: NOW } };
  const { pool } = selectDeepPoolDetailed([plain, flagged], { maxNames: 1, now: NOW });
  assert.equal(pool[0].ticker, 'FLAG', 'identical picks: the discovery-flagged one wins the slot');
});

// ── 3./4. Lane reservations: discovery guaranteed, management protected ──────
test('3. new discoveries get reserved deep-analysis capacity despite a wall of lifecycle names', () => {
  const priorRecords = {};
  const mgmt = Array.from({ length: 40 }, (_, i) => {
    priorRecords[`M${i}`] = { state: STATES.ACTIONABLE_NOW };
    return { ticker: `M${i}`, relVol: 5, pctChange: 8, excessPct: 7 };
  });
  const discs = Array.from({ length: 8 }, (_, i) => ({
    ticker: `D${i}`, source: 'discovery', scan: 'discovery',
    cusum: 5 + i, z: 2, quoteAsOf: NOW, relVol: 1, pctChange: 1, excessPct: 0.5,
  }));
  const { pool, diagnostics } = selectDeepPoolDetailed([...mgmt, ...discs], { priorRecords, maxNames: 30, now: NOW });
  const discSelected = pool.filter(p => p.ticker.startsWith('D')).length;
  assert.ok(discSelected >= CFG.STAGE2.LANES.DISCOVERY_RESERVE,
    `discovery lane must keep ≥ ${CFG.STAGE2.LANES.DISCOVERY_RESERVE} slots (got ${discSelected})`);
  assert.ok(diagnostics.selected.some(s => s.via === 'discovery-reserve'), 'diagnostics name the reserve path');
  assert.ok(diagnostics.rejected.every(r => r.reason === 'stage2-budget'), 'rejections are reason-coded');
});

test('4. management/revalidation capacity remains protected under a flood of discoveries', () => {
  const priorRecords = {
    HOT: { state: STATES.MANAGING }, ACT: { state: STATES.ACTIONABLE_NOW }, ARM: { state: STATES.ARMED },
  };
  const tracked = [
    { ticker: 'HOT', relVol: 0.5, pctChange: -1, excessPct: -2 },   // weak NOW — but being managed
    { ticker: 'ACT', relVol: 0.6, pctChange: 0.5, excessPct: 0 },
    { ticker: 'ARM', relVol: 0.7, pctChange: 0.8, excessPct: 0.2 },
  ];
  const flood = Array.from({ length: 60 }, (_, i) => ({
    ticker: `F${i}`, source: 'discovery', scan: 'discovery', cusum: 12, z: 4, quoteAsOf: NOW,
    relVol: 6, pctChange: 10, excessPct: 9,
  }));
  const { pool } = selectDeepPoolDetailed([...tracked, ...flood], { priorRecords, maxNames: 20, now: NOW });
  const names = pool.map(p => p.ticker);
  assert.ok(names.includes('HOT') && names.includes('ACT') && names.includes('ARM'),
    'every managed/armed name keeps its failure-detection slot');
  assert.equal(names[0], 'HOT', 'management ordered first (failure detection before discovery)');
});

test('back-compat: selectDeepPool façade still returns a plain pick array', () => {
  const picks = Array.from({ length: 10 }, (_, i) => ({ ticker: `T${i}`, relVol: 2, pctChange: 5, excessPct: 1 }));
  assert.equal(selectDeepPool(picks, { maxNames: 4 }).length, 4);
});

// ── 8. Premarket and regular-hours baselines are separated ────────────────────
test('8. interval state from one session never seeds another (premarket vs regular)', () => {
  const base = { date: '2026-07-08', updatedAt: '2026-07-08T13:20:00Z', byTicker: { A: { cusum: 3 } } };
  const args = { date: '2026-07-08', nowIso: '2026-07-08T13:40:00Z' };
  assert.equal(isStateFresh({ ...base, session: 'regular' }, { ...args, session: 'regular' }), true);
  assert.equal(isStateFresh({ ...base, session: 'premarket' }, { ...args, session: 'regular' }), false,
    'premarket CUSUM state must NOT carry into regular hours');
  assert.equal(isStateFresh({ ...base, session: 'regular' }, { ...args, session: 'premarket' }), false);
  assert.equal(isStateFresh({ ...base, session: 'regular' }, { date: '2026-07-09', session: 'regular', nowIso: '2026-07-09T13:40:00Z' }), false, 'a new date resets');
});

test('8b. premarket thresholds are separate (and stricter) than regular-hours', () => {
  assert.ok(CFG.DISCOVERY.PREMARKET.CUSUM_H > CFG.DISCOVERY.CUSUM_H, 'premarket demands stronger drift');
  assert.ok(CFG.DISCOVERY.PREMARKET.MIN_AVG_DOLLAR_VOL > CFG.DISCOVERY.MIN_AVG_DOLLAR_VOL, 'premarket demands deeper liquidity');
});

test('8c. session buckets separate premarket / open / midday / power hour', () => {
  const { sessionBucketOf } = require('../lib/lifecycle-eval');
  assert.equal(sessionBucketOf(new Date('2026-07-08T12:00:00Z')), 'premarket');   // 08:00 ET
  assert.equal(sessionBucketOf(new Date('2026-07-08T13:32:00Z')), 'open5');       // 09:32 ET
  assert.equal(sessionBucketOf(new Date('2026-07-08T13:50:00Z')), 'open30');      // 09:50 ET
  assert.equal(sessionBucketOf(new Date('2026-07-08T17:00:00Z')), 'midday');      // 13:00 ET
  assert.equal(sessionBucketOf(new Date('2026-07-08T19:30:00Z')), 'power');       // 15:30 ET
});

// ── 9. Discovery results reach the SAME board cycle ──────────────────────────
test('9. loadOrRunDiscovery runs one inline scan when no fresh doc exists (same-cycle consumption)', async () => {
  let scanned = 0;
  const scanStub = async () => { scanned++; return { ok: true, session: 'regular', anomalies: [{ ticker: 'NEW' }] }; };
  const out = await loadOrRunDiscovery({
    now: new Date(NOW), t0: Date.now(), deadline: 50000,
    load: async () => null, scan: scanStub,
  });
  assert.equal(scanned, 1, 'inline scan ran');
  assert.equal(out.ranInline, true);
  assert.equal(out.doc.anomalies[0].ticker, 'NEW', 'the board consumes the scan it just ran');
});

test('9b. a fresh persisted doc short-circuits (no double scan), and a spent budget skips honestly', async () => {
  let scanned = 0;
  const scanStub = async () => { scanned++; return { ok: true, anomalies: [] }; };
  const doc = { anomalies: [{ ticker: 'X' }] };
  const hit = await loadOrRunDiscovery({ now: new Date(NOW), load: async () => doc, scan: scanStub });
  assert.equal(hit.doc, doc);
  assert.equal(hit.ranInline, false);
  const broke = await loadOrRunDiscovery({
    now: new Date(NOW), t0: Date.now() - 60000, deadline: 50000,   // budget already exhausted
    load: async () => null, scan: scanStub,
  });
  assert.equal(broke.doc, null);
  assert.equal(broke.note, 'insufficient-time-budget');
  assert.equal(scanned, 0, 'no scan attempted without budget');
});

// ── 10. Frozen live plans: remaining R:R is no longer mechanically 2 ─────────
test('10. the frozen plan keeps its levels and remaining R:R falls as price approaches the target', () => {
  const bars1 = risingBars(9);
  const f1 = buildIntradayFeatures({ todayBars: bars1, now: bars1.at(-1).t, dailyAtr: 2 });
  const plan1 = computeLivePlan(f1, { now: bars1.at(-1).t });
  assert.ok(plan1 && plan1.frozen === false, 'first confirmation mints a fresh plan');
  assert.equal(plan1.remainingRR, 2, 'at creation the ratio is the target R:R by construction');

  // Two bars later the price has risen toward the target: the plan must NOT re-anchor.
  const bars2 = risingBars(11);
  const f2 = buildIntradayFeatures({ todayBars: bars2, now: bars2.at(-1).t, dailyAtr: 2 });
  const plan2 = computeLivePlan(f2, { now: bars2.at(-1).t, priorPlan: plan1 });
  assert.equal(plan2.frozen, true, 'the prior plan stays in force');
  assert.equal(plan2.stop, plan1.stop, 'stop unchanged');
  assert.equal(plan2.target, plan1.target, 'target unchanged — NOT reset around the new quote');
  assert.ok(plan2.remainingRR < 2, `remaining R:R discriminates (${plan2.remainingRR} < 2)`);
});

test('10b. an expired or breached prior plan is not frozen-reused', () => {
  const bars = risingBars(11);
  const f = buildIntradayFeatures({ todayBars: bars, now: bars.at(-1).t, dailyAtr: 2 });
  const dead = { basis: 'live-intraday', entry: 100, stop: 99, target: 102, expiresAt: '2026-07-08T13:00:00Z' };
  const plan = computeLivePlan(f, { now: bars.at(-1).t, priorPlan: dead });
  assert.equal(plan.frozen, false, 'expired prior plan → a fresh plan is computed');
});

test('10c. stampActivePlan persists the plan on active records and retires it with the setup', () => {
  const livePlan = { basis: 'live-intraday', entry: 100, stop: 99, target: 102, expiresAt: '2026-07-08T16:00:00Z' };
  const active = stampActivePlan({ ticker: 'A', state: STATES.ACTIONABLE_NOW, setupId: 'A|2026-07-08|s1' }, { livePlan });
  assert.equal(active.activePlan.entry, 100);
  assert.equal(active.activePlan.setupId, 'A|2026-07-08|s1', 'plan bound to the setup identity');
  const retired = stampActivePlan({ ...active, state: STATES.FAILED }, {});
  assert.equal(retired.activePlan, undefined, 'a retired setup surrenders its live plan');
  assert.ok(retired.retiredPlan, 'provenance retained');
});

// ── CUSUM math is untouched by the redesign (regression guard) ───────────────
test('cusumStep still accumulates standardized positive drift and alarms deterministically', () => {
  let s = null;
  const t0 = Date.parse(NOW);
  s = cusumStep(s, 100, t0);
  s = cusumStep(s, 100.05, t0 + 60000);
  const s2 = cusumStep(s, 101.2, t0 + 120000);
  assert.ok(s2.cusum > 0, 'a sharp standardized move raises the statistic');
});
