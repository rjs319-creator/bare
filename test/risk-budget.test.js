'use strict';
// RISK BUDGET — deterministic sizing and capacity. The contract under test is that it
// REFUSES rather than guessing: every missing input yields available:false with a reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'risk-budget.js')).href);

const B = { equityUsd: 100000, riskPctPerTrade: 0.5 };   // $500 at risk

test('module exports the sizing surface', async () => {
  const R = await load();
  for (const fn of ['loadBudget', 'saveBudget', 'budgetIsSet', 'dollarRisk', 'shareSize', 'capacity', 'sizeAlertDecision', 'sizeOptionContracts']) {
    assert.equal(typeof R[fn], 'function', `${fn} must be exported`);
  }
});

test('budgetIsSet requires BOTH equity and risk percent', async () => {
  const R = await load();
  assert.equal(R.budgetIsSet(B), true);
  assert.equal(R.budgetIsSet({ equityUsd: 100000, riskPctPerTrade: null }), false);
  assert.equal(R.budgetIsSet({ equityUsd: null, riskPctPerTrade: 0.5 }), false);
  assert.equal(R.budgetIsSet(null), false);
});

test('dollarRisk is equity × risk% and refuses without a budget', async () => {
  const R = await load();
  assert.equal(R.dollarRisk(B).value, 500);
  const none = R.dollarRisk(null);
  assert.equal(none.available, false);
  assert.match(none.reason, /no risk budget set/i);
});

// ── Share sizing ────────────────────────────────────────────────────────────

test('share size comes from the DETERMINISTIC invalidation, not a percentage guess', async () => {
  const R = await load();
  const s = R.shareSize({ budget: B, entry: 100, invalidation: 95, side: 'long' });
  assert.equal(s.available, true);
  assert.equal(s.perShareRisk, 5);
  assert.equal(s.shares, 100);            // $500 / $5
  assert.equal(s.notionalUsd, 10000);
  assert.match(s.note, /not a recommendation/i);
});

test('a SHORT sizes off the stop ABOVE entry', async () => {
  const R = await load();
  const s = R.shareSize({ budget: B, entry: 50, invalidation: 55, side: 'short' });
  assert.equal(s.available, true);
  assert.equal(s.perShareRisk, 5);
  assert.equal(s.shares, 100);
});

test('no invalidation ⇒ NO size, with a reason — never a default stop', async () => {
  const R = await load();
  const s = R.shareSize({ budget: B, entry: 100, invalidation: null });
  assert.equal(s.available, false);
  assert.match(s.reason, /no deterministic invalidation/i);
});

test('an invalidation on the wrong side of entry is REFUSED, not silently flipped', async () => {
  const R = await load();
  const long = R.shareSize({ budget: B, entry: 100, invalidation: 105, side: 'long' });
  assert.equal(long.available, false);
  assert.match(long.reason, /wrong side of entry/i);
  const short = R.shareSize({ budget: B, entry: 100, invalidation: 95, side: 'short' });
  assert.equal(short.available, false);
});

test('a sub-one-share position is refused rather than rounded up', async () => {
  const R = await load();
  const s = R.shareSize({ budget: { equityUsd: 1000, riskPctPerTrade: 0.1 }, entry: 500, invalidation: 400 });
  assert.equal(s.available, false);
  assert.match(s.reason, /under one share/i);
});

test('no budget ⇒ sizing is unevaluated, not assumed', async () => {
  const R = await load();
  const s = R.shareSize({ budget: null, entry: 100, invalidation: 95 });
  assert.equal(s.available, false);
  assert.match(s.reason, /no risk budget/i);
});

// ── Capacity ────────────────────────────────────────────────────────────────

test('capacity needs BOTH an order size and an ADV', async () => {
  const R = await load();
  assert.equal(R.capacity({ notionalUsd: null, advUsd: 5e7 }).available, false);
  assert.equal(R.capacity({ notionalUsd: 10000, advUsd: null }).available, false);
  assert.match(R.capacity({ notionalUsd: 10000, advUsd: null }).reason, /no dollar-ADV evidence/i);
});

test('capacity flags a constrained order at the same 10% threshold the server uses', async () => {
  const R = await load();
  const ok = R.capacity({ notionalUsd: 10000, advUsd: 5e7 });
  assert.equal(ok.comfortable, true);
  assert.equal(ok.constrained, false);
  const big = R.capacity({ notionalUsd: 6e6, advUsd: 5e7 });
  assert.equal(big.constrained, true);
  assert.match(big.note, /capacity-constrained/i);
});

// ── End-to-end over a served decision ───────────────────────────────────────

const dec = (o = {}) => ({
  side: 'long', trigger: 106, invalidation: 97.5, priceNow: 104,
  execution: { components: { liquidity: { state: 'MEASURED', value: 8.8e7 } } },
  ...o,
});

test('sizeAlertDecision reads the ADV the server already published', async () => {
  const R = await load();
  const { size, capacity } = R.sizeAlertDecision(dec(), B);
  assert.equal(size.available, true);
  assert.equal(size.perShareRisk, 8.5);          // 106 − 97.5
  assert.equal(capacity.available, true);
  assert.ok(capacity.pctOfAdv > 0);
});

test('an UNMEASURED liquidity component leaves capacity unevaluated', async () => {
  const R = await load();
  const { capacity } = R.sizeAlertDecision(dec({ execution: { components: { liquidity: { state: 'MISSING', reason: 'no ADV' } } } }), B);
  assert.equal(capacity.available, false);
  assert.match(capacity.reason, /no dollar-ADV evidence/i);
});

test('a decision with no invalidation reports unevaluated size AND unevaluated capacity', async () => {
  const R = await load();
  const { size, capacity } = R.sizeAlertDecision(dec({ invalidation: null }), B);
  assert.equal(size.available, false);
  assert.equal(capacity.available, false);
});

// ── Options contract sizing ─────────────────────────────────────────────────

test('options size to PREMIUM at risk, and say so', async () => {
  const R = await load();
  const { size, fit } = R.sizeOptionContracts({ budget: B, contractPrice: 2.10, openInterest: 20000, sessionVolume: 8000 });
  assert.equal(size.available, true);
  assert.equal(size.contracts, 2);               // $500 / ($2.10 × 100)
  assert.match(size.note, /PREMIUM AT RISK/i);
  assert.equal(fit.available, true);
  assert.equal(fit.comfortable, true);
});

test('an option too expensive for the budget is refused, not rounded to one', async () => {
  const R = await load();
  const { size } = R.sizeOptionContracts({ budget: { equityUsd: 10000, riskPctPerTrade: 0.1 }, contractPrice: 50 });
  assert.equal(size.available, false);
  assert.match(size.reason, /below the .* cost of one contract/i);
});

test('a contract with neither OI nor volume leaves the fit unknown', async () => {
  const R = await load();
  const { fit } = R.sizeOptionContracts({ budget: B, contractPrice: 1, openInterest: null, sessionVolume: null });
  assert.equal(fit.available, false);
  assert.match(fit.reason, /capacity unknown/i);
});

test('a size that swamps the contract is flagged constrained', async () => {
  const R = await load();
  const { fit } = R.sizeOptionContracts({ budget: { equityUsd: 1e6, riskPctPerTrade: 5 }, contractPrice: 1, openInterest: 50, sessionVolume: 40 });
  assert.equal(fit.constrained, true);
});

test('no budget ⇒ options size unevaluated', async () => {
  const R = await load();
  const { size } = R.sizeOptionContracts({ budget: null, contractPrice: 2 });
  assert.equal(size.available, false);
  assert.match(size.reason, /no risk budget/i);
});
