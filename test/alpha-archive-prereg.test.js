// Locks the alpha-archive preregistration (PREREGISTRATION-ARCHIVE-STREAMS-2026-08.md):
// the five registry entries, the three sealed prospective holdouts, and the
// WRITE-ONLY property of the collectors (no outcome computation may creep into
// the collection path — that would be a peek at a sealed ledger).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const REG = require('../lib/research/hypothesis-registry');

const ARCHIVE_IDS = ['earnings-date-revision', 'gex-vol-damping', 'revision-cascade-velocity'];
const EXPLORATORY_IDS = ['overnight-share-conditioning', 'announcement-congestion'];
const HOLDOUT_IDS = ['calrev-prospective', 'gex-prospective', 'revcascade-prospective'];

test('all five alpha-archive hypotheses are registered and valid', () => {
  for (const id of [...ARCHIVE_IDS, ...EXPLORATORY_IDS]) {
    const h = REG.find(id);
    assert.ok(h, `${id} missing from registry`);
    const v = REG.validateHypothesis(h);
    assert.ok(v.valid, `${id} invalid: ${JSON.stringify(v.errors)}`);
  }
  // The three archive streams have no data yet — they must stay open.
  for (const id of ARCHIVE_IDS) assert.equal(REG.find(id).status, 'open', `${id} must be open (no data exists)`);
  // The two exploratory passes ran their one registered pass each on 2026-08-05 → honest nulls.
  assert.equal(REG.find('overnight-share-conditioning').status, 'no-edge');
  assert.equal(REG.find('announcement-congestion').status, 'no-edge');
});

test('the three archive-stream hypotheses are confirmatory; the panel passes are exploratory', () => {
  for (const id of ARCHIVE_IDS) assert.equal(REG.find(id).mode, 'confirmatory', id);
  for (const id of EXPLORATORY_IDS) assert.equal(REG.find(id).mode, 'exploratory', id);
});

test('stopping rules carry the frozen earliest-test conditions', () => {
  assert.match(REG.find('earnings-date-revision').stoppingRule, /2027-02-01/);
  assert.match(REG.find('earnings-date-revision').stoppingRule, /≥400/);
  assert.match(REG.find('gex-vol-damping').stoppingRule, /≥60 trading-day/);
  assert.match(REG.find('gex-vol-damping').stoppingRule, /≥300/);
  assert.match(REG.find('revision-cascade-velocity').stoppingRule, /≥500 initiating/);
});

test('the three prospective holdouts are sealed and untouched', () => {
  const untouched = new Set(REG.untouchedHoldouts().map(h => h.id));
  for (const id of HOLDOUT_IDS) assert.ok(untouched.has(id), `${id} must be sealed and untouched`);
});

test('registrations widen their family denominators (trial accounting)', () => {
  assert.ok(REG.familyTrials('event-drift') >= 2, 'event-drift must count date-revision + congestion');
  assert.ok(REG.familyTrials('volatility-structure') >= 2, 'volatility-structure must count gex');
  assert.ok(REG.familyTrials('alt-signals') >= 1, 'alt-signals must count cascade');
});

test('WRITE-ONLY collectors: no outcome machinery in the collection path', () => {
  // The collectors must never compute a drift/IC/correlation — that is a peek.
  // Locked structurally: neither module may import the outcome/drift machinery.
  for (const f of ['lib/alpha-archive.js', 'lib/alpha-archive-routes.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const banned of ['drift-eval', 'fetchDailyHistory', 'evalDrift', 'spearman', 'rankIC']) {
      assert.ok(!src.includes(banned), `${f} must not reference ${banned} (write-only collector)`);
    }
  }
});
