'use strict';
// REGRESSION — the FRESH_CATALYST discovery lane was structurally unreachable.
//
// `evaluateLanes` in lib/mover-discovery.js only fires FRESH_CATALYST off a `catalystTier` /
// `catalystFreshnessMinutes` pair supplied by the caller's `catalystByTicker` map. But catalyst
// enrichment (lib/catalyst-context.js `fetchCatalystContext`) is only ever run in
// lib/lowfloat-pipeline.js Stage 2/3, on the narrow top-N candidates that discovery ALREADY
// produced — and the Stage 0b discovery call never received a `catalystByTicker` seed at all.
// So the lane could never fire in production: confirmed live on 2026-08-06 (10:45 ET, market
// open) where two consecutive op=lowfloat / op=intradaycontinuation reads both showed
// FRESH_CATALYST completely absent from discoveryLaneCounts while the other six lanes were all
// active. The fix seeds discovery from a persisted catalyst cache (lib/lowfloat-store.js
// readCatalystCache/writeCatalystCache), mirroring the existing float-cache seed, with
// freshness recomputed against the current clock on every read (`reassessCatalyst`) so a
// headline cached several cycles ago correctly ages out instead of reading as still-fresh.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const F = require('./lowfloat-fixtures');
const discovery = require('../lib/mover-discovery');
const catalyst = require('../lib/catalyst-context');

function baseQuote(over = {}) {
  // Deliberately quiet on every other axis: a <1% move, no gap, and session volume far below
  // even a generous relative-volume expectation, so PCT_MOVER/RVOL_MOVER/GAP_PREMARKET cannot
  // fire and the catalyst lane is isolated as the only possible trigger.
  return {
    ticker: 'CTLY', price: 7.85, prevClose: 7.80, dayVolume: 50_000, open: 7.80,
    avgVolume: 2_000_000, asOf: F.at(90).toISOString(), ...over,
  };
}

test('FRESH_CATALYST fires when a fresh, material catalyst is seeded into discovery', () => {
  const now = F.at(90);
  const quotes = [baseQuote()];
  // Nothing else about this quote trips a lane: the move is small (3.9%), RVOL is unremarkable,
  // there is no prior snapshot for acceleration, and there is no gap. A fresh Tier-2 catalyst is
  // the ONLY qualifying signal.
  const catalystByTicker = {
    CTLY: { catalystTier: 2, freshnessMinutes: 45 },
  };

  const out = discovery.buildCandidates({ quotes, catalystByTicker, now, minutesSinceOpen: 90 });

  assert.strictEqual(out.candidates.length, 1, 'the catalyst-only mover must be discovered');
  const c = out.candidates[0];
  assert.ok(c.discoverySources.includes(discovery.LANES.FRESH_CATALYST),
    'FRESH_CATALYST must fire off the seeded catalyst data');
  assert.deepStrictEqual(c.discoveryEvidence.FRESH_CATALYST, { catalystTier: 2, catalystFreshnessMinutes: 45 });
});

test('FRESH_CATALYST does not fire without a seed, on a stale catalyst, or on tier 4 noise', () => {
  const now = F.at(90);

  // No catalystByTicker at all (the pre-fix production shape) — no lane, no candidate.
  const noSeed = discovery.buildCandidates({ quotes: [baseQuote()], now, minutesSinceOpen: 90 });
  assert.strictEqual(noSeed.candidates.length, 0, 'with no catalyst data and no other trigger, nothing is discovered');
  assert.strictEqual(noSeed.rejected.noLane, 1);

  // Stale (older than the 24h freshness window).
  const stale = discovery.buildCandidates({
    quotes: [baseQuote()], now, minutesSinceOpen: 90,
    catalystByTicker: { CTLY: { catalystTier: 1, freshnessMinutes: 25 * 60 } },
  });
  assert.strictEqual(stale.candidates.length, 0, 'a catalyst older than 24h must not trigger discovery');

  // Tier 4 (dilution / social noise) is explicitly never a discovery reason on its own.
  const tier4 = discovery.buildCandidates({
    quotes: [baseQuote()], now, minutesSinceOpen: 90,
    catalystByTicker: { CTLY: { catalystTier: 4, freshnessMinutes: 5 } },
  });
  assert.strictEqual(tier4.candidates.length, 0, 'tier 4 catalysts must not trigger discovery');
});

test('reassessCatalyst recomputes freshness and materiality against the current clock', () => {
  const publishedAt = F.at(0).toISOString();
  const cached = catalyst.buildCatalystContext(
    [{ title: 'Company wins FDA approval for lead product', datetime: publishedAt }],
    { now: F.at(10), sessionOpenIso: F.at(0).toISOString() },
  );
  assert.strictEqual(cached.catalystTier, 1);
  assert.strictEqual(cached.freshnessMinutes, 10);
  const freshMateriality = cached.materiality;

  // Re-read the SAME cached record four hours later.
  const reassessed = catalyst.reassessCatalyst(cached, F.at(10 + 4 * 60));
  assert.strictEqual(reassessed.freshnessMinutes, 4 * 60 + 10, 'freshness must advance with the clock, not stay frozen at cache-write time');
  assert.ok(reassessed.materiality < freshMateriality, 'materiality must decay as the catalyst ages');
  assert.strictEqual(reassessed.catalystTier, 1, 'tier is a fact about the event and does not change on reassessment');
});

test('reassessCatalyst pins tier-4 materiality at 0 and passes through records with no publishedAt', () => {
  const noNews = catalyst.unevaluatedCatalyst('XYZ');
  assert.strictEqual(catalyst.reassessCatalyst(noNews, F.at(500)), noNews, 'nothing to reassess without a publishedAt');

  const tier4 = { catalystTier: 4, publishedAt: F.at(0).toISOString(), freshnessMinutes: 0, materiality: 0 };
  const reassessed = catalyst.reassessCatalyst(tier4, F.at(30));
  assert.strictEqual(reassessed.materiality, 0);
  assert.strictEqual(reassessed.freshnessMinutes, 30);
});

test('the pipeline seeds discovery from the catalyst cache, mirroring the float-cache seed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'lowfloat-pipeline.js'), 'utf8');
  assert.ok(/readCatalystCache/.test(src),
    'Stage 0b must consult a persisted catalyst cache — without it FRESH_CATALYST can never fire during discovery');
  assert.ok(/catalystByTicker:\s*catalystSeed/.test(src),
    'the catalyst seed must actually be passed into runMoverDiscovery');
  assert.ok(/writeCatalystCache/.test(src),
    'catalyst answers from Stage 2/3 must be written back so the NEXT cycle can seed from them');
});

test('lowfloat-store exposes catalyst cache read/write alongside the float cache', () => {
  const store = require('../lib/lowfloat-store');
  assert.strictEqual(typeof store.readCatalystCache, 'function');
  assert.strictEqual(typeof store.writeCatalystCache, 'function');
});
