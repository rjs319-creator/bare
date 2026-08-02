'use strict';
// PEER PROPAGATION — feature tests. The invariants that matter:
//   1. Robust aggregation: one extreme peer cannot dominate the group median.
//   2. Minimum peer count: a group below minPeers yields NULL aggregates —
//      never a false-precision number from two names.
//   3. unreflectedPeerStrength is the spec's gap: strong peers + quiet own
//      reaction → large positive; the stock catching up shrinks it.
//   4. Stage precedence: LATE beats everything (chasing guard); EARLY requires
//      confirmed peers/leaders AND a quiet own reaction; missing data → INVALID.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/peerprop/features');

function dates(n) {
  const out = [];
  const d = new Date('2025-01-01T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const DTS = dates(120);
const flat = (level = 0) => DTS.map(date => ({ date, residual: level }));
// A series with a small alternating base (so vol > 0) plus a drift per day.
function drifty(drift, amp = 0.004) {
  return DTS.map((date, i) => ({ date, residual: drift + (i % 2 ? amp : -amp) }));
}

test('median aggregation: one extreme peer cannot dominate', () => {
  const peers = [drifty(0.002), drifty(0.002), drifty(0.002), drifty(0.002), drifty(0.5)];
  const agg = F.peerAggregates(peers);
  assert.ok(agg, 'five peers is enough');
  // The 21d median momentum must reflect the 0.002 majority, not the 0.5 outlier.
  assert.ok(agg.byHorizon[21].median < 0.1, `median ${agg.byHorizon[21].median} hijacked by outlier`);
});

test('below minPeers the aggregate is NULL — fail closed, not false precision', () => {
  assert.equal(F.peerAggregates([drifty(0.01), drifty(0.01)]), null);
  assert.equal(F.peerAggregates([]), null);
});

test('unreflectedPeerStrength: strong peers + quiet stock → positive gap; catching up shrinks it', () => {
  const strongPeers = [drifty(0.004), drifty(0.004), drifty(0.005), drifty(0.004), drifty(0.005)];
  const quiet = F.stockPeerFeatures({ ticker: 'Q', ownSeries: drifty(0), groupSeries: strongPeers });
  assert.ok(quiet.unreflectedPeerStrength > 0.5, `expected positive gap, got ${quiet.unreflectedPeerStrength}`);
  const caughtUp = F.stockPeerFeatures({ ticker: 'C', ownSeries: drifty(0.005), groupSeries: strongPeers });
  assert.ok(caughtUp.unreflectedPeerStrength < quiet.unreflectedPeerStrength, 'catching up must shrink the gap');
});

test('withinPeerPosition is a tie-aware percentile inside the group', () => {
  const peers = [drifty(0.001), drifty(0.002), drifty(0.003), drifty(0.004), drifty(0.005)];
  const top = F.stockPeerFeatures({ ticker: 'T', ownSeries: drifty(0.01), groupSeries: peers });
  const bottom = F.stockPeerFeatures({ ticker: 'B', ownSeries: drifty(-0.01), groupSeries: peers });
  assert.ok(top.withinPeerPosition > 0.9);
  assert.ok(bottom.withinPeerPosition < 0.1);
});

test('stage precedence: LATE (own move too large) beats a positive gap', () => {
  const s = F.classifyStage({ unreflected: 1.2, ownReactionZ: 0.3, ownMove21Pct: 12, leadersConfirming: 3, peerStrengthZ: 1, decay: 0.8, dataOk: true });
  assert.equal(s, 'LATE');
});

test('stage EARLY requires confirmation AND a quiet own reaction', () => {
  const early = F.classifyStage({ unreflected: 1.0, ownReactionZ: 0.2, ownMove21Pct: 1, leadersConfirming: 2, peerStrengthZ: 1, decay: 0.8, dataOk: true });
  assert.equal(early, 'EARLY');
  const noConfirm = F.classifyStage({ unreflected: 1.0, ownReactionZ: 0.2, ownMove21Pct: 1, leadersConfirming: 0, peerStrengthZ: 0.2, decay: 0.8, dataOk: true });
  assert.equal(noConfirm, 'NONE');
  const decayed = F.classifyStage({ unreflected: 1.0, ownReactionZ: 0.2, ownMove21Pct: 1, leadersConfirming: 2, peerStrengthZ: 1, decay: 0.1, dataOk: true });
  assert.notEqual(decayed, 'EARLY', 'an old impulse cannot be EARLY');
});

test('missing data basis → INVALID, and the bundle reports what is missing', () => {
  assert.equal(F.classifyStage({ dataOk: false }), 'INVALID');
  const f = F.stockPeerFeatures({ ticker: 'X', ownSeries: [], groupSeries: [] });
  assert.equal(f.stage, 'INVALID');
  assert.ok(f.missing.length >= 1);
  assert.equal(f.unreflectedPeerStrength, null);
});

test('leaderRead with no in-edges is a real state, not an error', () => {
  const lead = F.leaderRead({ ticker: 'Z', byFollower: {}, seriesByTicker: {} });
  assert.equal(lead.leaders, 0);
  assert.equal(lead.leaderPressure, null);
});

test('score is bounded 0..100 and deterministic', () => {
  const peers = [drifty(0.004), drifty(0.004), drifty(0.004), drifty(0.004), drifty(0.004)];
  const a = F.stockPeerFeatures({ ticker: 'A', ownSeries: drifty(0), groupSeries: peers });
  const b = F.stockPeerFeatures({ ticker: 'A', ownSeries: drifty(0), groupSeries: peers });
  assert.equal(a.score, b.score);
  assert.ok(a.score >= 0 && a.score <= 100);
});
