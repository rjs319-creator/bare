'use strict';
// STEP 8 — daily contract snapshots + next-session OI confirmation.
// Rising open interest after a volume spike is CONFIRMATION EVIDENCE that the activity
// opened and stuck — never proof of trade direction. These tests pin the honest states
// and the cross-day keying (by OCC contractSymbol).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  OI_STATE, snapshotContracts, indexBySymbol, oiConfirm, stampOiConfirmation,
} = require('../lib/options-snapshot');

test('oiConfirm: no prior snapshot for the contract → NO_PRIOR, not confirmed', () => {
  const r = oiConfirm({ priorOi: null, oi: 4000 });
  assert.equal(r.state, OI_STATE.NO_PRIOR);
  assert.equal(r.confirmsPositioning, false);
  assert.equal(r.oiChange, null);
});

test('oiConfirm: material OI growth → BUILDING (positioning confirmed)', () => {
  const r = oiConfirm({ priorOi: 1000, oi: 1600 });
  assert.equal(r.state, OI_STATE.BUILDING);
  assert.equal(r.confirmsPositioning, true);
  assert.equal(r.oiChange, 600);
  assert.equal(r.oiChangePct, 60);
});

test('oiConfirm: material OI decline → REDUCING (likely closing), not confirmed', () => {
  const r = oiConfirm({ priorOi: 2000, oi: 1200 });
  assert.equal(r.state, OI_STATE.REDUCING);
  assert.equal(r.confirmsPositioning, false);
  assert.equal(r.oiChange, -800);
});

test('oiConfirm: change within the noise floor → FLAT (volume did not become OI)', () => {
  // +20 contracts on 5000 prior OI is below both the 50-abs and 5% floors.
  const r = oiConfirm({ priorOi: 5000, oi: 5020 });
  assert.equal(r.state, OI_STATE.FLAT);
  assert.equal(r.confirmsPositioning, false);
});

test('oiConfirm: small absolute rise on tiny OI stays FLAT (abs floor guards noise)', () => {
  // +40 is a big % of 100 but under the 50-contract absolute floor.
  const r = oiConfirm({ priorOi: 100, oi: 140 });
  assert.equal(r.state, OI_STATE.FLAT);
});

test('oiConfirm: brand-new OI from zero (prior 0) confirms when it clears the abs floor', () => {
  const r = oiConfirm({ priorOi: 0, oi: 300 });
  assert.equal(r.state, OI_STATE.BUILDING);
  assert.equal(r.confirmsPositioning, true);
});

test('snapshotContracts keeps only contracts with a stable key and normalizes fields', () => {
  const signals = [
    { contractSymbol: 'NVDA260320C00150000', ticker: 'NVDA', side: 'call', strike: 150, expiry: '2026-03-20', openInterest: 1200, volume: 5000 },
    { ticker: 'AMD', side: 'put', openInterest: 10 }, // no contractSymbol → dropped
  ];
  const snap = snapshotContracts(signals, { date: '2026-07-21' });
  assert.equal(snap.length, 1);
  assert.equal(snap[0].contractSymbol, 'NVDA260320C00150000');
  assert.equal(snap[0].date, '2026-07-21');
});

test('stampOiConfirmation is immutable and keys today vs yesterday by contractSymbol', () => {
  const yesterday = snapshotContracts([
    { contractSymbol: 'NVDA260320C00150000', ticker: 'NVDA', openInterest: 1000, volume: 800 },
  ], { date: '2026-07-20' });
  const priorIndex = indexBySymbol(yesterday);

  const today = [
    { contractSymbol: 'NVDA260320C00150000', ticker: 'NVDA', openInterest: 1800, volume: 6000 }, // OI grew
    { contractSymbol: 'TSLA260320P00300000', ticker: 'TSLA', openInterest: 500, volume: 4000 },  // unseen yesterday
  ];
  const frozen = JSON.parse(JSON.stringify(today));
  const stamped = stampOiConfirmation(today, priorIndex);

  assert.deepEqual(today, frozen, 'inputs must not be mutated');
  assert.equal(stamped[0].oiConfirm.state, OI_STATE.BUILDING);
  assert.equal(stamped[0].oiConfirm.confirmsPositioning, true);
  assert.equal(stamped[1].oiConfirm.state, OI_STATE.NO_PRIOR);
  // original fields preserved
  assert.equal(stamped[0].ticker, 'NVDA');
});

test('scanChain emits contractSymbol so contracts are cross-day keyable', () => {
  const { scanChain } = require('../lib/optionsflow');
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 30 * 86400;
  const result = {
    quote: { regularMarketPrice: 150, regularMarketChangePercent: 1.2 },
    options: [{
      expirationDate: exp,
      calls: [{
        contractSymbol: 'NVDA260320C00160000', strike: 160, expiration: exp,
        volume: 8000, openInterest: 500, lastPrice: 3.2, bid: 3.1, ask: 3.3,
        impliedVolatility: 0.5,
      }],
      puts: [],
    }],
  };
  const sigs = scanChain('NVDA', result);
  assert.ok(sigs.length >= 1);
  assert.equal(sigs[0].contractSymbol, 'NVDA260320C00160000');
});
