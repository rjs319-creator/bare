'use strict';
// A LEDGER READ FAILURE SILENTLY REWROTE THE EVIDENCE RECORD (alpha-research pass 3).
//
// Every Scoreboard ledger loaded as `readAllX().catch(() => [])`. A Blob/CDN failure
// became an empty array indistinguishable from "this strategy has no picks", so the
// group graded as:
//     { grade: 'experimental', reason: 'Not yet tracked in the Scoreboard — accruing.' }
// which is an affirmatively FALSE statement about a strategy that may have hundreds of
// resolved picks.
//
// That grade is written into scoreboard/summary.json, whose `evidenceHash` gov-v2.1
// requires a promotion artifact to match. So ONE transient read failure could change the
// hash, invalidate every version-matched approval, and demote live strategies into
// reduce-only/paper through governance.demote().
//
// NOTE ON METHOD: runScoreboard needs a live Blob store and ~23 ledger reads, so these
// are structural pins on the guard rather than an end-to-end run. They are written to
// fail if the guard is removed or bypassed — verified by reverting it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apex-routes.js'), 'utf8');
const A = require('../lib/apex-routes');

test('no ledger loader silently swallows a failure into an empty array', () => {
  // The exact pattern that caused this. If it reappears anywhere in the loader block,
  // the failure becomes invisible again.
  // Grep EXECUTABLE code only — the comment explaining this fix necessarily quotes the
  // old pattern, and a naive grep flags its own documentation (it did, twice).
  const code = SRC.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // Scoped to the scoreboard loader block: readCern().catch(() => null) in op=cerndecay
  // is a different function with no evidence-record consequence.
  const block = code.slice(code.indexOf('const ledgerErrors = []'), code.indexOf('], LEDGER_LOAD_CONCURRENCY'));
  const bare = [...block.matchAll(/readAll\w+\([^)]*\)\.catch\(\(\) => (?:\[\]|null)\)/g)].map(m => m[0]);
  assert.deepEqual(bare, [], `bare swallow(s) reintroduced: ${bare.join(', ')}`);
});

test('failures are captured BY NAME so a degraded run says which ledger broke', () => {
  assert.match(SRC, /const ledgerErrors = \[\]/);
  assert.match(SRC, /ledgerErrors\.push\(\{ ledger: name, error:/,
    'the ledger name must be recorded, not just a count');
  // Applied, not merely defined.
  assert.ok((SRC.match(/load\('readAll\w+'/g) || []).length >= 18,
    'every readAll* loader must route through the named wrapper');
});

test('a degraded run does NOT rewrite scoreboard/summary.json', () => {
  // The write must sit behind the guard, not beside it.
  const i = SRC.indexOf('if (ledgerErrors.length) {');
  const w = SRC.indexOf("writeJSON('scoreboard/summary.json'");
  assert.ok(i > 0, 'the degradation guard must exist');
  assert.ok(w > i, 'the summary write must be inside the guard, after the degraded branch');
  assert.match(SRC, /evidence not rewritten from a degraded run/);
});

test('the degradation is reported on the response, not merely logged', () => {
  assert.match(SRC, /return res\.json\(\{ configured: true, ledgerErrors, degraded: ledgerErrors\.length > 0/);
});

test('the existing daily-ledger guard is unchanged — this mirrors it, not replaces it', () => {
  // safeToWrite/ledgerWriteDecision already protect per-day ledgers from a degraded run
  // clobbering a complete day. The summary now follows the same principle.
  assert.equal(typeof A.ledgerWriteDecision, 'function');
  assert.deepEqual(A.ledgerWriteDecision(5, false), { write: true }, 'clean run writes');
  assert.equal(A.ledgerWriteDecision(0, true).write, false, 'degraded+empty never writes');
  assert.equal(A.ledgerWriteDecision(3, true, 10).write, false, 'degraded+shrink never writes');
  assert.equal(A.ledgerWriteDecision(12, true, 10).write, true, 'degraded but grown still writes');
});

test('a complete run still writes — the guard is not a permanent block', () => {
  // Regression guard: if ledgerErrors were ever populated unconditionally, the evidence
  // record would freeze forever and every grade would silently go stale.
  assert.ok(!/ledgerErrors\.push\([^)]*\)\s*;?\s*\n\s*(?!.*catch)/.test(SRC.slice(SRC.indexOf('const ledgerErrors'), SRC.indexOf('const ['))),
    'ledgerErrors may only be appended from a loader catch');
  const guard = SRC.slice(SRC.indexOf('if (ledgerErrors.length) {'), SRC.indexOf('if (ledgerErrors.length) {') + 900);
  assert.match(guard, /} else \{/, 'the clean path must still write');
});
