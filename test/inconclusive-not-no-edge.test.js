'use strict';
// F-10 (deriveStatus half): "COULDN'T TELL" WAS RECORDED AS "DOESN'T WORK".
//
// lib/research/evidence-log.js VERDICTS has always included `inconclusive`:
//
//     ['pass-provisional', 'not-confirmed', 'invalid-data', 'inconclusive']
//
// but deriveStatus handled only three of them. `inconclusive` matched no branch
// and fell through to the terminal return:
//
//     return { status: 'no-edge', basis: `${fails.length} not-confirmed, 0 passes` }
//
// which, for a hypothesis whose only record was inconclusive, emitted the basis
// string "0 not-confirmed records, 0 passes" — a NO-EDGE verdict justified by an
// explicit count of zero failures. The absence of a decision was recorded as a
// decision.
//
// This is the most consequential label in the registry. `no-edge` is the
// graveyard the file exists to maintain — "so a rejected hypothesis is findable
// BEFORE someone re-runs it as if new" — and 24 of 43 hypotheses carry it. An
// idea that was never actually decided gets buried there and never revisited.
//
// no-edge now REQUIRES at least one not-confirmed record. Evidence that exists
// but decides nothing returns `inconclusive`, which is a real status, not a
// synonym for failure.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const EL = require('../lib/research/evidence-log');
const { STATUSES } = require('../lib/research/hypothesis-registry');

const rec = (o) => ({ recordId: 'r' + Math.abs(JSON.stringify(o).length), generatedAt: '2026-08-01', ...o });

test('inconclusive is a recordable verdict', () => {
  assert.ok(EL.VERDICTS.includes('inconclusive'));
});

test('a lone inconclusive record is NOT no-edge', () => {
  const s = EL.deriveStatus([rec({ verdict: 'inconclusive' })]);
  assert.notEqual(s.status, 'no-edge', 'an undecided test is not a failed one');
  assert.equal(s.status, 'inconclusive');
});

test('no-edge requires at least one actual not-confirmed record', () => {
  // The old terminal branch could emit no-edge with a basis literally reading
  // "0 not-confirmed records, 0 passes".
  const s = EL.deriveStatus([rec({ verdict: 'inconclusive' }), rec({ verdict: 'inconclusive' })]);
  assert.notEqual(s.status, 'no-edge');
  assert.doesNotMatch(String(s.basis), /^0 not-confirmed/);
});

test('a genuine failure still earns no-edge', () => {
  const s = EL.deriveStatus([rec({ verdict: 'not-confirmed' })]);
  assert.equal(s.status, 'no-edge');
});

test('a real failure is not softened by inconclusive company', () => {
  // Guard the opposite error: adding an undecided run must not launder a
  // hypothesis that genuinely failed.
  const s = EL.deriveStatus([rec({ verdict: 'not-confirmed' }), rec({ verdict: 'inconclusive' })]);
  assert.equal(s.status, 'no-edge');
});

test('inconclusive never outranks invalid-data', () => {
  const s = EL.deriveStatus([
    rec({ verdict: 'inconclusive', generatedAt: '2026-08-01' }),
    rec({ verdict: 'invalid-data', generatedAt: '2026-08-02' }),
  ]);
  assert.equal(s.status, 'invalid-data', 'the newest record still poisons the view');
});

test('inconclusive does not disturb the pass ladder', () => {
  const twoPass = [
    rec({ verdict: 'pass-provisional', mode: 'confirmatory', periodStart: '2020-01', periodEnd: '2021-01' }),
    rec({ verdict: 'pass-provisional', mode: 'confirmatory', periodStart: '2022-01', periodEnd: '2023-01' }),
    rec({ verdict: 'inconclusive' }),
  ];
  assert.equal(EL.deriveStatus(twoPass).status, 'provisional');
  const onePass = [rec({ verdict: 'pass-provisional', mode: 'confirmatory', periodStart: '2020-01', periodEnd: '2021-01' }), rec({ verdict: 'inconclusive' })];
  assert.equal(EL.deriveStatus(onePass).status, 'open', 'one period is still never validation');
});

test('the registry can actually store the status deriveStatus returns', () => {
  // deriveStatus is the VIEW the registry status must follow (docs/alpha-foundry.md).
  // Returning a status the registry rejects would just move the conflation.
  assert.ok(STATUSES.includes('inconclusive'), 'registry STATUSES must accept inconclusive');
});

test('no evidence at all is still open, not inconclusive', () => {
  // "Nothing recorded" and "recorded but undecided" are different states and
  // must stay distinguishable.
  assert.equal(EL.deriveStatus([]).status, 'open');
});
