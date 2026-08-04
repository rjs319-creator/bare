'use strict';
// Gap & Go intraday ORB verification (gapgo-orb-verify-v2) — the REAL execution record
// the daily-close proxy ledger cannot provide. Pins the frozen contract: genuine
// 30-minute opening range (never the completed daily high), trigger only after the
// range completes, gap-through at the worse open, >5% chase ceiling = gap-skip,
// same-bar stop/target ambiguity resolves to the STOP, honest no-trigger and
// insufficient-bars states, cost-net R — and, since v2, DECISION-TIME honesty:
// the post-close decision may only trade the NEXT trading session, the frozen
// logged `take` decision is copied (never recomputed), take:false is a CONTROL
// cohort, and superseded v1 same-session records never pool with v2.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveOrbFromBars, verifyCostTier, GAPGO_VERIFY_VERSION, SUPERSEDED_VERSIONS,
  selectEntrySession, gradeVerifyEpisode,
} = require('../lib/gapgo-verify');

const bar = (t, open, high, low, close) => ({ t, open, high, low, close });
// A clean 30-min opening range: high 105, low 100.
const OR = [
  bar('09:30', 101, 103, 100, 102),
  bar('09:35', 102, 104, 101, 103),
  bar('09:40', 103, 105, 102, 104),
  bar('09:45', 104, 104.5, 103, 104),
  bar('09:50', 104, 104.8, 103.5, 104.2),
  bar('09:55', 104.2, 104.6, 103.8, 104.1),
];

test('no-trigger: a gap whose OR high never breaks records NO-FILL, not a 3-day drift return', () => {
  const post = [bar('10:00', 104, 104.9, 103, 104), bar('10:05', 104, 104.5, 102, 103), bar('15:55', 103, 103.5, 101, 102)];
  const r = resolveOrbFromBars([...OR, ...post]);
  assert.equal(r.status, 'no-trigger');
  assert.equal(r.trigger, 105);
  assert.equal(r.version, GAPGO_VERIFY_VERSION);
});

test('touched trigger fills AT the trigger; target-before-stop resolves at +2R', () => {
  const post = [
    bar('10:00', 104.5, 105.5, 104, 105.2),  // breaks 105 → fill 105 (touched, not gapped)
    bar('10:05', 105.2, 108, 105.1, 107),
    bar('10:10', 107, 116, 106.5, 115),      // target = 105 + 2×(105−100) = 115
  ];
  const r = resolveOrbFromBars([...OR, ...post]);
  assert.equal(r.status, 'target-before-stop');
  assert.equal(r.fill, 105);
  assert.equal(r.stop, 100);
  assert.equal(r.target, 115);
  assert.equal(r.grossR, 2);
});

test('gap-through fills at the WORSE open, never the trigger', () => {
  const post = [
    bar('10:00', 106.5, 107, 106, 106.8),    // opens above 105 but under the 5% ceiling (110.25)
    bar('15:55', 107, 107.5, 106, 107),
  ];
  const r = resolveOrbFromBars([...OR, ...post]);
  assert.equal(r.fill, 106.5, 'gap-through must fill at the open, not the trigger');
  assert.equal(r.status, 'timeout');         // neither stop (100) nor target hit
  assert.equal(r.exit, 107);
});

test('an open beyond the 5% chase ceiling is a GAP-SKIP — refused, never an optimistic fill', () => {
  const post = [bar('10:00', 111, 112, 110, 111.5), bar('15:55', 111, 111.5, 110, 111)];
  const r = resolveOrbFromBars([...OR, ...post]);
  assert.equal(r.status, 'gap-skip');
  assert.equal(r.fill, undefined);
});

test('same-bar stop+target ambiguity resolves to the STOP (conservative), on the fill bar too', () => {
  const post = [
    // fill bar: breaks 105, then spans BOTH the stop (100) and the target — stop wins
    bar('10:00', 104.5, 116, 99.5, 100.5),
  ];
  const r = resolveOrbFromBars([...OR, ...post]);
  assert.equal(r.status, 'stop-before-target');
  assert.equal(r.exit, 100);
  assert.equal(r.grossR, -1);
});

test('timeout exits at the session close; netR charges the round-trip cost', () => {
  const post = [
    bar('10:00', 104.5, 105.5, 104, 105.2),  // fill 105
    bar('15:55', 106, 107, 105.5, 106.5),    // no stop/target → time exit at 106.5
  ];
  const r = resolveOrbFromBars([...OR, ...post], { costPct: 0.5 });
  assert.equal(r.status, 'timeout');
  assert.equal(r.exit, 106.5);
  assert.equal(r.grossR, 0.3);               // (106.5−105)/5
  assert.ok(r.netR < r.grossR, 'net must be worse than gross');
  assert.equal(r.netR, +(((106.5 - 105) - 105 * 0.005) / 5).toFixed(3));
});

test('a truncated opening range fails CLOSED (insufficient-bars) — the daily high can never stand in', () => {
  const r = resolveOrbFromBars([OR[0], OR[1], bar('10:05', 104, 110, 103, 109)]);
  assert.equal(r.status, 'insufficient-bars');
});

test('unknown ADV never earns the cheapest cost tier', () => {
  assert.equal(verifyCostTier(null), 'small');
  assert.equal(verifyCostTier(0), 'small');
  assert.equal(verifyCostTier(60_000_000), 'liquid');
  assert.equal(verifyCostTier(3_000_000), 'micro');
});

// ── v2 decision-time honesty ─────────────────────────────────────────────────

// Bars that would produce a clean +2R WIN if graded (OR high 105 broken, target hit).
const WIN_SESSION = [
  ...OR,
  bar('10:00', 104.5, 105.5, 104, 105.2),   // touches trigger 105 → fill at 105
  bar('10:30', 105.2, 116, 105, 115),        // target 105 + 2*(105-100) = 115 prints
];
// Bars that stop out immediately if graded.
const LOSS_SESSION = [
  ...OR,
  bar('10:00', 104.5, 105.5, 104, 105.2),   // fill at 105
  bar('10:30', 104, 104.5, 99, 100),         // stop 100 hit
];

test('v2: the verifier cannot trade before the decision — the signal session itself is never an eligible entry session', () => {
  assert.equal(selectEntrySession(['2026-08-03'], '2026-08-03').status, 'no-entry-session');
  assert.equal(selectEntrySession(['2026-08-01', '2026-08-03'], '2026-08-03').status, 'no-entry-session');
  const ok = selectEntrySession(['2026-08-03', '2026-08-04'], '2026-08-03');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.entrySession, '2026-08-04');
});

test('v2: weekend gap picks Monday; a hole wider than weekend+holiday is entry-session-uncertain, never guessed', () => {
  const fri = selectEntrySession(['2026-08-07', '2026-08-10'], '2026-08-07'); // Fri → Mon
  assert.equal(fri.status, 'ok');
  assert.equal(fri.entrySession, '2026-08-10');
  const hole = selectEntrySession(['2026-08-03', '2026-08-12'], '2026-08-03'); // 9-day hole
  assert.equal(hole.status, 'entry-session-uncertain');
});

test('v2: grading uses ONLY the entry session — signal-day bars cannot change the outcome', () => {
  const pick = { ticker: 'GAP', date: '2026-08-03', take: true, decisionTs: '2026-08-04T00:10:00.000Z', advUsd: 60_000_000 };
  const withSignalDay = gradeVerifyEpisode(pick, { '2026-08-03': WIN_SESSION, '2026-08-04': LOSS_SESSION });
  const withoutSignalDay = gradeVerifyEpisode(pick, { '2026-08-04': LOSS_SESSION });
  assert.equal(withSignalDay.entrySession, '2026-08-04');
  assert.equal(withSignalDay.status, 'stop-before-target');
  // The signal session's own (winning) bars are invisible to the grade.
  assert.equal(withSignalDay.status, withoutSignalDay.status);
  assert.equal(withSignalDay.exit, withoutSignalDay.exit);
});

test('v2: the frozen decision is COPIED from the pick — bar data can change execution, never the decision or cohort', () => {
  const pick = { ticker: 'GAP', date: '2026-08-03', take: false, decisionTs: '2026-08-04T00:10:00.000Z' };
  const win = gradeVerifyEpisode(pick, { '2026-08-04': WIN_SESSION });
  const loss = gradeVerifyEpisode(pick, { '2026-08-04': LOSS_SESSION });
  assert.equal(win.take, false);
  assert.equal(win.cohort, 'CONTROL');
  assert.equal(loss.cohort, 'CONTROL');
  assert.equal(win.cohort, loss.cohort);
});

test('v2: take:false can NEVER enter the promotion-grade TAKE cohort', () => {
  const ep = gradeVerifyEpisode({ ticker: 'GAP', date: '2026-08-03', take: false, decisionTs: '2026-08-04T00:10:00.000Z' }, { '2026-08-04': WIN_SESSION });
  assert.equal(ep.cohort, 'CONTROL');
  assert.equal(ep.promotionEligible, false);
});

test('v2: a legacy pick with no persisted decision is LEGACY-NO-DECISION and non-promotable', () => {
  const ep = gradeVerifyEpisode({ ticker: 'OLD', date: '2026-08-03' }, { '2026-08-04': WIN_SESSION });
  assert.equal(ep.cohort, 'LEGACY-NO-DECISION');
  assert.equal(ep.promotionEligible, false);
});

test('v2: a frozen TAKE with decision provenance IS promotion-eligible — but only with a resolvable entry session', () => {
  const good = gradeVerifyEpisode({ ticker: 'GAP', date: '2026-08-03', take: true, decisionTs: '2026-08-04T00:10:00.000Z' }, { '2026-08-04': WIN_SESSION });
  assert.equal(good.cohort, 'TAKE');
  assert.equal(good.promotionEligible, true);
  assert.equal(good.status, 'target-before-stop');
  const noSession = gradeVerifyEpisode({ ticker: 'GAP', date: '2026-08-03', take: true, decisionTs: '2026-08-04T00:10:00.000Z' }, {});
  assert.equal(noSession.status, 'no-entry-session');
  assert.equal(noSession.promotionEligible, false);
});

test('v2: superseded v1 (same-session look-ahead) is declared non-promotable and carries a distinct version — the lanes cannot mix', () => {
  assert.ok(SUPERSEDED_VERSIONS['gapgo-orb-verify-v1'], 'v1 must be explicitly superseded');
  assert.match(SUPERSEDED_VERSIONS['gapgo-orb-verify-v1'], /look-ahead/i);
  assert.notEqual(GAPGO_VERIFY_VERSION, 'gapgo-orb-verify-v1');
  const ep = gradeVerifyEpisode({ ticker: 'GAP', date: '2026-08-03', take: true, decisionTs: 'x' }, { '2026-08-04': WIN_SESSION });
  assert.equal(ep.version, GAPGO_VERIFY_VERSION);
});

test('v2: logger, contract and verifier share ONE strategy identity and the SAME execution geometry', () => {
  const { freezeGapLedgerPick, GAPGO_SCORING_VERSION } = require('../lib/gapgo');
  const SC = require('../lib/strategy-contracts');
  const contract = SC.contractFor('gapgo');
  // One scoring identity everywhere.
  assert.equal(contract.scoringVersion, GAPGO_SCORING_VERSION);
  // The contract names the verified execution channel and its decision basis.
  assert.equal(contract.verifyVersion, GAPGO_VERIFY_VERSION);
  assert.equal(contract.eligibleEntrySession, 'next-session');
  assert.match(contract.decisionBasis, /post-close/i);
  // The logger freezes the decision the verifier will grade.
  const frozen = freezeGapLedgerPick(
    { ticker: 'GAP', tier: 'STRONG', gapPct: 7, date: '2026-08-03', plan: { trigger: 12 }, sector: 'Tech',
      take: true, continuationScore: 3.2, avgDollarVol: 60_000_000, earningsCheck: 'clear' },
    { decisionTs: '2026-08-04T00:10:00.000Z', sessionDate: '2026-08-03' });
  assert.equal(frozen.take, true);
  assert.equal(frozen.scoringVersion, GAPGO_SCORING_VERSION);
  assert.equal(frozen.decisionTs, '2026-08-04T00:10:00.000Z');
  assert.equal(frozen.dataCutoffSession, '2026-08-03');
  const ep = gradeVerifyEpisode(frozen, { '2026-08-04': WIN_SESSION });
  assert.equal(ep.cohort, 'TAKE');
  assert.equal(ep.scoringVersion, GAPGO_SCORING_VERSION);
  assert.equal(ep.dataCutoffSession, '2026-08-03');
});

test('v2: a truthy-but-non-boolean take never silently becomes a TAKE', () => {
  const ep = gradeVerifyEpisode({ ticker: 'GAP', date: '2026-08-03', take: 'yes', decisionTs: 'x' }, { '2026-08-04': WIN_SESSION });
  assert.equal(ep.cohort, 'LEGACY-NO-DECISION');
  assert.equal(ep.promotionEligible, false);
});
