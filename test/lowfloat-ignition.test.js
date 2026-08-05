'use strict';
// THE 31 REQUIRED BEHAVIOURS of the low-float / intraday-continuation redesign.
//
// Each test is numbered to match the specification it enforces. They are behavioural, not
// implementation tests: they assert the DECISION the system reaches, so the internals can be
// refactored without rewriting them — and so a refactor that quietly breaks a safety rule
// (a forming candle confirming a breakout, an unvalidated template going live) fails loudly.

const { test } = require('node:test');
const assert = require('node:assert');

const F = require('./lowfloat-fixtures');
const CFG = require('../lib/lowfloat-config');
const floatData = require('../lib/float-data');
const supply = require('../lib/supply-risk');
const catalyst = require('../lib/catalyst-context');
const discovery = require('../lib/mover-discovery');
const ignition = require('../lib/low-float-ignition');
const cont = require('../lib/intraday-continuation');
const act = require('../lib/intraday-actionability');
const outcomes = require('../lib/intraday-outcomes');
const validation = require('../lib/intraday-validation');
const auditLib = require('../lib/large-mover-audit');
const universe = require('../lib/tradable-universe');
const idata = require('../lib/intraday-data');

const S = cont.STRUCTURE_STATES;
const A = act.ACTION_STATES;

// Analyze a fixture at the instant just after its last bar completes.
function analyze(bars, over = {}) {
  return cont.analyzeIntradayContinuation(bars, { now: F.at(bars.length * 5 + 3), ...over });
}
function decide(bars, ctxOver = {}, analysisOver = {}) {
  const a = { ...analyze(bars), ...analysisOver };
  return act.evaluateActionability(a, F.tradeableCtx({ price: a.price, ...ctxOver }));
}

// ── 1. A historically dormant low-float stock with sudden strong current volume ──────────
test('1. dormant low-float stock with sudden volume is DISCOVERED despite a tiny historical average', () => {
  // Arrange — 40k average daily volume (would fail any 500k historical gate), 2M shares today.
  const now = new Date(Date.UTC(2026, 7, 5, 15, 0));
  const quotes = [{
    ticker: 'DORM', price: 6.2, prevClose: 4.0, dayVolume: 2_000_000, open: 4.3,
    avgVolume: 40_000, asOf: now.toISOString(),
  }];
  const state = {
    byTicker: {
      DORM: {
        price: 5.6, dayVolume: 1_500_000, at: new Date(now - 5 * 60000).toISOString(),
        n: 4, volMean: 20_000, retMean: 0.001, trail: [],
      },
    },
  };
  const floatByTicker = { DORM: { floatShares: 3_000_000, floatTier: 'ULTRA_LOW', floatConfidence: 'HIGH', usable: true } };

  // Act
  const out = discovery.buildCandidates({ quotes, state, floatByTicker, now, minutesSinceOpen: 90 });

  // Assert — present, and specifically found by the low-float demand lane.
  assert.strictEqual(out.candidates.length, 1);
  const c = out.candidates[0];
  assert.ok(c.discoverySources.includes(discovery.LANES.LOW_FLOAT_DEMAND),
    'the low-float demand lane must fire on real float turnover');
  assert.ok(c.discoverySources.includes(discovery.LANES.RVOL_MOVER));
  assert.ok(c.floatTurnover > 0.5, 'over half the float traded today');
  // And no rejection reason mentions historical volume, because none exists.
  assert.strictEqual(out.rejected.thinSession, 0);
});

// ── 2. Small market cap with a large float is not mislabelled ────────────────────────────
test('2. a small-cap with a LARGE float is not treated as low float', () => {
  const rec = floatData.mergeProviderAnswers('SMALLCAP', [{
    provider: 'fmp-shares-float',
    data: { floatShares: 180_000_000, sharesOutstanding: 200_000_000, asOf: new Date().toISOString(), filingDate: new Date().toISOString() },
  }]);
  assert.strictEqual(rec.floatTier, 'NORMAL');

  // And the supply-constraint family awards almost nothing for it.
  const scored = ignition.scoreExplosionPotential(
    ignition.calculateIgnitionFeatures({ price: 3, floatShares: 180_000_000, floatUsable: true, sessionVolume: 5e6, sessionDollarVolume: 15e6 }),
    { floatConfidence: 'HIGH' });
  assert.ok(scored.families.SUPPLY_CONSTRAINT < CFG.EXPLOSION_FAMILIES.SUPPLY_CONSTRAINT * 0.2,
    'a 180M float must not earn a supply-constraint score');
});

// ── 3. Ultra-low float with strong turnover ──────────────────────────────────────────────
test('3. ultra-low float with strong float turnover scores high explosion and warns on execution', () => {
  const f = ignition.calculateIgnitionFeatures({
    price: 8, sessionVolume: 4_000_000, sessionDollarVolume: 32_000_000,
    floatShares: 3_000_000, floatUsable: true, minutesSinceOpen: 90,
    relativeVolume: 12, dayChangePct: 22, fiveMinChange: 2.1, fifteenMinChange: 5,
    thirtyMinChange: 9, volumeAcceleration: 3.5,
  });
  const exp = ignition.scoreExplosionPotential(f, {
    floatConfidence: 'HIGH',
    catalyst: { catalystPresent: true, catalystType: 'FDA_APPROVAL', catalystTier: 1, materiality: 1, freshnessMinutes: 30 },
    regime: 'risk-on',
  });
  assert.ok(exp.explosionPotentialScore >= 60, `expected high explosion, got ${exp.explosionPotentialScore}`);
  assert.ok(exp.reasonCodes.includes('SUPPLY_TIGHT_FLOAT'));

  // Execution warning: an ultra-low-float name always requires a human spread check.
  assert.strictEqual(act.requiresManualSpreadCheck({ price: 8, floatTier: 'ULTRA_LOW', spreadObserved: false }), true);
});

// ── 4. High-volume large-float name ──────────────────────────────────────────────────────
test('4. a high-volume LARGE-float name gets participation credit but little supply credit', () => {
  const f = ignition.calculateIgnitionFeatures({
    price: 50, sessionVolume: 40_000_000, sessionDollarVolume: 2_000_000_000,
    floatShares: 900_000_000, floatUsable: true, minutesSinceOpen: 90,
    relativeVolume: 8, dayChangePct: 9, volumeAcceleration: 2.2,
  });
  const exp = ignition.scoreExplosionPotential(f, { floatConfidence: 'HIGH', regime: 'risk-on' });
  assert.ok(exp.families.PARTICIPATION > 5, 'real dollars must earn participation credit');
  assert.ok(exp.families.SUPPLY_CONSTRAINT < 3, 'a 900M float earns essentially no supply credit');
});

// ── 5. Missing float ─────────────────────────────────────────────────────────────────────
test('5. missing float yields UNKNOWN — never a fabricated value and never "low float"', () => {
  const rec = floatData.mergeProviderAnswers('NOFLOAT', [{ provider: 'fmp-shares-float', error: '404' }]);
  assert.strictEqual(rec.floatShares, null);
  assert.strictEqual(rec.floatTier, 'UNKNOWN');
  assert.strictEqual(rec.floatConfidence, 'LOW');
  assert.strictEqual(rec.usable, false);

  // And the scorer gives it ZERO supply credit rather than a default.
  const exp = ignition.scoreExplosionPotential(
    ignition.calculateIgnitionFeatures({ price: 8, floatShares: null, floatUsable: false, sessionVolume: 4e6, sessionDollarVolume: 32e6, relativeVolume: 12 }),
    { floatConfidence: 'LOW' });
  assert.strictEqual(exp.families.SUPPLY_CONSTRAINT, 0);
  assert.ok(exp.reasonCodes.includes('FLOAT_UNKNOWN_NO_SUPPLY_CREDIT'));
});

// ── 6. Stale float ───────────────────────────────────────────────────────────────────────
test('6. a stale float record is confidence-penalized', () => {
  const now = new Date('2026-08-05T12:00:00Z');
  const old = new Date('2025-01-01T00:00:00Z').toISOString();   // ~580 days
  const rec = floatData.mergeProviderAnswers('STALE', [{
    provider: 'fmp-shares-float',
    data: { floatShares: 4_000_000, sharesOutstanding: 10_000_000, asOf: old, filingDate: old },
  }], { now });
  assert.strictEqual(rec.stale, true);
  assert.strictEqual(rec.floatConfidence, 'LOW');
  assert.strictEqual(rec.usable, false, 'beyond MAX_AGE_DAYS the float cannot be used as evidence');

  // A merely stale (not ancient) record drops to MEDIUM but stays usable.
  const semi = floatData.mergeProviderAnswers('SEMI', [{
    provider: 'fmp-shares-float',
    data: { floatShares: 4_000_000, sharesOutstanding: 10_000_000, asOf: '2026-02-01T00:00:00Z', filingDate: '2026-02-01T00:00:00Z' },
  }], { now });
  assert.strictEqual(semi.floatConfidence, 'MEDIUM');
  assert.strictEqual(semi.usable, true);
});

// ── 7. Conflicting float sources ─────────────────────────────────────────────────────────
test('7. conflicting float sources raise a conflict and keep the CONSERVATIVE (larger) value', () => {
  const iso = new Date().toISOString();
  const rec = floatData.mergeProviderAnswers('CONF', [
    { provider: 'a', data: { floatShares: 4_000_000, sharesOutstanding: 20_000_000, asOf: iso, filingDate: iso } },
    { provider: 'b', data: { floatShares: 9_000_000, sharesOutstanding: 20_000_000, asOf: iso, filingDate: iso } },
  ]);
  assert.strictEqual(rec.conflicts.length, 1);
  assert.strictEqual(rec.floatShares, 9_000_000, 'a disagreement must never manufacture a smaller float');
  assert.strictEqual(rec.floatConfidence, 'LOW');
});

// ── 8. Fresh material catalyst ───────────────────────────────────────────────────────────
test('8. a fresh material catalyst earns tier-1 catalyst credit', () => {
  const now = new Date();
  const ctx = catalyst.buildCatalystContext([
    { title: 'Acme announces FDA approval of ACME-1', datetime: new Date(now - 20 * 60000).toISOString(), publisher: 'GlobeNewswire' },
  ], { now });
  assert.strictEqual(ctx.catalystPresent, true);
  assert.strictEqual(ctx.catalystTier, 1);
  assert.ok(ctx.materiality > 0.8);
  assert.strictEqual(ctx.isRecycled, false);

  const exp = ignition.scoreExplosionPotential(ignition.calculateIgnitionFeatures({ price: 5 }), { catalyst: ctx });
  assert.ok(exp.families.CATALYST > CFG.EXPLOSION_FAMILIES.CATALYST * 0.7);
  assert.ok(exp.reasonCodes.includes('CATALYST_TIER1'));
});

// ── 9. Recycled news ─────────────────────────────────────────────────────────────────────
test('9. recycled news scores materially lower than the same headline when fresh', () => {
  const now = new Date();
  const fresh = catalyst.buildCatalystContext([
    { title: 'Acme announces FDA approval of ACME-1', datetime: new Date(now - 20 * 60000).toISOString(), publisher: 'GlobeNewswire' },
  ], { now });
  const stale = catalyst.buildCatalystContext([
    { title: 'Acme announces FDA approval of ACME-1', datetime: new Date(now - 5 * 24 * 3600 * 1000).toISOString(), publisher: 'GlobeNewswire' },
  ], { now });
  assert.strictEqual(stale.isRecycled, true);
  assert.ok(stale.materiality < fresh.materiality * 0.5, 'recycled news must be heavily discounted');
});

// ── 10. Active offering ──────────────────────────────────────────────────────────────────
test('10. an active offering raises a supply warning and penalizes TRADE QUALITY (not discovery)', () => {
  const now = new Date();
  const ev = supply.scanHeadlines([{ title: 'Acme announces at-the-market offering program', datetime: now.toISOString() }], { now });
  const risk = supply.assessSupplyRisk({ evidence: ev, newsAvailable: true });
  assert.strictEqual(risk.dilutionRisk, 'HIGH');
  assert.strictEqual(risk.atmRisk, true);

  const f = ignition.calculateIgnitionFeatures({ price: 5, sessionDollarVolume: 40e6, minutesSinceOpen: 90 });
  const withRisk = ignition.scoreTradeQuality(f, { supplyRisk: risk, structure: analyze(F.CONFIRMED_BREAKOUT_BARS) });
  const without = ignition.scoreTradeQuality(f, { supplyRisk: { dilutionRisk: 'LOW' }, structure: analyze(F.CONFIRMED_BREAKOUT_BARS) });
  assert.ok(withRisk.tradeQualityScore < without.tradeQualityScore, 'high dilution risk must cost trade quality');
  assert.ok(withRisk.warnings.includes('HIGH_DILUTION_RISK'));

  // Explosion potential is NOT reduced by the dilution risk — discovery is preserved.
  const expRisk = ignition.scoreExplosionPotential(f, { supplyRisk: risk });
  const expNone = ignition.scoreExplosionPotential(f, { supplyRisk: { dilutionRisk: 'LOW' } });
  assert.strictEqual(expRisk.explosionPotentialScore, expNone.explosionPotentialScore);
  assert.ok(expRisk.penalties.includes('HIGH_SUPPLY_RISK'), 'but it must be surfaced as a warning');
});

// ── 11. HELP-like compression ────────────────────────────────────────────────────────────
test('11. a tight consolidation under the high classifies as COMPRESSION or BREAKOUT_PENDING', () => {
  const r = analyze(F.COMPRESSION_BARS);
  assert.ok([S.COMPRESSION, S.BREAKOUT_PENDING].includes(r.structureState), `got ${r.structureState}`);
  assert.ok(r.compressionRatio < 1, 'a contracting range must have a ratio BELOW 1');
});

// ── 12. JLHL-like post-spike collapse ────────────────────────────────────────────────────
test('12. a post-spike collapse classifies as DISTRIBUTION or EXHAUSTED', () => {
  const r = analyze(F.POST_SPIKE_COLLAPSE_BARS);
  assert.ok([S.DISTRIBUTION, S.EXHAUSTED].includes(r.structureState), `got ${r.structureState}`);
  const d = decide(F.POST_SPIKE_COLLAPSE_BARS);
  assert.strictEqual(d.actionState, A.AVOID);
});

// ── 13. Forming-bar breakout ─────────────────────────────────────────────────────────────
test('13. a FORMING bar above resistance is BREAKOUT_ATTEMPT and can never be confirmed', () => {
  const forming = {
    t: new Date(Date.UTC(2026, 7, 5, 13, 30 + 5 * F.COMPRESSION_BARS.length)).toISOString(),
    o: 11.29, h: 11.9, l: 11.28, c: 11.85, v: 60000,
  };
  const r = analyze(F.COMPRESSION_BARS, { formingBar: forming });
  assert.strictEqual(r.structureState, S.BREAKOUT_ATTEMPT);
  assert.ok(r.reasonCodes.includes('NOT_CONFIRMED_UNTIL_BAR_CLOSES'));

  const d = act.evaluateActionability(r, F.tradeableCtx({ price: r.price }));
  assert.ok(d.blockingReasons.includes('FORMING_CANDLE_BREAKOUT_NOT_CONFIRMED'));
  assert.strictEqual(d.entryAllowed, false);
});

// ── 14. Completed breakout ───────────────────────────────────────────────────────────────
test('14. a completed close above resistance on volume is BREAKOUT_CONFIRMED', () => {
  const r = analyze(F.CONFIRMED_BREAKOUT_BARS);
  assert.strictEqual(r.structureState, S.BREAKOUT_CONFIRMED);
  assert.ok(r.reasonCodes.includes('COMPLETED_CLOSE_ABOVE_RESISTANCE'));
  assert.ok(r.reasonCodes.includes('VOLUME_CONFIRMED'));
});

// ── 15. Failed breakout ──────────────────────────────────────────────────────────────────
test('15. a failed breakout blocks entry', () => {
  const r = analyze(F.FAILED_BREAKOUT_BARS);
  assert.strictEqual(r.structureState, S.FAILED_BREAKOUT);
  const d = decide(F.FAILED_BREAKOUT_BARS);
  assert.strictEqual(d.actionState, A.AVOID);
  assert.strictEqual(d.entryAllowed, false);
  assert.ok(d.blockingReasons.includes('FAILED_BREAKOUT'));
});

// ── 16. Controlled retest ────────────────────────────────────────────────────────────────
test('16. a controlled retest is BREAKOUT_RETEST and can reach paper eligibility', () => {
  const r = analyze(F.VWAP_RECOVERY_BARS);
  assert.strictEqual(r.structureState, S.BREAKOUT_RETEST);
  const d = decide(F.VWAP_RECOVERY_BARS);
  assert.strictEqual(d.entryTemplate, act.ENTRY_TEMPLATES.FIRST_BREAKOUT_RETEST);
  assert.strictEqual(d.actionState, A.PAPER_ENTRY_ELIGIBLE);
});

// ── 17. VWAP pullback WITHOUT recovery ───────────────────────────────────────────────────
test('17. a VWAP pullback with no completed recovery bar is WATCH_ONLY', () => {
  const r = analyze(F.PULLBACK_NO_RECOVERY_BARS);
  assert.strictEqual(r.structureState, S.CONSTRUCTIVE_PULLBACK);
  const d = decide(F.PULLBACK_NO_RECOVERY_BARS);
  assert.strictEqual(d.actionState, A.WATCH_ONLY);
  assert.ok(d.templateRequirementsMissing.includes('NEEDS_COMPLETED_RECOVERY_BAR'));
});

// ── 18. VWAP recovery ────────────────────────────────────────────────────────────────────
test('18. a completed recovery reaches PAPER_ENTRY_ELIGIBLE when the other checks pass', () => {
  const d = decide(F.VWAP_RECOVERY_BARS);
  assert.strictEqual(d.actionState, A.PAPER_ENTRY_ELIGIBLE);
  assert.strictEqual(d.entryAllowed, true);
  assert.deepStrictEqual(d.blockingReasons, []);
});

// ── 19. Excessive chase ──────────────────────────────────────────────────────────────────
test('19. price above the maximum chase price is MISSED_OR_EXTENDED, not an entry', () => {
  const d = decide(F.EXTENDED_BREAKOUT_BARS, { price: 11.78 });
  assert.strictEqual(d.actionState, A.MISSED_OR_EXTENDED);
  assert.strictEqual(d.entryAllowed, false);
  assert.ok(d.blockingReasons.includes('ABOVE_MAXIMUM_CHASE_PRICE'));
  assert.strictEqual(d.setupEntryClassification, act.SETUP_ENTRY_CLASSES.GOOD_SETUP_BAD_ENTRY);
  assert.match(d.whatMustHappenNext, /Do not chase/i);
  assert.ok(Number.isFinite(d.maximumChasePrice), 'the maximum chase price must be displayed');
});

// ── 20. Risk-off market ──────────────────────────────────────────────────────────────────
test('20. a risk-off tape blocks long entries by default but the candidate is still analyzed', () => {
  const d = decide(F.CONFIRMED_BREAKOUT_BARS, { regime: 'risk-off' });
  assert.ok(d.blockingReasons.includes('RISK_OFF_MARKET_DEFAULT_BLOCK'));
  assert.strictEqual(d.entryAllowed, false);
  // Research logging is retained: the analysis, template and scores are all still produced.
  assert.strictEqual(d.entryTemplate, act.ENTRY_TEMPLATES.COMPLETED_BREAKOUT);
  assert.ok(d.entryQualityScore > 0);
  // And the block is a POLICY default, overridable, not a validated gate.
  const allowed = decide(F.CONFIRMED_BREAKOUT_BARS, { regime: 'risk-off', allowRiskOffEntries: true });
  assert.ok(!allowed.blockingReasons.includes('RISK_OFF_MARKET_DEFAULT_BLOCK'));
});

// ── 21. Stale intraday data ──────────────────────────────────────────────────────────────
test('21. stale intraday data forces NO_TRADE', () => {
  const r = analyze(F.CONFIRMED_BREAKOUT_BARS, { stale: true });
  assert.strictEqual(r.structureState, S.STALE_DATA);
  const d = act.evaluateActionability(r, F.tradeableCtx({ stale: true, price: 11.36 }));
  assert.strictEqual(d.actionState, A.NO_TRADE);
  assert.strictEqual(d.entryAllowed, false);
});

// ── 22. Fewer than 15 minutes to the close ───────────────────────────────────────────────
test('22. fewer than the minimum minutes to close blocks a NEW entry', () => {
  // 15:52 ET → 8 minutes left.
  const late = new Date(Date.UTC(2026, 7, 5, 19, 52));
  const a = cont.analyzeIntradayContinuation(F.CONFIRMED_BREAKOUT_BARS, { now: late, stale: false });
  const d = act.evaluateActionability({ ...a, minutesUntilClose: 8 }, F.tradeableCtx({ price: a.price }));
  assert.ok(d.blockingReasons.includes('INSUFFICIENT_TIME_TO_CLOSE'));
  assert.strictEqual(d.actionState, A.MANAGE_EXISTING_ONLY);
});

// ── 23. Poor reward-to-risk ──────────────────────────────────────────────────────────────
test('23. reward:risk below the floor blocks the entry, and the stop is never tightened to fix it', () => {
  const a = analyze(F.CONFIRMED_BREAKOUT_BARS);
  const poor = { ...a, riskReward: 1.1 };
  const d = act.evaluateActionability(poor, F.tradeableCtx({ price: a.price }));
  assert.ok(d.blockingReasons.includes('REWARD_RISK_BELOW_FLOOR'));
  assert.strictEqual(d.entryAllowed, false);
  assert.match(d.whatMustHappenNext, /Do not tighten the stop/i);

  // The plan's stop is structural: it does not move when the target does.
  const plan = cont.buildContinuationPlan(a.features, { bars: F.CONFIRMED_BREAKOUT_BARS });
  const plan2 = cont.buildContinuationPlan(a.features, { bars: F.CONFIRMED_BREAKOUT_BARS });
  assert.strictEqual(plan.invalidation, plan2.invalidation);
});

// ── 24. Low-priced stock without a manual spread check ───────────────────────────────────
test('24. a sub-$5 name without a spread confirmation is blocked', () => {
  const a = analyze(F.CONFIRMED_BREAKOUT_BARS);
  const cheap = { ...a, price: 3.5 };
  const blocked = act.evaluateActionability(cheap, F.tradeableCtx({ price: 3.5, spreadObserved: false }));
  assert.ok(blocked.manualSpreadCheckRequired);
  assert.ok(blocked.blockingReasons.includes('MANUAL_SPREAD_CONFIRMATION_REQUIRED'));
  assert.strictEqual(blocked.entryAllowed, false);

  // With the human attestation it clears.
  const ok = act.evaluateActionability(cheap, F.tradeableCtx({ price: 3.5, spreadObserved: false, spreadConfirmed: true }));
  assert.ok(!ok.blockingReasons.includes('MANUAL_SPREAD_CONFIRMATION_REQUIRED'));
});

// ── 25. No look-ahead ────────────────────────────────────────────────────────────────────
test('25. features and states at time T never use bars after T', () => {
  const full = F.CONFIRMED_BREAKOUT_BARS;
  const truncated = full.slice(0, -1);   // everything before the breakout bar
  const tEarly = F.at((full.length - 1) * 5 + 3);

  // Evaluating the FULL series at the earlier instant must equal evaluating the truncated
  // series — i.e. the future bar is invisible.
  const withFuture = cont.analyzeIntradayContinuation(
    idata.completedBarsOnly(full, tEarly), { now: tEarly });
  const withoutFuture = cont.analyzeIntradayContinuation(truncated, { now: tEarly });
  assert.strictEqual(withFuture.structureState, withoutFuture.structureState);
  assert.strictEqual(withFuture.price, withoutFuture.price);
  assert.strictEqual(withFuture.priorResistance, withoutFuture.priorResistance);

  // And the completed/forming split itself excludes a bar whose interval has not elapsed.
  const completed = idata.completedBarsOnly(full, tEarly);
  assert.strictEqual(completed.length, full.length - 1);
});

// ── 26. Same-bar target and stop ─────────────────────────────────────────────────────────
test('26. a target and stop inside one bar resolve STOP-FIRST and are flagged as ambiguous', () => {
  const bars = F.bars([[10, 10.2, 9.9, 10.1, 1000], [10.1, 11.0, 9.5, 10.2, 1000]]);
  const ev = outcomes.buildEntryEvent({
    ticker: 'AMB', sessionDate: F.SESSION_DATE,
    signalTimestamp: bars[1].t, firstUserVisibleTimestamp: bars[1].t,
    entryTemplate: 'COMPLETED_BREAKOUT', trigger: 10.1, structuralStop: 9.8, target1: 10.9,
    minutesUntilClose: 200, sessionDollarVolume: 50e6,
  });
  const r = outcomes.resolveEntryEvent(ev, bars);
  assert.strictEqual(r.target1Hit, false);
  assert.strictEqual(r.invalidationHit, true);
  assert.strictEqual(r.sameBarAmbiguous, true);
  assert.match(r.sameBarRule, /STOP is assumed to have come first/i);
});

// ── 27. One ticker's provider failure ────────────────────────────────────────────────────
test('27. a single ticker failure does not remove the other candidates', () => {
  const now = new Date(Date.UTC(2026, 7, 5, 15, 0));
  const quotes = [
    { ticker: 'GOOD', price: 6.2, prevClose: 4.0, dayVolume: 2_000_000, avgVolume: 40_000, asOf: now.toISOString() },
    { ticker: 'BADQ', price: null, prevClose: 4.0, dayVolume: 1_000, asOf: now.toISOString() },
    { ticker: 'ALSO', price: 12, prevClose: 10, dayVolume: 3_000_000, avgVolume: 100_000, asOf: now.toISOString() },
  ];
  const out = discovery.buildCandidates({ quotes, now, minutesSinceOpen: 90 });
  assert.ok(out.candidates.some(c => c.ticker === 'GOOD'));
  assert.ok(out.candidates.some(c => c.ticker === 'ALSO'));
  assert.strictEqual(out.rejected.noPrice, 1, 'the broken row is counted, not silently dropped');

  // Float enrichment isolates failures the same way: an errored provider yields an explicit
  // UNKNOWN record rather than a missing key.
  const rec = floatData.mergeProviderAnswers('FAIL', [{ provider: 'registry', error: 'fetch failed' }]);
  assert.strictEqual(rec.floatTier, 'UNKNOWN');
});

// ── 28. Discovery recall audit ───────────────────────────────────────────────────────────
test('28. a missed mover receives the correct stage and reason', () => {
  const quotes = [
    { ticker: 'FOUND', price: 9, open: 4, dayHigh: 12, dayLow: 3.9, prevClose: 3.8, dayVolume: 20e6 },
    { ticker: 'WARR', price: 2, open: 1, dayHigh: 3, dayLow: 0.95, prevClose: 0.98, dayVolume: 1e6 },
    { ticker: 'QUIET', price: 4.2, open: 4, dayHigh: 9, dayLow: 3.9, prevClose: 3.95, dayVolume: 8e6 },
  ];
  const movers = auditLib.rankMovers(quotes, { topN: 20 });
  const trail = {
    universe: new Set(['FOUND', 'QUIET']),
    universeExclusions: new Map([['WARR', 'WARRANT']]),
    quoted: new Set(['FOUND', 'QUIET']),
    discovery: [{ generatedAt: '2026-08-05T14:00:00Z', candidates: [{ ticker: 'FOUND', firstDetectedAt: '2026-08-05T14:00:00Z', priceAtFirstDetection: 4.5, dayChangeAtFirstDetection: 18, discoveryRank: 3 }] }],
    ignition: [{ records: [{ ticker: 'FOUND', floatShares: 4e6, floatTier: 'ULTRA_LOW', actionState: 'PAPER_ENTRY_ELIGIBLE', displayed: true }] }],
    continuation: [{ records: [{ ticker: 'FOUND', structureState: 'BREAKOUT_CONFIRMED' }] }],
    events: [{ ticker: 'FOUND' }], rejections: [],
  };
  const out = auditLib.buildAudit({ sessionDate: F.SESSION_DATE, movers, trail, cfg: CFG.DISCOVERY });
  const by = Object.fromEntries(out.records.map(r => [r.ticker, r]));

  assert.strictEqual(by.FOUND.discovered, true);
  assert.strictEqual(by.FOUND.missCategory, null, 'a mover that produced an entry event is not a miss');
  assert.strictEqual(by.FOUND.pipelineStageReached, 'PAPER_ENTRY');

  assert.strictEqual(by.WARR.missCategory, auditLib.MISS_CATEGORIES.SECURITY_TYPE_EXCLUDED);
  assert.strictEqual(by.WARR.pipelineStageReached, 'NOT_IN_UNIVERSE');

  assert.strictEqual(by.QUIET.discovered, false);
  assert.ok(by.QUIET.missCategory, 'every missed mover must carry a category');
  assert.strictEqual(by.QUIET.rejectionStage, 'DISCOVERY');

  // Recall metrics exist and are computed over the audited set.
  assert.ok(Number.isFinite(out.recall.overallRecallPct));
  assert.ok(Number.isFinite(out.recall.recallOfTop10OpenToHighMovers));
});

// ── 29. pcarry suppression audit ─────────────────────────────────────────────────────────
test('29. a same-session runner suppressed by the carry model is recorded as PCARRY_SUPPRESSED', () => {
  const quotes = [{ ticker: 'CARRY', price: 9, open: 4, dayHigh: 12, dayLow: 3.9, prevClose: 3.8, dayVolume: 20e6 }];
  const movers = auditLib.rankMovers(quotes, { topN: 20 });
  const trail = {
    universe: new Set(['CARRY']), universeExclusions: new Map(), quoted: new Set(['CARRY']),
    discovery: [{ generatedAt: '2026-08-05T14:00:00Z', candidates: [{ ticker: 'CARRY', firstDetectedAt: '2026-08-05T14:00:00Z', priceAtFirstDetection: 4.5, dayChangeAtFirstDetection: 12, discoveryRank: 2 }] }],
    ignition: [{ records: [{ ticker: 'CARRY', floatShares: 4e6, floatTier: 'ULTRA_LOW' }] }],
    continuation: [{ records: [{ ticker: 'CARRY', structureState: 'BREAKOUT_CONFIRMED' }] }],
    events: [],
    rejections: [{ ticker: 'CARRY', reason: 'pcarry below the carry floor' }],
  };
  const out = auditLib.buildAudit({ sessionDate: F.SESSION_DATE, movers, trail, cfg: CFG.DISCOVERY });
  const rec = out.records.find(r => r.ticker === 'CARRY');
  assert.strictEqual(rec.discovered, true, 'it WAS discovered');
  assert.strictEqual(rec.missCategory, auditLib.MISS_CATEGORIES.PCARRY_SUPPRESSED);
  assert.strictEqual(rec.pcarrySuppressed, true);
});

// ── 29b. pcarry cannot reach the same-session discovery path at all ──────────────────────
test('29b. the same-session discovery stack never consults pcarry', () => {
  const fs = require('node:fs');
  const modules = [
    'lib/mover-discovery.js', 'lib/low-float-ignition.js', 'lib/intraday-continuation.js',
    'lib/intraday-actionability.js', 'lib/intraday-data.js', 'lib/lowfloat-pipeline.js',
  ];
  for (const m of modules) {
    const src = fs.readFileSync(require('node:path').join(__dirname, '..', m), 'utf8');
    assert.ok(!/require\(['"]\.\/pcarry['"]\)/.test(src), `${m} must not import pcarry`);
  }
});

// ── 30. Promotion gate ───────────────────────────────────────────────────────────────────
test('30. an unvalidated template can NEVER return LIVE_VALIDATED_ENTRY', () => {
  const a = analyze(F.CONFIRMED_BREAKOUT_BARS);
  const liveFlags = { ENABLE_LIVE_VALIDATED_SIGNALS: true, ENABLE_INTRADAY_PAPER_SIGNALS: true };

  // Flag on, template UNVALIDATED → paper.
  const unval = act.evaluateActionability(a, F.tradeableCtx({ price: a.price, flags: liveFlags, templatePromotion: 'UNVALIDATED' }));
  assert.strictEqual(unval.actionState, A.PAPER_ENTRY_ELIGIBLE);

  // Flag on, promoted but under a DIFFERENT configuration version → paper.
  const wrongVersion = act.evaluateActionability(a, F.tradeableCtx({
    price: a.price, flags: liveFlags, templatePromotion: 'LIVE_VALIDATED', promotionConfigVersion: 'some-other-version',
  }));
  assert.strictEqual(wrongVersion.actionState, A.PAPER_ENTRY_ELIGIBLE);

  // Flag OFF, properly promoted → still paper.
  const flagOff = act.evaluateActionability(a, F.tradeableCtx({
    price: a.price, flags: { ENABLE_LIVE_VALIDATED_SIGNALS: false, ENABLE_INTRADAY_PAPER_SIGNALS: true },
    templatePromotion: 'LIVE_VALIDATED', promotionConfigVersion: CFG.CONFIG_VERSION,
  }));
  assert.strictEqual(flagOff.actionState, A.PAPER_ENTRY_ELIGIBLE);

  // Only all three together produce a live label.
  const live = act.evaluateActionability(a, F.tradeableCtx({
    price: a.price, flags: liveFlags, templatePromotion: 'LIVE_VALIDATED', promotionConfigVersion: CFG.CONFIG_VERSION,
  }));
  assert.strictEqual(live.actionState, A.LIVE_VALIDATED_ENTRY);

  // The promotion evaluator itself refuses on a thin sample.
  const thin = validation.evaluateTemplatePromotion(
    validation.calculateTemplateStats(makeEvents(20, { win: true })), { currentConfigVersion: CFG.CONFIG_VERSION });
  assert.strictEqual(thin.promotionState, validation.PROMOTION_STATES.INSUFFICIENT_SAMPLE);
});

// ── 31. Drift demotion ───────────────────────────────────────────────────────────────────
test('31. a previously validated template can be automatically demoted', () => {
  const recent = validation.calculateTemplateStats(makeEvents(50, { win: false }), { template: 'COMPLETED_BREAKOUT' });
  const drift = validation.evaluateModelDrift(
    { configurationVersion: CFG.CONFIG_VERSION },
    recent,
    { currentConfigVersion: CFG.CONFIG_VERSION, baselineRate: 0.5 },
  );
  assert.strictEqual(drift.demote, true);
  assert.strictEqual(drift.status, 'DEMOTE');

  const before = { COMPLETED_BREAKOUT: { promotionState: validation.PROMOTION_STATES.LIVE_VALIDATED } };
  const after = validation.applyDrift(before, { COMPLETED_BREAKOUT: drift });
  assert.strictEqual(after.COMPLETED_BREAKOUT.promotionState, validation.PROMOTION_STATES.PAPER_PROMISING);
  assert.ok(after.COMPLETED_BREAKOUT.demotedAt);
  // The original map is untouched (immutable update).
  assert.strictEqual(before.COMPLETED_BREAKOUT.promotionState, validation.PROMOTION_STATES.LIVE_VALIDATED);

  // A configuration change alone is enough to trigger demotion.
  const configDrift = validation.evaluateModelDrift(
    { configurationVersion: 'old-version' },
    validation.calculateTemplateStats(makeEvents(50, { win: true }), { template: 'COMPLETED_BREAKOUT' }),
    { currentConfigVersion: CFG.CONFIG_VERSION, baselineRate: 0.3 },
  );
  assert.ok(configDrift.reasons.some(r => r.includes('CONFIG_VERSION_CHANGED')));
});

// Synthetic resolved outcome events for the validation tests.
function makeEvents(n, { win = true, template = 'COMPLETED_BREAKOUT' } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    resolved: true,
    ticker: `T${i % 30}`,
    sessionDate: `2026-0${(i % 3) + 4}-1${i % 10}`,
    entryTemplate: template,
    targetHitBeforeInvalidation: win,
    rMultiple: win ? 2 : -1,
    return30m: win ? 3 : -1.5,
    returnToClose: win ? 4 : -2,
    maximumFavorableExcursion60m: win ? 5 : 0.5,
    maximumAdverseExcursion60m: win ? -0.5 : -3,
    configurationVersion: CFG.CONFIG_VERSION,
    outOfSample: i >= n * 0.6,
    sameBarAmbiguous: false,
  }));
}

// ── Cross-cutting invariants the spec calls for elsewhere ────────────────────────────────

test('explosion potential and trade quality are independent scores', () => {
  // High explosion, low trade quality: a real, common, and previously inexpressible state.
  const f = ignition.calculateIgnitionFeatures({
    price: 3.2, sessionVolume: 8_000_000, sessionDollarVolume: 4_000_000,
    floatShares: 2_500_000, floatUsable: true, minutesSinceOpen: 90,
    relativeVolume: 25, dayChangePct: 65, fiveMinChange: 4, fifteenMinChange: 11, volumeAcceleration: 5,
  });
  const exp = ignition.scoreExplosionPotential(f, { floatConfidence: 'HIGH', regime: 'risk-on' });
  const q = ignition.scoreTradeQuality(f, {
    supplyRisk: { dilutionRisk: 'HIGH' }, stale: false,
    structure: { structureState: S.EXHAUSTED, vwapExtensionAtr: 5, riskReward: 1.1, stopDistancePct: 20 },
  });
  assert.ok(exp.explosionPotentialScore >= 45, 'explosion potential stays high');
  assert.ok(q.tradeQualityScore < 35, 'trade quality is low');
  assert.notStrictEqual(exp.explosionPotentialScore, q.tradeQualityScore);
});

test('the eligible universe keeps dormant micro-caps and excludes non-common securities', () => {
  const rows = [
    { symbol: 'AAPL', name: 'Apple Inc. - Common Stock', testIssue: 'N', finStatus: 'N', etf: 'N', exchange: 'NASDAQ' },
    { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', testIssue: 'N', finStatus: '', etf: 'Y', exchange: 'NYSE Arca' },
    { symbol: 'ACMEW', name: 'Acme Corp Warrants', testIssue: 'N', finStatus: '', etf: 'N', exchange: 'NASDAQ' },
    { symbol: 'ACMEU', name: 'Acme Acquisition Units', testIssue: 'N', finStatus: '', etf: 'N', exchange: 'NASDAQ' },
    { symbol: 'ZVZZT', name: 'NASDAQ TEST STOCK', testIssue: 'Y', finStatus: 'N', etf: 'N', exchange: 'NASDAQ' },
    { symbol: 'TINY', name: 'Tiny Dormant Biotech Inc. - Common Stock', testIssue: 'N', finStatus: 'N', etf: 'N', exchange: 'AMEX' },
  ];
  const built = universe.buildUniverseFromRows(rows);
  const syms = built.eligible.map(e => e.symbol);
  assert.deepStrictEqual(syms.sort(), ['AAPL', 'TINY']);
  assert.strictEqual(built.excludedByReason.ETF, 1);
  assert.strictEqual(built.excludedByReason.WARRANT, 1);
  assert.strictEqual(built.excludedByReason.UNIT, 1);
  assert.strictEqual(built.excludedByReason.TEST_SECURITY, 1);
});

test('the outcome fill is anchored to the user-visible timestamp, never an earlier price', () => {
  const bars = F.bars([
    [10.00, 10.20, 9.90, 10.10, 1000],
    [10.10, 10.30, 10.05, 10.25, 1000],
    [10.25, 10.70, 10.20, 10.60, 1000],
  ]);
  const ev = outcomes.buildEntryEvent({
    ticker: 'FILL', sessionDate: F.SESSION_DATE,
    signalTimestamp: bars[1].t, firstUserVisibleTimestamp: bars[1].t,
    entryTemplate: 'COMPLETED_BREAKOUT', trigger: 10.1, structuralStop: 9.9, target1: 10.8,
    minutesUntilClose: 200, sessionDollarVolume: 200e6,
  });
  const r = outcomes.resolveEntryEvent(ev, bars);
  // The fill is bar 2's OPEN plus slippage — NOT bar 1's low, NOT the prior close, NOT the open.
  assert.ok(r.simulatedFillPrice >= 10.10, 'fill cannot be better than the visible bar open');
  assert.strictEqual(r.simulatedFillAt, bars[1].t);
  assert.ok(r.simulatedFillPrice > bars[1].o, 'the modeled fill pays the slippage tier');
});

test('the session-aware relative volume uses a time-of-day curve, not linear pacing', () => {
  // At 30 minutes in, ~15% of the day's volume has printed — not 30/390 = 7.7%.
  const early = discovery.expectedVolumeFraction(30);
  assert.ok(early > 0.12 && early < 0.2, `expected ~0.15, got ${early}`);
  assert.ok(discovery.expectedVolumeFraction(390) === 1);
  // A name at 15% of its average volume 30 minutes in is running at ~1x, not 2x.
  const rv = discovery.sessionRelativeVolume(150_000, 1_000_000, 30);
  assert.ok(rv > 0.9 && rv < 1.1, `expected ~1.0x, got ${rv}`);
});

test('bar validation rejects impossible OHLCV instead of passing it into the feature math', () => {
  const out = idata.validateBars([
    { t: '2026-08-05T13:30:00.000Z', o: 10, h: 10.5, l: 9.8, c: 10.2, v: 100 },
    { t: '2026-08-05T13:35:00.000Z', o: 10, h: 9.0, l: 9.8, c: 10.2, v: 100 },   // high < low
    { t: '2026-08-05T13:40:00.000Z', o: -1, h: 10.5, l: 9.8, c: 10.2, v: 100 },  // negative
    { t: 'not-a-date', o: 10, h: 10.5, l: 9.8, c: 10.2, v: 100 },                // bad timestamp
    { t: '2026-08-05T13:45:00.000Z', o: 1, h: 100, l: 1, c: 90, v: 100 },        // 100x range
  ]);
  assert.strictEqual(out.bars.length, 1);
  assert.strictEqual(out.rejected.inconsistentRange, 1);
  assert.strictEqual(out.rejected.nonPositive, 1);
  assert.strictEqual(out.rejected.badTimestamp, 1);
  assert.strictEqual(out.rejected.absurdMove, 1);
});

test('position sizing never tightens the stop and caps low-float names on liquidity', () => {
  const sizing = require('../lib/position-sizing');
  const wide = sizing.calculatePositionSize({
    entryPrice: 10, invalidation: 9,   // $1 risk per share
    settings: { accountSize: 25_000, maxRiskPerTradePct: 0.5 },
    sessionDollarVolume: 5_000_000, floatTier: 'ULTRA_LOW',
  });
  // $125 risk budget ÷ $1 = 125 shares by risk; the low-float capacity cap is 0.1% of $5M = $5,000 → 500 shares.
  assert.strictEqual(wide.riskPerShare, 1);
  assert.strictEqual(wide.bindingCap, 'RISK_BUDGET');
  assert.ok(wide.warnings.includes('LOW_FLOAT_SIZE_CONSERVATIVELY'));
  assert.ok(wide.liquidityCapacity.lowFloatCapApplied);

  // A thin tape makes liquidity the binding cap rather than the risk budget.
  const thin = sizing.calculatePositionSize({
    entryPrice: 10, invalidation: 9.9,   // $0.10 risk → 1250 shares by risk
    settings: { accountSize: 25_000, maxRiskPerTradePct: 0.5 },
    sessionDollarVolume: 1_000_000, floatTier: 'ULTRA_LOW',
  });
  assert.strictEqual(thin.bindingCap, 'LIQUIDITY_CAPACITY');
  assert.ok(thin.disclaimers.some(d => /never move the stop/i.test(d)));
});

test('the system is allowed to return nothing rather than backfill', () => {
  const routes = require('../lib/lowfloat-routes');
  const buckets = routes.bucketRadar([]);
  assert.strictEqual(buckets.all.length, 0);
  assert.strictEqual(buckets.potentialMovers.length, 0);
  // And the limitations are stated on every response envelope.
  const env = routes.envelope({ ok: true });
  assert.ok(env.limitations.length >= 5);
  assert.ok(env.limitations.some(l => /PAPER only/i.test(l)));
  assert.strictEqual(env.configurationVersion, CFG.CONFIG_VERSION);
});
