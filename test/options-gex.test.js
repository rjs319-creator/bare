'use strict';
// lib/options-gex — per-strike dealer gamma, gamma-flip interpolation, max-pain, the
// shuffled-OI negative control, and the full-chain refusal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const X = require('../lib/options-gex');

const NOW = Date.UTC(2026, 9, 1, 15);                         // 2026-10-01 11:00 ET
const EXP30 = Math.floor(Date.UTC(2026, 9, 31) / 1000);      // ~30 days out
const contract = (strike, openInterest, extra = {}) => ({ contractSymbol: `T${strike}`, strike, openInterest, volume: 0, impliedVolatility: 0.25, ...extra });

// A chain with call OI stacked above spot and put OI stacked below — the classic positive-
// gamma regime at spot, flipping negative as spot falls into the put wall.
function syntheticChain({ spot = 100, chainComplete = true } = {}) {
  return {
    underlyingSymbol: 'TST', chainComplete, source: 'test',
    quote: { regularMarketPrice: spot },
    options: [{
      expirationDate: EXP30,
      calls: [100, 102, 105, 108, 110].map((k) => contract(k, 4000)),
      puts: [85, 88, 90, 92, 95].map((k) => contract(k, 4000)),
    }],
  };
}

test('contractGex: Γ × OI × 100 × S² × 0.01, and zero for missing/zero inputs', () => {
  assert.equal(X.contractGex({ gamma: 0.02, openInterest: 1000, spot: 100 }), 0.02 * 1000 * 100 * 100 * 100 * 0.01);
  assert.equal(X.contractGex({ gamma: 0.02, openInterest: 0, spot: 100 }), 0);
  assert.equal(X.contractGex({ gamma: null, openInterest: 10, spot: 100 }), 0);
});

test('perStrikeGex: vendor gamma is used when supplied; calls add, puts subtract; strikes sorted', () => {
  const rows = [
    { side: 'call', strike: 110, openInterest: 1000, gamma: 0.01, iv: 0.3, dte: 30 },
    { side: 'put', strike: 90, openInterest: 500, gamma: 0.02, iv: 0.3, dte: 30 },
    { side: 'put', strike: 95, openInterest: 0, gamma: 0.02, iv: 0.3, dte: 30 },   // no OI → ignored
  ];
  const { strikes, sources } = X.perStrikeGex(rows, { spot: 100 });
  assert.deepEqual(strikes.map((s) => s.strike), [90, 110]);
  assert.equal(strikes[1].callGex, 100_000); assert.equal(strikes[1].netGex, 100_000);
  assert.equal(strikes[0].putGex, 100_000); assert.equal(strikes[0].netGex, -100_000);
  assert.deepEqual(sources, { vendor: 2, model: 0, skipped: 0 });
});

test('perStrikeGex: without vendor gamma the model gamma from quoted IV fills in; no IV → skipped and counted', () => {
  const rows = [
    { side: 'call', strike: 100, openInterest: 100, gamma: null, iv: 0.25, dte: 30 },
    { side: 'call', strike: 105, openInterest: 100, gamma: null, iv: null, dte: 30 },
  ];
  const { strikes, sources } = X.perStrikeGex(rows, { spot: 100 });
  assert.equal(strikes.length, 1); assert.ok(strikes[0].callGex > 0);
  assert.deepEqual(sources, { vendor: 0, model: 1, skipped: 1 });
});

test('gammaFlip: interpolates the zero crossing nearest spot', () => {
  const profile = [{ level: 90, netGex: -100 }, { level: 95, netGex: -50 }, { level: 100, netGex: 50 }, { level: 105, netGex: 100 }];
  const flip = X.gammaFlip(profile, 100);
  assert.equal(flip.level, 97.5);
  assert.match(flip.method, /interpolated/);
  assert.equal(X.gammaFlip([{ level: 90, netGex: 10 }, { level: 100, netGex: 20 }], 100), null, 'no sign change → no flip');
  assert.equal(X.gammaFlipDistancePct(100, 97.5), 2.56);
  assert.equal(X.gammaFlipDistancePct(100, null), null);
});

test('computeGex: synthetic chain → flip below spot, spot above flip, max-pain between the walls', () => {
  const g = X.computeGex({ result: syntheticChain(), nowMs: NOW });
  assert.equal(g.available, true);
  assert.equal(g.spot, 100);
  assert.ok(g.netGex > 0, 'call wall at/above spot dominates at spot');
  assert.ok(g.gammaFlip > 85 && g.gammaFlip < 100, `flip ${g.gammaFlip} sits inside the put wall`);
  assert.ok(g.gammaFlipDistancePct > 0, 'spot is ABOVE the flip');
  assert.ok(g.maxPainNearestExpiry.strike >= 95 && g.maxPainNearestExpiry.strike <= 100, `max pain ${g.maxPainNearestExpiry.strike}`);
  assert.equal(g.maxPainNearestExpiry.expiry, '2026-10-31');
  assert.equal(g.gammaSource, 'model');
  assert.equal(g.weight, 0);
  assert.equal(g.contracts.used, 10);
  assert.ok(g.perStrike.every((s) => Number.isInteger(s.netGex)), 'persisted rows are rounded integers');
  assert.match(g.signConvention, /assumption/i);
});

test('computeGex: the shuffled-OI negative control is deterministic per seed and preserves OI per side', () => {
  const chain = syntheticChain();
  const a = X.computeGex({ result: chain, nowMs: NOW, seed: 7 });
  const b = X.computeGex({ result: chain, nowMs: NOW, seed: 7 });
  assert.equal(a.control.shuffledFlip, b.control.shuffledFlip);
  assert.equal(a.control.seed, 7);
  assert.ok(['positive-gamma', 'negative-gamma'].includes(a.control.shuffledRegime), 'the control arm always gets a regime label');
  assert.equal(a.regime, 'positive-gamma');
  const rows = X.flattenChain(chain, { nowMs: NOW, spot: 100 });
  const shuffled = X.shuffleOpenInterest(rows, 7);
  const oi = (list, side) => list.filter((r) => r.side === side).reduce((s, r) => s + r.openInterest, 0);
  assert.equal(oi(shuffled, 'call'), oi(rows, 'call')); assert.equal(oi(shuffled, 'put'), oi(rows, 'put'));
  assert.deepEqual(shuffled.map((r) => r.strike), rows.map((r) => r.strike), 'strikes stay in place; only OI moves');
  assert.notEqual(rows[0], shuffled[0], 'input rows are not mutated (new objects)');
});

test('maxPain: payout-minimizing strike on a toy chain', () => {
  const rows = [
    { side: 'call', strike: 100, openInterest: 100 }, { side: 'call', strike: 110, openInterest: 50 },
    { side: 'put', strike: 90, openInterest: 100 }, { side: 'put', strike: 100, openInterest: 50 },
  ];
  assert.deepEqual(X.maxPain(rows), { strike: 100, payout: 0 });
  assert.equal(X.maxPain([]), null);
});

test('computeGex: refuses incomplete chains and chains without a price — with a reason', () => {
  const partial = X.computeGex({ result: syntheticChain({ chainComplete: false }), nowMs: NOW });
  assert.equal(partial.available, false); assert.match(partial.reason, /incomplete/i);
  const noPrice = X.computeGex({ result: { ...syntheticChain(), quote: {} }, nowMs: NOW });
  assert.equal(noPrice.available, false); assert.match(noPrice.reason, /price/i);
  assert.equal(X.computeGex({ result: null, nowMs: NOW }).available, false);
  assert.match(X.computeGex({ result: syntheticChain() }).reason, /nowMs/);
});

test('flattenChain: far wings outside ±33% of spot and SETTLED expiries are excluded; same-day contracts stay live until the close', () => {
  const chain = { options: [{ expirationDate: EXP30, calls: [contract(100, 1), contract(150, 1)], puts: [contract(60, 1)] }] };
  const rows = X.flattenChain(chain, { nowMs: NOW, spot: 100 });
  assert.deepEqual(rows.map((r) => r.strike), [100]);
  assert.ok(rows[0].dte > 30 && rows[0].dte < 31, 'measured to the 4pm ET settlement, not midnight');
  const today = Math.floor(Date.UTC(2026, 9, 1) / 1000);
  const sameDay = { options: [{ expirationDate: today, calls: [contract(100, 5)], puts: [] }] };
  assert.equal(X.flattenChain(sameDay, { nowMs: NOW, spot: 100 }).length, 1, '11:00 ET on expiry day: still live');
  assert.equal(X.flattenChain(sameDay, { nowMs: Date.UTC(2026, 9, 1, 22), spot: 100 }).length, 0, '18:00 ET on expiry day: settled, dropped');
});
