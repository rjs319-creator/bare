'use strict';
// CATALYST–FLOW FEATURES + REGISTRY — the no-forward-look guarantee.
//
// The central test here mutates bars AFTER the confirmation session and asserts that not a
// single feature value moves. That is the property the whole leakage argument rests on, and
// it is the one that silently breaks the first time someone reaches for a date range
// instead of an index.
const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/catalyst-flow/features');
const R = require('../lib/catalyst-flow/registry');

function series(n, { start = 100, drift = 0.001, vol = 1e6 } = {}) {
  const out = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    px *= 1 + drift + 0.004 * Math.sin(i / 3);
    out.push({
      date: `2024-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      open: px * 0.995, high: px * 1.02, low: px * 0.98, close: px, volume: vol * (1 + 0.2 * Math.sin(i)),
    });
  }
  return out;
}

test('every declared feature carries the full contract — source, availability, missing behaviour, direction', () => {
  for (const f of R.FEATURES) {
    assert.ok(f.name && f.family && f.source && f.observes, `${f.name} is under-declared`);
    assert.ok(['confirmation-close', 'overnight-eod', 'publication-lagged', 'unavailable'].includes(f.availability), `${f.name}: ${f.availability}`);
    assert.ok(['leave-missing', 'never-missing'].includes(f.missing), `${f.name}: ${f.missing}`);
    assert.ok(['positive', 'negative', 'ambiguous'].includes(f.direction), `${f.name}: ${f.direction}`);
  }
});

test('feature names are unique across families', () => {
  const names = R.FEATURES.map((f) => f.name);
  assert.strictEqual(new Set(names).size, names.length);
});

test('E2 does not merely zero family C — the columns are ABSENT from its feature set', () => {
  const e2 = R.featureNamesForArm('E2_CATALYST_RANKER');
  const e3 = R.featureNamesForArm('E3_CATALYST_FLOW_RANKER');
  const familyC = R.NAMES_BY_FAMILY[R.FAMILY.C];
  assert.ok(familyC.every((n) => !e2.includes(n)), 'no signed-flow column may reach E2');
  assert.ok(familyC.every((n) => e3.includes(n)));
  assert.strictEqual(e3.length - e2.length, familyC.length);
});

test('an undeclared column is a defect, not a bonus feature', () => {
  assert.strictEqual(R.validateColumns(['overnightGap', 'realizedVol20']).ok, true);
  const bad = R.validateColumns(['overnightGap', 'secretAlphaFactor']);
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.unknown, ['secretAlphaFactor']);
});

test('NO FORWARD LOOK — mutating every bar after the confirmation session changes nothing', () => {
  const bars = series(80);
  const spy = series(80, { start: 400, drift: 0.0005 });
  const sector = series(80, { start: 90, drift: 0.0008 });
  const confIdx = 60;

  const before = F.familyB({ bars, confIdx, announcementIdx: confIdx - 1, spy, spyConfIdx: confIdx, sector: 'Technology', sectorBars: sector, sectorConfIdx: confIdx });

  // Rewrite the future beyond recognition.
  const tampered = bars.map((b, i) => (i > confIdx ? { ...b, open: b.open * 4, high: b.high * 4, low: b.low * 4, close: b.close * 4, volume: b.volume * 100 } : b));
  const spyT = spy.map((b, i) => (i > confIdx ? { ...b, close: b.close * 4 } : b));
  const secT = sector.map((b, i) => (i > confIdx ? { ...b, close: b.close * 4 } : b));

  const after = F.familyB({ bars: tampered, confIdx, announcementIdx: confIdx - 1, spy: spyT, spyConfIdx: confIdx, sector: 'Technology', sectorBars: secT, sectorConfIdx: confIdx });
  assert.deepStrictEqual(after, before, 'a single differing value means a feature reached past the cutoff');
});

test("pre-event momentum ends at the ANNOUNCEMENT anchor — the event's own reaction is not its own prior trend", () => {
  const bars = series(80);
  const confIdx = 60, announcementIdx = 59;
  const base = F.familyB({ bars, confIdx, announcementIdx, spy: null, spyConfIdx: null, sector: null, sectorBars: null, sectorConfIdx: null });

  // A violent confirmation session must not leak into preEventReturn5.
  const shocked = bars.map((b, i) => (i === confIdx ? { ...b, close: b.close * 1.5, high: b.high * 1.6 } : b));
  const after = F.familyB({ bars: shocked, confIdx, announcementIdx, spy: null, spyConfIdx: null, sector: null, sectorBars: null, sectorConfIdx: null });

  assert.strictEqual(after.preEventReturn5, base.preEventReturn5);
  assert.strictEqual(after.preEventReturn20, base.preEventReturn20);
  assert.notStrictEqual(after.firstSessionReturn, base.firstSessionReturn, 'the confirmation-session features SHOULD move');
});

test("abnormal volume is measured against the sessions BEFORE the confirmation session, not including it", () => {
  const bars = series(80);
  const confIdx = 60;
  const base = F.familyB({ bars, confIdx, announcementIdx: 59, spy: null, spyConfIdx: null, sector: null, sectorBars: null, sectorConfIdx: null });

  const spike = bars.map((b, i) => (i === confIdx ? { ...b, volume: b.volume * 50 } : b));
  const after = F.familyB({ bars: spike, confIdx, announcementIdx: 59, spy: null, spyConfIdx: null, sector: null, sectorBars: null, sectorConfIdx: null });
  assert.ok(after.abnormalShareVolume > base.abnormalShareVolume + 3,
    'a 50× session must register as abnormal — it cannot be absorbed into its own baseline');
});

test('an incomplete window yields NULL, never a zero or a carried-forward value', () => {
  const bars = series(80);
  const early = F.familyB({ bars, confIdx: 3, announcementIdx: 2, spy: null, spyConfIdx: null, sector: null, sectorBars: null, sectorConfIdx: null });
  assert.strictEqual(early.realizedVol20, null);
  assert.strictEqual(early.preEventReturn20, null);
  assert.strictEqual(early.abnormalShareVolume, null);
  assert.notStrictEqual(early.realizedVol20, 0);
});

test('family D leaves short interest MISSING unless it was published by the cutoff', () => {
  const bars = series(40);
  const unpublished = F.familyD({ bars, confIdx: 30, shortInterest: { daysToCover: 9, publishedByCutoff: false } });
  assert.strictEqual(unpublished.daysToCover, null, 'a settlement-dated figure is not yet public');
  assert.strictEqual(unpublished.extremeCrowdingFlag, null);

  const published = F.familyD({ bars, confIdx: 30, shortInterest: { daysToCover: 9, publishedByCutoff: true } });
  assert.strictEqual(published.daysToCover, 9);
  assert.strictEqual(published.extremeCrowdingFlag, 1, 'the ≥7 crowding flag fires');
  assert.strictEqual(F.familyD({ bars, confIdx: 30, shortInterest: { daysToCover: 3, publishedByCutoff: true } }).extremeCrowdingFlag, 0);
});

test('borrow availability stays missing rather than defaulting to "available"', () => {
  assert.strictEqual(F.familyD({ bars: series(40), confIdx: 30 }).borrowAvailable, null);
});

test('missingFeatureShare reports how much of the row was actually measured', () => {
  const bars = series(80);
  const B = F.familyB({ bars, confIdx: 60, announcementIdx: 59, spy: null, spyConfIdx: null, sector: 'Energy', sectorBars: null, sectorConfIdx: null });
  const row = F.buildFeatureRow({ familyBValues: B, familyDValues: F.familyD({ bars, confIdx: 60 }) });
  assert.ok(row.missingFeatureShare > 0.4 && row.missingFeatureShare < 1, `got ${row.missingFeatureShare}`);
});

test('sourceQualityScore is dragged down by a reconstructed fundamental, and only by one', () => {
  const bOnly = F.buildFeatureRow({ familyBValues: { overnightGap: 0.02 }, pitClass: 'RECONSTRUCTED_EXPLORATORY' });
  assert.strictEqual(bOnly.sourceQualityScore, F.SOURCE_QUALITY.IMMUTABLE_PIT,
    'bars are observations; a row with no fundamentals is not penalised for the archive');

  const withA = F.buildFeatureRow({ familyAValues: { epsSurpriseStd: 1.2 }, familyBValues: { overnightGap: 0.02 }, pitClass: 'RECONSTRUCTED_EXPLORATORY' });
  assert.strictEqual(withA.sourceQualityScore, F.SOURCE_QUALITY.RECONSTRUCTED_EXPLORATORY);
});
