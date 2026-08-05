'use strict';
// API SHAPE + ROUTING + PERSISTENCE CONTRACT tests for the low-float stack.
//
// These assert the things that break silently in production: an op that is not wired into the
// dispatcher, a writer op that is not privileged, a response missing the version stamps or the
// coverage diagnostics, and the alert engine firing on score noise rather than state changes.
//
// No network: the route tests exercise the pure projection/envelope helpers, and the
// dispatcher/privilege checks read api/tracker.js as source.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CFG = require('../lib/lowfloat-config');
const routes = require('../lib/lowfloat-routes');
const alerts = require('../lib/lowfloat-alerts');
const store = require('../lib/lowfloat-store');
const { STRUCTURE_STATES } = require('../lib/intraday-continuation');
const { ACTION_STATES } = require('../lib/intraday-actionability');

const trackerSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'tracker.js'), 'utf8');

const PUBLIC_OPS = ['lowfloat', 'lowfloatbook', 'intradaycontinuation', 'intradaybook',
  'intradayvalidation', 'largemoveraudit', 'largemoverbook', 'positionsize'];
const WRITER_OPS = ['lowfloattick', 'intradaytick', 'intradayresolve', 'intradaypromote', 'largemoveraudittick'];

test('every new op is dispatched from api/tracker.js', () => {
  for (const op of [...PUBLIC_OPS, ...WRITER_OPS]) {
    assert.ok(trackerSrc.includes(`req.query.op === '${op}'`), `op=${op} is not wired into the dispatcher`);
  }
});

test('every WRITER op is privileged and no public read is', () => {
  // Extract the PRIVILEGED_OPS literal so the assertion is about the real set, not a substring.
  const m = trackerSrc.match(/const PRIVILEGED_OPS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'PRIVILEGED_OPS set not found');
  const privileged = new Set([...m[1].matchAll(/'([a-z0-9]+)'/g)].map(x => x[1]));
  for (const op of WRITER_OPS) {
    assert.ok(privileged.has(op), `writer op=${op} MUST require the CRON_SECRET bearer`);
  }
  for (const op of PUBLIC_OPS) {
    assert.ok(!privileged.has(op), `public read op=${op} should not be privileged`);
  }
});

test('the heavy public reads are rate-limited', () => {
  const m = trackerSrc.match(/const EXPENSIVE_OPS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'EXPENSIVE_OPS set not found');
  const expensive = new Set([...m[1].matchAll(/'([a-z0-9]+)'/g)].map(x => x[1]));
  for (const op of ['lowfloat', 'intradaycontinuation', 'largemoveraudit']) {
    assert.ok(expensive.has(op), `op=${op} runs the full pipeline and must be throttled for anonymous callers`);
  }
});

test('no new serverless function was added', () => {
  const apiFiles = fs.readdirSync(path.join(__dirname, '..', 'api')).filter(f => f.endsWith('.js'));
  // The plan caps deployed Serverless Functions; this stack folds into the existing dispatcher.
  assert.ok(apiFiles.length <= 12, `expected ≤12 API functions, found ${apiFiles.length}: ${apiFiles.join(', ')}`);
  assert.ok(!apiFiles.includes('lowfloat.js'));
});

test('every response envelope carries versions, flags and limitations', () => {
  const env = routes.envelope({ ok: true });
  assert.strictEqual(env.schemaVersion, CFG.SCHEMA_VERSION);
  assert.strictEqual(env.scoringVersion, CFG.LOW_FLOAT_IGNITION_VERSION);
  assert.strictEqual(env.configurationVersion, CFG.CONFIG_VERSION);
  for (const k of ['universe', 'float', 'discovery', 'ignition', 'continuation', 'actionability', 'validation', 'audit']) {
    assert.ok(env.versions[k], `versions.${k} missing`);
  }
  assert.ok(Array.isArray(env.limitations) && env.limitations.length >= 5);
  assert.ok(env.flags && typeof env.flags.ENABLE_LIVE_VALIDATED_SIGNALS === 'boolean');
  assert.ok(env.generatedAt);
});

test('live-validated signals are OFF by default', () => {
  const f = CFG.flags();
  assert.strictEqual(f.ENABLE_LIVE_VALIDATED_SIGNALS, false);
  assert.strictEqual(f.ENABLE_LOW_FLOAT_DISCOVERY, true);
  assert.strictEqual(f.ENABLE_INTRADAY_CONTINUATION, true);
  assert.strictEqual(f.ENABLE_INTRADAY_PAPER_SIGNALS, true);
  assert.strictEqual(f.ENABLE_LARGE_MOVER_AUDIT, true);
});

test('feature flags respond to the environment without a deploy', () => {
  const prev = process.env.ENABLE_LOW_FLOAT_DISCOVERY;
  try {
    process.env.ENABLE_LOW_FLOAT_DISCOVERY = '0';
    assert.strictEqual(CFG.flags().ENABLE_LOW_FLOAT_DISCOVERY, false);
    process.env.ENABLE_LOW_FLOAT_DISCOVERY = 'true';
    assert.strictEqual(CFG.flags().ENABLE_LOW_FLOAT_DISCOVERY, true);
    // An unrecognized value falls back to the DEFAULT rather than guessing.
    process.env.ENABLE_LIVE_VALIDATED_SIGNALS = 'maybe';
    assert.strictEqual(CFG.flags().ENABLE_LIVE_VALIDATED_SIGNALS, false);
  } finally {
    if (prev === undefined) delete process.env.ENABLE_LOW_FLOAT_DISCOVERY;
    else process.env.ENABLE_LOW_FLOAT_DISCOVERY = prev;
    delete process.env.ENABLE_LIVE_VALIDATED_SIGNALS;
  }
});

test('the headline is derived from the DECISION, not the score', () => {
  const base = { ticker: 'X', stale: false, blockingReasons: [], explosionPotentialScore: 95, tradeQualityScore: 10 };
  assert.strictEqual(routes.headlineFor({ ...base, structureState: STRUCTURE_STATES.FAILED_BREAKOUT }), 'FAILED BREAKOUT');
  assert.strictEqual(routes.headlineFor({ ...base, structureState: STRUCTURE_STATES.DISTRIBUTION }), 'DISTRIBUTION RISK');
  assert.strictEqual(routes.headlineFor({ ...base, actionState: ACTION_STATES.MISSED_OR_EXTENDED }), 'DO NOT CHASE');
  assert.strictEqual(routes.headlineFor({ ...base, stale: true }), 'NO TRADE — STALE DATA');
  assert.strictEqual(routes.headlineFor({ ...base, blockingReasons: ['MANUAL_SPREAD_CONFIRMATION_REQUIRED'] }), 'NO TRADE — SPREAD NOT VERIFIED');
  // A 95-explosion name with 10 trade quality reads as a WARNING, not an opportunity.
  assert.strictEqual(routes.headlineFor({ ...base, actionState: ACTION_STATES.WATCH_ONLY }), 'HIGH EXPLOSION — POOR TRADE QUALITY');
});

test('radar bucketing never sorts by day gain alone', () => {
  const cards = [
    { ticker: 'BIGGAIN', dayChangePct: 90, explosionPotentialScore: 30, tradeQualityScore: 10, actionState: ACTION_STATES.AVOID, structureState: STRUCTURE_STATES.DISTRIBUTION },
    { ticker: 'EARLY', dayChangePct: 6, explosionPotentialScore: 70, tradeQualityScore: 60, actionState: ACTION_STATES.PAPER_ENTRY_ELIGIBLE, structureState: STRUCTURE_STATES.BREAKOUT_CONFIRMED },
  ];
  const b = routes.bucketRadar(cards);
  assert.ok(b.avoid.some(c => c.ticker === 'BIGGAIN'), 'the biggest gainer belongs in Avoid');
  assert.ok(b.potentialMovers.some(c => c.ticker === 'EARLY'));
  assert.ok(!b.potentialMovers.some(c => c.ticker === 'BIGGAIN'));
});

test('coverage diagnostics report every stage the spec requires', () => {
  const cov = routes.coverageOf({
    elapsedMs: 1234, partialResults: true,
    diagnostics: {
      stages: {
        universe: { universeSize: 4200, coverage: {}, ageHours: 3 },
        discovery: { bulkQuotesReceived: 4100, candidatesDiscovered: 180, provider: 'fmp-batch', volumeAvailable: true, laneCounts: {}, rejected: {} },
        float: { withFloat: 90, withoutFloat: 30, floatCoveragePct: 75, providerConfigured: true, providers: ['fmp-shares-float'], note: 'x' },
        intraday: { enriched: 55, failed: 3, deadlineSkipped: 2, barResolutionMinutes: 5, provider: 'yahoo-chart' },
        catalyst: { enriched: 20 },
        scoring: { candidatesRanked: 60, staleCandidates: 4 },
      },
    },
  });
  for (const k of ['universeSize', 'bulkQuotesReceived', 'candidatesDiscovered', 'floatEnriched',
    'floatMissing', 'intradayEnriched', 'intradayFailures', 'staleCandidates', 'candidatesRanked',
    'elapsedMs', 'partialResults', 'providerCoverage']) {
    assert.ok(cov[k] !== undefined, `coverage.${k} missing`);
  }
  assert.strictEqual(cov.partialResults, true);
  assert.strictEqual(cov.barResolutionMinutes, 5);
});

// ── Alerts ───────────────────────────────────────────────────────────────────
test('alerts fire on state TRANSITIONS, not on score movement', () => {
  const rec = t => ({
    ticker: 'X', structureState: t, trigger: 10, entryZoneLow: 10, entryZoneHigh: 10.2,
    maximumChasePrice: 10.2, actionState: ACTION_STATES.WATCH_ONLY,
    explosionPotentialScore: 50, tradeQualityScore: 50, blockingReasons: [],
  });
  const now = new Date('2026-08-05T15:00:00Z');
  // First observation of a constructive state: no transition FROM anything → no alert for
  // most rules, but the pending→confirmed step below must alert.
  const r1 = alerts.buildAlerts([rec(STRUCTURE_STATES.BREAKOUT_PENDING)], { sessionDate: '2026-08-05', byTicker: { X: { structureState: STRUCTURE_STATES.COMPRESSION } }, dayCounts: {} }, { now, sessionDate: '2026-08-05' });
  assert.strictEqual(r1.alerts.length, 1);
  assert.strictEqual(r1.alerts[0].kind, 'BREAKOUT_PENDING');

  // SAME state again → no new alert (this is the "score wobbled" case).
  const r2 = alerts.buildAlerts([rec(STRUCTURE_STATES.BREAKOUT_PENDING)], r1.nextState, { now: new Date('2026-08-05T15:01:00Z'), sessionDate: '2026-08-05' });
  assert.strictEqual(r2.alerts.length, 0);

  // A genuine transition → alerts.
  const r3 = alerts.buildAlerts([rec(STRUCTURE_STATES.BREAKOUT_CONFIRMED)], r2.nextState, { now: new Date('2026-08-05T15:02:00Z'), sessionDate: '2026-08-05' });
  assert.strictEqual(r3.alerts.length, 1);
  assert.strictEqual(r3.alerts[0].kind, 'BREAKOUT_CONFIRMED');
  assert.strictEqual(r3.alerts[0].severity, 'high');
});

test('a repeated transition is suppressed until the cooldown expires', () => {
  const base = {
    ticker: 'Y', trigger: 10, actionState: ACTION_STATES.WATCH_ONLY,
    explosionPotentialScore: 50, tradeQualityScore: 50, blockingReasons: [],
  };
  const t0 = new Date('2026-08-05T15:00:00Z');
  let state = { sessionDate: '2026-08-05', byTicker: { Y: { structureState: STRUCTURE_STATES.COMPRESSION } }, dayCounts: {} };
  const a1 = alerts.buildAlerts([{ ...base, structureState: STRUCTURE_STATES.BREAKOUT_PENDING }], state, { now: t0, sessionDate: '2026-08-05' });
  assert.strictEqual(a1.alerts.length, 1);
  // Flap back and forth inside the cooldown → suppressed.
  state = alerts.buildAlerts([{ ...base, structureState: STRUCTURE_STATES.COMPRESSION }], a1.nextState, { now: new Date('2026-08-05T15:03:00Z'), sessionDate: '2026-08-05' }).nextState;
  const a2 = alerts.buildAlerts([{ ...base, structureState: STRUCTURE_STATES.BREAKOUT_PENDING }], state, { now: new Date('2026-08-05T15:05:00Z'), sessionDate: '2026-08-05' });
  assert.strictEqual(a2.alerts.length, 0);
  assert.ok(a2.suppressed >= 1);
});

test('the divergence alert names the situation the user most needs told', () => {
  const r = alerts.buildAlerts([{
    ticker: 'Z', structureState: STRUCTURE_STATES.WATCH, explosionPotentialScore: 80,
    tradeQualityScore: 20, actionState: ACTION_STATES.WATCH_ONLY, blockingReasons: [],
    manualSpreadCheckRequired: true,
  }], { sessionDate: '2026-08-05', byTicker: {}, dayCounts: {} }, { now: new Date(), sessionDate: '2026-08-05' });
  const div = r.alerts.find(a => a.kind === 'HIGH_EXPLOSION_POOR_QUALITY');
  assert.ok(div, 'a high-explosion / poor-quality name must raise the divergence alert');
  assert.match(div.message, /Manual spread check required/i);
});

// ── Storage contract ─────────────────────────────────────────────────────────
test('every blob path the spec names is constructed correctly', () => {
  const d = '2026-08-05';
  const at = new Date('2026-08-05T15:04:05.000Z');
  assert.match(store.discoveryKey(d, at), /^intraday-discovery\/2026-08-05\/\d{8}T\d{6}Z\.json$/);
  assert.match(store.ignitionKey(d, at), /^low-float-ignition\/2026-08-05\//);
  assert.match(store.continuationKey(d, at), /^intraday-continuation\/2026-08-05\//);
  assert.strictEqual(store.outcomesKey(d), 'intraday-outcomes/2026-08-05.json');
  assert.strictEqual(store.auditKey(d), 'large-mover-audit/2026-08-05.json');
  assert.strictEqual(store.eventsKey(d), 'intraday-events/2026-08-05.json');
});

test('reads degrade gracefully when Blob storage is not configured', async () => {
  const prev = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    assert.strictEqual(store.hasStore(), false);
    assert.deepStrictEqual(await store.listSnapshotDates(store.DISCOVERY_PREFIX), []);
    assert.deepStrictEqual(await store.readSnapshotsForDay(store.DISCOVERY_PREFIX, '2026-08-05'), []);
    assert.strictEqual(await store.readEventsDay('2026-08-05'), null);
  } finally {
    if (prev !== undefined) process.env.BLOB_READ_WRITE_TOKEN = prev;
  }
});

// ── Backward compatibility of the existing Day Trade surface ─────────────────
test('the legacy Day Trade lanes are labelled, not redefined', () => {
  const { LANE_PURPOSES, GATE, SCANS } = {
    ...require('../lib/daytrade-config'),
    SCANS: require('../lib/daytrade').SCANS,
  };
  // Every legacy lane still exists with its original key and thresholds.
  assert.ok(SCANS.momentum_liquid && SCANS.explosive_small);
  assert.strictEqual(SCANS.explosive_small.minPct, 8.0, 'the legacy explosive gate is unchanged');
  assert.strictEqual(GATE.VERSION, 'best-gate-v2', 'the existing gate version is unchanged');

  // And each now states what question it answers.
  for (const k of ['momentum_liquid', 'explosive_small', 'momentum_run', 'pcarry']) {
    assert.ok(LANE_PURPOSES[k] && LANE_PURPOSES[k].purpose, `lane purpose missing for ${k}`);
  }
  assert.match(LANE_PURPOSES.explosive_small.detail, /PROXY for low float/i);
  assert.match(LANE_PURPOSES.pcarry.purpose, /NOT same-session/i);
});

test('the frontend module exports the four section loaders', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'lowfloat.js'), 'utf8');
  for (const fn of ['loadLowFloat', 'loadBreakoutRadar', 'loadMoverAudit', 'loadIntradayValidation']) {
    assert.ok(new RegExp(`export async function ${fn}`).test(src), `${fn} is not exported`);
  }
  // And app.js imports and wires all four.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(app.includes("from './lowfloat.js'"));
  for (const tab of ['lowfloat', 'breakoutradar', 'movermiss', 'intradayval']) {
    assert.ok(app.includes(`sub === '${tab}'`), `tab ${tab} is not wired into showTab`);
  }
  // And the sections exist in the document.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const id of ['lowfloat', 'breakoutradar', 'movermiss', 'intradayval']) {
    assert.ok(html.includes(`id="${id}"`), `section #${id} missing from index.html`);
    assert.ok(html.includes(`id="${id}-container"`), `container #${id}-container missing`);
  }
});

test('the keyless bulk-quote fallback respects the provider symbol cap', () => {
  // REGRESSION: Yahoo's spark endpoint caps a request at 20 symbols and answers
  //   400 {"error":{"description":"Number of symbols needs to be less than or equal to 20"}}
  // SPARK_CHUNK was 40, so EVERY chunk failed and the keyless fallback silently returned zero
  // rows for any request above 20 names. The failure was invisible because a failed chunk is
  // swallowed and the coverage report only counts what came back — a full-market scan simply
  // reported "0 candidates discovered" and looked like a quiet day.
  const qp = require('../lib/quote-provider');
  assert.ok(qp.SPARK_CHUNK <= 20, `spark chunk ${qp.SPARK_CHUNK} exceeds the provider's 20-symbol cap`);
  assert.ok(qp.FMP_CHUNK <= 200);
});

test('a stale quote is never treated as a live observation', () => {
  // After the close every quote timestamp is hours old. Those must be REJECTED as candidates,
  // not silently ranked — which is what makes an after-hours scan honestly empty.
  const md = require('../lib/mover-discovery');
  const now = new Date('2026-08-05T22:45:00Z');
  const stale = { ticker: 'OLD', price: 10, prevClose: 8, dayVolume: 5e6, avgVolume: 1e5, asOf: '2026-08-05T20:00:00Z' };
  const fresh = { ...stale, ticker: 'NEW', asOf: '2026-08-05T22:44:00Z' };
  const out = md.buildCandidates({ quotes: [stale, fresh], now, minutesSinceOpen: 390 });
  assert.strictEqual(out.rejected.staleQuote, 1);
  assert.deepStrictEqual(out.candidates.map(c => c.ticker), ['NEW']);
});

test('an omitted sizing setting falls back to its default rather than zeroing the position', () => {
  // REGRESSION: an absent query parameter arrives as null, and a plain spread let that null
  // overwrite a real default. `accountSize * (null / 100)` is 0, so a perfectly sizeable trade
  // reported "no viable size" and blamed MAX_POSITION_PCT.
  const sizing = require('../lib/position-sizing');
  const out = sizing.calculatePositionSize({
    entryPrice: 10, invalidation: 9.5,
    settings: { accountSize: 25_000, maxRiskPerTradePct: 0.5, maxPositionPct: null, maxPortfolioOpenRiskPct: null, maxTradeValue: null, maxShares: null },
    sessionDollarVolume: 20_000_000, floatTier: 'ULTRA_LOW',
  });
  assert.strictEqual(out.shares, 250);
  assert.strictEqual(out.bindingCap, 'RISK_BUDGET');
  assert.ok(!out.warnings.includes('PORTFOLIO_OPEN_RISK_EXHAUSTED'));
  assert.ok(!out.warnings.includes('NO_VIABLE_SIZE'));
  assert.strictEqual(out.settings.maxPositionPct, sizing.defaultSettings().maxPositionPct);
});

test('no LLM is invoked anywhere in the live scoring path', () => {
  const liveModules = [
    'lib/mover-discovery.js', 'lib/low-float-ignition.js', 'lib/intraday-continuation.js',
    'lib/intraday-actionability.js', 'lib/intraday-data.js', 'lib/lowfloat-pipeline.js',
    'lib/catalyst-context.js', 'lib/supply-risk.js', 'lib/float-data.js',
    'lib/intraday-validation.js', 'lib/intraday-outcomes.js', 'lib/large-mover-audit.js',
  ];
  for (const m of liveModules) {
    const src = fs.readFileSync(path.join(__dirname, '..', m), 'utf8');
    assert.ok(!/@anthropic-ai\/sdk|anthropic|claude-|messages\.create/i.test(src),
      `${m} must not reference an LLM in the live scoring path`);
  }
});

test('no automated order placement exists anywhere in the new stack', () => {
  const dir = path.join(__dirname, '..', 'lib');
  const files = fs.readdirSync(dir).filter(f => /^(lowfloat|low-float|intraday-|mover-discovery|tradable-universe|float-data|supply-risk|catalyst-context|large-mover-audit|position-sizing)/.test(f) && f.endsWith('.js'));
  const forbidden = /\b(placeOrder|submitOrder|createOrder|buyMarket|sellMarket|broker(?:Api|Client)|alpaca|tradier|ibkr)\b/i;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!forbidden.test(src), `${f} must not contain order-placement code`);
  }
  assert.ok(files.length >= 12, `expected the new stack's modules, found ${files.length}`);
});
