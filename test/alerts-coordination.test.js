'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const co = require('../lib/alerts-coordination');

const post = (id, acct, text, ts, extra = {}) => ({ postId: id, accountKey: acct, handle: acct, contentHash: extra.hash || null, text, publishedAt: ts, referencedDomains: extra.domains || [], media: extra.media || [], quotedPostId: extra.quoted || null });

test('copy/echo detection: near-identical text across accounts forms ONE cluster', () => {
  const posts = [
    post('1', 'x:a', '$ABCD to the moon huge breakout load up now', '2026-07-21T14:00:00Z'),
    post('2', 'x:b', '$ABCD to the moon huge breakout load up now!!', '2026-07-21T14:05:00Z'),
    post('3', 'x:c', '$ABCD to the moon huge breakout load up now', '2026-07-21T14:10:00Z'),
  ];
  const { clusters } = co.clusterPosts(posts);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].distinctAccounts, 3);
  assert.equal(clusters[0].coordinated, true);    // ≥3 accounts copying = coordinated
});

test('input-order invariance: reversing the post list yields the SAME partition and scores', () => {
  const posts = [
    post('1', 'x:a', '$XYZ breakout over 50 target 70', '2026-07-21T14:00:00Z'),
    post('2', 'x:b', '$XYZ breakout over 50 target 70', '2026-07-21T14:02:00Z'),
    post('3', 'x:c', 'totally different idea about $QQQ macro', '2026-07-21T15:00:00Z'),
  ];
  const a = co.clusterPosts(posts).clusters.map(c => ({ id: c.id, n: c.size, orig: c.originalKey }));
  const b = co.clusterPosts([...posts].reverse()).clusters.map(c => ({ id: c.id, n: c.size, orig: c.originalKey }));
  assert.deepEqual(a, b);
});

test('original of a copied cluster is the EARLIEST published, never arrival order', () => {
  const posts = [
    post('late', 'x:b', '$ABCD identical pump text here now', '2026-07-21T14:30:00Z'),
    post('early', 'x:a', '$ABCD identical pump text here now', '2026-07-21T14:00:00Z'),
  ];
  const { clusters } = co.clusterPosts(posts);
  assert.equal(clusters[0].originalKey, 'id:early');
  // reversing input does not change who is original
  assert.equal(co.clusterPosts([...posts].reverse()).clusters[0].originalKey, 'id:early');
});

test('shared media hash links a cluster even without identical text', () => {
  const posts = [
    post('1', 'x:a', 'chart looks great $AAA', '2026-07-21T14:00:00Z', { media: [{ hash: 'img9' }] }),
    post('2', 'x:b', 'my thoughts on $AAA today', '2026-07-21T14:20:00Z', { media: [{ hash: 'img9' }] }),
  ];
  assert.equal(co.clusterPosts(posts).clusters.length, 1);
});

test('saturating aggregation is bounded and concave — NOT the old quadratic inflation', () => {
  const one = co.saturatingConfirmation([{ skillWeight: 0.5 }]);
  const five = co.saturatingConfirmation(Array(5).fill({ skillWeight: 0.5 }));
  const fifty = co.saturatingConfirmation(Array(50).fill({ skillWeight: 0.5 }));
  assert.ok(five.confirmation > one.confirmation);              // more sources help…
  assert.ok(five.confirmation - one.confirmation > fifty.confirmation - five.confirmation); // …with diminishing returns
  assert.ok(fifty.confirmation <= co.CFG.socialCap + 1e-9);     // hard cap
});

test('coordinated clusters are EXCLUDED from follow confirmation by default (kept for grading elsewhere)', () => {
  const withCoord = co.saturatingConfirmation([{ skillWeight: 0.5, coordinated: true }]);
  assert.equal(withCoord.confirmation, 0);
  assert.equal(withCoord.clustersCounted, 0);
});

test('per-source contribution is capped so one loud source cannot dominate', () => {
  assert.ok(co.sourceContribution(1) <= co.CFG.sourceCap + 1e-9);
  assert.ok(co.sourceContribution(0) < co.sourceContribution(1));   // proven skill contributes more, still capped
});
