'use strict';
// GHOST-BACKTEST CLAIMED GENERALIZATION FROM AN IN-SAMPLE SELECTION (alpha-research pass 3).
//
// Two independent defects in the same block:
//
//   1. SELECTION WAS IN-SAMPLE. The four "data-justified" refinements were chosen by
//      looking at these records — the file's own comments say so ("DROP IN — negative IC
//      on large-cap; zeroed", "BONUS tilt — the one additive factor (+IC); up-weighted
//      1.5x") — and then re-scored on the same records, with the result reported as
//      `generalizes` and headlined "Refinements WORK ... Crosses the confidence bar".
//      A purged re-run bounds overlapping-label leakage; it cannot undo selection that
//      happened before it.
//
//   2. THE PURGE DID NOT COVER THE LABEL. purgeDates counts DECISION DATES, spaced `step`
//      sessions apart (default 10), while every label runs MAX_HOLD = 63 sessions forward.
//      A purge of 1 removed ~10 sessions against a 63-session window, so six-sevenths of
//      each label's span still straddled every fold boundary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MAX_HOLD } = require('../lib/outcome');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ghost-backtest.js'), 'utf8');

test('the purge is DERIVED from the label horizon, not a fixed 1', () => {
  assert.match(SRC, /function purgeDatesFor\(step\)/);
  assert.match(SRC, /Math\.ceil\(MAX_HOLD \/ s\)/, 'the purge must cover the forward window');
  // Applied at every walk-forward site, not just defined.
  const applied = (SRC.match(/purgeDates: purgeDatesFor\(step\)/g) || []).length;
  assert.equal(applied, 3, 'all three purgedBlocks call sites must derive the purge');
  assert.ok(!/purgeDates: 1 \}\)/.test(SRC), 'no call site may keep the fixed purge');
});

test('the derived purge actually covers a 63-session label', () => {
  const purgeFor = (step) => Math.max(1, Math.ceil(MAX_HOLD / step));
  assert.equal(MAX_HOLD, 63);
  // At the default step of 10 the old value of 1 purged ~10 sessions; 7 covers 63+.
  assert.equal(purgeFor(10), 7);
  assert.ok(purgeFor(10) * 10 >= MAX_HOLD, 'purge x step must span the label');
  assert.ok(purgeFor(5) * 5 >= MAX_HOLD);
  assert.ok(purgeFor(21) * 21 >= MAX_HOLD);
});

test('the generalization claim is withdrawn, not softened', () => {
  assert.match(SRC, /generalizes: null/);
  assert.match(SRC, /generalizesReason: 'refinement selection was in-sample/);
  assert.match(SRC, /selectionBasis: 'in-sample: refinements were chosen from these same records'/);
});

test('the old boolean is preserved under an honest name — nothing is lost', () => {
  // The measurement still has diagnostic value; only the claim it supported is wrong.
  assert.match(SRC, /inSampleGates: \{ clearedOosGate: rGeneralizes, topQuintileBeatsMarket: rTopBeats \}/);
});

test('no headline asserts the refinements work or cross a confidence bar', () => {
  assert.ok(!/Refinements WORK/.test(SRC), 'the claim must not survive');
  assert.ok(!/Crosses the confidence bar/.test(SRC));
  assert.ok(!/it generalizes OOS/.test(SRC));
  assert.match(SRC, /IN-SAMPLE ONLY/, 'the replacement must state what the figures are');
  assert.match(SRC, /measure FIT, not generalization/);
  assert.match(SRC, /re-running the FROZEN refined weights on a later, untouched window/,
    'and say what would actually establish an edge');
});
