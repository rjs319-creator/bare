'use strict';
// PHASE 6 — the canonical executable-episode ledger. One representation, honest attrition,
// derived (never toggled) fill verification.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EL = require('../lib/episode-ledger');

const IDENTITY = {
  strategyId: 'screener', scoringVersion: 'screener-v1', side: 'long', policyTier: 'Breakout',
  scope: 'large', horizon: 'swing', metric: '5d',
  executionPolicyVersion: 'exec-v1', labelVersion: 'executable-v1', benchmarkVersion: 'bench:SPY+sector',
  cohortVersion: 'scoped-v1',
};
const base = (over = {}) => ({
  identity: IDENTITY, ticker: 'AAA', decisionTs: '2026-01-05', informationCutoff: '2026-01-05',
  actualEntryTs: '2026-01-06', fillStatus: EL.FILL_STATUS.FILLED, fillBasis: 'next-open',
  entryPrice: 100, stop: 95, target: 110, exitReason: EL.EXIT_REASON.TARGET, exitPrice: 110,
  grossExcessPct: 4.2, netExcessPct: 3.8, ...over,
});

test('an episode carries the full contract: identity, timing, execution, costs, benchmark, lineage', () => {
  const e = EL.makeEpisode(base({ securityId: 'CIK0000320193', borrowAvailable: true, borrowCostBps: 40, transactionCostPct: 0.2, benchmarkReturnPct: 0.4, sectorReturnPct: 0.9, dataLineage: { source: 'fmp' }, evaluatorVersion: 'v1' }));
  assert.equal(e.schemaVersion, EL.EPISODE_SCHEMA_VERSION);
  assert.equal(e.valid, true);
  assert.equal(e.identityClass, 'CANONICAL');
  assert.ok(e.identityKey.includes('strategyId=screener'));
  assert.equal(e.securityId, 'CIK0000320193');
  assert.equal(e.fillVerified, true);
  assert.equal(e.borrowAvailable, true);
  assert.equal(e.dataLineage.source, 'fmp');
});

test('LEAKAGE: an entry at or before the decision is INVALID_DATA, never graded', () => {
  const same = EL.makeEpisode(base({ actualEntryTs: '2026-01-05' }));
  assert.equal(same.fillStatus, EL.FILL_STATUS.INVALID_DATA);
  assert.equal(same.attritionReason, EL.ATTRITION.INVALID_TIMESTAMPS);
  assert.equal(same.valid, false);
  const before = EL.makeEpisode(base({ actualEntryTs: '2026-01-02' }));
  assert.equal(before.fillStatus, EL.FILL_STATUS.INVALID_DATA);
});

test('LEAKAGE: an information cutoff after the decision is refused', () => {
  const e = EL.makeEpisode(base({ informationCutoff: '2026-01-07' }));
  assert.equal(e.fillStatus, EL.FILL_STATUS.INVALID_DATA);
  assert.match(e.errors.join(' '), /look-ahead/);
});

test('a MISSING expected entry session is never substituted with a later one', () => {
  const e = EL.makeEpisode(base({ expectedEntrySession: '2026-01-06', actualEntryTs: '2026-01-09' }));
  assert.equal(e.fillStatus, EL.FILL_STATUS.INVALID_DATA);
  assert.equal(e.attritionReason, EL.ATTRITION.MISSING_ENTRY_SESSION);
  assert.match(e.errors.join(' '), /never substituted/);
  // the exact session is accepted
  assert.equal(EL.makeEpisode(base({ expectedEntrySession: '2026-01-06' })).fillStatus, EL.FILL_STATUS.FILLED);
});

test('FILL VERIFICATION IS DERIVED, not toggled: a proxy basis can never claim a verified fill', () => {
  const proxy = EL.makeEpisode(base({ fillBasis: 'signal-close-proxy' }));
  assert.equal(proxy.fillVerified, false);
  const verified = Array.from({ length: 25 }, (_, i) => {
    const d = `2026-01-0${(i % 9) + 1}`;
    return EL.makeEpisode(base({ ticker: `T${i}`, decisionTs: d, informationCutoff: d, actualEntryTs: '2026-02-02' }));
  });
  const d = EL.deriveFillVerified(verified);
  assert.equal(d.fillVerified, true);
  assert.equal(d.resolved, 25);
  // one proxy episode in the pool destroys the claim
  const mixed = [...verified, EL.makeEpisode(base({ ticker: 'X', fillBasis: 'assumed-filled' }))];
  const dm = EL.deriveFillVerified(mixed);
  assert.equal(dm.fillVerified, false);
  assert.match(dm.reason, /unverified fill bases/);
});

test('fill verification fails CLOSED below the resolved-episode floor', () => {
  const few = Array.from({ length: 3 }, (_, i) => EL.makeEpisode(base({ ticker: `T${i}` })));
  const d = EL.deriveFillVerified(few);
  assert.equal(d.fillVerified, false);
  assert.match(d.reason, /fails closed/);
});

test('ATTRITION is counted by reason — no-fill and gap-skip are outcomes, not absences', () => {
  const eps = [
    EL.makeEpisode(base()),
    EL.makeEpisode(base({ ticker: 'B', fillStatus: EL.FILL_STATUS.NO_FILL, actualEntryTs: null })),
    EL.makeEpisode(base({ ticker: 'C', fillStatus: EL.FILL_STATUS.GAP_SKIP, actualEntryTs: null })),
    EL.makeEpisode(base({ ticker: 'D', fillStatus: EL.FILL_STATUS.INVALID_DATA, actualEntryTs: null, attritionReason: EL.ATTRITION.DELISTED })),
    EL.makeEpisode(base({ ticker: 'E', fillStatus: EL.FILL_STATUS.PENDING, actualEntryTs: null })),
  ];
  const a = EL.attritionReport(eps);
  assert.equal(a.candidates, 5);
  assert.equal(a.filled, 1);
  assert.equal(a.pending, 1);
  assert.equal(a.attrited, 3);
  assert.equal(a.byReason[EL.ATTRITION.NO_FILL], 1);
  assert.equal(a.byReason[EL.ATTRITION.GAP_SKIP], 1);
  assert.equal(a.byReason[EL.ATTRITION.DELISTED], 1);
  assert.equal(a.fillRatePct, 25);
});

test('an unfilled plan is never averaged in as a 0% return', () => {
  const eps = [
    EL.makeEpisode(base({ netExcessPct: 4 })),
    EL.makeEpisode(base({ ticker: 'B', fillStatus: EL.FILL_STATUS.NO_FILL, actualEntryTs: null, netExcessPct: null })),
  ];
  const rows = EL.toDateSeriesRows(eps);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].netExc, 4);
});

test('ADAPTER: swing-evaluate no-fill / gap-skip semantics survive the migration', () => {
  const origin = { ticker: 'ZZZ', strategyId: 'screener', scoringVersion: 'screener-v1', side: 'long', firstDecisionDate: '2026-01-05', originalHoldingWindow: 10 };
  const filled = EL.fromSwingEvaluate(origin, { fill: { status: 'filled', fillDate: '2026-01-06', fillPrice: 101, reason: 'ENTER_NOW_NEXT_OPEN' }, barrier: { reason: 'stop', exitPrice: 95, exitDate: '2026-01-09' }, returnSinceFill: -0.06, excessVsSpy: -0.05 });
  assert.equal(filled.fillStatus, EL.FILL_STATUS.FILLED);
  assert.equal(filled.fillBasis, 'next-open');
  assert.equal(filled.fillVerified, true);
  assert.equal(filled.exitReason, 'stop');
  assert.equal(filled.grossReturnPct, -6);
  const unfilled = EL.fromSwingEvaluate(origin, { fill: { status: 'unfilled', reason: 'TRIGGER_NOT_REACHED' } });
  assert.equal(unfilled.fillStatus, EL.FILL_STATUS.NO_FILL);
  assert.equal(unfilled.attritionReason, EL.ATTRITION.NO_FILL);
  assert.equal(unfilled.fillVerified, false);
});

test('ADAPTER: gapgo-verify intraday outcomes map to canonical statuses (TAKE vs CONTROL preserved)', () => {
  const pick = { ticker: 'GAP', decisionTs: '2026-01-05', dataCutoffSession: '2026-01-05', entrySession: '2026-01-06', take: true, scoringVersion: 'gapgo-v1' };
  const win = EL.fromGapGoVerify(pick, { status: 'target-before-stop', fill: 10, stop: 9.5, target: 11, exit: 11, at: '10:35', grossR: 2, netR: 1.8, costPct: 0.2 });
  assert.equal(win.fillStatus, EL.FILL_STATUS.FILLED);
  assert.equal(win.exitReason, EL.EXIT_REASON.TARGET);
  assert.equal(win.fillVerified, true);
  assert.equal(win.identity.policyTier, 'TAKE');
  assert.equal(win.rMultipleNet, 1.8);
  const skip = EL.fromGapGoVerify(pick, { status: 'gap-skip', at: '10:00' });
  assert.equal(skip.fillStatus, EL.FILL_STATUS.GAP_SKIP);
  assert.equal(skip.attritionReason, EL.ATTRITION.GAP_SKIP);
  const noBars = EL.fromGapGoVerify(pick, { status: 'insufficient-bars' });
  assert.equal(noBars.attritionReason, EL.ATTRITION.TRUNCATED_HISTORY);
  const control = EL.fromGapGoVerify({ ...pick, take: false }, { status: 'no-trigger' });
  assert.equal(control.identity.policyTier, 'CONTROL');
  assert.equal(control.fillStatus, EL.FILL_STATUS.NO_FILL);
});

test('ADAPTER: a legacy Scoreboard proxy row is admitted but honestly marked fill-UNVERIFIED', () => {
  const e = EL.fromScoreboardRow({ section: 'screener', tier: 'Setup', ticker: 'AAA', date: '2026-01-05', ret: 3.1, netExc: 2.2, exc: 2.6 });
  assert.equal(e.fillStatus, EL.FILL_STATUS.FILLED);
  assert.equal(e.fillBasis, 'signal-close-proxy');
  assert.equal(e.fillVerified, false);
  assert.equal(e.identityClass, 'LEGACY_CONTEXT', 'a proxy row cannot carry a complete identity');
});

test('RECONCILIATION reports the migration delta instead of hiding it', () => {
  const legacy = [{ ret: 3, netExc: 3 }, { ret: -1, netExc: -1 }, { ret: 2, netExc: 2 }];
  const canonical = [
    EL.makeEpisode(base({ netExcessPct: 3 })),
    EL.makeEpisode(base({ ticker: 'B', fillStatus: EL.FILL_STATUS.NO_FILL, actualEntryTs: null })),
    EL.makeEpisode(base({ ticker: 'C', netExcessPct: -1 })),
  ];
  const r = EL.reconcile(legacy, canonical, { label: 'screener' });
  assert.equal(r.legacy.graded, 3);
  assert.equal(r.canonical.filled, 2);
  assert.equal(r.countDelta, -1);
  assert.ok(Number.isFinite(r.meanDelta));
  assert.equal(r.attrition.byReason[EL.ATTRITION.NO_FILL], 1);
});
