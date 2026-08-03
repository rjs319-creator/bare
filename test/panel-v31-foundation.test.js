'use strict';
// Adversarial tests for the panel v3 foundation layers (v3.2 contracts):
//   research/lib/manifest.js     — snapshot-manifest-v2 contract + invariants
//   research/lib/identity-v3.js  — listingId identity, alias intervals, dedup
//   research/lib/corpactions.js  — adjustment verification, TR index,
//                                  DECISION-TIME quality audit (v2: future
//                                  paths never gate data)
// Each test constructs the failure the layer exists to prevent and proves it is
// caught (fail closed), plus append-invariance in both layers.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const MF = require('../research/lib/manifest');
const ID3 = require('../research/lib/identity-v3');
const CA = require('../research/lib/corpactions');
const CAL = require('../research/lib/calendar');
const COHORT = require('../research/lib/cohort');
const SV = require('../lib/research/survivorship');

const DAY = 86400000;
const D0 = Date.UTC(2024, 0, 2);
const ms = (i) => D0 + i * DAY;
const iso = (i) => new Date(ms(i)).toISOString().slice(0, 10);
const bars = (closes, start = 0) => closes.map((c, i) => ({ ms: ms(start + i), close: c, dollar: c * 1e6 }));

// ── manifest (snapshot-manifest-v2) ──────────────────────────────────────────

// Daily "sessions" 2024-01-02 onward (a test calendar; density is irrelevant
// to the invariants under test).
const testCalendar = () => CAL.buildSessionCalendar(Array.from({ length: 120 }, (_, i) => iso(i)), { source: 'test' });

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

const HEX = (c) => c.repeat(64);

function tinyManifest(panel, over = {}) {
  const cal = testCalendar();
  const ledger = COHORT.computeCohortLedger({
    panelByMonth: panel, calendar: cal, horizons: [21],
    labelObservationCutoff: over.labelObservationCutoff || '2024-03-01',
  });
  return MF.buildSnapshotManifest({
    snapshotId: 't1', datasetHash: MF.normalizedPanelHash(panel), generatedAt: '2024-03-01T00:00:00Z',
    sourceHashes: {
      securityMasterPayloadHash: HEX('a'), universePayloadHash: HEX('b'),
      corpactionsMerkleRoot: HEX('c'), priceCacheMerkleRoot: HEX('d'),
      marketCalendarHash: cal.calendarHash, cohortEligibilityHash: ledger.ledgerHash,
    },
    build: {
      codeCommit: HEX('e').slice(0, 40), worktreeDirty: false, dirtyDiffHash: null,
      buildCommand: 'node test', generationParams: { grid: ['2024-01', '2024-02'] },
      sourceSchemaVersions: { test: 'v1' },
    },
    sources: [],
    featureAvailabilityCutoff: '2024-03-01', lastDecisionTimestamp: '2024-02-29',
    labelObservationCutoff: '2024-03-01',
    lastLabelReadyDecisionDateByHorizon: { 21: '2024-01-31' },
    lastFullyObservedCohortDateByHorizon: Object.fromEntries(
      Object.entries(ledger.byHorizon).map(([h, v]) => [h, v.lastFullyObservedCohortDate]),
    ),
    cohortEligibilityByHorizon: COHORT.ledgerManifestSummary(ledger),
    cohortCoveragePolicy: { minOutcomeCoverage: COHORT.DEFAULT_MIN_OUTCOME_COVERAGE },
    ineligibleCohortCounts: Object.fromEntries(
      Object.entries(ledger.byHorizon).map(([h, v]) => [h, v.ineligibleCounts]),
    ),
    priceAdjustmentBasis: 'test', corporateActionStatus: 'test', sectorClassificationBasis: 'test',
    survivorship: SV.makeSurvivorshipContract({ historicalListingSource: 'test payload', delistedSecuritiesCovered: 1 }),
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

test('manifest: valid panel verifies clean (cohort maturity recomputed from calendar)', () => {
  const panel = tinyPanel();
  const v = MF.verifySnapshotManifest(tinyManifest(panel), panel, { horizons: [21], calendar: testCalendar() });
  assert.deepEqual(v.errors, []);
  assert.equal(v.valid, true);
  // The fully observed cohort is Jan (both mature); Feb is pending → excluded.
  assert.equal(v.stats.lastFullyObservedCohortByHorizon['21'], '2024-01-31');
});

test('manifest: verification without a calendar fails closed (cohorts cannot be trusted from the manifest itself)', () => {
  const panel = tinyPanel();
  const v = MF.verifySnapshotManifest(tinyManifest(panel), panel, { horizons: [21] });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /calendar/.test(e)));
});

test('manifest: duplicate (lid, dt) keys fail verification', () => {
  const panel = tinyPanel();
  panel['2024-01'].push({ ...panel['2024-01'][0], s: 'AAA2' });
  const m = tinyManifest(panel, { rowCount: 4, datasetHash: MF.normalizedPanelHash(panel) });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21], calendar: testCalendar() });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /duplicate/.test(e)), v.errors.join('; '));
});

test('manifest: a trainable label ending after labelObservationCutoff fails', () => {
  const panel = tinyPanel();
  panel['2024-01'][0].le21 = '2024-03-15';   // beyond cutoff 2024-03-01
  const m = tinyManifest(panel, { datasetHash: MF.normalizedPanelHash(panel) });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21], calendar: testCalendar() });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /labelObservationCutoff/.test(e)));
});

test('manifest: trainable label without le{h} is unverifiable and fails', () => {
  const panel = tinyPanel();
  panel['2024-01'][0].le21 = null;
  const m = tinyManifest(panel, { datasetHash: MF.normalizedPanelHash(panel) });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21], calendar: testCalendar() });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /missing le/.test(e)));
});

test('manifest: decisions after lastDecisionTimestamp and stale counts fail', () => {
  const panel = tinyPanel();
  const m = tinyManifest(panel, { lastDecisionTimestamp: '2024-01-31', rowCount: 99 });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21], calendar: testCalendar() });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /decided after/.test(e)));
  assert.ok(v.errors.some((e) => /rowCount/.test(e)));
});

test('manifest: dataset hash mismatch (stale manifest) fails', () => {
  const panel = tinyPanel();
  const m = tinyManifest(panel, { datasetHash: 'deadbeef' });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21], calendar: testCalendar() });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /datasetHash mismatch/.test(e)));
});

test('manifest: null lid rows are rejected (indefensible identity)', () => {
  const panel = tinyPanel();
  panel['2024-01'].push({ s: 'ZZZ', lid: null, dt: '2024-01-31', f21: 0.1, s21: 'm', le21: '2024-02-28' });
  const m = tinyManifest(panel, { rowCount: 4, datasetHash: MF.normalizedPanelHash(panel) });
  const v = MF.verifySnapshotManifest(m, panel, { horizons: [21], calendar: testCalendar() });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /null listingId/.test(e)));
});

test('manifest: required fields cannot be omitted', () => {
  assert.throws(() => MF.buildSnapshotManifest({ snapshotId: 'x' }), /required field/);
});

test('manifest: source hashes must be content hashes — versions/counts are rejected', () => {
  const panel = tinyPanel();
  assert.throws(
    () => tinyManifest(panel, {
      sourceHashes: {
        securityMasterPayloadHash: 'v1.2.3',   // a version string, not a hash
        universePayloadHash: HEX('b'), corpactionsMerkleRoot: HEX('c'),
        priceCacheMerkleRoot: HEX('d'), marketCalendarHash: HEX('f'), cohortEligibilityHash: HEX('9'),
      },
    }),
    /content hash/,
  );
});

test('manifest: reproducibility class is derived — a dirty build cannot claim confirmatory', () => {
  assert.equal(MF.reproducibilityClass({ codeCommit: 'abc', worktreeDirty: false, dirtyDiffHash: null }), MF.REPRODUCIBILITY.CONFIRMATORY);
  assert.equal(MF.reproducibilityClass({ codeCommit: 'abc', worktreeDirty: true, dirtyDiffHash: 'ddd' }), MF.REPRODUCIBILITY.EXPLORATORY_DIFF);
  assert.equal(MF.reproducibilityClass({ codeCommit: 'abc', worktreeDirty: true, dirtyDiffHash: null }), MF.REPRODUCIBILITY.NON_REPRODUCIBLE);
  assert.equal(MF.reproducibilityClass({ codeCommit: null, worktreeDirty: false, dirtyDiffHash: null }), MF.REPRODUCIBILITY.NON_REPRODUCIBLE);
  const panel = tinyPanel();
  assert.throws(
    () => tinyManifest(panel, {
      build: {
        codeCommit: 'abc', worktreeDirty: true, dirtyDiffHash: null,
        buildCommand: 'x', generationParams: {}, sourceSchemaVersions: {},
        reproducibility: MF.REPRODUCIBILITY.CONFIRMATORY,
      },
    }),
    /contradicts build facts/,
  );
});

test('manifest: merkle root changes when any partition changes, and when one is added', () => {
  const leaves = [{ name: 'a.json', hash: HEX('1') }, { name: 'b.json', hash: HEX('2') }];
  const r1 = MF.merkleRoot(leaves);
  const r2 = MF.merkleRoot([{ name: 'a.json', hash: HEX('3') }, leaves[1]]);
  const r3 = MF.merkleRoot([...leaves, { name: 'c.json', hash: HEX('4') }]);
  assert.notEqual(r1, r2);
  assert.notEqual(r1, r3);
  // Order-independence: same partitions, any order → same root.
  assert.equal(r1, MF.merkleRoot([leaves[1], leaves[0]]));
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

// ── corporate actions (v2: decision-time validation vs post-event diagnostics) ─

test('corpactions: an ALREADY-adjusted split series verifies clean and creates no extreme event', () => {
  // 3:1 split at day 50 on a vendor-adjusted series: closes are continuous.
  const closes = Array.from({ length: 100 }, (_, i) => 30 + i * 0.05);
  const series = bars(closes);
  const splits = [{ date: iso(50), numerator: 3, denominator: 1 }];
  const sv = CA.verifySplitAdjustment(series, splits);
  assert.equal(sv.verified, true);
  assert.equal(sv.basis, 'vendor-split-adjusted-verified');
  const audit = CA.decisionTimeQualityAudit(series, { splits, dividends: [] });
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
  const audit = CA.decisionTimeQualityAudit(series, { splits, dividends: [] });
  const ev = audit.events.find((e) => e.class === 'explained-split-error');
  assert.ok(ev, 'the -67% jump must be classified as a split error, not a crash');
  assert.ok(audit.poisonedMs.has(ms(50)), 'the split date is poisoned');
});

test('corpactions: a reverse split does not create a false crash or rally', () => {
  // 1:10 reverse split unadjusted: 2 → 20 at day 50.
  const closes = Array.from({ length: 100 }, (_, i) => (i < 50 ? 2 : 20));
  const series = bars(closes);
  const splits = [{ date: iso(50), numerator: 1, denominator: 10 }];
  const audit = CA.decisionTimeQualityAudit(series, { splits, dividends: [] });
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
  const audit = CA.decisionTimeQualityAudit(bars(closes), { splits: [], dividends });
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

test('corpactions: a genuine spike-and-revert is an OBSERVED MOVE — retained, flagged, never poisoned', () => {
  // v1 poisoned this via the FUTURE path (it reverted) — selection leakage.
  const closes = Array.from({ length: 20 }, (_, i) => (i === 10 ? 25 : 10));   // one-bar 150% spike
  const audit = CA.decisionTimeQualityAudit(bars(closes), { splits: [], dividends: [] });
  const ev = audit.events.find((e) => e.date === iso(10));
  assert.ok(ev);
  assert.equal(ev.class, 'unconfirmed-extreme', 'no structural evidence → observed market move, not bad vendor data');
  assert.ok(!audit.poisonedMs.has(ms(10)), 'future reversion must NOT poison the date');
  assert.ok(audit.extremeMs.has(ms(10)), 'flagged for the symmetric sensitivity views');
  // The reversion is still DESCRIBED — as a diagnostic that can never gate data.
  const diag = CA.postEventPersistenceDiagnostics(bars(closes), audit.events);
  assert.equal(diag[0].persistence, 'reverted');
  assert.equal(diag[0].diagnosticOnly, true);
});

test('corpactions: a persistent large move is equally an observed move — identical treatment to the reverting one', () => {
  const closes = Array.from({ length: 20 }, (_, i) => (i < 10 ? 10 : 22));   // repriced and held (e.g. acquisition pop)
  const audit = CA.decisionTimeQualityAudit(bars(closes), { splits: [], dividends: [] });
  const ev = audit.events.find((e) => e.date === iso(10));
  assert.ok(ev);
  assert.equal(ev.class, 'unconfirmed-extreme');
  assert.ok(!audit.poisonedMs.has(ms(10)));
  assert.ok(audit.extremeMs.has(ms(10)), 'SYMMETRY: the persistent move carries the same flag as the reverting one');
  const diag = CA.postEventPersistenceDiagnostics(bars(closes), audit.events);
  assert.equal(diag[0].persistence, 'persistent');
});

test('corpactions: CHANGING the future path changes nothing about trainability (append-invariance of quality)', () => {
  // Same history through day 10; wildly different futures.
  const revert = Array.from({ length: 20 }, (_, i) => (i === 10 ? 25 : 10));
  const persist = Array.from({ length: 20 }, (_, i) => (i < 10 ? 10 : 25));
  const aR = CA.decisionTimeQualityAudit(bars(revert), { splits: [], dividends: [] });
  const aP = CA.decisionTimeQualityAudit(bars(persist), { splits: [], dividends: [] });
  const evR = aR.events.find((e) => e.date === iso(10));
  const evP = aP.events.find((e) => e.date === iso(10));
  assert.equal(evR.class, evP.class, 'the class of the day-10 extreme cannot depend on later bars');
  assert.equal(aR.poisonedMs.has(ms(10)), aP.poisonedMs.has(ms(10)));
  assert.equal(aR.extremeMs.has(ms(10)), aP.extremeMs.has(ms(10)));
});

test('corpactions: an extreme at the series tail is an observed move too (no forward bars needed)', () => {
  const closes = Array.from({ length: 12 }, (_, i) => (i === 11 ? 30 : 10));
  const audit = CA.decisionTimeQualityAudit(bars(closes), { splits: [], dividends: [] });
  const ev = audit.events.find((e) => e.date === iso(11));
  assert.ok(ev);
  assert.equal(ev.class, 'unconfirmed-extreme');
  assert.ok(!audit.poisonedMs.has(ms(11)), 'absence of future bars is not evidence of bad data');
  const diag = CA.postEventPersistenceDiagnostics(bars(closes), audit.events);
  assert.equal(diag[0].persistence, 'tail-truncated');
  assert.equal(diag[0].diagnosticOnly, true);
});

test('corpactions: OHLC inconsistency and duplicate bars are decision-time structural errors and DO poison', () => {
  const series = bars(Array.from({ length: 10 }, () => 100));
  series[4] = { ...series[4], open: 100, high: 90, low: 95, close: 100 };   // high < low
  const audit = CA.decisionTimeQualityAudit(series, { splits: [], dividends: [] });
  assert.ok(audit.events.some((e) => e.class === 'ohlc-inconsistent'));
  assert.ok(audit.poisonedMs.has(series[4].ms));

  const dup = bars(Array.from({ length: 10 }, () => 100));
  dup.splice(5, 0, { ...dup[4] });   // duplicated session record
  const audit2 = CA.decisionTimeQualityAudit(dup, { splits: [], dividends: [] });
  assert.ok(audit2.events.some((e) => e.class === 'duplicate-bar'));
});

test('corpactions: poisoning classes are decision-time only (the audit gate contract)', () => {
  for (const c of CA.POISONING_CLASSES) {
    assert.ok(!['spike-revert', 'ambiguous', 'legitimate-persistent', 'tail-truncated'].includes(c),
      `future-path class '${c}' may never poison`);
  }
});

test('corpactions: missing provenance reports basis unverified + missing (fail-closed marker)', () => {
  const p = CA.adjustmentProvenance({ symbol: 'XXX', series: bars([1, 2, 3]), corp: null });
  assert.equal(p.basis, 'vendor-split-adjusted-unverified');
  assert.equal(p.dividendBasis, 'missing');
  assert.equal(p.corpActionStatus, 'missing');
});
