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

test('costTierFor: UNKNOWN dollar-volume assumes the CONSERVATIVE tier, never the cheapest', () => {
  // CONTRACT CHANGE (predictive-redesign, defect #13): the old rule assumed 'liquid' for a
  // missing feed, so unknown-liquidity names paid the SMALLEST modeled friction and
  // out-ranked measured peers — missing data as a favorable assumption. Unknown now takes
  // the documented conservative middle tier, flagged `assumed` so the UI never implies a
  // measurement, and the eligibility layer separately refuses to size such names.
  const t = C.costTierFor({ liquidity: { price: 40 } });
  assert.strictEqual(t.tier, 'small');
  assert.strictEqual(t.assumed, true);
  assert.match(t.basis, /conservative/i);
});

test('costTierFor: no liquidity block at all still degrades safely (conservative, flagged)', () => {
  const t = C.costTierFor({});
  assert.strictEqual(t.tier, 'small');
  assert.strictEqual(t.assumed, true);
});

test('costTierFor: unknown liquidity can never be the cheapest tier while a measured-liquid peer exists', () => {
  const unknown = C.costTierFor({ liquidity: { price: 40 } });
  const measured = C.costTierFor({ liquidity: { dollarVol: 5e7 } });
  const { roundTripCostPct } = require('../lib/costs');
  assert.ok(roundTripCostPct(unknown.tier) > roundTripCostPct(measured.tier),
    'unknown pays strictly more modeled friction than measured-liquid');
});

// ── the cost model ──────────────────────────────────────────────────────────
test('costModel: charges the round trip against the trade OWN target move — on the FILL basis', () => {
  // BASIS CHANGE (audit 2026-08-14, entry-basis fix): entry 100 → target 110 is a 10%
  // move off the PRINTED level, but the graded contract (strategy-contracts fillPolicy
  // next-session-open, apex-routes entry-v2.2) fills at the next open — exec-v1 models
  // that as printed level + adverse entry-side slippage. Liquid slip = 0.08%, so the
  // expected fill is 100.08 and the gross move charged is (110−100.08)/100.08 = 9.91%.
  const m = C.costModel({ entry: 100, target: 110, liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(m.known, true);
  assert.strictEqual(m.grossMovePct, 9.91);
  assert.strictEqual(m.grossMovePrintedPct, 10, 'the printed-level move stays auditable');
  assert.strictEqual(m.roundTripPct, roundTripCostPct('liquid'));
  assert.strictEqual(m.netMovePct, +(9.91 - roundTripCostPct("liquid")).toFixed(2));
  // Cost is a trivial share of a ~10% move → penalty barely below 1.
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
  // Fill basis: a short's adverse entry fill is BELOW the print (sells down) — 99.92 on
  // the liquid tier — so the 10% printed move is a 9.93% expected move from the fill.
  const short = C.costModel({ entry: 100, target: 90, side: 'short', liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(short.grossMovePrintedPct, 10, 'a short target below entry is still a 10% printed move');
  assert.strictEqual(short.grossMovePct, 9.93, 'fill-adjusted: (99.92−90)/99.92');
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

// ── ENTRY BASIS (audit 2026-08-14) ──────────────────────────────────────────
// THE DEFECT: the live board's cost/net-EV waterfall priced off the PUBLISHED entry
// (screener Breakout = signal-day close; Early/Setup = pivot stop-entry), but the strategy
// contract (fillPolicy next-session-open) and the grading path (apex-routes entry-v2.2)
// grade the track record from next-open fills. exec-v1 (lib/execution-policy) is the
// canonical fill model: the achievable fill sits an adverse entry-side slippage leg beyond
// the printed level. The decision math must price the expected FILL, not the print — and
// the correction may only SHRINK the expected net move, never flatter it.
const { EXECUTION_POLICY_VERSION, perSideSlippagePct } = require('../lib/execution-policy');

test('ENTRY BASIS: the fill adjustment reuses exec-v1 per-side slippage — one source of friction truth', () => {
  const adj = C.entryAdjustmentFor({ entry: 100, target: 110, liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(adj.adjusted, true);
  assert.strictEqual(adj.slippagePct, perSideSlippagePct('liquid'));
  assert.strictEqual(adj.execModel, EXECUTION_POLICY_VERSION);
});

test('REGRESSION: the net expected move SHRINKS vs the printed-level computation (long, quantified)', () => {
  // Representative screener-style long: entry 100 → target 110, measured-liquid.
  // OLD (printed-level) basis: gross 10.00%, net 10.00 − 0.16 = 9.84%.
  // NEW (fill) basis: fill = 100 × (1 + 0.0008) = 100.08 → gross 9.91%, net 9.75%.
  const m = C.costModel({ source: 'screener', section: 'screener', entry: 100, target: 110, liquidity: { dollarVol: 5e8 } });
  const oldNet = +(10 - m.roundTripPct).toFixed(2);
  assert.strictEqual(oldNet, 9.84);
  assert.strictEqual(m.netMovePct, 9.75, 'fill-adjusted net');
  assert.ok(m.netMovePct < oldNet, `net must shrink: ${m.netMovePct} vs printed-basis ${oldNet}`);
  assert.strictEqual(+(oldNet - m.netMovePct).toFixed(2), 0.09, 'the haircut is ~0.09pp on a liquid 10% target');
});

test('CONSERVATIVE INVARIANT: the fill adjustment can only shrink the expected move, never flatter it', () => {
  const cases = [
    { entry: 100, target: 110, liquidity: { dollarVol: 5e8 } },          // liquid long
    { entry: 100, target: 90, side: 'short', liquidity: { dollarVol: 5e8 } }, // liquid short
    { entry: 30.2, target: 34, liquidity: { dollarVol: 5e6 } },          // small long
    { entry: 8.35, target: 9.6, liquidity: { dollarVol: 3e5 } },         // micro long
    { entry: 50, target: 49, side: 'short', liquidity: { dollarVol: 3e5 } }, // micro short
    { entry: 20, target: 20.1, liquidity: { price: 20 } },               // unknown tier, thin move
    { section: 'Biotech', entry: 40, target: 48, liquidity: { dollarVol: 1e7 } },
  ];
  for (const sig of cases) {
    const m = C.costModel(sig);
    assert.strictEqual(m.known, true);
    assert.ok(m.grossMovePct <= m.grossMovePrintedPct,
      `fill basis must never exceed the printed basis: ${JSON.stringify(sig)} → ${m.grossMovePct} vs ${m.grossMovePrintedPct}`);
  }
});

test('ENTRY BASIS: a move fully eaten by the entry leg is 0 (charged), never null (neutral)', () => {
  // micro slip = 0.75%; a 0.5% printed move is gone before the round trip is even charged.
  // Returning null here would mean known:false → penalty 1 — missing move as a favorable
  // assumption, the exact failure class this codebase bans.
  const m = C.costModel({ entry: 100, target: 100.5, liquidity: { dollarVol: 3e5 } });
  assert.strictEqual(m.known, true);
  assert.strictEqual(m.grossMovePct, 0);
  assert.ok(m.netMovePct < 0, 'net is the full round trip underwater');
  assert.strictEqual(m.penalty, C.MAX_COST_DRAG_FLOOR);
});

test('BASIS STAMP: the cost payload is self-describing about which basis the decision used', () => {
  const m = C.costModel({ entry: 100, target: 110, liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(m.entryBasis, 'next-open+slippage');
  assert.strictEqual(m.execModel, EXECUTION_POLICY_VERSION);
  assert.strictEqual(m.basis, `next-open+slippage (${EXECUTION_POLICY_VERSION})`);
  assert.strictEqual(m.entrySlippagePct, +(perSideSlippagePct('liquid') * 100).toFixed(3));
  // A lead with no target still says which basis WOULD apply — audits never guess.
  const lead = C.costModel({ entry: 100, liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(lead.known, false);
  assert.strictEqual(lead.entryBasis, 'next-open+slippage');
  assert.strictEqual(lead.execModel, EXECUTION_POLICY_VERSION);
});

test('DAY TRADE FROZEN: the daytrade section keeps the published-level basis (grading is pinned to legacy)', () => {
  // apex-routes entryBasisForSection returns null for daytrade — its displayed record is
  // contractually frozen on the logged entry, so the decision basis must match IT, not
  // the next-open contract the other sections grade on.
  const m = C.costModel({ section: 'daytrade', source: 'daytrade', entry: 100, target: 110, liquidity: { dollarVol: 5e8 } });
  assert.strictEqual(m.grossMovePct, 10, 'printed-level move, exactly as before the basis fix');
  assert.strictEqual(m.netMovePct, +(10 - m.roundTripPct).toFixed(2));
  assert.strictEqual(m.entryBasis, 'published-level');
  assert.strictEqual(m.execModel, null);
  assert.match(m.basis, /published-level/);
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
