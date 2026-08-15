'use strict';
// Prevents: lookahead through the cutoff, infinite z on zero dispersion, thin history
// producing confident scores, peer adjustment silently degrading, and the attention
// score masquerading as expected return.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/tech-evidence/signals');

function syntheticPoints({ start = '2025-06-01', days = 440, jumpLastDays = 0, jumpFactor = 1.3, noise = true }) {
  const points = {};
  let d = start;
  for (let i = 0; i < days; i += 1) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    const weekend = dow === 0 || dow === 6;
    // deterministic pseudo-noise so MAD > 0 without Math.random
    const wobble = noise ? 1 + 0.06 * Math.sin(i * 1.7) : 1;
    let v = Math.round((weekend ? 4000 : 10000) * wobble);
    if (jumpLastDays && i >= days - jumpLastDays) v = Math.round(v * jumpFactor);
    points[d] = v;
    d = S.addDays(d, 1);
  }
  return { points, lastDay: S.addDays(start, days - 1) };
}

test('npm: a genuine adoption jump produces a positive surprise with finite z', () => {
  const { points, lastDay } = syntheticPoints({ jumpLastDays: 28 });
  const cutoff = S.addDays(lastDay, 1);
  const sig = S.npmSignal({ points }, cutoff);
  assert.equal(sig.available, true);
  assert.ok(sig.surprise > 0.1, `surprise should be strongly positive, got ${sig.surprise}`);
  assert.ok(Number.isFinite(sig.z) && sig.z > 1, `z should exceed 1, got ${sig.z}`);
  assert.equal(sig.quality, 'ok');
});

test('npm: the cutoff only sees days ≤ cutoff−1 (no lookahead)', () => {
  const { points, lastDay } = syntheticPoints({ jumpLastDays: 1, jumpFactor: 100 });
  // With the cutoff ON the jump day, the jump day itself (== cutoff) is invisible.
  const sig = S.npmSignal({ points }, lastDay);
  assert.equal(sig.available, true);
  assert.ok(Math.abs(sig.surprise) < 0.1, 'the same-day observation must not leak into the signal');
});

test('npm: zero dispersion yields z=null and quality low — never Infinity', () => {
  const { points, lastDay } = syntheticPoints({ noise: false });
  const sig = S.npmSignal({ points }, S.addDays(lastDay, 1));
  assert.equal(sig.z, null);
  assert.equal(sig.quality, 'low');
  assert.ok(sig.caveats.some(c => /MAD=0/.test(c)));
});

test('npm: insufficient history refuses to produce a signal', () => {
  const { points } = syntheticPoints({ days: 100 });
  const sig = S.npmSignal({ points }, '2025-09-15');
  assert.equal(sig.available, false);
  assert.match(sig.reason, /insufficient history/);
});

test('npm: a hole in the recent window degrades quality instead of silently scoring', () => {
  const { points, lastDay } = syntheticPoints({ jumpLastDays: 28 });
  const holed = { ...points };
  for (let i = 0; i < 6; i += 1) delete holed[S.addDays(lastDay, -i)];
  const sig = S.npmSignal({ points: holed }, S.addDays(lastDay, 1));
  if (sig.available) {
    assert.notEqual(sig.quality, 'ok', 'missing days must reduce quality');
  } else {
    assert.match(sig.reason, /incomplete/);
  }
});

test('github: span floor enforced; release cadence needs a year of history', () => {
  const releases = { '2026-07-01|v1': {}, '2026-08-01|v2': {} };
  const sig = S.githubSignal({ releases }, '2026-08-10');
  assert.equal(sig.available, false);
  assert.match(sig.reason, /spans/);
});

test('deriveArmSignals: peer adjustment needs ≥2 peers, degrades quality when absent, and eligibility follows |z|≥1 with ok quality', () => {
  const good = syntheticPoints({ jumpLastDays: 28 });
  const cutoff = S.addDays(good.lastDay, 1);
  const entries = [
    { ticker: 'AAA', entity: 'pkg-a', mappingId: 'a', mappingVersion: 2, bucket: { points: good.points } },
  ];
  const solo = S.deriveArmSignals('npm', entries, cutoff);
  assert.equal(solo.length, 1);
  assert.equal(solo[0].peerMedianSurprise, null);
  assert.equal(solo[0].quality, 'degraded', 'no peers → quality degraded');
  assert.equal(solo[0].eligible, false, 'degraded quality is never forward-ledger eligible');
  const flat1 = syntheticPoints({});
  const flat2 = syntheticPoints({});
  const trio = S.deriveArmSignals('npm', [
    ...entries,
    { ticker: 'BBB', entity: 'pkg-b', mappingId: 'b', mappingVersion: 2, bucket: { points: flat1.points } },
    { ticker: 'CCC', entity: 'pkg-c', mappingId: 'c', mappingVersion: 2, bucket: { points: flat2.points } },
  ], cutoff);
  const aaa = trio.find(s => s.ticker === 'AAA');
  assert.ok(aaa.peerMedianSurprise != null, 'two peers present → peer adjustment computed');
  assert.equal(aaa.quality, 'ok');
  assert.equal(aaa.eligible, true);
  assert.ok(aaa.adjustedSurprise > 0.05);
});

test('attentionScore is bounded 0..100 and null without a finite z', () => {
  const s = { available: true, z: 2.4, quality: 'ok' };
  const a = S.attentionScore(s, { monetizationWeight: 'high', ageDays: 0 });
  assert.ok(a >= 0 && a <= 100);
  assert.equal(S.attentionScore({ available: true, z: null, quality: 'low' }), null);
  assert.ok(S.attentionScore(s, { monetizationWeight: 'high', ageDays: 20 }) === 0, 'stale signals decay to zero attention');
});
