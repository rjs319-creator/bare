'use strict';
// STEP 12 — real listed cash-secured-put selection. No synthetic strikes: a recommendation
// must come from an actual liquid listed contract or be refused. Delta is a LABELED proxy
// (free chains have no greeks), credit is conservative, and the economics are exact.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  deltaProxy, executableCredit, relSpread, selectExpiry, selectPutContract,
  putEconomics, managementRules, DELTA_LO, DELTA_HI,
} = require('../lib/putsell-contract');

const DAY = 86_400;
const NOW = 1_700_000_000;
const at = dte => NOW + dte * DAY;

test('deltaProxy is always labeled a proxy and OTM puts sit below 0.5', () => {
  const d = deltaProxy({ spot: 100, strike: 90, iv: 0.4, dte: 35 });
  assert.equal(d.isProxy, true);
  assert.match(d.basis, /no listed greeks/i);
  assert.ok(d.value > 0 && d.value < 0.5, `OTM put proxy delta in (0,0.5), got ${d.value}`);
});

test('deltaProxy honestly returns null on insufficient data (never fabricates a greek)', () => {
  assert.equal(deltaProxy({ spot: 100, strike: 90, iv: 0, dte: 35 }).value, null);
  assert.equal(deltaProxy({ spot: 0, strike: 90, iv: 0.4, dte: 35 }).value, null);
});

test('executableCredit is conservative — the bid by default, never the mid', () => {
  assert.equal(executableCredit(1.00, 1.40, 0), 1.00);        // default: bid
  assert.equal(executableCredit(1.00, 1.40, 1), 1.20);        // fraction=1 → mid
  assert.equal(executableCredit(null, 1.40), null);           // no bid → no credit
});

test('relSpread flags a blown-out quote', () => {
  assert.ok(relSpread(1.00, 1.05) < 0.06);
  assert.ok(relSpread(0.50, 1.50) > 0.9);
});

test('selectExpiry prefers the 25-45 DTE window, closest to target', () => {
  const dates = [7, 14, 33, 40, 70].map(at);
  const e = selectExpiry(dates, NOW);
  assert.equal(e.inWindow, true);
  assert.equal(e.dte, 33);   // closest to 35 within [25,45]
});

test('selectExpiry falls back to the closest expiry when none is in-window', () => {
  const dates = [5, 10, 70].map(at);
  const e = selectExpiry(dates, NOW);
  assert.equal(e.inWindow, false);
  assert.ok(e.dte === 70 || e.dte === 10);   // closest available to 35 (both 35 away) — deterministic pick
});

test('selectPutContract requires a real, liquid OTM strike BELOW support', () => {
  const puts = [
    { strike: 95, bid: 1.2, ask: 1.35, openInterest: 800, impliedVolatility: 0.4 },  // below support, liquid ✓
    { strike: 99, bid: 2.0, ask: 2.1, openInterest: 500, impliedVolatility: 0.4 },   // above support → rejected
    { strike: 90, bid: 0.6, ask: 2.0, openInterest: 500, impliedVolatility: 0.4 },   // spread too wide → rejected
    { strike: 88, bid: 0.4, ask: 0.5, openInterest: 5, impliedVolatility: 0.4 },     // illiquid (OI<50) → rejected
  ];
  const sel = selectPutContract(puts, { spot: 100, supportPx: 97, dte: 35, iv: 0.4 });
  assert.ok(sel.contract, 'a valid contract was selected');
  assert.equal(sel.contract.strike, 95);
  assert.equal(sel.proxyDelta.isProxy, true);
  assert.ok(sel.credit > 0);
});

test('selectPutContract rejects a near-ATM (high proxy-delta) put — not a conservative CSP', () => {
  // A liquid put just below support but only ~2% OTM → proxy delta well above the ceiling.
  const puts = [
    { strike: 98, bid: 4.0, ask: 4.2, openInterest: 900, impliedVolatility: 0.4 },   // ~ATM, high delta → rejected
  ];
  const sel = selectPutContract(puts, { spot: 100, supportPx: 99, dte: 35, iv: 0.4 });
  assert.equal(sel.contract, null, 'a near-ATM put must not be recommended as a CSP');
});

test('selectPutContract refuses (no fabrication) when nothing qualifies', () => {
  const puts = [
    { strike: 99, bid: 2.0, ask: 2.1, openInterest: 500 },   // above support
    { strike: 90, bid: 0, ask: 0.05, openInterest: 500 },    // no real bid
  ];
  const sel = selectPutContract(puts, { spot: 100, supportPx: 97, dte: 35, iv: 0.4 });
  assert.equal(sel.contract, null);
  assert.match(sel.reason, /no-liquid-otm-put/);
});

test('putEconomics computes exact CSP figures for a real contract', () => {
  const econ = putEconomics({ strike: 95, credit: 1.90 }, { spot: 100, supportPx: 97, dte: 38 });
  assert.equal(econ.cashRequired, 9500);
  assert.equal(econ.maxProfit, 190);
  assert.equal(econ.breakeven, 93.1);
  assert.equal(econ.returnOnCash, 2);                        // 1.90/95 = 2.0%
  assert.ok(econ.annualizedYield > 18 && econ.annualizedYield < 20); // 2% * 365/38 ≈ 19.2%
  assert.equal(econ.assignmentPrice, 95);
  assert.equal(econ.effectiveCostBasis, 93.1);
});

test('managementRules flags a trade that crosses earnings before expiry', () => {
  const crosses = managementRules({ dte: 35, earningsInDays: 10 });
  assert.equal(crosses.crossesEarnings, true);
  assert.match(crosses.earningsHandling, /CROSSES an earnings report/);
  const clean = managementRules({ dte: 35, earningsInDays: 60 });
  assert.equal(clean.crossesEarnings, false);
  assert.match(clean.earningsHandling, /No earnings before expiry/);
});

test('proxy-delta band constants are the documented CSP window', () => {
  assert.equal(DELTA_LO, 0.15);
  assert.equal(DELTA_HI, 0.25);
});
