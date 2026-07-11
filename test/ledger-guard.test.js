const { test } = require('node:test');
const assert = require('node:assert');
const { ledgerWriteDecision } = require('../lib/apex-routes');

// A clean run (no source errors) always writes — even a genuinely quiet/empty day,
// so "nothing qualified today" is still honestly recorded.
test('clean run always writes, including an honest empty day', () => {
  assert.deepEqual(ledgerWriteDecision(0, 0, 5), { write: true });
  assert.deepEqual(ledgerWriteDecision(40, 0, 60), { write: true });
});

// A degraded run (a data-source threw) must not persist an empty snapshot — that
// would look like a legitimate zero-pick day and corrupt the ledger.
test('degraded + empty never writes', () => {
  const d = ledgerWriteDecision(0, 1, -1);
  assert.equal(d.write, false);
  assert.equal(d.reason, 'degraded-empty');
});

// A degraded run must not shrink a more complete existing snapshot.
test('degraded run that would shrink a complete day is blocked', () => {
  const d = ledgerWriteDecision(12, 2, 55);
  assert.equal(d.write, false);
  assert.equal(d.reason, 'degraded-shrink');
  assert.equal(d.existing, 55);
});

// A degraded run may still write if it is not empty and no smaller existing day
// exists (first run of the day, or it matches/exceeds what's stored).
test('degraded but non-empty writes when no larger existing day', () => {
  assert.deepEqual(ledgerWriteDecision(20, 1, -1), { write: true });   // no existing file
  assert.deepEqual(ledgerWriteDecision(30, 1, 30), { write: true });   // equal count
  assert.deepEqual(ledgerWriteDecision(40, 1, 25), { write: true });   // grew despite an error
});
