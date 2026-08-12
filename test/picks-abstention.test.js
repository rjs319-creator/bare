'use strict';
// FORCED RECOMMENDATIONS (alpha-research brief §3).
//
// api/picks.js enforced a 10-pick quota TWICE — once in the prompt ("You MUST return
// EXACTLY 10 picks. Not 3, not 5.") and once in the tool schema (`minItems: 10`). The
// schema half is the load-bearing one: it rejected an honest short list, so the model
// had to pad to satisfy the tool call whatever the prompt said. The prompt also told it
// how to pad — "fill remaining slots with the next-best opportunities from the news even
// if their rating is lower (5-6 range is acceptable for picks 8-10)".
//
// The brief's requirement is that the economically correct output may be "no position".
// A quota makes abstention structurally impossible, so these are source-level pins.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'picks.js'), 'utf8');

test('the pick count quota is gone from the prompt', () => {
  assert.ok(!/EXACTLY 10 picks/.test(SRC), 'the hard count instruction must not return');
  assert.ok(!/Not 3, not 5/.test(SRC));
  assert.ok(!/fill remaining slots/i.test(SRC), 'padding instructions must not return');
  assert.ok(!/5-6 range is acceptable/.test(SRC), 'the explicit lowered bar must not return');
});

test('the prompt states that zero picks is a correct answer', () => {
  assert.match(SRC, /returning ZERO is correct and expected/i);
  assert.match(SRC, /There is no quota/i);
  assert.match(SRC, /NEVER pad/i);
});

test('the tool schema permits an empty book — this is the load-bearing half', () => {
  // A floor in the schema overrides any instruction in the prompt, so asserting on the
  // prompt alone would not have caught the real defect.
  assert.match(SRC, /minItems: 0/, 'minItems must allow an empty picks array');
  assert.ok(!/minItems: 10/.test(SRC), 'the quota floor must not return');
  assert.match(SRC, /maxItems: 10/, 'a cap is a bar, not a quota — it stays');
});

test('a missing tool call and an empty book are distinguished', () => {
  // Conflating "the model never answered" (a failure) with "the model answered: none"
  // (the honest quiet-day result) is what motivated the quota originally.
  assert.match(SRC, /if \(!toolUse\?\.input\?\.picks\)/);
  assert.match(SRC, /const abstained = all\.length === 0/);
});

test('the response carries the abstention contract', () => {
  for (const field of ['abstained', 'actionableCount', 'screenedCount', 'rejectionReasonCounts']) {
    assert.ok(new RegExp(`\\b${field}[,:]`).test(SRC), `response must expose ${field}`);
  }
});

test('abstention is keyed off the screened book, not off a downstream empty track', () => {
  // shortTerm/longTerm can be empty for ordinary classification reasons; that is not
  // abstention. Only an empty *screened* set is.
  assert.ok(!/abstained = (shortTerm|longTerm)/.test(SRC));
  assert.match(SRC, /abstained\s*\n?\s*\?\s*\{ noQualifyingCatalyst/);
});
