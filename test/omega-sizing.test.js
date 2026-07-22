'use strict';
// OMEGA-SWING sizing tests (Phase 11 / Phase 16): HARD caps (never 100% of equity), ADV
// capacity, gap-loss, evidence haircuts, and honest portfolio-aware labeling.
const { test } = require('node:test');
const assert = require('node:assert');
const OS = require('../lib/omega-sizing');

test('a razor-thin stop can NEVER imply ~100% of equity — capped at the max position', () => {
  // stop 0.5% away would, under naive 1%-risk sizing, imply ~200% of equity.
  const s = OS.positionSizing({ entry: 100, stop: 99.5, dollarVol: 1e9, atrPct: 0.02 });
  assert.ok(s.ok);
  assert.ok(s.sizePctOfEquity <= OS.MAX_POSITION_PCT * 100, `size ${s.sizePctOfEquity}% must be ≤ ${OS.MAX_POSITION_PCT * 100}%`);
  assert.strictEqual(s.maxStandalonePct, 20);
});

test('ADV capacity binds for a thin name', () => {
  const s = OS.positionSizing({ entry: 100, stop: 90, dollarVol: 5e5, atrPct: 0.03, accountSize: 1e6 });
  assert.strictEqual(s.bindingConstraint, 'adv-capacity');
  assert.ok(s.sizePctOfEquity < 5);
});

test('evidence haircut shrinks a shadow, uncalibrated pick — never grows it', () => {
  const base = OS.positionSizing({ entry: 100, stop: 92, dollarVol: 1e9, atrPct: 0.03, ctx: { maturity: 'production', calibrated: true } });
  const shadow = OS.positionSizing({ entry: 100, stop: 92, dollarVol: 1e9, atrPct: 0.03, ctx: { maturity: 'shadow', calibrated: false } });
  assert.ok(shadow.sizePctOfEquity < base.sizePctOfEquity, 'shadow+uncalibrated is smaller');
  assert.ok(shadow.evidenceHaircut < 1);
});

test('binary event + fat tail compound the haircut', () => {
  const h = OS.evidenceHaircut({ maturity: 'shadow', calibrated: false, binaryEvent: true, tailLossProb: 0.4 });
  assert.ok(h <= 0.5 * 0.8 * 0.5 * 0.75 + 1e-9);
});

test('missing exposures → standalone size + honest "portfolio-aware unavailable" note', () => {
  const s = OS.positionSizing({ entry: 100, stop: 92, dollarVol: 1e9, atrPct: 0.03 });
  assert.strictEqual(s.portfolioAware, false);
  assert.match(s.note, /portfolio-aware sizing unavailable|Educational estimate/i);
});

test('sector exposure headroom binds when the sector is already heavy', () => {
  const s = OS.positionSizing({ entry: 100, stop: 92, dollarVol: 1e9, atrPct: 0.03, ctx: { sectorExposurePct: 0.33 } });
  assert.strictEqual(s.portfolioAware, true);
  assert.ok(s.sizePctOfEquity <= 2 + 1e-9, 'only 2% sector headroom remains');
});

test('invalid entry/stop fails closed with zero standalone size', () => {
  const s = OS.positionSizing({ entry: 100, stop: 101 });   // stop above entry
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.maxStandalonePct, 0);
});

test('dollar risk illustration scales with the account size', () => {
  const s = OS.positionSizing({ entry: 100, stop: 95, dollarVol: 1e9, atrPct: 0.02, accountSize: 50000 });
  assert.strictEqual(s.accountSize, 50000);
  assert.ok(s.dollarRisk > 0 && s.positionDollars > 0);
});
