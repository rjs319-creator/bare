'use strict';
// DECLARED PROMOTION CEILING (alpha-research pass 3).
//
// No non-Day-Trade strategy can reach `validated`, because fill verification is derived
// from canonical episodes (lib/episode-ledger.deriveFillVerified) and no non-Day-Trade
// module emits one. That is a missing pipeline, not a verdict on any strategy's edge —
// so it is declared in lib/strategy-registry.PROMOTION_CEILING rather than left for a
// reader to infer from everything sitting at `promising` forever.
//
// The danger of such a declaration is that it silently becomes false. These tests make
// it SELF-INVALIDATING: the moment a non-Day-Trade module starts emitting a canonical
// episode fill basis, the tripwire below fails and the declaration must be revisited.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PROMOTION_CEILING, STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const SC = require('../lib/strategy-contracts');
const M = require('../lib/maturity');

const LIB = path.join(__dirname, '..', 'lib');

// Day-Trade lanes are out of scope for this ceiling and legitimately DO verify fills.
const DAYTRADE_RE = /^(intraday|daytrade|lowfloat|low-float|ignition|gapgo)/;

test('the ceiling is declared with a machine-readable blocker and an exit condition', () => {
  assert.equal(PROMOTION_CEILING.blocked, true);
  assert.equal(PROMOTION_CEILING.scope, 'non-daytrade');
  assert.equal(PROMOTION_CEILING.maxGrade, 'promising');
  assert.equal(PROMOTION_CEILING.blocker, 'no-intraday-verified-fill-pipeline');
  assert.ok(Array.isArray(PROMOTION_CEILING.unblockRequires) && PROMOTION_CEILING.unblockRequires.length >= 3,
    'a ceiling without a stated way out is just an excuse');
  assert.ok(Object.isFrozen(PROMOTION_CEILING));
});

test('TRIPWIRE: no non-Day-Trade module emits a canonical episode fill basis', () => {
  // This is the fact the declaration rests on. If it stops being true, the declaration
  // is stale and must be re-examined — so this test fails LOUDLY rather than the
  // declaration quietly lying.
  const offenders = fs.readdirSync(LIB)
    .filter(f => f.endsWith('.js'))
    .filter(f => f !== 'episode-ledger.js')          // the definition itself
    .filter(f => f !== 'strategy-registry.js')       // the declaration's own prose names the field
    .filter(f => !DAYTRADE_RE.test(f))               // Day Trade legitimately verifies fills
    // Match EMISSION (`fillBasis:` as an object property or assignment), not any mention
    // of the identifier — otherwise a comment explaining the ceiling trips its own wire.
    .filter(f => /\bfillBasis\s*[:=]/.test(fs.readFileSync(path.join(LIB, f), 'utf8')));

  assert.deepEqual(offenders, [],
    `a non-Day-Trade module now emits a canonical episode fillBasis (${offenders.join(', ')}). `
    + 'PROMOTION_CEILING in lib/strategy-registry.js may no longer be accurate — re-verify it '
    + 'and remove the declaration if fill verification is now derivable.');
});

test('a daily-bar next-open reconstruction is deliberately NOT accepted as verification', () => {
  // 'next-open' IS in VERIFIED_FILL_BASES, and entry-v2.2 moved ~23 sections to
  // next-open grading — so a literal reading would grant verification broadly. The
  // declaration records the rejection of that reading; this pins the rationale in place.
  assert.match(PROMOTION_CEILING.summary, /daily-bar next-open/i);
  assert.match(PROMOTION_CEILING.summary, /NOT accepted/);
});

test('every registered non-Day-Trade strategy actually fails fill verification today', () => {
  // The claim is universal, so test it universally rather than on one example.
  const nonDT = STRATEGY_REGISTRY.filter(e => e.kind === 'signal' && !DAYTRADE_RE.test(e.id) && e.id !== 'daytrade');
  assert.ok(nonDT.length > 20, 'fixture sanity: the registry has many non-Day-Trade signals');
  for (const e of nonDT) {
    const fv = SC.fillVerifiedFor(e.id, { groups: [] });
    assert.equal(fv.fillVerified, false, `${e.id} unexpectedly reports verified fills`);
    assert.equal(fv.ceiling && fv.ceiling.blocker, 'no-intraday-verified-fill-pipeline',
      `${e.id}'s fail-closed verdict must carry the systemic reason, not read as a strategy-specific failure`);
  }
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
