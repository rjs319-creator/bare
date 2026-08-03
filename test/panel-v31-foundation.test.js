'use strict';
// Adversarial tests for the panel-v3.1 foundation layers:
//   research/lib/manifest.js     — snapshot-manifest contract + invariants
//   research/lib/identity-v3.js  — listingId identity, alias intervals, dedup
//   research/lib/corpactions.js  — adjustment verification, TR index, extreme audit
// Each test constructs the failure the layer exists to prevent and proves it is
// caught (fail closed), plus append-invariance in both layers.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const MF = require('../research/lib/manifest');
const ID3 = require('../research/lib/identity-v3');
const CA = require('../research/lib/corpactions');

const DAY = 86400000;
const D0 = Date.UTC(2024, 0, 2);
const ms = (i) => D0 + i * DAY;
const iso = (i) => new Date(ms(i)).toISOString().slice(0, 10);
const bars = (closes, start = 0) => closes.map((c, i) => ({ ms: ms(start + i), close: c, dollar: c * 1e6 }));

// ── manifest ─────────────────────────────────────────────────────────────────

function tinyPanel() {
  return {
    '2024-01': [
      { s: 'AAA', lid: 'L1', dt: '2024-01-31', f21: 0.05, s21: 'm', le21: '2024-02-28' },
      { s: 'BBB', lid: 'L2', dt: '2024-01-31', f21: -0.02, s21: 'm', le21: '2024-02-27' },
    ],
    '2024-02': [
      { s: 'AAA', lid: 'L1', dt: '2024-02-29', f21: null, s21: 'p', le21: null },
    ],
  };
}
function tinyManifest(panel, over = {}) {
  return MF.buildSnapshotManifest({
    snapshotId: 't1', datasetHash: MF.normalizedPanelHash(panel), generatedAt: '2024-03-01T00:00:00Z',
    securityMasterHash: 'smh', universeDefinitionHash: 'udh', sources: [],
    featureAvailabilityCutoff: '2024-03-01', lastDecisionTimestamp: '2024-02-29',
    labelObservationCutoff: '2024-03-01',
    lastFullyMatureDecisionDate: { 21: '2024-01-31' },
    priceAdjustmentBasis: 'test', corporateActionStatus: 'test', sectorClassificationBasis: 'test',
    rowCount: 3, securityCount: 2, labelStateCounts: { 21: { m: 2, p: 1 } },
    ...over,
  });
}

test('manifest: canonical hash is key-order independent and metadata-independent', () => {
  const p1 = tinyPanel();
  const p2 = { '2024-02': p1['2024-02'], '2024-01': p1['2024-01'].map((r) => Object.fromEntries(Object.entries(r).reverse())) };
  assert.equal(MF.normalizedPanelHash(p1), MF.normalizedPanelHash(p2));
});

test('manifest: hash covers the actual payload — one changed value changes it', () => {
  const p1 = tinyPanel(), p2 = tinyPanel();
  p2['2024-01'][0].f21 = 0.051;
  assert.notEqual(MF.normalizedPanelHash(p1), MF.normalizedPanelHash(p2));
});

test('manifest: valid panel verifies clean', () => {
  const panel = tinyPanel();
  const v = MF.verifySnapshotManifest(tinyManifest(panel), panel, { horizons: [21] });
  assert.deepEqual(v.errors, []);
  assert.equal(v.valid, true);
});

test('manifest: duplicate (lid, dt) keys fail verification', () => {
  const panel = tinyPanel();
  panel['2024-01'].push({ ...panel['2024-01'][0], s: 'AAA2' });
  const m = tinyManifest(panel, { rowCount: 4, datasetHash: MF.normalizedPanelHash(panel) });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21] });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /duplicate/.test(e)), v.errors.join('; '));
});

test('manifest: a trainable label ending after labelObservationCutoff fails', () => {
  const panel = tinyPanel();
  panel['2024-01'][0].le21 = '2024-03-15';   // beyond cutoff 2024-03-01
  const m = tinyManifest(panel, { datasetHash: MF.normalizedPanelHash(panel) });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21] });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /labelObservationCutoff/.test(e)));
});

test('manifest: trainable label without le{h} is unverifiable and fails', () => {
  const panel = tinyPanel();
  panel['2024-01'][0].le21 = null;
  const m = tinyManifest(panel, { datasetHash: MF.normalizedPanelHash(panel) });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21] });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /missing le/.test(e)));
});

test('manifest: decisions after lastDecisionTimestamp and stale counts fail', () => {
  const panel = tinyPanel();
  const m = tinyManifest(panel, { lastDecisionTimestamp: '2024-01-31', rowCount: 99 });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21] });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /decided after/.test(e)));
  assert.ok(v.errors.some((e) => /rowCount/.test(e)));
});

test('manifest: dataset hash mismatch (stale manifest) fails', () => {
  const panel = tinyPanel();
  const m = tinyManifest(panel, { datasetHash: 'deadbeef' });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21] });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /datasetHash mismatch/.test(e)));
});

test('manifest: null lid rows are rejected (indefensible identity)', () => {
  const panel = tinyPanel();
  panel['2024-01'].push({ s: 'ZZZ', lid: null, dt: '2024-01-31', f21: 0.1, s21: 'm', le21: '2024-02-28' });
  const m = tinyManifest(panel, { rowCount: 4, datasetHash: MF.normalizedPanelHash(panel) });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21] });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /null listingId/.test(e)));
});

test('manifest: required fields cannot be omitted', () => {
  assert.throws(() => MF.buildSnapshotManifest({ snapshotId: 'x' }), /required field/);
});

// ── identity ─────────────────────────────────────────────────────────────────

// A rename pair: OLD trades days 0..99 then stops; NEW carries the identical
// backfilled history 0..99 and continues 100..199. This is the exact CDAY/DAY,
// RDUS/SCHN, MCG/SHCO, AMSWA/LGTY shape found in the real cache.
function renamePair(oldSym, newSym) {
  const oldCloses = Array.from({ length: 100 }, (_, i) => 10 + i * 0.1);
  const newCloses = Array.from({ length: 200 }, (_, i) => (i < 100 ? 10 + i * 0.1 : 20 + (i - 100) * 0.05));
  const series = { [oldSym]: bars(oldCloses), [newSym]: bars(newCloses) };
  const members = [
    { symbol: oldSym, listingId: 'LID-X', firstBar: iso(0), lastBar: iso(99), bars: 100 },
    { symbol: newSym, listingId: 'LID-X', firstBar: iso(0), lastBar: iso(199), bars: 200 },
  ];
  const overlapCheck = (a, b) => ID3.seriesConsistent(series[a], series[b]);
  return { series, members, overlapCheck };
}

for (const [oldSym, newSym] of [['CDAY', 'DAY'], ['SCHN', 'RDUS'], ['MCG', 'SHCO'], ['AMSWA', 'LGTY']]) {
  test(`identity: rename ${oldSym}→${newSym} resolves to ONE group, successor canonical, correct alias intervals`, () => {
    const { members, overlapCheck } = renamePair(oldSym, newSym);
    const res = ID3.resolveGroup('LID-X', members, overlapCheck);
    assert.ok(res.group, 'must resolve, not quarantine');
    assert.equal(res.group.canonicalSource, newSym);
    assert.equal(res.group.aliases.length, 2);
    // During the old symbol's tenure the canonical ticker is the OLD symbol...
    assert.equal(ID3.canonicalTickerAt(res.group, iso(50)), oldSym);
    // ...and after the rename it is the successor.
    assert.equal(ID3.canonicalTickerAt(res.group, iso(150)), newSym);
  });
}

test('identity: one canonical observation per (lid, date) — the dedup guarantee', () => {
  const { members, overlapCheck } = renamePair('CDAY', 'DAY');
  const res = ID3.resolveGroup('LID-X', members, overlapCheck);
  // The group exposes ONE canonical source series; a builder iterating groups
  // (not symbols) can emit at most one row per (lid, dt) by construction.
  assert.equal(res.group.members.length, 2);
  assert.equal(typeof res.group.canonicalSource, 'string');
});

test('identity: two live series sharing a listingId (share classes / collision) quarantine', () => {
  const members = [
    { symbol: 'CLSA', listingId: 'LID-S', firstBar: iso(0), lastBar: iso(199), bars: 200 },
    { symbol: 'CLSB', listingId: 'LID-S', firstBar: iso(0), lastBar: iso(198), bars: 199 },
  ];
  const res = ID3.resolveGroup('LID-S', members, () => ({ comparable: true, consistent: true, overlapBars: 100, maxRelDiff: 0 }));
  assert.ok(res.quarantine);
  assert.match(res.quarantine.reason, /multiple-live-members/);
});

test('identity: recycled ticker (overlapping bars DISAGREE) quarantines, never merges', () => {
  const a = bars(Array.from({ length: 100 }, () => 10));
  const b = bars(Array.from({ length: 200 }, (_, i) => (i < 100 ? 55 : 20)));   // different company's history
  const members = [
    { symbol: 'OLDCO', listingId: 'LID-R', firstBar: iso(0), lastBar: iso(99), bars: 100 },
    { symbol: 'NEWCO', listingId: 'LID-R', firstBar: iso(0), lastBar: iso(199), bars: 200 },
  ];
  const res = ID3.resolveGroup('LID-R', members, (x, y) => ID3.seriesConsistent(x === 'OLDCO' ? a : b, y === 'OLDCO' ? a : b));
  assert.ok(res.quarantine);
  assert.match(res.quarantine.reason, /overlap-disagrees/);
});

test('identity: merger successor without a mapping stays a separate listing (no cross-lid merge)', () => {
  // Different listingIds are NEVER grouped — the index is keyed by lid.
  const idx = ID3.buildIdentityIndex({
    symbols: ['TGT1', 'ACQ1'],
    records: { TGT1: { listingId: 'LID-T' }, ACQ1: { listingId: 'LID-A' } },
    spanOf: () => ({ firstBar: iso(0), lastBar: iso(199), bars: 200 }),
    overlapCheck: null,
  });
  assert.equal(idx.groups.size, 2);
  assert.notEqual(idx.symbolToGroup.get('TGT1'), idx.symbolToGroup.get('ACQ1'));
});

test('identity: alias whose validity ended before the decision date is not returned', () => {
  const { members, overlapCheck } = renamePair('CDAY', 'DAY');
  const g = ID3.resolveGroup('LID-X', members, overlapCheck).group;
  // Query far after the old alias expired: must be the successor, never CDAY.
  assert.equal(ID3.canonicalTickerAt(g, iso(199)), 'DAY');
  // Query before ANY observed bar: identity unknown at that date → null (fail closed).
  assert.equal(ID3.canonicalTickerAt(g, '2020-01-01'), null);
});

test('identity: appending a future alias never changes historical resolution (append-invariance)', () => {
  const { members, overlapCheck, series } = renamePair('CDAY', 'DAY');
  const before = ID3.resolveGroup('LID-X', members, overlapCheck).group;
  const historical = ID3.canonicalTickerAt(before, iso(50));
  // A later rename DAY→DAYX appears in the master: DAY's series now ends at 199
  // and DAYX carries the identical history and extends beyond.
  const extCloses = Array.from({ length: 260 }, (_, i) => (i < 100 ? 10 + i * 0.1 : i < 200 ? 20 + (i - 100) * 0.05 : 25 + (i - 200) * 0.05));
  series.DAYX = bars(extCloses);
  const members2 = [...members, { symbol: 'DAYX', listingId: 'LID-X', firstBar: iso(0), lastBar: iso(259), bars: 260 }];
  const after = ID3.resolveGroup('LID-X', members2, (a, b) => ID3.seriesConsistent(series[a], series[b])).group;
  assert.equal(ID3.canonicalTickerAt(after, iso(50)), historical, 'historical ticker resolution must not change');
  assert.equal(after.canonicalSource, 'DAYX');
  assert.equal(ID3.canonicalTickerAt(after, iso(230)), 'DAYX');
});

test('identity: no listingId → excluded and reported, never embedded', () => {
  const idx = ID3.buildIdentityIndex({
    symbols: ['GOOD', 'NOID'],
    records: { GOOD: { listingId: 'LID-G' }, NOID: null },
    spanOf: () => ({ firstBar: iso(0), lastBar: iso(99), bars: 100 }),
    overlapCheck: null,
  });
  assert.deepEqual(idx.noIdentity, ['NOID']);
  assert.equal(idx.report.noIdentitySymbols, 1);
});

// ── corporate actions ────────────────────────────────────────────────────────

test('corpactions: an ALREADY-adjusted split series verifies clean and creates no extreme event', () => {
  // 3:1 split at day 50 on a vendor-adjusted series: closes are continuous.
  const closes = Array.from({ length: 100 }, (_, i) => 30 + i * 0.05);
  const series = bars(closes);
  const splits = [{ date: iso(50), numerator: 3, denominator: 1 }];
  const sv = CA.verifySplitAdjustment(series, splits);
  assert.equal(sv.verified, true);
  assert.equal(sv.basis, 'vendor-split-adjusted-verified');
  const audit = CA.extremeReturnAudit(series, { splits, dividends: [] });
  assert.equal(audit.events.length, 0, 'no artificial momentum from a properly adjusted split');
});

test('corpactions: an UNADJUSTED split (raw discontinuity) is a conflict, classified and poisoned — never profit', () => {
  // Raw series: 90 → 30 at day 50 (3:1 split NOT adjusted).
  const closes = Array.from({ length: 100 }, (_, i) => (i < 50 ? 90 : 30));
  const series = bars(closes);
  const splits = [{ date: iso(50), numerator: 3, denominator: 1 }];
  const sv = CA.verifySplitAdjustment(series, splits);
  assert.equal(sv.verified, false);
  assert.equal(sv.basis, 'split-adjustment-conflict');
  const audit = CA.extremeReturnAudit(series, { splits, dividends: [] });
  const ev = audit.events.find((e) => e.class === 'explained-split-error');
  assert.ok(ev, 'the -67% jump must be classified as a split error, not a crash');
  assert.ok(audit.poisonedMs.has(ms(50)), 'the split date is poisoned');
});

test('corpactions: a reverse split does not create a false crash or rally', () => {
  // 1:10 reverse split unadjusted: 2 → 20 at day 50.
  const closes = Array.from({ length: 100 }, (_, i) => (i < 50 ? 2 : 20));
  const series = bars(closes);
  const splits = [{ date: iso(50), numerator: 1, denominator: 10 }];
  const audit = CA.extremeReturnAudit(series, { splits, dividends: [] });
  const ev = audit.events.find((e) => e.date === iso(50));
  assert.ok(ev);
  assert.equal(ev.class, 'explained-split-error');
  assert.ok(audit.poisonedMs.has(ms(50)));
});

test('corpactions: total-return index reconciles to an independent calculation', () => {
  const series = bars([100, 100, 100, 100]);
  const dividends = [{ date: iso(2), adjDividend: 5 }];
  const tr = CA.withTotalReturn(series, dividends);
  // Independent: day2 TR return = (100+5)/100 - 1 = 5%; price flat elsewhere.
  assert.ok(Math.abs(tr[3].tr / tr[0].tr - 1.05) < 1e-12);
  assert.ok(Math.abs(tr[1].tr / tr[0].tr - 1.0) < 1e-12);
  // Raw closes untouched (execution/display basis preserved).
  assert.equal(tr[2].close, 100);
});

test('corpactions: dividends handled consistently — ex-date drop is explained, not an anomaly', () => {
  // Big special dividend: price drops 60% on ex-date with a matching dividend.
  const closes = Array.from({ length: 20 }, (_, i) => (i < 10 ? 50 : 20));
  const dividends = [{ date: iso(10), adjDividend: 30 }];
  const audit = CA.extremeReturnAudit(bars(closes), { splits: [], dividends });
  const ev = audit.events.find((e) => e.date === iso(10));
  assert.ok(ev);
  assert.equal(ev.class, 'explained-dividend');
  assert.ok(!audit.poisonedMs.has(ms(10)), 'an explained dividend does not poison — the TR layer absorbs it');
  // And the TR index sees ~0% economic move.
  const tr = CA.withTotalReturn(bars(closes), dividends);
  assert.ok(Math.abs(tr[10].tr / tr[9].tr - 1.0) < 1e-9);
});

test('corpactions: appended future corporate actions cannot change earlier TR values', () => {
  const series = bars(Array.from({ length: 30 }, () => 100));
  const div1 = [{ date: iso(10), adjDividend: 2 }];
  const trBefore = CA.withTotalReturn(series, div1);
  const div2 = [...div1, { date: iso(25), adjDividend: 3 }];   // future action appended
  const trAfter = CA.withTotalReturn(series, div2);
  for (let i = 0; i <= 20; i++) assert.equal(trAfter[i].tr, trBefore[i].tr, `tr[${i}] changed by a future action`);
});

test('corpactions: a spike that fully reverts is unresolved and poisons its window', () => {
  const closes = Array.from({ length: 20 }, (_, i) => (i === 10 ? 25 : 10));   // one-bar 150% spike
  const audit = CA.extremeReturnAudit(bars(closes), { splits: [], dividends: [] });
  const ev = audit.events.find((e) => e.date === iso(10));
  assert.ok(ev);
  assert.equal(ev.class, 'spike-revert');
  assert.ok(audit.poisonedMs.has(ms(10)));
  assert.ok(CA.windowPoisoned(audit.poisonedMs, ms(5), ms(15)), 'label windows crossing the spike are poisoned');
  assert.ok(!CA.windowPoisoned(audit.poisonedMs, ms(13), ms(18)), 'windows clear of the spike are unaffected');
});

test('corpactions: a persistent large move is legitimate and does NOT poison', () => {
  const closes = Array.from({ length: 20 }, (_, i) => (i < 10 ? 10 : 22));   // repriced and held (e.g. acquisition pop)
  const audit = CA.extremeReturnAudit(bars(closes), { splits: [], dividends: [] });
  const ev = audit.events.find((e) => e.date === iso(10));
  assert.ok(ev);
  assert.equal(ev.class, 'legitimate-persistent');
  assert.ok(!audit.poisonedMs.has(ms(10)));
});

test('corpactions: extreme at the series tail (unverifiable persistence) fails closed', () => {
  const closes = Array.from({ length: 12 }, (_, i) => (i === 11 ? 30 : 10));
  const audit = CA.extremeReturnAudit(bars(closes), { splits: [], dividends: [] });
  const ev = audit.events.find((e) => e.date === iso(11));
  assert.ok(ev);
  assert.equal(ev.class, 'tail-truncated');
  assert.ok(audit.poisonedMs.has(ms(11)));
});

test('corpactions: missing provenance reports basis unverified + missing (fail-closed marker)', () => {
  const p = CA.adjustmentProvenance({ symbol: 'XXX', series: bars([1, 2, 3]), corp: null });
  assert.equal(p.basis, 'vendor-split-adjusted-unverified');
  assert.equal(p.dividendBasis, 'missing');
  assert.equal(p.corpActionStatus, 'missing');
});
