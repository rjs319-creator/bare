'use strict';
// COST-SHARE WORST-CASE SENTINEL (review finding #9, 2026-08-15).
//
// THE DEFECT: when the printed move was fully eaten by the entry-slippage leg
// (grossMovePct clamps to 0), costModel returned `known:true, costShare:null`.
// Both rankers treat a non-numeric costShare as MISSING — the factor is excluded
// and the weights renormalize over the remaining features — so the WORST-cost
// trade on the board ranked strictly BETTER on cost-efficiency than a moderately
// costly one. Missing-data-as-favorable-assumption, exactly where costs matter most.
//
// THE CONTRACT: on the known path costShare ∈ [0,1] and SATURATES at 1 whenever
// round-trip cost meets or exceeds the move (including the fully-eaten clamp-to-0
// case). null costShare is reserved for known:false (no target to charge against).
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/decision-costs');
const { FEATURES, rankCrossSection } = require('../lib/challenger-rank');
const OE = require('../lib/omega-ensemble');

// micro tier (dollarVol 3e5): slippage 0.75% per side eats a 0.5% printed move whole.
const fullyEaten = () => C.costModel({ entry: 100, target: 100.5, liquidity: { dollarVol: 3e5 } });
// liquid tier chasing 2×-cost move: costShare 0.5, a genuinely moderate cost burden.
const halfEaten = () => C.costModel({ entry: 100, target: 100.4004, liquidity: { dollarVol: 5e8 } });

// ── the source ──────────────────────────────────────────────────────────────
test('fully-eaten move: costShare is the worst-case sentinel 1, never null on the known path', () => {
  // Arrange/Act
  const m = fullyEaten();
  // Assert
  assert.strictEqual(m.known, true);
  assert.strictEqual(m.grossMovePct, 0, 'the printed move is fully consumed by the entry leg');
  assert.strictEqual(m.costShare, 1, 'worst case = 100% of the move eaten, not MISSING');
  assert.strictEqual(m.penalty, C.MAX_COST_DRAG_FLOOR);
});

test('costShare saturates at 1 when the round trip exceeds a nonzero move', () => {
  // micro round trip 1.5% against a ~0.25% surviving move: share would be ~6 uncapped.
  const m = C.costModel({ entry: 100, target: 101, liquidity: { dollarVol: 3e5 } });
  assert.strictEqual(m.known, true);
  assert.ok(m.grossMovePct > 0, 'this move survives the entry leg');
  assert.strictEqual(m.costShare, 1, 'costShare ∈ [0,1] — saturation, not an unbounded ratio');
});

test('costShare stays a true ratio below saturation and null remains exclusive to known:false', () => {
  const half = halfEaten();
  assert.ok(half.costShare > 0.4 && half.costShare < 0.6, `expected ~0.5, got ${half.costShare}`);
  const lead = C.costModel({ entry: 100, liquidity: { dollarVol: 5e8 } }); // no target
  assert.strictEqual(lead.known, false);
  assert.strictEqual(lead.costShare, null);
});

// ── consumer: challenger-rank costEff factor ────────────────────────────────
test('challenger-rank: a fully-eaten move scores the WORST cost factor (0), strictly worse than half-eaten', () => {
  // Arrange
  const costEff = FEATURES.find((f) => f.key === 'costEff');
  const worst = { cost: fullyEaten() };
  const middling = { cost: halfEaten() };
  // Act
  const worstRaw = costEff.get(worst);
  const middlingRaw = costEff.get(middling);
  // Assert — the factor is PRESENT (never excluded/renormalized away) and floored.
  assert.strictEqual(worstRaw, 0, 'clamp01(1 - 1) = 0, the worst possible cost-efficiency');
  assert.ok(middlingRaw > worstRaw, `half-eaten (${middlingRaw}) must beat fully-eaten (${worstRaw})`);
});

test('challenger-rank cross-section: fully-eaten is ranked below half-eaten on costEff, not flagged missing', () => {
  // Arrange
  const sigs = [
    { ticker: 'WORST', cost: fullyEaten() },
    { ticker: 'MID', cost: halfEaten() },
  ];
  // Act
  const ranked = rankCrossSection(sigs, { asOf: '2026-08-15T00:00:00.000Z' });
  const worst = ranked[0].challengerRank;
  const mid = ranked[1].challengerRank;
  // Assert
  assert.ok(!worst.missingFlags.includes('costEff'), 'worst-case cost is a MEASUREMENT, not missing data');
  assert.strictEqual(worst.features.costEff.raw, 0);
  assert.ok(worst.features.costEff.norm < mid.features.costEff.norm,
    'the fully-eaten name must sit strictly below the half-eaten one on the cost column');
});

// ── consumer: omega-ensemble cost passthrough ───────────────────────────────
test('omega-ensemble: the worst-case sentinel survives the view mapping as numeric 1', () => {
  // Arrange — minimal op=today shape with one selected row carrying the fully-eaten cost.
  const t = {
    ok: true, generatedAt: '2026-08-15T13:00:00.000Z',
    portfolio: { selected: [{ portfolioRank: 1, ticker: 'EATN', score: 50, cost: fullyEaten() }], excluded: [] },
  };
  // Act
  const v = OE.buildEnsembleView({ today: t });
  // Assert
  assert.strictEqual(v.ranking[0].cost.known, true);
  assert.strictEqual(v.ranking[0].cost.costShare, 1, 'num(1) must pass through, never fold to null');
});
