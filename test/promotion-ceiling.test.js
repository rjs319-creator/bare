'use strict';
// DECLARED PROMOTION CEILING (alpha-research pass 3; revised 2026-08-14).
//
// No non-Day-Trade strategy can reach `validated`, because fill verification is derived
// from canonical episodes (lib/episode-ledger.deriveFillVerified) and — until 2026-08-14
// — no non-Day-Trade module emitted one. The sanctioned exit path now EXISTS for the
// screener's Early:large cohort (op=swingverify, lib/screener-verify.js): episodes on an
// intraday-verified basis, reduced into scoreboard/summary.json as
// fillVerification.screener. Verification accrues PROSPECTIVELY: the pipeline being
// live changes NO grade today.
//
// The danger of such a declaration is that it silently becomes false — in either
// direction. These tests make it SELF-INVALIDATING both ways:
//   • if a NEW non-Day-Trade module starts emitting a canonical episode fill basis
//     outside the sanctioned pipeline, the tripwire fails and the declaration must be
//     re-verified;
//   • if anyone tries to uncap a grade WITHOUT data (a contract flag, a wording edit,
//     an edit to the declaration itself), the fail-closed pins below fail: the ONLY
//     path to fillVerified:true is ≥minResolved resolved episodes, all on a verified
//     basis, flowing through summary.fillVerification — and with ZERO accrued episodes
//     the whole grading surface must remain byte-identical to the pre-pipeline state.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PROMOTION_CEILING, STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const SC = require('../lib/strategy-contracts');
const M = require('../lib/maturity');
const EL = require('../lib/episode-ledger');
const SV = require('../lib/screener-verify');

const LIB = path.join(__dirname, '..', 'lib');

// Day-Trade lanes are out of scope for this ceiling and legitimately DO verify fills.
const DAYTRADE_RE = /^(intraday|daytrade|lowfloat|low-float|ignition|gapgo)/;

// The ONLY non-Day-Trade modules allowed to emit a canonical episode `fillBasis`:
// the definition itself, and the sanctioned screener verification pipeline the
// declaration's `pipelines` field names. Anything else is an unreviewed channel.
const SANCTIONED_EMITTERS = new Set(['episode-ledger.js', 'screener-verify.js']);

test('the ceiling is declared with a machine-readable blocker and an exit condition', () => {
  assert.equal(PROMOTION_CEILING.blocked, true);
  assert.equal(PROMOTION_CEILING.scope, 'non-daytrade');
  assert.equal(PROMOTION_CEILING.maxGrade, 'promising');
  assert.equal(PROMOTION_CEILING.version, 'promotion-ceiling-v2');
  assert.equal(PROMOTION_CEILING.blocker, 'intraday-fill-verification-accruing');
  assert.ok(Array.isArray(PROMOTION_CEILING.unblockRequires) && PROMOTION_CEILING.unblockRequires.length >= 3,
    'a ceiling without a stated way out is just an excuse');
  assert.ok(Object.isFrozen(PROMOTION_CEILING));
});

test('the declaration names its live pipeline honestly — screener only, prospective only', () => {
  assert.ok(PROMOTION_CEILING.pipelines && PROMOTION_CEILING.pipelines.screener,
    'the one live pipeline must be declared, or the ceiling reads as if none exists');
  assert.match(PROMOTION_CEILING.pipelines.screener, /swingverify/);
  assert.match(PROMOTION_CEILING.summary, /prospectively/i);
  assert.ok(Object.isFrozen(PROMOTION_CEILING.pipelines));
  // Only strategies with a declared pipeline may ever be described as accruing.
  for (const id of Object.keys(PROMOTION_CEILING.pipelines)) {
    assert.ok(STRATEGY_REGISTRY.some(e => e.id === id), `pipeline declared for unknown strategy "${id}"`);
  }
});

test('TRIPWIRE: no UNSANCTIONED non-Day-Trade module emits a canonical episode fill basis', () => {
  // The declaration rests on the emitter set being exactly what `pipelines` says. A new
  // emitter outside it means the declaration is stale — this fails LOUDLY rather than
  // the declaration quietly lying.
  const offenders = fs.readdirSync(LIB)
    .filter(f => f.endsWith('.js'))
    .filter(f => !SANCTIONED_EMITTERS.has(f))
    .filter(f => f !== 'strategy-registry.js')       // the declaration's own prose names the field
    .filter(f => !DAYTRADE_RE.test(f))               // Day Trade legitimately verifies fills
    // Match EMISSION (`fillBasis:` as an object property or assignment), not any mention
    // of the identifier — otherwise a comment explaining the ceiling trips its own wire.
    .filter(f => /\bfillBasis\s*[:=]/.test(fs.readFileSync(path.join(LIB, f), 'utf8')));

  assert.deepEqual(offenders, [],
    `a non-Day-Trade module outside the sanctioned pipeline now emits a canonical episode fillBasis (${offenders.join(', ')}). `
    + 'PROMOTION_CEILING in lib/strategy-registry.js may no longer be accurate — re-verify it, '
    + 'and add the channel to `pipelines` + SANCTIONED_EMITTERS only after review.');
});

test('the sanctioned pipeline stamps ONLY a basis episode-ledger recognizes as verified', () => {
  // A fillBasis name outside VERIFIED_FILL_BASES would be counted as an unverified
  // basis by deriveFillVerified and poison the whole stream — and a NEW verified name
  // may only be added to episode-ledger with a justification, never invented here.
  assert.ok(EL.VERIFIED_FILL_BASES.includes(SV.FILL_BASIS),
    `screener-verify stamps "${SV.FILL_BASIS}", which VERIFIED_FILL_BASES does not admit`);
  const ep = SV.buildEpisode(
    { ticker: 'TEST', date: '2026-08-10', ts: Date.parse('2026-08-10T21:30:00Z'), entry: 100, signalVersion: 'screener-v2' },
    { status: 'ok', entrySession: '2026-08-11' },
    { status: 'filled', at: '10:05', referencePrice: 100, fill: 100.18, reason: 'stop-trigger', trigger: 100, slippagePct: 0.0018 },
  );
  assert.equal(ep.fillBasis, SV.FILL_BASIS);
  assert.equal(ep.fillVerified, true);
});

test('a daily-bar next-open reconstruction is deliberately NOT accepted as verification', () => {
  // 'next-open' IS in VERIFIED_FILL_BASES, and entry-v2.2 moved ~23 sections to
  // next-open grading — so a literal reading would grant verification broadly. The
  // declaration records the rejection of that reading; this pins the rationale in place.
  assert.match(PROMOTION_CEILING.summary, /daily-bar next-open/i);
  assert.match(PROMOTION_CEILING.summary, /NOT accepted/);
});

test('every registered non-Day-Trade strategy actually fails fill verification today', () => {
  // The claim is universal, so test it universally rather than on one example. The
  // pipeline being LIVE must change nothing here until episodes actually accrue.
  const nonDT = STRATEGY_REGISTRY.filter(e => e.kind === 'signal' && !DAYTRADE_RE.test(e.id) && e.id !== 'daytrade');
  assert.ok(nonDT.length > 20, 'fixture sanity: the registry has many non-Day-Trade signals');
  for (const e of nonDT) {
    const fv = SC.fillVerifiedFor(e.id, { groups: [] });
    assert.equal(fv.fillVerified, false, `${e.id} unexpectedly reports verified fills`);
    assert.equal(fv.ceiling && fv.ceiling.blocker, 'intraday-fill-verification-accruing',
      `${e.id}'s fail-closed verdict must carry the systemic reason, not read as a strategy-specific failure`);
  }
});

test('ZERO ACCRUED EPISODES: the grading surface is byte-identical to the pre-pipeline state', () => {
  // The reduction is fail-closed at the summary itself: with no episodes the
  // fillVerification key is ABSENT, so maturity/governance/eligibility see the exact
  // summary they saw before the pipeline existed — nothing may promote today.
  assert.equal(SV.fillVerificationForSummary(null), null);
  assert.equal(SV.fillVerificationForSummary({}), null);
  assert.equal(SV.fillVerificationForSummary({ episodes: [] }), null);

  const summaryBefore = { generatedAt: 'x', groups: [{ section: 'screener', tier: 'Early', scope: 'large', picks: 3, horizons: {} }] };
  const summaryAfter = { ...summaryBefore };
  const fv = SV.fillVerificationForSummary({ episodes: [] });
  if (fv) summaryAfter.fillVerification = fv;
  assert.equal(JSON.stringify(summaryAfter), JSON.stringify(summaryBefore), 'zero episodes must not change the summary by a single byte');

  // And the derived verdict downstream is the identical fail-closed object.
  assert.deepEqual(SC.fillVerifiedFor('screener', summaryAfter), SC.fillVerifiedFor('screener', summaryBefore));
  const track = { excessN: 60, avgExcess: 0.5, beatMktRate: 55, dates: 25 };
  const before = M.gradeTrack(track, { fillVerified: SC.fillVerifiedFor('screener', summaryBefore).fillVerified, noHistoryRate: 0 });
  const after = M.gradeTrack(track, { fillVerified: SC.fillVerifiedFor('screener', summaryAfter).fillVerified, noHistoryRate: 0 });
  assert.deepEqual(after, before);
  assert.notEqual(before.grade, 'validated');
});

test('SILENT-UNCAP GUARD: no flag, wording edit, or ceiling edit can grant verification', () => {
  // The contract flag stays honest documentation of the legacy pipeline — false — and
  // fillVerifiedFor must ignore it as a grantor: absent derived evidence fails closed.
  assert.equal(SC.CONTRACTS.screener.fillVerified, false,
    'the screener contract flag must stay false — a hand-set flag can never turn verification on');
  assert.equal(SC.fillVerifiedFor('screener', null).fillVerified, false);
  assert.equal(SC.fillVerifiedFor('screener', {}).fillVerified, false);
  // The derivation itself fails closed on an empty or thin stream.
  assert.equal(EL.deriveFillVerified([]).fillVerified, false);
  assert.ok(EL.deriveFillVerified([]).minResolved >= 20, 'the resolved minimum is the accrual bar — lowering it is a reviewable data-contract change');
});

test('THE LIFT IS DATA-DRIVEN: enough resolved verified episodes — and only that — flips the derivation', () => {
  const resolvedEp = (i) => EL.makeEpisode({
    identity: { strategyId: 'screener', scoringVersion: 'screener-v2', side: 'long', policyTier: 'Early', scope: 'large' },
    ticker: `T${i}`, decisionTs: '2026-08-10T21:30:00Z', informationCutoff: '2026-08-10',
    expectedEntrySession: '2026-08-11', actualEntryTs: '2026-08-11T10:05',
    fillStatus: EL.FILL_STATUS.FILLED, fillBasis: 'intraday-verified',
    entryPrice: 100, exitReason: EL.EXIT_REASON.TIME, exitPrice: 101, exitTs: '2026-08-18',
  });
  const nineteen = Array.from({ length: 19 }, (_, i) => resolvedEp(i));
  assert.equal(EL.deriveFillVerified(nineteen).fillVerified, false, 'below the minimum the derivation fails closed');
  const twenty = Array.from({ length: 20 }, (_, i) => resolvedEp(i));
  const derived = EL.deriveFillVerified(twenty);
  assert.equal(derived.fillVerified, true, 'the sanctioned pipeline CAN lift the ceiling once the data is real');
  // …and it reaches the gate only through the summary reduction path.
  const fv = SC.fillVerifiedFor('screener', { fillVerification: { screener: derived } });
  assert.equal(fv.fillVerified, true);
  assert.equal(fv.basis, 'derived-from-episodes');
});

test('the ceiling is a ceiling, not a waiver — every other gate still applies', () => {
  // Granting fillVerified must not be sufficient on its own: the record still has to
  // clear cost-net basis, sector control, sample, dates, CI, effective N, blocks and
  // the ungradeable share.
  const weak = {
    excessN: 10, avgExcess: 0.2, beatMktRate: 52,
    netExcessN: 10, avgNetExcess: 0.1, netBeatMktRate: 51,
    secExcN: 10, avgSecExcess: 0.05, beatSecRate: 50,
    dates: 4,
    dateNet: { n: 4, avg: 0.1, sd: 2, se: 1, ci95: { lo: -1.9, hi: 2.1 }, effectiveN: 3, positiveBlocks: 1, blockStability: { blocks: 4, positive: 1, means: [0.1, -0.2, 0.3, -0.1], usable: true } },
  };
  const g = M.gradeTrack(weak, { fillVerified: true, noHistoryRate: 0 });
  assert.notEqual(g.grade, 'validated', 'fill verification alone must never promote');
});

test('op=maturity surfaces the ceiling on the governance board', () => {
  const src = fs.readFileSync(path.join(LIB, 'maturity-routes.js'), 'utf8');
  assert.match(src, /promotionCeiling: PROMOTION_CEILING/,
    'the ceiling must be visible on the board itself, not only inside each fillVerification detail');
});
