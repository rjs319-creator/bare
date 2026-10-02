'use strict';
// op=rlt served 5.2 MB (site audit 2026-10-02 #8); 3.9 MB of it were build/grader internals the
// RLT lab never reads. The default response omits them (named), `&full=1` restores them, and the
// lab's own source is pinned to the fields that remain.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { slimRltBoard, RLT_SLIM_OMIT } = require('../lib/rlt-routes');

const BOARD = {
  ok: true, mode: 'shadow', honesty: 'h', counts: { inventory: 3, abstained: 1 }, coverage: { eligible: 3, total: 5 },
  inventory: [{ ticker: 'AAA', state: 'ARMED' }], sectorLeadership: { leading: ['Tech'] }, byState: {},
  episodes: { sections: { big: new Array(1000).fill({ x: 1 }) } }, graded: new Array(200).fill({ g: 1 }),
  states: { AAA: 'ARMED' }, transitions: [{ t: 1 }], leadershipSnapshot: { s: 1 },
};

test('the slim board keeps every field the lab renders and names what it omitted', () => {
  const slim = slimRltBoard(BOARD);
  for (const k of ['ok', 'mode', 'honesty', 'counts', 'coverage', 'inventory', 'sectorLeadership', 'byState']) assert.deepEqual(slim[k], BOARD[k]);
  for (const k of RLT_SLIM_OMIT) assert.equal(k in slim, false, `${k} should be omitted`);
  assert.equal(slim.slim, true);
  assert.deepEqual(slim.omitted, [...RLT_SLIM_OMIT]);
  assert.match(slim.fullPayload, /full=1/);
  assert.ok(JSON.stringify(slim).length < JSON.stringify(BOARD).length / 4);
  // Pure: the input is not mutated.
  assert.ok('episodes' in BOARD);
});

test('slimRltBoard passes non-objects through (error envelopes are untouched)', () => {
  assert.equal(slimRltBoard(null), null);
});

test('the lab only reads fields the slim payload carries', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rlt-lab.js'), 'utf8');
  for (const k of RLT_SLIM_OMIT) assert.doesNotMatch(src, new RegExp(`\\bd\\.${k}\\b`), `rlt-lab.js reads d.${k}, which the default op=rlt no longer carries`);
  assert.match(src, /op=rlt'/);
});
