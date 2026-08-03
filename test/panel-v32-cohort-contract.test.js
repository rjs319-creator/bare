'use strict';
// ADVERSARIAL TESTS — panel-v3.2 cohort-maturity contract, provenance hashes,
// survivorship contract and the execution engine. Each test constructs the
// exact failure the layer exists to prevent:
//
//   * 3 early delistings must never make a 1,704-name pending cohort eligible
//     (the reproduced May-2026 defect: official 21s "IC" of -0.50 from
//     FFIC/KALV/MASI while the whole active universe was pending);
//   * eligibility comes from the TRADING-SESSION horizon elapsing, never from
//     any row's label state;
//   * appending future bars/months can never change historical eligibility;
//   * confirmed delistings REMAIN valid outcomes inside fully matured cohorts;
//   * partial-cohort rank-IC is rejected at the harness boundary;
//   * periodEnd == last evaluated eligible cohort;
//   * every content-source hash moves when its payload moves;
//   * survivorship-reduced can never claim survivorship-safe;
//   * signal-close entries and hand-invented costs cannot pass the economic
//     gate (see also harness-v31-purge-tiers tests).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const CAL = require('../research/lib/calendar');
const COHORT = require('../research/lib/cohort');
const MF = require('../research/lib/manifest');
const H3 = require('../lib/research/harness-v3');
const SV = require('../lib/research/survivorship');
const EX = require('../lib/research/execution');

const DAY = 86400000;
const D0 = Date.UTC(2026, 0, 2);
const iso = (i) => new Date(D0 + i * DAY).toISOString().slice(0, 10);
// Weekday-only sessions (a realistic market calendar shape).
const weekdaySessions = (n) => {
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const d = new Date(D0 + i * DAY);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

// ── calendar ─────────────────────────────────────────────────────────────────

test('calendar: required exit session is horizon SESSIONS after entry, skipping non-sessions', () => {
  const cal = CAL.buildSessionCalendar(weekdaySessions(60), { source: 'test' });
  const w = CAL.cohortWindow(cal, cal.sessions[10], 21);
  assert.equal(w.entrySession, cal.sessions[10]);
  assert.equal(w.requiredExitSession, cal.sessions[31]);
  // A weekend decision date maps to the LAST session at or before it.
  const friday = '2026-01-09';                          // a Friday session in this build
  assert.ok(cal.sessions.includes(friday));
  assert.equal(CAL.cohortWindow(cal, '2026-01-10', 21).entrySession, friday);   // Saturday → prior Friday
});

test('calendar: a window running past the calendar has NO required exit session and never counts as elapsed', () => {
  const cal = CAL.buildSessionCalendar(weekdaySessions(30), { source: 'test' });
  const w = CAL.cohortWindow(cal, cal.sessions[20], 21);
  assert.equal(w.requiredExitSession, null);
  assert.equal(CAL.cohortWindowElapsed(cal, cal.sessions[20], 21, cal.lastSession), false);
});

test('calendar: artifact round-trips and a tampered artifact is rejected', () => {
  const cal = CAL.buildSessionCalendar(weekdaySessions(40), { source: 'test' });
  const art = CAL.calendarArtifact(cal);
  const back = CAL.loadCalendarArtifact(art);
  assert.equal(back.calendarHash, cal.calendarHash);
  const tampered = { ...art, sessions: art.sessions.slice(0, -1) };
  assert.throws(() => CAL.loadCalendarArtifact(tampered), /hash mismatch/);
});

// ── cohort eligibility ───────────────────────────────────────────────────────

// The reproduced defect, in miniature: decision date whose horizon has NOT
// elapsed, with `pending` active names and `delisted` early-resolved labels.
function panelWith({ pending, delisted, mature = 0, date = null, cal, horizon = 21, cutoffIdx = 50 }) {
  const dt = date || cal.sessions[40];                  // late decision: 40+21 > 50 → not elapsed
  const rows = [];
  for (let i = 0; i < delisted; i++) rows.push({ s: `D${i}`, lid: `LD${i}`, dt, [`f${horizon}`]: -0.3 + i * 0.01, [`s${horizon}`]: 'c', [`le${horizon}`]: cal.sessions[45] });
  for (let i = 0; i < mature; i++) rows.push({ s: `M${i}`, lid: `LM${i}`, dt, [`f${horizon}`]: 0.01 * i, [`s${horizon}`]: 'm', [`le${horizon}`]: cal.sessions[Math.min(cutoffIdx, 40 + horizon)] });
  for (let i = 0; i < pending; i++) rows.push({ s: `P${i}`, lid: `LP${i}`, dt, [`f${horizon}`]: null, [`s${horizon}`]: 'p', [`le${horizon}`]: null });
  return { [dt.slice(0, 7)]: rows };
}

test('REGRESSION (required test 1): 3 early delistings can NEVER make a 1,704-name pending cohort eligible', () => {
  const cal = CAL.buildSessionCalendar(weekdaySessions(80), { source: 'test' });
  const panel = panelWith({ pending: 1704, delisted: 3, cal });
  const ledger = COHORT.computeCohortLedger({ panelByMonth: panel, calendar: cal, horizons: [21], labelObservationCutoff: cal.sessions[50] });
  const [c] = ledger.byHorizon['21'].cohorts;
  assert.equal(c.confirmedDelistedRows, 3);
  assert.equal(c.pendingRows, 1704);
  assert.equal(c.eligible, false);
  assert.ok(c.ineligibleReasons.includes('pending-rows'));
  assert.ok(c.ineligibleReasons.includes('window-not-elapsed'));
  assert.equal(ledger.byHorizon['21'].lastFullyObservedCohortDate, null, 'no eligible cohort exists at all');
});

test('required test 2: a cohort becomes eligible ONLY after the trading-session horizon elapsed', () => {
  const cal = CAL.buildSessionCalendar(weekdaySessions(80), { source: 'test' });
  // Same composition, but the decision sits early enough that entry+21 sessions
  // fit inside the cutoff AND nothing is pending.
  const early = panelWith({ pending: 0, delisted: 3, mature: 100, date: cal.sessions[10], cal });
  const ledgerEarly = COHORT.computeCohortLedger({ panelByMonth: early, calendar: cal, horizons: [21], labelObservationCutoff: cal.sessions[50] });
  assert.equal(ledgerEarly.byHorizon['21'].cohorts[0].eligible, true);
  // Identical rows, but a cutoff BEFORE the required exit session → ineligible,
  // even though every label is (impossibly) present: the calendar binds.
  const ledgerTight = COHORT.computeCohortLedger({ panelByMonth: early, calendar: cal, horizons: [21], labelObservationCutoff: cal.sessions[25] });
  assert.equal(ledgerTight.byHorizon['21'].cohorts[0].eligible, false);
  assert.ok(ledgerTight.byHorizon['21'].cohorts[0].ineligibleReasons.includes('window-not-elapsed'));
});

test('required test 3: appending future bars/months cannot change historical eligibility (append-invariance)', () => {
  const cal = CAL.buildSessionCalendar(weekdaySessions(80), { source: 'test' });
  const hist = panelWith({ pending: 0, delisted: 2, mature: 50, date: cal.sessions[10], cal });
  const before = COHORT.computeCohortLedger({ panelByMonth: hist, calendar: cal, horizons: [21], labelObservationCutoff: cal.sessions[50] });
  // The world moves on: a longer calendar, a later cutoff, new pending months.
  const cal2 = CAL.buildSessionCalendar(weekdaySessions(160), { source: 'test' });
  const futureDt = cal2.sessions[120];
  const extended = {
    ...hist,
    [futureDt.slice(0, 7)]: [{ s: 'NEW', lid: 'LN', dt: futureDt, f21: null, s21: 'p', le21: null }],
  };
  const after = COHORT.computeCohortLedger({ panelByMonth: extended, calendar: cal2, horizons: [21], labelObservationCutoff: cal2.sessions[150] });
  const histDate = cal.sessions[10];
  const recBefore = before.byHorizon['21'].cohorts.find((c) => c.decisionDate === histDate);
  const recAfter = after.byHorizon['21'].cohorts.find((c) => c.decisionDate === histDate);
  assert.equal(recAfter.eligible, recBefore.eligible);
  assert.equal(recAfter.pendingRows, recBefore.pendingRows);
  assert.equal(recAfter.numericLabelRows, recBefore.numericLabelRows);
  assert.equal(recAfter.requiredExitSession, recBefore.requiredExitSession, 'the historical window is fixed by the calendar, not by later data');
});

test('required test 6: confirmed delistings REMAIN valid outcomes inside fully matured cohorts', () => {
  const cal = CAL.buildSessionCalendar(weekdaySessions(80), { source: 'test' });
  const panel = panelWith({ pending: 0, delisted: 5, mature: 95, date: cal.sessions[10], cal });
  const ledger = COHORT.computeCohortLedger({ panelByMonth: panel, calendar: cal, horizons: [21], labelObservationCutoff: cal.sessions[50] });
  const [c] = ledger.byHorizon['21'].cohorts;
  assert.equal(c.eligible, true);
  assert.equal(c.confirmedDelistedRows, 5, 'delistings counted as outcomes');
  assert.equal(c.numericLabelRows, 100, 'delisted labels included in coverage');
  assert.equal(c.outcomeCoverageFraction, 1);
});

test('coverage gate: an elapsed zero-pending cohort below the coverage minimum is ineligible and DISCLOSED', () => {
  const cal = CAL.buildSessionCalendar(weekdaySessions(80), { source: 'test' });
  const dt = cal.sessions[10];
  const rows = [];
  for (let i = 0; i < 90; i++) rows.push({ s: `M${i}`, lid: `LM${i}`, dt, f21: 0.01, s21: 'm', le21: cal.sessions[31] });
  for (let i = 0; i < 10; i++) rows.push({ s: `U${i}`, lid: `LU${i}`, dt, f21: null, s21: 'u', le21: null });   // 90% coverage < 95%
  const ledger = COHORT.computeCohortLedger({ panelByMonth: { [dt.slice(0, 7)]: rows }, calendar: cal, horizons: [21], labelObservationCutoff: cal.sessions[50] });
  const [c] = ledger.byHorizon['21'].cohorts;
  assert.equal(c.eligible, false);
  assert.deepEqual(c.ineligibleReasons, ['coverage-below-minimum']);
  assert.equal(c.unresolvedRows, 10, 'exclusions disclosed, not hidden');
});

// ── harness boundary (required tests 7 + 8) ──────────────────────────────────

function syntheticEvents(dates, perDate = 6) {
  const rows = [];
  for (const [di, d] of dates.entries()) {
    for (let k = 0; k < perDate; k++) {
      rows.push({
        securityId: `s${k}`, decisionTs: d, labelEndDate: dates[Math.min(dates.length - 1, di + 2)],
        features: { mom121: ((k * 31 + di * 17) % 89) / 89 - 0.5 },
        outcome: ((k * 7 + di * 3) % 13) / 13 - 0.5,
      });
    }
  }
  return rows;
}

test('required test 7: partial-cohort rank-IC is rejected — no eligibility map, no experiment', () => {
  const dates = Array.from({ length: 10 }, (_, i) => iso(i));
  assert.throws(
    () => H3.runExperimentV3(syntheticEvents(dates), [], { folds: 3, seed: 1 }, { generatedAt: 'T' }),
    /cohortEligibility is required/,
  );
});

test('required tests 7+8: ineligible dates are excluded from IC and periodEnd == last eligible evaluated date', () => {
  const dates = Array.from({ length: 12 }, (_, i) => iso(i));
  const eligible = dates.slice(0, 8);                    // the last 4 dates are partial cohorts
  const rows = syntheticEvents(dates);
  const out = H3.runExperimentV3(rows, [], {
    folds: 3, seed: 1,
    cohortEligibility: { eligibleDates: eligible, source: 'test-ledger' },
  }, { generatedAt: 'T' });
  assert.deepEqual(out.cohortReport.excludedIneligibleDates, dates.slice(8));
  assert.equal(out.cohortReport.latestEvaluatedDecisionDate, eligible[eligible.length - 1]);
  assert.ok(out.cohortReport.minNamesPerDate >= H3.MIN_NAMES_PER_DATE);
  // No per-date IC may exist on an ineligible date, whatever its finite-outcome count.
  for (const r of Object.values(out.summaries)) {
    // summaries hold fold ICs internally; the guarantee surfaces via cohortReport
    assert.ok(r.dates <= eligible.length);
  }
  // perDateICv3 directly: an ineligible date with MIN_NAMES finite outcomes stays out.
  const probe = H3.perDateICv3(rows, (r) => r.features.mom121, { requireFeatures: ['mom121'], eligibility: { eligibleDates: eligible } });
  assert.ok(!probe.ics.some((x) => !eligible.includes(x.date)), 'no IC on any ineligible date');
  assert.deepEqual(probe.cohortExclusions.excludedIneligibleDates, dates.slice(8));
});

// ── provenance hashes (required test 9) ──────────────────────────────────────

test('required test 9: every content-source hash changes when its payload changes', () => {
  // Security master: one field.
  const master = { version: 'v3', records: { AAA: { listingId: 'L1', status: 'active' } } };
  const master2 = { version: 'v3', records: { AAA: { listingId: 'L1', status: 'delisted' } } };
  assert.notEqual(MF.definitionHash(master), MF.definitionHash(master2));
  // Universe: one constituent.
  const uni = { symbols: { AAA: {}, BBB: {} } };
  const uni2 = { symbols: { AAA: {}, CCC: {} } };
  assert.notEqual(MF.definitionHash(uni), MF.definitionHash(uni2));
  // Price partition: one bar → leaf hash → Merkle root.
  const barHash = (bars) => MF.definitionHash(bars);
  const p1 = [{ date: '2026-01-02', close: 100 }, { date: '2026-01-03', close: 101 }];
  const p2 = [{ date: '2026-01-02', close: 100 }, { date: '2026-01-03', close: 101.01 }];
  const root1 = MF.merkleRoot([{ name: 'AAA.json', hash: barHash(p1) }, { name: 'BBB.json', hash: barHash(p1) }]);
  const root2 = MF.merkleRoot([{ name: 'AAA.json', hash: barHash(p2) }, { name: 'BBB.json', hash: barHash(p1) }]);
  assert.notEqual(root1, root2);
  // Corporate action: one split record.
  const ca1 = { splits: [{ date: '2026-01-05', numerator: 2, denominator: 1 }], dividends: [] };
  const ca2 = { splits: [{ date: '2026-01-05', numerator: 3, denominator: 1 }], dividends: [] };
  assert.notEqual(
    MF.merkleRoot([{ name: 'AAA.json', hash: MF.definitionHash(ca1) }]),
    MF.merkleRoot([{ name: 'AAA.json', hash: MF.definitionHash(ca2) }]),
  );
  // Calendar: one session.
  const c1 = CAL.buildSessionCalendar(weekdaySessions(40), { source: 't' });
  const c2 = CAL.buildSessionCalendar(weekdaySessions(41), { source: 't' });
  assert.notEqual(c1.calendarHash, c2.calendarHash);
  // Cohort ledger: policy change moves the ledger hash.
  const cal = c1;
  const panel = panelWith({ pending: 0, delisted: 1, mature: 20, date: cal.sessions[5], cal });
  const l1 = COHORT.computeCohortLedger({ panelByMonth: panel, calendar: cal, horizons: [21], labelObservationCutoff: cal.sessions[30] });
  const l2 = COHORT.computeCohortLedger({ panelByMonth: panel, calendar: cal, horizons: [21], labelObservationCutoff: cal.sessions[30], minOutcomeCoverage: 0.99 });
  assert.notEqual(l1.ledgerHash, l2.ledgerHash);
});

// ── survivorship (required test 11) ──────────────────────────────────────────

test('required test 11: survivorship-reduced data can never claim survivorship-safe', () => {
  // A present-day symbols payload with partial dead-name coverage → reduced.
  const reduced = SV.makeSurvivorshipContract({
    historicalListingSource: 'symbols.json (present-day payload)',
    historicalListingSourceAuthoritative: false,
    delistedSecuritiesCovered: 636,
    totalSecurities: 2547,
  });
  assert.equal(reduced.status, 'survivorship-reduced');
  assert.equal(reduced.promotionEligible, false);
  // Forged: claim proven-safe without measurements → rejected by verification.
  const forged = { ...reduced, status: 'proven-safe' };
  const v = SV.verifySurvivorshipContract(forged);
  assert.equal(v.valid, false);
  // A bare boolean is never measured evidence.
  assert.equal(SV.verifySurvivorshipContract({ survivorshipSafe: true }).valid, false);
  // Authoritative source + measured coverage above the gates IS proven-safe.
  const proven = SV.makeSurvivorshipContract({
    historicalListingSource: 'exchange-monthly-listings',
    historicalListingSourceAuthoritative: true,
    monthlyExpectedListingCount: { '2026-01': 3000 },
    monthlyCoveredListingCount: { '2026-01': 2970 },
    delistedSecuritiesExpected: 200, delistedSecuritiesCovered: 195,
    totalSecurities: 3000,
  });
  assert.equal(proven.status, 'proven-safe');
  assert.equal(SV.verifySurvivorshipContract(proven).valid, true);
  // …but the same authoritative source below the gate stays reduced.
  const belowGate = SV.makeSurvivorshipContract({
    historicalListingSource: 'exchange-monthly-listings',
    historicalListingSourceAuthoritative: true,
    monthlyExpectedListingCount: { '2026-01': 3000 },
    monthlyCoveredListingCount: { '2026-01': 2000 },
    delistedSecuritiesExpected: 200, delistedSecuritiesCovered: 100,
    totalSecurities: 3000,
  });
  assert.equal(belowGate.status, 'survivorship-reduced');
});

// ── execution engine (economic-label contract; see also purge-tiers tests) ───

const mkBars = (closes, opens = null) => closes.map((c, i) => ({
  ms: D0 + i * DAY, open: opens ? opens[i] : c, high: c * 1.01, low: c * 0.99, close: c,
}));

test('execution: entry is the NEXT session open — the signal-day close is never the entry', () => {
  const bars = mkBars([100, 100, 100, 100, 100, 110, 110, 110], [100, 100, 100, 100, 100, 108, 110, 110]);
  const r = EX.executableOutcome({ bars, decisionIdx: 4, horizonSessions: 2, adv: 100e6 });
  assert.equal(r.status, 'filled');
  assert.equal(r.entryBasis, 'next-session-open');
  assert.equal(r.entryOpen, 108, 'fills at the next open, not the decision close');
  assert.ok(Math.abs(r.gapThroughPct - 0.08) < 1e-6, 'gap-through recorded');
  assert.ok(Math.abs(r.gross - (110 / 108 - 1)) < 1e-6, 'gross measured from the executable entry');
  assert.ok(r.netBase < r.gross && r.netDoubled < r.netBase && r.netStressed < r.netDoubled, 'cost scenarios ordered');
  assert.equal(r.raw.entry.open, 108, 'raw OHLC preserved');
});

test('execution: no next session, malformed open, or over-participation → no_fill', () => {
  const bars = mkBars([100, 100, 100]);
  assert.equal(EX.executableOutcome({ bars, decisionIdx: 2, horizonSessions: 2, adv: 1e7 }).status, 'no_fill');
  const badOpen = mkBars([100, 100, 100]); badOpen[1] = { ...badOpen[1], open: 0 };
  assert.equal(EX.executableOutcome({ bars: badOpen, decisionIdx: 0, horizonSessions: 1, adv: 1e7 }).status, 'no_fill');
  const thin = EX.executableOutcome({ bars: mkBars([1, 1, 1, 1]), decisionIdx: 0, horizonSessions: 2, adv: 100000, notionalUsd: 10000 });
  assert.equal(thin.status, 'no_fill');
  assert.match(thin.noFillReason, /participation/);
});

test('execution: cost evidence artifact is self-verifying and tamper-evident', () => {
  const bars = mkBars(Array.from({ length: 30 }, () => 100));
  const fill = EX.executableOutcome({ bars, decisionIdx: 2, horizonSessions: 21, adv: 100e6 });
  const ev = EX.buildCostEvidence({ fills: [fill], strategyId: 't', datasetHash: 'h', horizonSessions: 21 });
  assert.equal(EX.verifyCostEvidence(ev).valid, true);
  assert.equal(EX.verifyCostEvidence({ ...ev, net: (ev.net ?? 0) + 0.01 }).valid, false, 'edited number breaks the hash');
  assert.equal(EX.verifyCostEvidence({ ...ev, entryBasis: 'signal-day-close' }).valid, false);
  assert.equal(EX.verifyCostEvidence({ net: 1, doubledCostNet: 1, stressedLiquidityNet: 1 }).valid, false, 'bare numbers are not an artifact');
});
