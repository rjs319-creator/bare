'use strict';
// OPTIONS FALSE-POSITIVE HYPOTHESES + CONTRACT-LEVEL EXECUTION + VOLATILITY CONTEXT.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const h = require('../lib/options-hypotheses-v2');
const e = require('../lib/options-execution-v2');

const NOW = Date.parse('2026-08-13T18:00:00Z');
const secAgo = s => (NOW - s * 1000) / 1000;

const goodContract = (o = {}) => ({
  side: 'call', strike: 110, expiry: '2026-09-18', dte: 36,
  volume: 5000, openInterest: 20000,
  bid: 2.00, ask: 2.10, lastPrice: 2.08, lastTradeTs: secAgo(600),
  estNotional: 1e6, underlying: 100, ...o,
});

// ── The catalogue is complete ───────────────────────────────────────────────

test('LEDGER: every benign explanation the mission enumerates is catalogued', () => {
  const ids = h.CATALOG.map(c => c.id).sort();
  assert.deepEqual(ids, ['closing', 'corpAction', 'eventVol', 'hedge', 'overwrite', 'roll', 'spread', 'staleQuote']);
  for (const c of h.CATALOG) {
    assert.ok(c.statement && c.statement.length > 20);
    assert.ok(c.requires && c.requires.length > 10, 'each hypothesis must state what data would decide it');
  }
});

test('LEDGER: every hypothesis is reported on every event with a verdict and evidence', () => {
  const L = h.buildHypotheses({ contracts: [goodContract()], nowMs: NOW });
  assert.equal(L.hypotheses.length, h.CATALOG.length);
  for (const x of L.hypotheses) {
    assert.ok(Object.values(h.VERDICT).includes(x.verdict));
    assert.ok(Array.isArray(x.evidence) && x.evidence.length, `${x.id} must carry evidence for its verdict`);
  }
});

// ── UNRESOLVED is not clear ─────────────────────────────────────────────────

test('LEDGER: only actively REFUTED hypotheses count as ruled out', () => {
  const L = h.buildHypotheses({ contracts: [goodContract()], nowMs: NOW });
  const refuted = L.hypotheses.filter(x => x.verdict === h.VERDICT.REFUTED).length;
  assert.equal(L.refutedFraction, +(refuted / L.hypotheses.length).toFixed(3));
  assert.ok(L.counts.unresolved + L.counts.notTestable > 0);
  assert.match(L.caveat, /Unresolved is NOT clear|actively SUPPORTED/);
});

test('LEDGER: an unresolvable hypothesis names the capability that would decide it', () => {
  const L = h.buildHypotheses({ contracts: [goodContract()], capabilities: {}, nowMs: NOW });
  const overwrite = L.hypotheses.find(x => x.id === 'overwrite');
  assert.equal(overwrite.verdict, h.VERDICT.NOT_TESTABLE);
  assert.match(overwrite.evidence.join(' '), /BOUGHT or WRITTEN/i);
  assert.match(overwrite.requires, /aggressor/i);
});

// ── Individual hypotheses ───────────────────────────────────────────────────

test('CLOSING: next-session open-interest change is what actually decides it', () => {
  const contracts = [goodContract({ volume: 5000, openInterest: 200 })];
  const rose = h.buildHypotheses({ contracts, nowMs: NOW, oiChange: { A: 400, B: 300 } });
  assert.equal(rose.hypotheses.find(x => x.id === 'closing').verdict, h.VERDICT.REFUTED);
  const fell = h.buildHypotheses({ contracts, nowMs: NOW, oiChange: { A: -400, B: -300 } });
  assert.equal(fell.hypotheses.find(x => x.id === 'closing').verdict, h.VERDICT.SUPPORTED);
});

test('CLOSING: without OI change it stays UNRESOLVED even when volume dwarfs OI', () => {
  const L = h.buildHypotheses({ contracts: [goodContract({ volume: 50000, openInterest: 100 })], nowMs: NOW });
  const c = L.hypotheses.find(x => x.id === 'closing');
  assert.equal(c.verdict, h.VERDICT.UNRESOLVED);
  assert.match(c.evidence.join(' '), /no open\/close flag/i);
});

test('ROLL: matched same-side volume across two expiries is a roll footprint', () => {
  const L = h.buildHypotheses({ contracts: [
    goodContract({ expiry: '2026-09-18', volume: 4000 }),
    goodContract({ expiry: '2026-12-18', volume: 3800, strike: 115 }),
  ], nowMs: NOW });
  const r = L.hypotheses.find(x => x.id === 'roll');
  assert.equal(r.verdict, h.VERDICT.SUPPORTED);
  assert.ok(r.pairs.length >= 1);
});

test('SPREAD: near-identical same-expiry volume is a FOOTPRINT, never a confirmed spread', () => {
  const L = h.buildHypotheses({ contracts: [
    goodContract({ strike: 110, volume: 3000 }),
    goodContract({ strike: 120, volume: 3000 }),
  ], nowMs: NOW });
  const s = L.hypotheses.find(x => x.id === 'spread');
  assert.equal(s.verdict, h.VERDICT.SUPPORTED);
  assert.match(s.evidence.join(' '), /FOOTPRINT \(not a confirmed spread\)/i);
});

test('HEDGE: index put-dominant flow is SUPPORTED; call-dominant single-stock flow is REFUTED', () => {
  const idx = h.buildHypotheses({ contracts: [goodContract({ side: 'put', strike: 90, estNotional: 9e6 })], isIndex: true, nowMs: NOW });
  assert.equal(idx.hypotheses.find(x => x.id === 'hedge').verdict, h.VERDICT.SUPPORTED);
  const single = h.buildHypotheses({ contracts: [goodContract({ side: 'call', estNotional: 9e6 })], isIndex: false, nowMs: NOW });
  assert.equal(single.hypotheses.find(x => x.id === 'hedge').verdict, h.VERDICT.REFUTED);
});

test('HEDGE: far-OTM put concentration is a protective footprint even on a single name', () => {
  const L = h.buildHypotheses({ contracts: [goodContract({ side: 'put', strike: 70, underlying: 100, estNotional: 5e6 })], isIndex: false, nowMs: NOW });
  const x = L.hypotheses.find(y => y.id === 'hedge');
  assert.equal(x.verdict, h.VERDICT.SUPPORTED);
  assert.match(x.evidence.join(' '), /out of the money/i);
});

test('EVENT-VOL: a near event with expiries beyond it is at least as likely as a bet', () => {
  const L = h.buildHypotheses({ contracts: [goodContract({ dte: 36 })], earnings: { daysUntil: 5 }, nowMs: NOW });
  const x = L.hypotheses.find(y => y.id === 'eventVol');
  assert.equal(x.verdict, h.VERDICT.SUPPORTED);
  assert.match(x.evidence.join(' '), /at least as likely as a directional bet/i);
  const far = h.buildHypotheses({ contracts: [goodContract()], earnings: { daysUntil: 90 }, nowMs: NOW });
  assert.equal(far.hypotheses.find(y => y.id === 'eventVol').verdict, h.VERDICT.REFUTED);
});

test('CORP ACTION: with no calendar wired, dividend/split flow is NOT excluded', () => {
  const L = h.buildHypotheses({ contracts: [goodContract()], corpAction: null, nowMs: NOW });
  const x = L.hypotheses.find(y => y.id === 'corpAction');
  assert.equal(x.verdict, h.VERDICT.UNRESOLVED);
  assert.match(x.evidence.join(' '), /cannot be excluded/i);
});

test('STALE QUOTES: a majority of unusable quotes marks the whole event a possible artifact', () => {
  const bad = [
    goodContract({ bid: 1, ask: 3 }),                       // 100% wide
    goodContract({ bid: null, ask: null }),                 // no book
    goodContract({ lastTradeTs: secAgo(60 * 60 * 100) }),   // 100h stale
  ];
  const L = h.buildHypotheses({ contracts: bad, nowMs: NOW });
  const x = L.hypotheses.find(y => y.id === 'staleQuote');
  assert.equal(x.verdict, h.VERDICT.SUPPORTED);
  assert.match(x.evidence.join(' '), /data artifact/i);
});

test('STALE QUOTES: clean books actively REFUTE the artifact explanation', () => {
  const L = h.buildHypotheses({ contracts: [goodContract(), goodContract({ strike: 115 })], nowMs: NOW });
  assert.equal(L.hypotheses.find(y => y.id === 'staleQuote').verdict, h.VERDICT.REFUTED);
});

// ── Evidence strength replaces numeric confidence ───────────────────────────

test('STRENGTH: it is an ordinal band, never a 0–100 number or a probability', () => {
  const L = h.buildHypotheses({ contracts: [goodContract()], nowMs: NOW });
  const s = h.evidenceStrength({ hypotheses: L, componentCoverage: 0.9 });
  assert.ok(h.STRENGTH.includes(s.band));
  assert.equal(s.isProbability, false);
  assert.equal(typeof s.band, 'string');
  assert.ok(Array.isArray(s.reasons) && s.reasons.length);
});

test('STRENGTH: any actively SUPPORTED benign explanation collapses strength to NONE', () => {
  const L = h.buildHypotheses({ contracts: [goodContract({ side: 'put', strike: 70, estNotional: 5e6 })], nowMs: NOW });
  const s = h.evidenceStrength({ hypotheses: L, componentCoverage: 1, independentPriceConfirmation: true });
  assert.equal(s.band, 'NONE');
  assert.match(s.reasons.join(' '), /benign explanation/i);
});

test('STRENGTH: a delayed chain can NEVER reach STRONG, however good everything else is', () => {
  const L = { counts: { supported: 0, refuted: 8, unresolved: 0, notTestable: 0, total: 8 }, refutedFraction: 1, caveat: 'x' };
  const delayed = h.evidenceStrength({ hypotheses: L, componentCoverage: 1, independentPriceConfirmation: true, sourceMode: 'DELAYED_CHAIN' });
  assert.equal(delayed.band, 'MODERATE');
  assert.match(delayed.reasons.join(' '), /capped at MODERATE/i);
  const realtime = h.evidenceStrength({ hypotheses: L, componentCoverage: 1, independentPriceConfirmation: true, sourceMode: 'REALTIME_TRADE_QUOTE' });
  assert.equal(realtime.band, 'STRONG');
});

test('STRENGTH: sparse component coverage is called out, not hidden', () => {
  const L = { counts: { supported: 0, refuted: 6, unresolved: 2, notTestable: 0, total: 8 }, refutedFraction: 0.75, caveat: 'x' };
  const sparse = h.evidenceStrength({ hypotheses: L, componentCoverage: 0.3 });
  assert.match(sparse.reasons.join(' '), /sparse-evidence score/i);
  assert.equal(sparse.componentCoverage, 0.3);
});

test('STRENGTH: with UNKNOWN direction, the band describes ACTIVITY, not a direction', () => {
  const L = { counts: { supported: 0, refuted: 5, unresolved: 3, notTestable: 0, total: 8 }, refutedFraction: 0.625, caveat: 'x' };
  const s = h.evidenceStrength({ hypotheses: L, componentCoverage: 0.9, directionState: 'UNKNOWN' });
  assert.match(s.reasons.join(' '), /not a direction/i);
});

// ── Contract-level executable liquidity ─────────────────────────────────────

test('LIQUIDITY: it is judged on the SELECTED contract, and names it', () => {
  const r = e.contractLiquidity({ contract: goodContract(), contracts: 20, nowMs: NOW });
  assert.equal(r.contract.strike, 110);
  assert.equal(r.contract.expiry, '2026-09-18');
  assert.equal(r.state, 'OK');
});

test('LIQUIDITY: with NO requested size, capacity is UNEVALUATED — not passed', () => {
  const r = e.contractLiquidity({ contract: goodContract(), contracts: null, nowMs: NOW });
  assert.equal(r.checks.size.available, false);
  assert.match(r.checks.size.reason, /has NOT been evaluated/i);
  assert.ok(r.coverage < 1);
});

test('LIQUIDITY: a size too large for the contract BLOCKS, whatever the ticker aggregate says', () => {
  const r = e.contractLiquidity({ contract: goodContract({ openInterest: 100, volume: 50 }), contracts: 500, nowMs: NOW });
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.executableFraction, 0);
  assert.match(r.blocking.join(' '), /capacity-constrained/i);
});

test('LIQUIDITY: a crossed or unusably wide quote blocks execution', () => {
  assert.equal(e.contractLiquidity({ contract: goodContract({ bid: 3, ask: 2 }), contracts: 5, nowMs: NOW }).state, 'BLOCKED');
  assert.equal(e.contractLiquidity({ contract: goodContract({ bid: 1, ask: 3 }), contracts: 5, nowMs: NOW }).state, 'BLOCKED');
});

test('LIQUIDITY: a stale print blocks it', () => {
  const r = e.contractLiquidity({ contract: goodContract({ lastTradeTs: secAgo(3600 * 100) }), contracts: 5, nowMs: NOW });
  assert.equal(r.state, 'BLOCKED');
  assert.match(r.blocking.join(' '), /last print/i);
});

test('LIQUIDITY: a usable quote yields a concrete limit rule and a max-spread ceiling', () => {
  const r = e.contractLiquidity({ contract: goodContract(), contracts: 10, nowMs: NOW });
  assert.ok(r.limitRule.suggestedLimit > 0);
  assert.ok(r.limitRule.neverPayAbove >= r.limitRule.suggestedLimit);
  assert.ok(r.limitRule.maxAcceptableSpreadPctOfMid > 0);
  assert.match(r.limitRule.rule, /limit|mid/i);
  assert.ok(r.estimatedSlippageFrac > 0);
});

test('LIQUIDITY: a wide-but-usable book tells you NOT to lift the offer', () => {
  const r = e.contractLiquidity({ contract: goodContract({ bid: 1.8, ask: 2.2 }), contracts: 10, nowMs: NOW });
  assert.match(r.limitRule.rule, /Do NOT lift the offer/i);
});

// ── Full-chain strike concentration ─────────────────────────────────────────

test('CONCENTRATION: it REFUSES to compute from retained display rows', () => {
  const r = e.strikeConcentration({ chainRows: [goodContract()], chainComplete: false });
  assert.equal(r.available, false);
  assert.match(r.reason, /Retention is a ranking decision/i);
});

test('CONCENTRATION: over the full chain it reports top-strike share and an HHI', () => {
  const rows = [
    { side: 'call', strike: 110, volume: 8000 },
    { side: 'call', strike: 115, volume: 1000 },
    { side: 'put', strike: 90, volume: 1000 },
  ];
  const r = e.strikeConcentration({ chainRows: rows, chainComplete: true });
  assert.equal(r.available, true);
  assert.equal(r.basis, 'FULL_CHAIN');
  assert.equal(r.distinctStrikes, 3);
  assert.equal(r.top1Share, 0.8);
  assert.equal(r.concentrated, true);
  assert.ok(r.hhi > 0.5);
});

// ── Volatility context ──────────────────────────────────────────────────────

test('IV RANK: refuses to report over a short history — a 12-observation rank is noise', () => {
  const r = e.ivRank({ currentIV: 55, ivHistory: Array.from({ length: 12 }, (_, i) => 40 + i) });
  assert.equal(r.available, false);
  assert.match(r.reason, /is noise/i);
});

test('IV RANK: with enough history it reports rank AND percentile with the range', () => {
  const hist = Array.from({ length: 120 }, (_, i) => 20 + (i % 40));
  const r = e.ivRank({ currentIV: 55, ivHistory: hist });
  assert.equal(r.available, true);
  assert.ok(r.ivRank >= 0 && r.ivRank <= 100);
  assert.ok(r.ivPercentile >= 0 && r.ivPercentile <= 100);
  assert.match(r.note, /not a forecast and not a probability/i);
});

test('EXPECTED MOVE: it is labelled a pricing convention, never a probability', () => {
  const r = e.expectedVsRealizedMove({ atmIV: 40, days: 30, spot: 100 });
  assert.equal(r.available, true);
  assert.ok(r.expectedMovePct > 0);
  assert.ok(r.expectedMoveAbs > 0);
  assert.match(r.note, /not a probability/i);
});

test('EXPECTED MOVE: it compares against the realized move when one is supplied', () => {
  const r = e.expectedVsRealizedMove({ atmIV: 40, days: 30, spot: 100, realizedMovePct: 25 });
  assert.ok(r.realizedVsExpected > 1);
  assert.match(r.interpretation, /already moved MORE/i);
});

test('SURFACE CHANGE: a CHANGE needs a prior snapshot — a level alone is refused', () => {
  const only = e.surfaceChange({ current: { atmIV: 40, skew: 5, termSlope: 2 }, prior: null });
  assert.equal(only.available, false);
  assert.match(only.reason, /prior-session surface snapshot is required/i);
  const both = e.surfaceChange({ current: { atmIV: 45, skew: 7, termSlope: 3 }, prior: { atmIV: 40, skew: 5, termSlope: 2 } });
  assert.equal(both.available, true);
  assert.equal(both.atmIVChange, 5);
  assert.equal(both.skewSteepening, true);
});

test('STRIKE MAP: it flags when it was computed over retained rows only', () => {
  const r = e.strikeMap({ chainRows: [goodContract()], spot: 100, chainComplete: false });
  assert.equal(r.basis, 'RETAINED_ROWS_ONLY');
  assert.match(r.basisCaveat, /display cut/i);
});

test('STRIKE MAP: far-OTM concentration is surfaced', () => {
  const r = e.strikeMap({ chainRows: [{ side: 'call', strike: 150, volume: 9000 }, { side: 'call', strike: 101, volume: 100 }], spot: 100, chainComplete: true });
  assert.equal(r.farOTMHeavy, true);
  assert.ok(r.shares.farOTM > 0.9);
});

test('CRUSH: an event before expiry produces an explicit "even if you are right" warning', () => {
  const r = e.crushStress({ atmIV: 70, dte: 30, eventInDays: 4 });
  assert.equal(r.eventBeforeExpiry, true);
  assert.ok(r.combinedStressPct > 0);
  assert.match(r.warning, /EVEN IF the stock moves the expected way/i);
  assert.match(r.approximation, /not a Greeks-based P&L/i);
});

test('VOLATILITY CONTEXT: partial inputs degrade per-block, never blanking the panel', () => {
  const ctx = e.volatilityContext({ atmIV: 40, days: 30, dte: 30, spot: 100, chainRows: [goodContract()], eventInDays: 5 });
  assert.equal(ctx.expectedMove.available, true);
  assert.equal(ctx.crushStress.available, true);
  assert.equal(ctx.ivRank.available, false, 'no IV history is persisted yet');
  assert.equal(ctx.surfaceChange.available, false, 'no prior surface snapshot is persisted yet');
  assert.ok(ctx.coverage.fraction > 0 && ctx.coverage.fraction < 1);
  for (const m of ctx.coverage.missing) assert.ok(m.reason, 'every missing block states why');
});

// ── Greeks capability ───────────────────────────────────────────────────────

test('GREEKS: with no provider Greeks, nothing is estimated and the gap is disclosed', () => {
  const g = e.greeksCapability({ capabilities: {}, chainRows: [goodContract(), goodContract({ strike: 115 })] });
  assert.equal(g.available, false);
  assert.equal(g.dealerPositioning.available, false);
  assert.match(g.disclosure, /would be fabrication/i);
  assert.match(g.dealerPositioning.reason, /NOT estimated/i);
});

test('GREEKS: dealer positioning still requires FULL-CHAIN open interest, not just Greeks', () => {
  const rows = [goodContract({ delta: 0.4, gamma: 0.02, vega: 0.1 }), goodContract({ strike: 115, delta: 0.3, gamma: 0.02, vega: 0.1 })];
  const withoutOI = e.greeksCapability({ capabilities: {}, chainRows: rows });
  assert.equal(withoutOI.available, true);
  assert.equal(withoutOI.dealerPositioning.available, false);
  const withOI = e.greeksCapability({ capabilities: { hasFullChainOI: true }, chainRows: rows });
  assert.equal(withOI.dealerPositioning.available, true);
});
