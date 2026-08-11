'use strict';
// PSRL predictive-addendum tests — survival/right-censoring, causal
// change-points, independent vetoes, opportunity disagreement, breadth,
// catalyst PIT discipline, forecastability abstention. Deterministic
// fixtures only.

const test = require('node:test');
const assert = require('node:assert');

const SV = require('../lib/psrl/survival');
const CP = require('../lib/psrl/changepoint');
const V = require('../lib/psrl/vetoes');
const B = require('../lib/psrl/breadth');
const CAT = require('../lib/psrl/catalyst');
const { applyPredictive } = require('../lib/psrl/engine');

// ── survival / trend-life ───────────────────────────────────────────────────

function closedEp(sessions, terminalEvent) {
  return { observations: Array.from({ length: sessions }, () => ({})), terminalEvent, rightCensored: false, startDate: '2026-01-01' };
}

test('trend-life abstains below the resolved-episode floor — accrual, not a curve', () => {
  const ledger = { episodes: {}, closed: [closedEp(10, 'PLATEAU'), closedEp(20, 'ABSOLUTE_TREND_BREAK')] };
  const fit = SV.fitTrendLife(ledger);
  assert.strictEqual(fit.available, false);
  assert.strictEqual(fit.reason, 'INSUFFICIENT_SAMPLE');
  assert.strictEqual(fit.survival.h21, null, 'no survival numbers before the floor');
  const proj = SV.trendLifeFor(fit, 30);
  assert.strictEqual(proj.available, false);
  assert.strictEqual(proj.pSurvive21, null);
});

test('life table: censored episodes contribute exposure only; hazards respect risk sets', () => {
  const closed = [
    ...Array.from({ length: 20 }, () => closedEp(10, 'ABSOLUTE_TREND_BREAK')),
    ...Array.from({ length: 15 }, () => closedEp(30, 'PLATEAU')),
  ];
  const active = { CENS: { observations: Array.from({ length: 8 }, () => ({})), terminalEvent: null, rightCensored: true, startDate: '2026-02-01' } };
  const fit = SV.fitTrendLife({ episodes: active, closed });
  assert.strictEqual(fit.available, true);
  assert.strictEqual(fit.resolved, 35);
  assert.strictEqual(fit.censored, 1, 'active episode counted as censored exposure');
  assert.strictEqual(fit.survival.h5, 1, 'no terminal event ever occurred in the first 5 sessions');
  assert.ok(fit.survival.h21 > 0 && fit.survival.h21 < 1, 'hazard mass at age 10 lowers 21-session survival');
  assert.ok(fit.byCause.breakdown.count === 20 && fit.byCause.stagnation.count === 15, 'competing risks tallied by family');
  assert.strictEqual(fit.calibrationStatus, 'uncalibrated');

  // Age-conditional projection beyond observed exposure honestly returns null.
  const old = SV.trendLifeFor(fit, 100);
  assert.strictEqual(old.pSurvive5, null, 'no exposure at that age — abstain, never extrapolate');
  const young = SV.trendLifeFor(fit, 1);
  assert.ok(young.pSurvive5 > 0, 'young trend has estimable near-term survival');
});

test('competing-risk families: every terminal event maps; censoring maps to null', () => {
  const EP = require('../lib/psrl/episodes');
  for (const ev of EP.TERMINAL_EVENTS) {
    assert.ok(ev === 'RIGHT_CENSORED' ? SV.RISK_FAMILY[ev] === null : SV.RISK_FAMILY[ev] !== undefined, `family for ${ev}`);
  }
});

// ── causal change-point ─────────────────────────────────────────────────────

const upThenBreak = [
  ...Array.from({ length: 60 }, (_, i) => 0.002 + (i % 2 ? 0.003 : -0.003)),
  ...Array.from({ length: 20 }, (_, i) => -0.02 + (i % 2 ? 0.002 : -0.002)),
];

test('change-point: detects an injected regime break with a declining transition', () => {
  const r = CP.detectChangepoints(upThenBreak);
  assert.ok(r.supported);
  assert.ok(r.detections >= 1, 'break detected');
  assert.ok(r.lastChangeIdx >= 58, `change located at/after the break, got ${r.lastChangeIdx}`);
  assert.ok(['STEADY_TO_DECLINING', 'HIGH_VOLATILITY_BREAK'].includes(r.likelyTransition), r.likelyTransition);
  assert.strictEqual(r.probabilityRecentChange, null, 'never a probability — uncalibrated');
  assert.ok(Number.isFinite(r.expectedCurrentRunLength));
});

test('change-point is CAUSAL: state at t equals a run on the truncated series', () => {
  const full = CP.detectChangepoints(upThenBreak, { trace: true });
  for (const t of [30, 59, 65, 79]) {
    const truncated = CP.detectChangepoints(upThenBreak.slice(0, t + 1), { trace: true });
    const a = full.trace[t], b = truncated.trace[t];
    assert.strictEqual(a.lastChangeIdx, b.lastChangeIdx, `lastChangeIdx at t=${t}`);
    assert.strictEqual(a.detections, b.detections, `detections at t=${t}`);
    assert.ok(Math.abs((a.cpos ?? 0) - (b.cpos ?? 0)) < 1e-12, `cusum state at t=${t}`);
  }
});

test('change-point: a steady series reports no reliable change', () => {
  const r = CP.detectChangepoints(Array.from({ length: 80 }, (_, i) => 0.001 + (i % 2 ? 0.002 : -0.002)));
  assert.strictEqual(r.detections, 0);
  assert.strictEqual(r.likelyTransition, 'NO_RELIABLE_CHANGE');
});

// ── vetoes + explicit override rule ─────────────────────────────────────────

function fakeCard(overrides = {}) {
  return {
    available: true, ticker: 'FAKE', sector: 'Technology',
    liquidity: { price: 50, dollarVol: 2e7 },
    scores: { combinedAfterPenalties: 85, rankScore: 80 },
    absPath: { state: 'STEADY_ADVANCE', post: {} },
    trend: { byHorizon: { 21: { available: true, accel: 0.001, totalReturn: 0.08, maxDrawdown: -0.05 }, 63: { available: true, maxDrawdown: -0.06 } }, sma: { byN: {} } },
    residual: { byHorizon: { 21: { residual: 0.03 } }, residualAccel: 0.001, beta: 1.0 },
    continuity: { w63: { concentration: { top1Share: 0.1 }, gaps: { gapDependence: 0.2 } } },
    participation: 0.6, extensionAtr: 1.5, atrPct: 0.02, trendAge: 30,
    support: { grade: 'FULL', abstain: false, reasons: [] },
    entry: { state: 'BUY_ZONE', reasons: [] },
    eligibility: { staleSessions: 0 },
    changepoint: {
      absolute: { recentChange: false, probabilityRecentChange: null },
      residual: { recentChange: false, probabilityRecentChange: null },
    },
    ...overrides,
  };
}

test('stage-3 rule: high continuation evidence cannot erase an independent failure veto', () => {
  const broken = fakeCard({ absPath: { state: 'TREND_BROKEN', post: {} } });
  const out = applyPredictive(broken, { market: { state: 'BULL' }, asOf: '2026-08-11' });
  assert.strictEqual(out.vetoes.breakdown.triggered, true);
  assert.strictEqual(out.vetoes.vetoed, true);
  assert.strictEqual(out.entry.state, 'WATCH', 'BUY capped to WATCH by the veto');
  assert.ok(out.entry.reasons.includes('FAILURE_VETO_ACTIVE'));
  assert.ok(out.scores.rankScore < out.scores.rankScorePreVeto, 'rank haircut applied');
  assert.match(out.vetoes.rule, /veto ≥ gate/);
});

test('stagnation veto separates dead plateaus from constructive consolidation', () => {
  const dead = V.stagnationVeto(fakeCard({
    absPath: { state: 'JUMP_PLATEAU', post: { daysSinceHigh: 20, higherLowPct: 0.2 } },
    residual: { residualAccel: -0.002, byHorizon: {} }, participation: 0.2,
  }));
  const constructive = V.stagnationVeto(fakeCard({
    absPath: { state: 'JUMP_HOLDING', post: { daysSinceHigh: 6, higherLowPct: 0.8, rangeContraction: 0.3 } },
  }));
  assert.ok(dead.score > constructive.score + 0.3, `dead ${dead.score} vs constructive ${constructive.score}`);
  assert.ok(dead.triggered && !constructive.triggered);
});

test('opportunity value: horizons are exposed separately and disagreement is flagged, never averaged', () => {
  const card = fakeCard({ atrPct: 0.006, scores: { combinedAfterPenalties: 42, rankScore: 40 }, liquidity: { price: 50, dollarVol: 5e6 } });
  const vet = V.vetoesFor(card, {});
  const opp = V.opportunityValue({ card, vetoes: vet });
  assert.strictEqual(opp.basis, 'BASELINE_UNCALIBRATED');
  assert.ok(opp.byHorizon.h5 && opp.byHorizon.h21 && opp.byHorizon.h63, 'three separate horizons');
  assert.ok(!('value' in opp), 'no single averaged value exists');
  if (opp.horizonsDisagree) assert.match(opp.disagreement, /never averaged/);
});

// ── breadth + market state ──────────────────────────────────────────────────

function breadthCard(t, sector, { dist20 = 0.05, ret21 = 0.05, resid21 = 0.02, quadrant = 'TRUE_LEADER', combined = 70 } = {}) {
  return {
    ticker: t, sector, available: true, quadrant,
    trend: { sma: { byN: { 20: { dist: dist20 }, 50: { dist: dist20 }, 200: { dist: dist20 } } }, byHorizon: { 21: { totalReturn: ret21 }, 63: { distFromHigh: -0.02 } } },
    residual: { byHorizon: { 21: { residual: resid21, sectorRel: resid21 } } },
    scores: { combinedAfterPenalties: combined },
  };
}

test('sector breadth: strengthening vs weak sectors and per-stock leadership states', () => {
  const strong = Array.from({ length: 6 }, (_, i) => breadthCard(`S${i}`, 'Technology', { combined: 50 + i * 5 }));
  const weak = Array.from({ length: 6 }, (_, i) => breadthCard(`W${i}`, 'Energy', { dist20: -0.05, ret21: -0.04, resid21: -0.02, quadrant: 'AVOID', combined: 30 + i }));
  const br = B.sectorBreadth([...strong, ...weak]);
  assert.ok(br.sectors.Technology.pctAboveSma50 > 0.9);
  assert.ok(br.sectors.Energy.pctAboveSma50 < 0.1);
  assert.match(br.sectorBasis, /NOT point-in-time/);

  const leader = { ...strong[5], sectorPercentile: 1 };
  const st = B.sectorStockState(leader, br, {});
  assert.strictEqual(st.state, 'LEADER_IN_STRENGTHENING_SECTOR');
  const passenger = { ...breadthCard('P1', 'Technology', { resid21: -0.01, quadrant: 'MARKET_CARRIED_LAGGARD' }), sectorPercentile: 0.2 };
  assert.strictEqual(B.sectorStockState(passenger, br, {}).state, 'MARKET_PASSENGER');
  const small = B.sectorBreadth([breadthCard('X', 'Utilities')]);
  assert.strictEqual(small.sectors.Utilities.available, false, 'tiny cohorts abstain');
});

test('market state is graded, not a binary switch', () => {
  const mkSpy = (rets) => {
    let c = 100;
    return rets.map((r, i) => { c *= 1 + r; return { date: `d${i}`, close: c }; });
  };
  const bull = B.marketState(mkSpy(Array.from({ length: 300 }, (_, i) => (i % 2 ? -0.002 : 0.004))));
  assert.strictEqual(bull.state, 'BULL');
  const crash = B.marketState(mkSpy([
    ...Array.from({ length: 250 }, (_, i) => (i % 2 ? -0.002 : 0.004)),
    ...Array.from({ length: 40 }, () => -0.008),
  ]));
  assert.ok(['BEAR', 'CORRECTION', 'PANIC_REVERSAL_RISK'].includes(crash.state), crash.state);
  assert.ok(B.MARKET_STATES.length === 6, 'six graded states exist');
});

// ── catalysts (PIT discipline) ──────────────────────────────────────────────

test('catalyst confirmation: future events are dropped, missing feeds are UNAVAILABLE with reasons', () => {
  const events = [
    { type: 'SEC_8K', direction: 'positive', firstSeenAt: '2026-08-01' },
    { type: 'EARNINGS_SURPRISE', direction: 'positive', firstSeenAt: '2026-08-20' }, // future — must be dropped
  ];
  const f = CAT.catalystFeatures({ events, asOf: '2026-08-11' });
  assert.strictEqual(f.available, true);
  assert.strictEqual(f.eventsConsidered, 1);
  assert.strictEqual(f.droppedFutureEvents, 1, 'PIT: post-decision events never leak in');
  assert.strictEqual(f.firstSeenAt, '2026-08-01');
  assert.strictEqual(f.estimateRevision7d, null);
  assert.match(f.unavailableReasons.estimateRevisions, /never reconstructed from current estimates/);
  const none = CAT.catalystFeatures({ events: [], asOf: '2026-08-11' });
  assert.strictEqual(none.catalystSupportGrade, 'UNAVAILABLE');
});

// ── forecastability / abstention ────────────────────────────────────────────

test('forecastability: deterministic abstention ladder with documented unavailable components', () => {
  const ok = applyPredictive(fakeCard(), { market: { state: 'BULL' }, asOf: '2026-08-11' });
  assert.strictEqual(ok.forecastability.disposition, 'ACTIONABLE');
  assert.ok(ok.forecastability.unavailable.includes('conformal-intervals'), 'honesty: conformal not implemented');
  const low = applyPredictive(fakeCard({ support: { grade: 'LOW', abstain: false, reasons: ['BETA_MODEL_LOW_SUPPORT'] } }), { market: { state: 'BULL' }, asOf: '2026-08-11' });
  assert.ok(['WATCH', 'ABSTAIN'].includes(low.forecastability.disposition));
  const stale = applyPredictive(fakeCard({ support: { grade: 'STALE', abstain: true, reasons: ['DATA_STALE'] } }), { market: { state: 'BULL' }, asOf: '2026-08-11' });
  assert.strictEqual(stale.forecastability.disposition, 'DATA_STALE');
});

test('probability-display restriction: no calibrated-looking probabilities anywhere in a predictive card', () => {
  const out = applyPredictive(fakeCard(), { market: { state: 'BULL' }, trendLifeFit: null, asOf: '2026-08-11' });
  assert.strictEqual(out.changepoint.absolute.probabilityRecentChange, null);
  assert.strictEqual(out.trendLife.pSurvive21, null, 'no fitted table → null with reason');
  assert.strictEqual(out.trendLife.reason, 'INSUFFICIENT_SAMPLE');
  assert.strictEqual(out.opportunity.basis, 'BASELINE_UNCALIBRATED');
});
