'use strict';
// TODAY REDESIGN REGRESSIONS — exact-horizon evidence contracts, lifecycle age from
// immutable origins, disappearing-pick visibility, and actionable/research separation.
// These pin the fixes for defects #8/#9/#11/#12/#13 confirmed in
// docs/predictive-redesign-audit.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const D = require('../lib/decision');
const { updateOrigins } = require('../lib/remaining-edge-origins');
const { buildToday } = require('../lib/decision-routes');
const { SOURCES } = require('./fixtures/today-sources');

// ── Defect #8: exact outcome contracts — no horizon fallback ────────────────────

test('expectancyFor NEVER falls back to another horizon — missing exact evidence is BUILDING EVIDENCE', () => {
  // Arrange: a group that has 1m and 5d records but NO 1d record.
  const summary = {
    groups: [{
      section: 'daytrade', tier: 'A',
      horizons: {
        '1m': { avgExcess: 5, winRate: 70, n: 40 },
        '5d': { avgExcess: 3, winRate: 65, n: 40 },
      },
    }],
  };

  // Act: an intraday signal asks for its exact 1d contract.
  const exp = D.expectancyFor('daytrade', 'A', 'intraday', summary);

  // Assert: no substitution — unknown, flagged as building, honest horizonKey.
  assert.equal(exp.known, false, 'a 21-session record must never grade a same-session signal');
  assert.equal(exp.buildingEvidence, true);
  assert.equal(exp.horizonKey, '1d', 'provenance reports the REQUESTED key, which is the only key ever read');
  // And the tilt is exactly neutral — never borrowed from the wrong horizon.
  assert.deepEqual(D.expectancyTilt(exp), { tilt: 1, shrink: 0 });

  // The exact horizon, when present, is served normally.
  const swing = D.expectancyFor('daytrade', 'A', 'swing', summary);
  assert.equal(swing.known, true);
  assert.equal(swing.horizonKey, '5d');
});

// ── Defect #11: lifecycle age from immutable origins ────────────────────────────

const mkSig = (over = {}) => D.makeSignal({
  source: 'coil', section: 'coil', ticker: 'AGED', horizon: 'swing', side: 'long',
  price: 100, entry: 104, stop: 97, target: 118, rawConfidence: 55, ...over,
}).signal;

test('lifecycle age comes from immutable origins — a re-emitted pick cannot reset to newly-detected', () => {
  // Arrange: an origin captured 12 sessions ago (bars advanced daily, never rewritten).
  const sig = mkSig();
  let origins = updateOrigins(null, [{ ...sig, score: 80 }], '2026-07-01');
  for (let d = 2; d <= 13; d++) origins = updateOrigins(origins, [{ ...sig, score: 80 }], `2026-07-${String(d).padStart(2, '0')}`);
  assert.equal(origins[sig.id].bars, 12);
  assert.equal(origins[sig.id].firstDate, '2026-07-01', 'origin first-detection is immutable');

  // Act: the normalizer (as today) emits ageBars 0 — rank with and without origins.
  const withoutOrigins = D.rankSignals([sig], { regime: {}, scoreboard: {}, includeInactive: true });
  const withOrigins = D.rankSignals([sig], { regime: {}, scoreboard: {}, includeInactive: true, origins });

  // Assert: without origins the row looks newly detected (the defect); with origins the
  // 12-session age binds — swing maxAge is 10, so the untriggered pick is EXPIRED.
  assert.equal(withoutOrigins[0].state, 'detected');
  assert.equal(withOrigins[0].ageBars, 12, 'age derived from the origin, not the normalizer');
  assert.equal(withOrigins[0].detectedAt, '2026-07-01', 'detection date surfaced from the immutable origin');
  assert.equal(withOrigins[0].state, 'expired', 'an aged, never-triggered pick expires instead of staying forever-new');
});

test('a triggered continuing pick keeps its original plan — re-ranking never re-anchors entry/stop/target', () => {
  const sig = mkSig({ price: 106 });   // now through the 104 trigger
  let origins = updateOrigins(null, [{ ...mkSig(), score: 80 }], '2026-07-01');
  origins = updateOrigins(origins, [{ ...sig, score: 82 }], '2026-07-02');
  const o = origins[sig.id];
  assert.deepEqual({ entry: o.entry, stop: o.stop, target: o.target }, { entry: 104, stop: 97, target: 118 },
    'origin plan frozen at first detection');
  const ranked = D.rankSignals([sig], { regime: {}, scoreboard: {}, includeInactive: true, origins });
  assert.equal(ranked[0].state, 'triggered');
  assert.equal(ranked[0].ageBars, 1);
});

// ── Disappearing swing picks stay visible with an explanation ───────────────────

test('a swing pick that ages out does not vanish — it lands in the expired lane with its state explained', () => {
  // Arrange: yesterday's snapshot tracked the pick; today its origin age exceeds maxAge.
  const sig = mkSig();
  let origins = updateOrigins(null, [{ ...sig, score: 80 }], '2026-07-01');
  for (let d = 2; d <= 13; d++) origins = updateOrigins(origins, [{ ...sig, score: 80 }], `2026-07-${String(d).padStart(2, '0')}`);
  const sources = { coil: { picks: [{ ticker: 'AGED', sector: 'Utilities', price: 100, decile: 8, band: 'high', entry: 104, stop: 97, target: 118, rr: 2 }] } };
  const prev = { ids: [{ id: sig.id, ticker: 'AGED', horizon: 'swing', state: 'early', rank: 3, score: 80 }] };

  // Act
  const p = buildToday(sources, prev, null, origins, {});

  // Assert: not on the active board, but visible in the expired lane — with lifecycle facts
  // a renderer can explain (state, age, original detection date).
  assert.ok(!Object.values(p.horizons).flat().some(x => x.id === sig.id), 'expired pick is not ranked as actionable');
  const lane = p.lanes.expired.find(x => x.id === sig.id);
  assert.ok(lane, 'the pick remains visible in the expired lane instead of disappearing');
  assert.equal(lane.state, 'expired');
  assert.ok(lane.ageBars > 10, 'the lane row carries the true origin-derived age');
  assert.equal(lane.detectedAt, '2026-07-01', 'and the original detection date for the explanation');
});

// ── Defects #12/#13: actionable vs research separation + liquidity sizing ───────

test('every board row carries an unmistakable ACTIONABLE vs RESEARCH class (shadow sources are never implied recommendations)', () => {
  const p = buildToday(SOURCES, null, null, null, {});
  const rows = Object.values(p.horizons).flat();
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(r.evidenceClass === 'ACTIONABLE' || r.evidenceClass === 'RESEARCH', `${r.id} classed`);
  // Without governance evidence, non-pinned sources fail closed to RESEARCH.
  const coremo = rows.find(r => r.source === 'coremo');
  if (coremo) assert.equal(coremo.evidenceClass, 'RESEARCH', 'a shadow source can never present as evidence-cleared');
});

test('unknown liquidity can never become a fully sizable recommendation', () => {
  const EL = require('../lib/eligibility');
  const src = { source: 'daytrade', staticStatus: 'production', pinned: true, governance: null, displayEligible: true, tradeEligible: true, sizingWeight: 1, reasons: [] };
  const known = EL.assessSignal({ source: 'daytrade', ticker: 'A', side: 'long', entry: 10, stop: 9, target: 12, liquidity: { dollarVol: 5e7 } }, src, {});
  const unknown = EL.assessSignal({ source: 'daytrade', ticker: 'B', side: 'long', entry: 10, stop: 9, target: 12, liquidity: { price: 10 } }, src, {});
  assert.equal(known.sizingEligible, true);
  assert.equal(unknown.sizingEligible, false, 'unknown liquidity → visible lead, never sized');
  assert.equal(unknown.sizingWeight, 0);
  assert.ok(unknown.reasons.some(r => /liquidity unknown/.test(r)));
});
