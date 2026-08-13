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
  const i = SRC.indexOf('if (blocking.length) {');
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
  const guard = SRC.slice(SRC.indexOf('if (blocking.length) {'), SRC.indexOf('if (blocking.length) {') + 900);
  assert.match(guard, /} else \{/, 'the clean path must still write');
});

// ── partial reads (the same defect one layer down) ───────────────────────────────

test('per-day readers report how much they lost, without changing their array contract', () => {
  const store = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
  assert.match(store, /function withReadStats\(arr, requested, unreadable\)/);
  assert.match(store, /enumerable: false/, 'metadata must not alter JSON/deep-equal/spread');
  // Every skip site increments the counter rather than swallowing.
  const code = store.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/catch \{ \/\* skip unreadable/.test(code), 'no silent per-day skip may remain');
  assert.ok((code.match(/unreadable\+\+/g) || []).length >= 18, 'both throw and !res.ok paths count');
});

test('every reader that counts losses also declares its counter', () => {
  // node --check does NOT catch a ReferenceError, so an undeclared counter would ship
  // green and throw only in production. This is the guard for that.
  const store = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8').split('\n');
  const starts = store.map((l, i) => (/^(async )?function \w+/.test(l) ? i : -1)).filter(i => i >= 0);
  starts.push(store.length);
  const bad = [];
  for (let k = 0; k < starts.length - 1; k++) {
    const body = store.slice(starts[k], starts[k + 1]);
    if (body.some(l => l.includes('unreadable++')) && !body.some(l => l.includes('let unreadable = 0;'))) {
      bad.push(store[starts[k]].split('(')[0]);
    }
  }
  assert.deepEqual(bad, [], `undeclared counter would throw at runtime: ${bad.join(', ')}`);
});

test('a small transient loss still writes; a material loss does not', () => {
  // One flaky shard out of 250 days must not freeze the evidence record; a systematic
  // outage must not silently shrink it. Both halves are the point.
  assert.match(SRC, /const MAX_DAY_LOSS_RATE = 0\.02/);
  assert.match(SRC, /material: rate > MAX_DAY_LOSS_RATE/);
  assert.match(SRC, /const blocking = ledgerErrors\.filter\(e => !e\.partial \|\| e\.material\)/,
    'a hard failure always blocks; a partial blocks only when material');
});

test('an unknown loss count is not silently treated as zero', () => {
  // A reader that took a no-read path (no store token) reports `undefined`, which means
  // unknown — counting it as 0 would assert completeness that was never measured.
  assert.match(SRC, /Number\.isFinite\(res\.unreadable\) \? res\.unreadable : 0/);
  assert.match(SRC, /unknown, not\n\s*\/\/ zero/);
});
