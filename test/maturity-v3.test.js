'use strict';
// maturity-v3 — the promotion grade is earned on the strategy's PRIMARY UTILITY metric
// (date-level cost-net portfolio excess with a dependence-aware CI), never on hit rate:
//   • low-hit/high-payoff strategies with genuinely positive utility can qualify
//   • high-hit negative-expectancy strategies can never qualify
//   • overlapping multi-session labels get a Newey-West (HAC) widened CI, floored at IID
//   • a same-day pick cluster is ONE decision portfolio, not many observations
//   • policy-cohort selection: control tiers (declared policyTiers) and research lanes
//     (BROAD_*, HIST_* historical reconstructions) never pool into the promoted policy
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/maturity');
const { dateLevelNetExcess, ignitionLedgerTier } = require('../lib/apex-routes');

// A record that clears every v3 utility gate but wins on only 38% of picks — the
// low-hit/high-payoff shape maturity-v2's mandatory Wilson >50% bound rejected.
const LOW_HIT_HIGH_PAYOFF = Object.freeze({
  excessN: 60, avgExcess: 2.6, beatMktRate: 38,
  netExcessN: 60, avgNetExcess: 2.4, netBeatMktRate: 36,
  secExcN: 60, avgSecExcess: 1.8, beatSecRate: 40,
  dates: 30,
  dateNet: { n: 30, avg: 1.2, sd: 2.0, ci95: { lo: 0.4, hi: 2.0 }, effectiveN: 22, positiveBlocks: 4, blockStability: { blocks: 4, positive: 4, means: [1.1, 1.3, 1.0, 1.4], usable: true } },
});

test('v3: low-hit/high-payoff with positive date-level utility CI qualifies when every other gate passes', () => {
  const g = M.gradeTrack({ ...LOW_HIT_HIGH_PAYOFF }, { fillVerified: true });
  assert.equal(g.grade, 'validated');
  assert.ok(g.stats.beatLo < 50, 'the Wilson bound is descriptive and below 50 here — it is no longer a gate');
  assert.match(g.reason, /descriptive, not a gate/i);
});

test('v3: the same low-hit record still fails closed on every non-hit-rate gate', () => {
  // proxy pipeline (fillVerified default false)
  let g = M.gradeTrack({ ...LOW_HIT_HIGH_PAYOFF });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /proxy/i);
  // date-level CI includes zero
  g = M.gradeTrack({ ...LOW_HIT_HIGH_PAYOFF, dateNet: { n: 30, avg: 0.4, sd: 3, ci95: { lo: -0.2, hi: 1.0 } } }, { fillVerified: true });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /does not exclude zero/i);
});

test('v3: high hit rate can NEVER rescue negative expectancy', () => {
  const g = M.gradeTrack({ excessN: 40, avgExcess: -0.5, beatMktRate: 70 });
  assert.notEqual(g.grade, 'validated');
  assert.notEqual(g.grade, 'promising');
  assert.match(g.reason, /cannot rescue/i);
});

test('v3: protective disablement is dependence-aware — a significantly NEGATIVE date-level CI disables', () => {
  const g = M.gradeTrack({
    excessN: 60, avgExcess: -0.4, beatMktRate: 48, netExcessN: 60, avgNetExcess: -0.6, netBeatMktRate: 46,
    dates: 30, dateNet: { n: 30, avg: -0.8, sd: 1.5, ci95: { lo: -1.4, hi: -0.2 } },
  });
  assert.equal(g.grade, 'disabled');
  assert.match(g.reason, /date-level/i);
});

test('v3: a same-day cluster is ONE decision portfolio, not many independent observations', () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ date: '2026-08-03', netExc: i % 2 ? 3 : -1 })),
    ...Array.from({ length: 10 }, () => ({ date: '2026-08-04', netExc: 1 })),
  ];
  const dn = dateLevelNetExcess(rows);
  assert.equal(dn.n, 2, '40 picks on 2 dates = 2 observations');
});

test('v3: overlapping labels do not receive naive IID confidence — the HAC CI is never narrower than IID', () => {
  // Strongly positively autocorrelated per-date returns (a slow sine drift), the shape
  // an overlapping 21-session label produces on consecutive decision dates.
  const rows = Array.from({ length: 60 }, (_, i) => ({
    date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
    netExc: 1 + Math.sin(i / 8) * 2,
  }));
  const hac = dateLevelNetExcess(rows, { horizonBars: 21 });
  const iid = dateLevelNetExcess(rows);   // Andrews-lag HAC, still floored at IID
  assert.match(hac.seBasis, /newey-west/i);
  const hacWidth = hac.ci95.hi - hac.ci95.lo;
  // Reconstruct the naive IID width from the reported sd/n.
  const naiveWidth = 2 * 1.96 * (hac.sd / Math.sqrt(hac.n));
  assert.ok(hacWidth >= naiveWidth - 1e-9, `HAC CI (${hacWidth.toFixed(3)}) must be at least as wide as IID (${naiveWidth.toFixed(3)})`);
  assert.ok(hacWidth > naiveWidth * 1.5, 'on this strongly autocorrelated series the HAC CI must be materially wider');
  assert.ok(iid, 'no-horizon call still returns stats');
});

test('v3: fewer than 2 distinct dates → no date-level verdict statistic at all (fail closed)', () => {
  assert.equal(dateLevelNetExcess([{ date: '2026-08-03', netExc: 2 }]), null);
});

// ── policy-cohort evidence selection ─────────────────────────────────────────
const H = (over = {}) => ({ excessN: 60, avgExcess: 2, beatMktRate: 60, netExcessN: 60, avgNetExcess: 1.8, netBeatMktRate: 58, dates: 25, ...over });

test('v3: control tiers and research lanes never pool into the promoted policy (policyTiers + BROAD_/HIST_)', () => {
  const entry = { id: 'ignition', label: 'Ignition', kind: 'signal', section: 'Ignition', horizon: 'swing', core: true, policyTiers: ['IGNITION'] };
  const summary = { groups: [
    { section: 'Ignition', tier: 'IGNITION', horizons: { '5d': H() } },
    { section: 'Ignition', tier: 'WATCH', horizons: { '5d': H({ avgExcess: 9, avgNetExcess: 9 }) } },
    { section: 'Ignition', tier: 'BROAD_IGNITION', horizons: { '5d': H({ avgExcess: 9, avgNetExcess: 9 }) } },
    { section: 'Ignition', tier: 'HIST_IGNITION', horizons: { '5d': H({ avgExcess: 9, avgNetExcess: 9 }) } },
  ] };
  const g = M.gradeStrategy(entry, summary);
  assert.deepEqual(g.stats.pooledTiers, ['IGNITION']);
  assert.deepEqual([...g.stats.excludedTiers].sort(), ['BROAD_IGNITION', 'HIST_IGNITION', 'WATCH']);
  // The pooled stats are the policy tier's own, uncontaminated by the 9%-avg lanes.
  assert.equal(g.stats.avgExcess, 1.8);
});

test('v3: BROAD_/HIST_ research lanes are excluded even WITHOUT declared policyTiers', () => {
  const entry = { id: 'x', label: 'X', kind: 'signal', section: 'S', horizon: 'swing', core: false };
  const summary = { groups: [
    { section: 'S', tier: 'A', horizons: { '5d': H() } },
    { section: 'S', tier: 'BROAD_A', horizons: { '5d': H({ avgNetExcess: 9 }) } },
    { section: 'S', tier: 'HIST_A', horizons: { '5d': H({ avgNetExcess: 9 }) } },
  ] };
  const g = M.gradeStrategy(entry, summary);
  assert.deepEqual(g.stats.pooledTiers, ['A']);
  assert.equal(g.stats.avgExcess, 1.8);
});

test('v3: backfilled (historically reconstructed) ignition rows reclassify to HIST_* at Scoreboard read time', () => {
  assert.equal(ignitionLedgerTier({ tier: 'IGNITION', backfill: true }), 'HIST_IGNITION');
  assert.equal(ignitionLedgerTier({ tier: 'WATCH', backfill: true }), 'HIST_WATCH');
  assert.equal(ignitionLedgerTier({ tier: 'IGNITION' }), 'IGNITION');
  assert.equal(ignitionLedgerTier({ tier: 'IGNITION', backfill: false }), 'IGNITION');
});

test('v3: the funnel, broad and backfill lanes are three distinct evidence identities end to end', () => {
  // Simulate one ledger row from each lane flowing through read-time classification
  // into Scoreboard-style groups, then into the grader.
  const ledger = [
    { tier: 'IGNITION', ticker: 'AAA' },                       // prospective funnel
    { tier: 'BROAD_IGNITION', ticker: 'BBB' },                 // broad shadow (own tier at write time)
    { tier: 'IGNITION', ticker: 'CCC', backfill: true },       // historical reconstruction
  ];
  const tiers = ledger.map(ignitionLedgerTier);
  assert.deepEqual(tiers, ['IGNITION', 'BROAD_IGNITION', 'HIST_IGNITION']);
  assert.equal(new Set(tiers).size, 3, 'no two lanes may share an evidence identity');
});
