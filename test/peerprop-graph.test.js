'use strict';
// PEER PROPAGATION — directed graph tests. The invariants that matter:
//   1. A genuine lead/lag relationship (B follows A by one session) produces an
//      A→B edge and NOT a B→A edge — direction is detected, not assumed.
//   2. Contemporaneous co-movement (same-day identical residuals) produces NO
//      directed edge — the antisymmetric gate rejects symmetric correlation,
//      which is the whole defense against relabeling beta as leadership.
//   3. Fisher-z shrinkage: the same raw correlation on a shorter sample yields a
//      strictly smaller shrunk edge — short windows cannot mint strong edges.
//   4. minObs is a hard floor — a thin pair simply has no edge.
//   5. reverseGraph is the falsification transform: every edge flips direction.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/peerprop/graph');
const { GRAPH_POLICY } = require('../lib/peerprop/config');

// Deterministic pseudo-noise (LCG) — no Math.random in tests either.
function noise(seed, n) {
  let s = seed >>> 0 || 1;
  const out = [];
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out.push((s / 4294967296 - 0.5) * 0.02); }
  return out;
}

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

function series(dts, vals) { return dts.map((date, i) => ({ date, residual: vals[i] })); }

const N = 160;
const DTS = dates(N);

function leaderFollowerPanel() {
  const a = noise(11, N);
  const cNoise = noise(22, N);
  const b = a.map((v, i) => (i >= 1 ? 0.8 * a[i - 1] : 0) + noise(33, N)[i] * 0.3);
  return {
    A: series(DTS, a),
    B: series(DTS, b),
    C: series(DTS, cNoise),
  };
}

test('a real one-session lead produces A→B and not B→A', () => {
  const seriesByTicker = leaderFollowerPanel();
  const graph = G.buildDirectedGraph({ seriesByTicker, groups: { 'Tech|large': ['A', 'B', 'C'] } });
  const ab = graph.edges.find(e => e.from === 'A' && e.to === 'B');
  assert.ok(ab, 'A→B edge must exist');
  assert.equal(ab.lag, 1);
  assert.ok(ab.leadCorr > 0.2, `lead corr should be strong, got ${ab.leadCorr}`);
  assert.ok(ab.antisym > 0, 'directional component must be positive');
  assert.ok(!graph.edges.find(e => e.from === 'B' && e.to === 'A'), 'no reverse edge');
});

test('contemporaneous co-movement yields NO directed edge (antisymmetric gate)', () => {
  const a = noise(44, N);
  const seriesByTicker = { X: series(DTS, a), Y: series(DTS, a.slice()) };   // identical same-day
  const graph = G.buildDirectedGraph({ seriesByTicker, groups: { 'Tech|large': ['X', 'Y'] } });
  assert.equal(graph.edges.length, 0, 'symmetric co-movement must not become leadership');
});

test('Fisher-z shrinkage: shorter sample → strictly smaller shrunk correlation', () => {
  const short = G.shrinkCorr(0.5, 30, GRAPH_POLICY.shrinkK);
  const long = G.shrinkCorr(0.5, 300, GRAPH_POLICY.shrinkK);
  assert.ok(Math.abs(short) < Math.abs(long));
  assert.ok(Math.abs(long) < 0.5, 'even a long sample shrinks toward zero');
  assert.equal(G.shrinkCorr(null, 100, 60), null);
});

test('minObs is a hard floor — thin pairs have no edge', () => {
  const seriesByTicker = leaderFollowerPanel();
  const thin = {};
  for (const [t, s] of Object.entries(seriesByTicker)) thin[t] = s.slice(-(GRAPH_POLICY.minObs - 5));
  const graph = G.buildDirectedGraph({ seriesByTicker: thin, groups: { 'Tech|large': ['A', 'B', 'C'] } });
  assert.equal(graph.edges.length, 0);
});

test('the MARKET group is never pairwise-estimated (all-to-all noise ban)', () => {
  const seriesByTicker = leaderFollowerPanel();
  const graph = G.buildDirectedGraph({ seriesByTicker, groups: { MARKET: ['A', 'B', 'C'] } });
  assert.equal(graph.stats.pairsEvaluated, 0);
  assert.equal(graph.edges.length, 0);
});

test('reverseGraph flips every edge — the falsification transform', () => {
  const seriesByTicker = leaderFollowerPanel();
  const graph = G.buildDirectedGraph({ seriesByTicker, groups: { 'Tech|large': ['A', 'B', 'C'] } });
  assert.ok(graph.edges.length >= 1);
  const rev = G.reverseGraph(graph);
  assert.equal(rev.reversed, true);
  for (const e of graph.edges) {
    assert.ok(rev.edges.find(r => r.from === e.to && r.to === e.from), `edge ${e.from}→${e.to} must flip`);
  }
  // The follower index must follow the flipped direction too.
  assert.ok(rev.byFollower.A && rev.byFollower.A.find(e => e.from === 'B'));
});

test('graph estimation is deterministic — identical inputs, identical output', () => {
  const p1 = G.buildDirectedGraph({ seriesByTicker: leaderFollowerPanel(), groups: { 'Tech|large': ['A', 'B', 'C'] } });
  const p2 = G.buildDirectedGraph({ seriesByTicker: leaderFollowerPanel(), groups: { 'Tech|large': ['A', 'B', 'C'] } });
  assert.equal(JSON.stringify(p1), JSON.stringify(p2));
});
