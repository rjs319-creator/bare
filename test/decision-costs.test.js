const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/decision-costs');
const { roundTripCostPct } = require('../lib/costs');

// ── tier classification ─────────────────────────────────────────────────────
test('costTierFor: deep dollar-volume is the liquid tier', () => {
  const t = C.costTierFor({ liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(t.tier, 'liquid');
  assert.strictEqual(t.assumed, false);
});

test('costTierFor: mid dollar-volume is the small tier', () => {
  assert.strictEqual(C.costTierFor({ liquidity: { dollarVol: 5e6 } }).tier, 'small');
});

test('costTierFor: thin dollar-volume is the micro tier', () => {
  assert.strictEqual(C.costTierFor({ liquidity: { dollarVol: 3e5 } }).tier, 'micro');
});

test('costTierFor: a biotech section overrides the dollar-volume tier', () => {
  const t = C.costTierFor({ section: 'Biotech', liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(t.tier, 'biotech');
});

test('costTierFor: UNKNOWN dollar-volume assumes the CHEAPEST tier, never the worst', () => {
  // A missing feed must never bury a name — same philosophy as executionQuality's
  // "unknown is neutral, not thin". We charge the cheapest defensible cost and flag it.
  const t = C.costTierFor({ liquidity: { price: 40 } });
  assert.strictEqual(t.tier, 'liquid');
  assert.strictEqual(t.assumed, true);
});

test('costTierFor: no liquidity block at all still degrades safely', () => {
  const t = C.costTierFor({});
  assert.strictEqual(t.tier, 'liquid');
  assert.strictEqual(t.assumed, true);
});

// ── the cost model ──────────────────────────────────────────────────────────
test('costModel: charges the round trip against the trade OWN target move', () => {
  // entry 100 → target 110 = a 10% gross move. Liquid round trip = 0.16%.
  const m = C.costModel({ entry: 100, target: 110, liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(m.known, true);
  assert.strictEqual(m.grossMovePct, 10);
  assert.strictEqual(m.roundTripPct, roundTripCostPct('liquid'));
  assert.strictEqual(m.netMovePct, +(10 - roundTripCostPct('liquid')).toFixed(2));
  // Cost is a trivial share of a 10% move → penalty barely below 1.
  assert.ok(m.penalty > 0.98, `expected a light penalty, got ${m.penalty}`);
});

test('costModel: a micro-cap scalp is punished far harder than a liquid swing', () => {
  // Same 3% target; one is liquid, one is micro (1.5% round trip).
  const liquid = C.costModel({ entry: 100, target: 103, liquidity: { dollarVol: 5e8 } });
  const micro = C.costModel({ entry: 100, target: 103, liquidity: { dollarVol: 3e5 } });
  assert.ok(micro.penalty < liquid.penalty, 'micro must carry the bigger drag');
  assert.ok(micro.costShare > liquid.costShare * 5, 'micro round trip dwarfs the liquid one');
});

test('costModel: when the round trip EXCEEDS the target move, the penalty floors', () => {
  // micro round trip 1.5% vs a 1% target = the trade cannot pay for itself.
  const m = C.costModel({ entry: 100, target: 101, liquidity: { dollarVol: 3e5 } });
  assert.ok(m.costShare > 1, 'cost should exceed the whole move');
  assert.ok(m.netMovePct < 0, 'net expected move is negative');
  assert.strictEqual(m.penalty, C.MAX_COST_DRAG_FLOOR);
});

test('costModel: no target ⇒ UNKNOWN ⇒ neutral penalty (never a guess)', () => {
  const m = C.costModel({ entry: 100, liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(m.known, false);
  assert.strictEqual(m.penalty, 1);
});

test('costModel: a zero or inverted move degrades to neutral rather than dividing by zero', () => {
  assert.strictEqual(C.costModel({ entry: 100, target: 100 }).penalty, 1);
  assert.strictEqual(C.costModel({ entry: 100, target: 100 }).known, false);
});

test('costModel: shorts are charged the same round trip as longs', () => {
  const short = C.costModel({ entry: 100, target: 90, side: 'short', liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(short.grossMovePct, 10, 'a short target below entry is still a 10% move');
  assert.ok(short.penalty > 0.98);
});

test('costModel: carries the version + tier label for an auditable waterfall', () => {
  const m = C.costModel({ entry: 100, target: 110, liquidity: { dollarVol: 3e5 } });
  assert.ok(m.modelVersion, 'must state which cost model produced this');
  assert.strictEqual(m.tier, 'micro');
  assert.ok(typeof m.tierLabel === 'string' && m.tierLabel.length > 0);
});

test('costModel: the waterfall reconciles — gross − cost === net', () => {
  const m = C.costModel({ entry: 50, target: 56, liquidity: { dollarVol: 4e6 } });
  assert.strictEqual(+(m.grossMovePct - m.roundTripPct).toFixed(2), m.netMovePct);
});

// ── THE BINDING PROOFS ──────────────────────────────────────────────────────
// The whole point of this module. PR #109 shipped a measurement that corrected nothing
// because it never reached the composite; these tests fail if that regresses here.
const D = require('../lib/decision');

// Two signals identical in EVERY ranking input except liquidity, both chasing the same
// thin 2% target. Only the cost model can tell them apart.
const scalp = (ticker, dollarVol) => D.makeSignal({
  ticker, source: 'daytrade', horizon: 'intraday',
  entry: 100, stop: 98, target: 102, price: 100,
  rawConfidence: 80,
  // Hold executionQuality constant: both are above the good-dollar-volume line for the
  // liquidity penalty, so any rank difference is COST, not the pre-existing liquidity read.
  liquidity: { dollarVol, price: 100 },
}).signal;

test('BINDING: cost demotes a costly name below an identical cheap one', () => {
  // 2.5e7 → liquid tier; but we force the micro tier via a biotech-free thin name below.
  const cheap = D.rankSignals([scalp('CHEAP', 5e8)], {})[0];
  const dear = D.rankSignals([scalp('DEAR', 3e5)], {})[0];
  assert.ok(dear.score < cheap.score,
    `costly name must rank lower: dear=${dear.score} cheap=${cheap.score}`);
});

test('BINDING: the demotion is the cost model, not the liquidity penalty', () => {
  const dear = D.rankSignals([scalp('DEAR', 3e5)], {})[0];
  // Sanity: if this ever equals 1, the cost factor has stopped binding.
  assert.ok(dear.cost.penalty < 1, 'a micro-cap 2% target must carry a real cost drag');
  assert.strictEqual(dear.cost.tier, 'micro');
  assert.strictEqual(dear.cost.known, true);
});

test('BINDING: rankSignals attaches an auditable cost waterfall to every signal', () => {
  const [s] = D.rankSignals([scalp('X', 5e8)], {});
  assert.ok(s.cost, 'every ranked signal carries its cost object');
  assert.strictEqual(s.cost.grossMovePct, 2);
  assert.ok(s.cost.modelVersion);
});

test('SAFETY: a signal with no target ranks EXACTLY as it did before costs bound', () => {
  // The regression guard — mirrors the redundancy engine's byte-identical fallback.
  const lead = D.makeSignal({
    ticker: 'LEAD', source: 'biotech', horizon: 'position', price: 20, rawConfidence: 70,
  }).signal;
  const [ranked] = D.rankSignals([lead], {});
  assert.strictEqual(ranked.cost.penalty, 1, 'unknown cost must be neutral');
  const expected = D.compositeScore({
    confidence: ranked.confidence, regimeFit: ranked.regimeFit,
    execution: ranked.execution.quality, tilt: ranked.expectancyTilt,
    evidenceMult: ranked.evidenceMult,
    // no costPenalty argument at all = the pre-change call signature
  });
  assert.strictEqual(ranked.score, expected);
});

test('SAFETY: a fat swing target is essentially unaffected by the round trip', () => {
  const swing = D.makeSignal({
    ticker: 'FAT', source: 'coil', horizon: 'swing',
    entry: 100, stop: 92, target: 125, price: 100, rawConfidence: 70,
    liquidity: { dollarVol: 5e8, price: 100 },
  }).signal;
  const [r] = D.rankSignals([swing], {});
  assert.ok(r.cost.penalty > 0.99, 'a 25% target should barely notice a 0.16% round trip');
});
