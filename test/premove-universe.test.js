'use strict';
// PHASES 4+5 — two-pass universe + ATLAS-X correctness fixes
// (docs/premove-transition-v2.md). Required regressions:
//   - full-universe candidate discovery independent of op=today;
//   - specialist-balanced shortlist caps (momentum cannot eat the budget);
//   - continuous transition features remain continuous in the compression expert;
//   - catalyst metadata reaches the catalyst expert; missing catalyst abstains;
//   - unknown surprise is never read as bullish;
//   - missing sector → LABELED market-only residual;
//   - unknown liquidity fails closed to the most expensive tier;
//   - riskOff reaches the red-tape expert.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SCAN = require('../lib/atlasx-scan');
const { buildUniverse } = require('../lib/atlasx-universe');
const { assessExperts } = require('../lib/atlasx-experts');
const { detectTransition } = require('../lib/atlasx-transition');
const { residualize } = require('../lib/atlasx-residual');
const CFG = require('../lib/atlasx-config');
const FLAGS = require('../lib/premove-flags');

// ── candle builders ──────────────────────────────────────────────────────────
function candles(n, px = 50, drift = 0, volScale = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 5 + Math.floor(i / 5) * 7 + (i % 5)));
    const c = px * (1 + drift * i + (i % 2 ? 0.004 : -0.004));
    out.push({ date: d.toISOString().slice(0, 10), open: c, high: c * 1.006, low: c * 0.994, close: c, volume: 1e6 * volScale });
  }
  return out;
}
const toBars = (cs) => cs.map(c => ({ date: c.date, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));

// A pool + barsOf pair covering many tickers with distinct profiles.
function makePool(n = 60) {
  const pool = {}; const bars = {};
  for (let i = 0; i < n; i++) {
    const t = `U${String(i).padStart(2, '0')}`;
    const drift = i < 20 ? 0.004 : 0;           // first 20 = momentum names
    const cs = candles(80, 20 + i, drift);
    pool[t] = { ticker: t, scope: 'small', sector: i % 2 ? 'Technology' : 'Energy', price: cs[cs.length - 1].close, dollarVol: 5e6 + i * 1e5, mom20: drift * 20, capGroup: i % 3 === 0 ? 'small' : 'micro', lastDate: cs[cs.length - 1].date };
    bars[t] = toBars(cs);
  }
  return { pool, barsOf: (t) => bars[t] || null };
}

// ── Pass A eligibility fails closed ──────────────────────────────────────────
test('Pass A: unknown liquidity, unknown price, stale bars and bad bars are ineligible with reasons', () => {
  const { pool, barsOf } = makePool(10);
  pool.NOLIQ = { ...pool.U00, ticker: 'NOLIQ', dollarVol: null };
  pool.BADBAR = { ...pool.U01, ticker: 'BADBAR' };
  const badCandles = candles(80, 30);
  badCandles[75] = { ...badCandles[75], close: badCandles[74].close * 3 };   // +200% bar
  const bars2 = (t) => t === 'NOLIQ' ? barsOf('U00') : t === 'BADBAR' ? toBars(badCandles) : barsOf(t);
  const scan = SCAN.runTwoPassScan({ pool, barsOf: bars2 });
  assert.ok(!scan.eligible.includes('NOLIQ'), 'unknown liquidity fails closed');
  assert.ok(scan.funnel.ineligibleByReason['unknown-liquidity'] >= 1);
  assert.ok(!scan.eligible.includes('BADBAR'), 'unresolved bad-bar anomaly fails closed');
  assert.ok(scan.funnel.ineligibleByReason['bad-bar-anomaly'] >= 1);
});

// ── Pass B: discovery independent of Today + caps ────────────────────────────
test('the shortlist discovers names with NO op=today presence, and momentum is capped', () => {
  const { pool, barsOf } = makePool(200);
  const scan = SCAN.runTwoPassScan({ pool, barsOf, currentMeta: [], episodeTickers: [] });
  assert.ok(scan.shortlist.length > 0, 'candidates discovered with an empty Today board');
  assert.ok(scan.funnel.perSpecialist.momentum.kept <= SCAN.SPECIALIST_CAPS.momentum,
    'momentum respects its cap');
  // Controls exist and are stratified.
  assert.ok(scan.funnel.controlCoverage > 0, 'deterministic controls present');
  // Every shortlisted name carries its selection reasons.
  for (const t of scan.shortlist) {
    assert.ok(Array.isArray(scan.selectionReasons[t]) && scan.selectionReasons[t].length > 0,
      `${t} must carry selection reasons`);
  }
  // Determinism.
  const again = SCAN.runTwoPassScan({ pool, barsOf, currentMeta: [], episodeTickers: [] });
  assert.deepEqual(again.shortlist, scan.shortlist);
});

test('per-liquidity-band cap prevents one band from consuming a specialist', () => {
  const ranked = Array.from({ length: 20 }, (_, i) => `T${i}`);
  const capGroupOf = () => 'micro';                       // every candidate in one band
  const { kept } = SCAN.bandCapped(ranked, capGroupOf, 10);
  assert.ok(kept.length <= Math.ceil(10 * SCAN.BAND_SHARE_CAP), 'single band cannot fill the cap');
});

test('buildUniverse in twopass mode discloses the funnel; legacy mode is unchanged', () => {
  const doc = { data: {}, n: 0, builtDate: '2026-07-24', updatedAt: Date.now() };
  const { pool, barsOf } = makePool(30);
  for (const t of Object.keys(pool)) {
    doc.data[t] = { c: barsOf(t).map(b => ({ date: b.date, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })) };
  }
  doc.n = Object.keys(doc.data).length;
  const uni = buildUniverse({ todayData: null, prevEpisodes: [], candleDocs: { small: doc }, opts: { mode: 'twopass', nowMs: Date.now() } });
  assert.equal(uni.coverage.funnelMode, 'twopass');
  assert.ok(uni.coverage.funnel, 'funnel disclosure present');
  assert.ok(uni.coverage.funnel.fullPool > 0);
  assert.ok(uni.coverage.funnel.perSpecialist.compression, 'specialist counts disclosed');
  const legacy = buildUniverse({ todayData: null, prevEpisodes: [], candleDocs: { small: doc }, opts: { mode: 'legacy', nowMs: Date.now() } });
  assert.equal(legacy.coverage.funnelMode, 'legacy');
  assert.equal(legacy.coverage.funnel, null);
});

// ── Phase 5.1: continuous compression values ─────────────────────────────────
test('compression expert preserves continuous expansion/compression values', () => {
  const cs = candles(80, 50);
  const residual = residualize({ stock: cs, spy: cs, sector: [], asOf: null });
  const transition = detectTransition({ candles: cs, residual });
  const experts = assessExperts({ candles: cs, spy: cs, sector: [], residual, transition, path: { features: {} }, ctx: {} });
  const comp = experts.assessments.compressionRelease;
  const c = comp.contributions;
  assert.ok(Number.isFinite(c.expansionRatio), 'expansionRatio is a number, not a boolean');
  assert.ok(Number.isFinite(c.compressionPctile), 'compressionPctile is a number, not a boolean');
  assert.ok(c.compressionPctile > 0 && c.compressionPctile < 1, 'percentile stays continuous');
  assert.equal(c.thresholdsVersion, CFG.EXPERT_PARAMS.version, 'binary stage reads use versioned thresholds');
  assert.ok(!('expansionNow' in c) || typeof c.expansionNow !== 'boolean', 'no boolean coercion');
});

// ── Phase 5.3: catalyst plumbing + abstention ────────────────────────────────
test('missing catalyst causes explicit abstention; a structured catalyst is consumed', () => {
  const cs = candles(80, 50);
  const residual = residualize({ stock: cs, spy: cs, sector: [], asOf: null });
  const transition = detectTransition({ candles: cs, residual });
  const path = { features: {} };
  const none = assessExperts({ candles: cs, spy: cs, sector: [], residual, transition, path, ctx: {} });
  assert.equal(none.assessments.catalystDrift.applicability, 0, 'no catalyst → abstain');
  assert.equal(none.assessments.catalystDrift.stage, 'no-catalyst');

  const asOf = cs[cs.length - 1].date;
  const tsUnix = Math.floor(Date.parse(cs[cs.length - 3].date) / 1000);
  const withCat = assessExperts({ candles: cs, spy: cs, sector: [], residual, transition, path,
    ctx: { asOf, catalyst: { type: 'earnings', tsUnix, surprise: 0.5 } } });
  assert.ok(withCat.assessments.catalystDrift.applicability > 0, 'structured catalyst is consumed');
  assert.equal(withCat.assessments.catalystDrift.stage, 'fresh-event', 'asOf reaches freshness');
});

test('unknown surprise is neutral evidence, never read as bullish', () => {
  const cs = candles(80, 50);
  const residual = residualize({ stock: cs, spy: cs, sector: [], asOf: null });
  const transition = detectTransition({ candles: cs, residual });
  const asOf = cs[cs.length - 1].date;
  const tsUnix = Math.floor(Date.parse(cs[cs.length - 3].date) / 1000);
  const r = assessExperts({ candles: cs, spy: cs, sector: [], residual, transition, path: { features: {} },
    ctx: { asOf, catalyst: { type: 'earnings', tsUnix, surprise: null } } });
  const cd = r.assessments.catalystDrift;
  assert.equal(cd.contributions.surpriseKnown, false);
  assert.notEqual(cd.direction, 'bullish', 'null surprise must not default to bullish via null>=0');
  const known = assessExperts({ candles: cs, spy: cs, sector: [], residual, transition, path: { features: {} },
    ctx: { asOf, catalyst: { type: 'earnings', tsUnix, surprise: 0.5 } } });
  assert.ok(cd.applicability < known.assessments.catalystDrift.applicability,
    'unknown surprise carries less weight than a known one');
});

// ── Phase 5.5: missing sector = labeled market-only residual ─────────────────
test('unknown sector produces a LABELED market-only residual, never a silent sector one', () => {
  const cs = candles(80, 50);
  const r = residualize({ stock: cs, spy: cs, sector: [], asOf: null });
  const h10 = r.byHorizon && r.byHorizon[10];
  assert.ok(h10, 'residual horizon present');
  assert.equal(h10.partial, true, 'no sector control → partial flag set');
  assert.equal(r.coverage.sector, false, 'sector coverage honestly false');
});

// ── Phase 5.6: unknown liquidity → most expensive tier ───────────────────────
test('unknown liquidity maps to the most expensive cost tier, never the cheapest', () => {
  const { finalizeCandidate, buildCandidate } = require('../lib/atlasx-engine');
  const cs = candles(80, 50);
  const built = buildCandidate({ ticker: 'NOLIQX', candles: cs, spy: cs, sector: [], meta: {}, ctx: { date: cs[cs.length - 1].date } });
  // Force the unknown-liquidity path (no liqTier, no dollar volume observed).
  const c = { ...built, dollarVol: null, sourceMeta: { ...built.sourceMeta, liqTier: null } };
  const fin = finalizeCandidate(c, 1, 0, { date: cs[cs.length - 1].date });
  assert.equal(fin.costs.tier, 'micro', 'unknown liquidity charged the micro (most expensive) tier');
  assert.ok(fin.costs.roundTripBps >= 100, 'micro round-trip is the expensive assumption');
});

// ── Phase 5: riskOff reaches redTapeReversal ─────────────────────────────────
test('riskOff ctx enables the red-tape expert instead of leaving it permanently disabled', () => {
  const cs = candles(80, 50);
  const residual = residualize({ stock: cs, spy: cs, sector: [], asOf: null });
  const transition = detectTransition({ candles: cs, residual });
  const off = assessExperts({ candles: cs, spy: cs, sector: [], residual, transition, path: { features: {} }, ctx: { riskOff: false } });
  assert.equal(off.assessments.redTapeReversal.stage, 'disabled');
  const on = assessExperts({ candles: cs, spy: cs, sector: [], residual, transition, path: { features: {} }, ctx: { riskOff: true } });
  assert.notEqual(on.assessments.redTapeReversal.stage, 'disabled', 'risk-off regime enables the expert');
});

// ── Phase 5.7: versioned transition params ───────────────────────────────────
test('transition sigmoid parameters are versioned and overridable for the harness (defaults unchanged)', () => {
  const cs = candles(80, 50, 0.004);
  const residual = residualize({ stock: cs, spy: candles(80, 400), sector: [], asOf: null });
  const base = detectTransition({ candles: cs, residual });
  const sameParams = detectTransition({ candles: cs, residual, params: CFG.TRANSITION_PARAMS });
  assert.deepEqual(sameParams.scores, base.scores, 'explicit default params reproduce the default output');
  const alt = detectTransition({ candles: cs, residual, params: {
    ...CFG.TRANSITION_PARAMS,
    momentumAcceleration: { retGain: 30, accelGain: 60, fallbackGain: 2 },
  } });
  assert.notDeepEqual(alt.scores, base.scores, 'an alternative parameter set actually changes the scores');
  assert.equal(CFG.TRANSITION_PARAMS.version, 'atlasx-transition-params-v1');
});

// ── flags: fail-closed artifact gating ───────────────────────────────────────
test('PREMOVE_V2_MODE default is shadow and enforce fails closed without a valid artifact', () => {
  assert.equal(FLAGS.resolvePremoveMode(undefined), 'shadow');
  assert.equal(FLAGS.resolvePremoveMode('garbage'), 'shadow');
  const g1 = FLAGS.premoveGate({ mode: 'enforce', artifact: null });
  assert.equal(g1.mayAffectLive, false, 'enforce without artifact behaves as shadow');
  assert.equal(g1.showProbabilities, false);
  const valid = {
    kind: 'stageA', modelVersion: 'm1', featureVersion: FLAGS.LIVE_VERSIONS.featureVersion,
    labelVersion: FLAGS.LIVE_VERSIONS.labelVersion, executionPolicyVersion: FLAGS.LIVE_VERSIONS.executionPolicyVersion,
    universePolicy: FLAGS.LIVE_VERSIONS.universePolicy, trainedThrough: '2026-07-01', status: 'validated',
  };
  const g2 = FLAGS.premoveGate({ mode: 'enforce', artifact: valid, kind: 'stageA' });
  assert.equal(g2.mayAffectLive, true, 'enforce + valid artifact may affect live');
  const g3 = FLAGS.premoveGate({ mode: 'enforce', artifact: { ...valid, featureVersion: 'premove-features-v0' }, kind: 'stageA' });
  assert.equal(g3.mayAffectLive, false, 'feature-schema change invalidates the artifact (fail closed)');
  const g4 = FLAGS.premoveGate({ mode: 'shadow', artifact: valid, kind: 'stageA' });
  assert.equal(g4.mayAffectLive, false, 'shadow can never affect live, artifact or not');
});
