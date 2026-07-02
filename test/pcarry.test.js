'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pcarryPriceFeatures, scorePcarry, CLAMP } = require('../lib/pcarry');

// build synthetic daily candles ending with a given last-day move + ADR
function candles({ n = 40, close = 10, adrPct = 3, lastMovePct = 5, hh5 = null } = {}) {
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const c = close * (1 - lastMovePct / 100);   // prior levels ~ pre-move
    const h = c * (1 + adrPct / 200), l = c * (1 - adrPct / 200);
    out.push({ open: c, high: h, low: l, close: c, volume: 1e6 });
  }
  const prev = out[out.length - 1].close;
  const last = prev * (1 + lastMovePct / 100);
  out.push({ open: prev, high: hh5 ?? last, low: prev, close: last, volume: 3e6 });
  return out;
}

test('pcarryPriceFeatures: extADR = move / ADR, hinge triggers past 3', () => {
  const f = pcarryPriceFeatures(candles({ adrPct: 2, lastMovePct: 8 }));   // 8% / ~2% ADR = 4 ADRs
  assert.ok(f.extADR >= 3, `extADR ${f.extADR}`);
  assert.ok(f.extHinge > 0, 'hinge should fire on a blow-off');
});

test('pcarryPriceFeatures: a moderate move on a high-ADR name is NOT overextended', () => {
  const f = pcarryPriceFeatures(candles({ adrPct: 8, lastMovePct: 8 }));   // 8% / 8% ADR = 1 ADR
  assert.ok(f.extADR < 3);
  assert.equal(f.extHinge, 0);
});

test('scorePcarry: overextended blow-off gets LOWER odds than a moderate move', () => {
  const blow = scorePcarry(pcarryPriceFeatures(candles({ adrPct: 1.5, lastMovePct: 9 })), { scan: 'momentum_liquid' });
  const mod = scorePcarry(pcarryPriceFeatures(candles({ adrPct: 6, lastMovePct: 9 })), { scan: 'momentum_liquid' });
  assert.ok(blow.overextended);
  assert.ok(!mod.overextended);
  assert.ok(blow.carry < mod.carry, `blow ${blow.carry} < mod ${mod.carry}`);
});

test('scorePcarry: dilution/M&A catalyst lowers odds; FDA/guidance raises', () => {
  const f = pcarryPriceFeatures(candles({ adrPct: 5, lastMovePct: 6 }));
  const none = scorePcarry(f, { scan: 'momentum_liquid', catalyst: 'NONE' }).carry;
  const fade = scorePcarry(f, { scan: 'momentum_liquid', catalyst: 'FADE_OFFERING' }).carry;
  const ma = scorePcarry(f, { scan: 'momentum_liquid', catalyst: 'MA' }).carry;
  const fda = scorePcarry(f, { scan: 'momentum_liquid', catalyst: 'FDA' }).carry;
  assert.ok(fade < none && ma < none, 'fade catalysts lower odds');
  assert.ok(fda > none, 'continue catalysts raise odds');
});

test('scorePcarry: risk-off regime lowers odds vs risk-on', () => {
  const f = pcarryPriceFeatures(candles({ adrPct: 5, lastMovePct: 6 }));
  const off = scorePcarry(f, { scan: 'momentum_liquid', regime: 'risk-off' }).carry;
  const on = scorePcarry(f, { scan: 'momentum_liquid', regime: 'risk-on' }).carry;
  assert.ok(off < on);
});

test('scorePcarry: explosive_small scan carries a lower base than momentum_building', () => {
  const f = pcarryPriceFeatures(candles({ adrPct: 5, lastMovePct: 9 }));
  const exp = scorePcarry(f, { scan: 'explosive_small' }).carry;
  const bld = scorePcarry(f, { scan: 'momentum_building' }).carry;
  assert.ok(exp < bld);
});

test('scorePcarry: odds stay within the honest clamp [30,66]', () => {
  for (const cat of ['NONE', 'FADE_OFFERING', 'MA', 'FDA'])
    for (const reg of ['risk-off', 'risk-on'])
      for (const mv of [3, 9, 20]) {
        const s = scorePcarry(pcarryPriceFeatures(candles({ lastMovePct: mv })), { scan: 'explosive_small', catalyst: cat, regime: reg });
        assert.ok(s.carry >= CLAMP[0] * 100 && s.carry <= CLAMP[1] * 100, `carry ${s.carry} out of clamp`);
      }
});

test('pcarryPriceFeatures: too few candles → null', () => {
  assert.equal(pcarryPriceFeatures([{ close: 1, high: 1, low: 1 }]), null);
});
