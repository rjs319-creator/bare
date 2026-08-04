'use strict';
// Multi-timeframe reconciliation + route-layer pure helpers (radar cards, evidence
// summary, family status, detection↔episode round-trip, 5d timeframe removal).
const { test } = require('node:test');
const assert = require('node:assert');
const { reconcileDetections } = require('../lib/patterns/reconcile');
const { TIMEFRAMES } = require('../lib/patterns');
const EP = require('../lib/patterns/episodes');
const routes = require('../lib/pattern-routes');

function d(over = {}) {
  return {
    ticker: 'ABC', family: 'BULL_FLAG', label: 'Bull flag', direction: 'LONG', timeframe: '20d', horizon: 'swing',
    phase: 'CONFIRMED', structurallyInvalid: false, structuralValidity: 0.9,
    plan: { trigger: 100, stop: 97, target: 110, rr: 3, quality: 'good' },
    ...over,
  };
}

test('reconcile: a 20d long inside a 120d long structure is strengthened', () => {
  const r = reconcileDetections([
    d(),
    d({ family: 'CUP_AND_HANDLE', label: 'Cup and handle', timeframe: '120d', horizon: 'longterm', phase: 'FORMING', structuralValidity: 0.8 }),
  ]);
  const short = r.ranked.find(x => x.detection.timeframe === '20d');
  assert.strictEqual(short.adjustment, 'strengthened');
});

test('reconcile: a bullish 20d beneath a bearish 120d is labeled tactical countertrend and downgraded', () => {
  const r = reconcileDetections([
    d({ structuralValidity: 0.85 }),
    d({ family: 'DOUBLE_TOP', label: 'Double top', direction: 'SHORT', timeframe: '120d', horizon: 'longterm', structuralValidity: 0.9, plan: { trigger: 95, stop: 104, target: 80, rr: 1.6, quality: 'acceptable' } }),
  ]);
  const bull = r.ranked.find(x => x.detection.direction === 'LONG');
  assert.strictEqual(bull.adjustment, 'tactical-countertrend');
  assert.ok(bull.contextNotes.some(n => /countertrend/.test(n)));
});

test('reconcile: opposing setups yield an explicit conflict explanation, never two bare calls', () => {
  const r = reconcileDetections([
    d({ structuralValidity: 0.95 }),
    d({ family: 'RISING_WEDGE', label: 'Rising wedge', direction: 'SHORT', timeframe: '60d', structuralValidity: 0.9, plan: { trigger: 96, stop: 103, target: 85, rr: 1.6, quality: 'acceptable' } }),
  ]);
  assert.ok(r.conflicts.length >= 1);
  assert.match(r.conflicts[0].explanation, /opposes the primary/);
});

test('reconcile: meaningful secondary detections survive (not similarity-winner-take-all)', () => {
  const r = reconcileDetections([
    d({ structuralValidity: 0.95 }),
    d({ family: 'FLAT_BASE', label: 'Flat base', timeframe: '60d', structuralValidity: 0.7 }),
  ]);
  assert.strictEqual(r.secondary.length, 1);
});

test('timeframes: the unusable 5d daily window is REMOVED, not displayed', () => {
  assert.ok(!TIMEFRAMES.some(t => t.key === '5d'), '5d supplied fewer bars than any detector minimum');
  assert.ok(TIMEFRAMES.some(t => t.key === '20d') && TIMEFRAMES.some(t => t.key === '120d'));
});

test('routes: evidence summary says "no independently graded history" at zero resolved', () => {
  const s = routes.evidenceSummary(null, null);
  assert.strictEqual(s.strategyId, 'chartpattern');
  assert.match(s.message, /No independently graded Pattern Radar history yet/);
});

test('routes: family status lists every implemented family with its evidence state', () => {
  const rows = routes.familyStatus(null);
  assert.ok(rows.length >= 14);
  for (const r of rows.filter(x => x.implemented)) {
    assert.strictEqual(r.status, 'no-validated-evidence');
  }
});

test('routes: canonical detection → reconstructDetection → createEpisode round-trips', () => {
  const canonical = {
    patternFamily: 'BULL_FLAG', patternLabel: 'Bull flag', direction: 'LONG', timeframe: '20d', horizon: 'swing',
    phase: 'NEAR_TRIGGER',
    structural: { validity: 0.9, pass: true, featureCoverage: 1, missingRequiredFeatures: [] },
    pivotsUsed: [], measurements: { atr: 2 },
    plan: { trigger: 100, stop: 95, target: 112, rewardRisk: 2.4, quality: 'good', triggerType: 'flag-boundary', invalidationType: 'flag-low', targetMethod: 'pole-measured-move' },
    similarity: { combined: 0.8 }, confirmation: { status: 'NONE' },
    currentPrice: 99, patternStart: '2026-05-20', patternAsOf: '2026-06-19',
  };
  const det2 = routes.reconstructDetection(canonical, 'ABC');
  const ep = EP.createEpisode(det2, { now: '2026-06-20T12:00:00Z', date: '2026-06-20', modelVersion: 'mv1' });
  assert.ok(ep);
  assert.strictEqual(ep.frozen.trigger.price, 100);
  assert.strictEqual(ep.frozen.atr, 2);
  assert.strictEqual(ep.state, 'READY');
});

test('routes: radar card shows null probability + eligibility status without evidence', () => {
  const ep = EP.createEpisode(routes.reconstructDetection({
    patternFamily: 'BULL_FLAG', patternLabel: 'Bull flag', direction: 'LONG', timeframe: '20d', horizon: 'swing',
    phase: 'NEAR_TRIGGER', structural: { validity: 0.9, pass: true, featureCoverage: 1, missingRequiredFeatures: [] },
    pivotsUsed: [], measurements: { atr: 2 },
    plan: { trigger: 100, stop: 95, target: 112, rewardRisk: 2.4, quality: 'good' },
    similarity: { combined: 0.8 }, confirmation: { status: 'NONE' },
    currentPrice: 99, patternStart: '2026-05-20', patternAsOf: '2026-06-19',
  }, 'ABC'), { now: new Date().toISOString(), date: '2026-06-20', modelVersion: 'mv1' });
  const card = routes.radarCard({ ...ep, lastClose: 99, lastEvaluatedDate: new Date().toISOString().slice(0, 10) }, { evidenceTable: null, date: '2026-06-20' });
  assert.strictEqual(card.probability, null);
  assert.strictEqual(card.recommendationEligibility.eligible, false);
  assert.ok(typeof card.distanceToTriggerPct === 'number');
  assert.ok(!/buy/i.test(card.actionLabel), 'card label uses position-aware vocabulary');
});

test('routes: scan universe is the full multi-band list, not a 16-name shortlist', () => {
  const u = routes.scanUniverse();
  assert.ok(u.length > 100, `universe ${u.length} should be far beyond the old 16-name default`);
  const bands = new Set(u.map(x => x.band));
  assert.ok(bands.has('large') && bands.has('small') && bands.has('micro'));
});

// The not-built-yet branch must expose scan-state. On a zero-episode night this is the ONLY
// public evidence of whether the cron chain ran (patternlog is privileged) — without it,
// "scan ran, nothing detected yet" and "chain never fired" are indistinguishable from
// outside, which is exactly the blind spot the 2026-08-03 first-night check hit. The branch
// is only reachable with live Blob storage, so this is a source-contract assertion (the
// established pattern for reach-limited branches).
test('routes: the not-built-yet response exposes scan-state, not just the ready path', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/pattern-routes.js'), 'utf8');
  const i = src.indexOf("reason: 'not-built-yet'");
  assert.ok(i > 0, 'not-built-yet branch exists');
  const branch = src.slice(i, i + 1200);
  assert.ok(/scan:\s*scanState\s*\?/.test(branch), 'not-built-yet branch includes the scan block');
  assert.ok(branch.includes('scanState.cursor'), 'scan block carries the resumable cursor');
});
