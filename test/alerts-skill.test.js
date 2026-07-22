'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sk = require('../lib/alerts-skill');

// Build n graded episodes for one account with a given per-episode excess and distinct dates.
function episodes(accountKey, excessArr, { side = 'long', horizon = 'swing', setup = 'breakout', startDay = 1 } = {}) {
  return excessArr.map((x, i) => ({ accountKey, identityKnown: true, date: `2026-0${1 + ((startDay + i) % 9)}-${String(1 + ((startDay + i) % 27)).padStart(2, '0')}`, side, horizon, setupClass: setup, excess: x, mfe: Math.max(0, x), mae: Math.min(0, x), rMultiple: x / 2 }));
}

test('cold-start / unknown account gets NO track-record bonus', () => {
  const model = sk.buildSkillModel(episodes('x:a', [1, 2, 3]));   // only 3 episodes < 30 floor
  const rec = sk.skillFor(model, 'x:a');
  assert.equal(rec.state, 'UNKNOWN');
  assert.equal(rec.skillWeight, 0);
  assert.equal(rec.accountPoints, 0);
});

test('a small lucky sample does NOT earn an extreme weight', () => {
  const model = sk.buildSkillModel(episodes('x:lucky', Array(5).fill(9)));  // 5-for-5 huge wins
  assert.equal(sk.skillFor(model, 'x:lucky').skillWeight, 0);              // still UNKNOWN < 30
});

test('account skill weight is capped (never exceeds MAX_ACCOUNT_POINTS)', () => {
  // A large, strongly positive, well-dated, multi-context record.
  const big = [
    ...episodes('x:pro', Array(80).fill(3), { side: 'long', setup: 'breakout' }),
    ...episodes('x:pro', Array(80).fill(3), { side: 'short', setup: 'squeeze', startDay: 3 }),
  ];
  const model = sk.buildSkillModel(big);
  const rec = sk.skillFor(model, 'x:pro');
  assert.ok(rec.accountPoints <= sk.MAX_ACCOUNT_POINTS + 1e-9);
});

test('partial pooling: a thin context shrinks toward the account global, not its raw rate', () => {
  const rows = [
    ...episodes('x:p', Array(60).fill(-1), { setup: 'breakout' }),  // mostly losing globally
    ...episodes('x:p', Array(3).fill(5), { setup: 'fda', startDay: 2 }), // tiny 3-for-3 winning context
  ];
  const model = sk.buildSkillModel(rows);
  const ctx = model.byAccount['x:p'].contexts['long|swing|fda'];
  assert.ok(ctx.pooledRate < 0.9);   // shrunk well below the raw 100% of the tiny context
});

test('drift demotion: a once-strong account with negative recent evidence is DEGRADING', () => {
  const rows = [
    ...episodes('x:d', Array(90).fill(2)),                        // long strong history
    ...episodes('x:d', Array(40).fill(-3), { startDay: 5 }),      // recent deterioration
  ];
  const model = sk.buildSkillModel(rows);
  const st = model.byAccount['x:d'].state;
  assert.ok(st === 'DEGRADING' || st === 'PROVISIONAL' || st === 'REJECTED');
  assert.ok(model.byAccount['x:d'].skillWeight < 0.7);
});

test('persistent negative net evidence with a real sample is REJECTED (zero weight)', () => {
  const model = sk.buildSkillModel(episodes('x:bad', Array(90).fill(-2)));
  assert.equal(model.byAccount['x:bad'].state, 'REJECTED');
  assert.equal(model.byAccount['x:bad'].skillWeight, 0);
});

test('multiple-testing deflation: the deflated lower bound is stricter than the plain one', () => {
  const wins = 40, n = 60;
  const plain = sk.deflatedLowerBound(wins, n, 2);
  const many = sk.deflatedLowerBound(wins, n, 500);   // best of many accounts
  assert.ok(many < plain);
});

test('unknown accounts do not share a record — each account key is separate', () => {
  const model = sk.buildSkillModel([...episodes('x:a', [1, 2]), ...episodes('x:b', [3, 4])]);
  assert.ok(model.byAccount['x:a']);
  assert.ok(model.byAccount['x:b']);
  assert.notEqual(model.byAccount['x:a'], model.byAccount['x:b']);
});
