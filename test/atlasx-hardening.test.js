'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { predictDistribution, featureRow } = require('../lib/atlasx-ranking');
const { prosecute, excessiveExtension } = require('../lib/atlasx-prosecutor');

const mkResid = (r10, vol) => ({
  byHorizon: { 1: { residual: r10 * 0.2 }, 3: { residual: r10 * 0.5 }, 5: { residual: r10 * 0.6 }, 10: { residual: r10 }, 20: { residual: r10 * 1.2 }, 63: { residual: r10 } },
  residualAccel: 0.02, vol,
});

// ── Fix 1: winsorization keeps an outlier from dominating the ranking ─────────
test('ranking: an extreme +767% residual is winsorized, not left absurd', () => {
  const ext = predictDistribution({ residual: mkResid(7.67, 0.30) });   // ABTC-like
  const norm = predictDistribution({ residual: mkResid(0.09, 0.02) });  // ordinary leader
  // the central estimate is bounded to a sane magnitude (was ~+758%)
  assert.ok(ext.median < 1.0, `winsorized median should be < 100%, got ${ext.median}`);
  // vol cap bounds the interval (was p10 -523% .. p90 +2040%)
  assert.ok(ext.p90 - ext.p10 < 1.2, `vol-capped interval should be bounded, got ${ext.p90 - ext.p10}`);
  // ORDER is preserved: the extreme name still ranks above the ordinary one, just not absurdly
  assert.ok(ext.median > norm.median, 'winsorization preserves cross-sectional order');
});

test('ranking: featureRow winsorizes each residual-momentum feature per horizon', () => {
  const f = featureRow({ residual: mkResid(7.67) });
  // 10-session cap = 0.16*sqrt(10) ≈ 0.506
  assert.ok(f.residMom10 <= 0.507 && f.residMom10 >= 0.505, `residMom10 capped ~0.506, got ${f.residMom10}`);
  // 5-session cap ≈ 0.358, 20-session cap ≈ 0.715 — each smaller/larger with √h
  assert.ok(f.residMom5 <= 0.36 && f.residMom20 <= 0.72);
  // a normal residual passes through unchanged
  const g = featureRow({ residual: mkResid(0.09) });
  assert.ok(Math.abs(g.residMom10 - 0.09) < 1e-9, 'normal residual unchanged');
});

test('ranking: monotonic below the cap (winsorization does not flatten normal names)', () => {
  const a = predictDistribution({ residual: mkResid(0.25, 0.02) });
  const b = predictDistribution({ residual: mkResid(0.10, 0.02) });
  assert.ok(a.median > b.median, 'stronger (below-cap) residual still ranks higher');
});

// ── Fix 2: prosecutor now flags parabolic extension ───────────────────────────
const engineSig = (resid10, ret20) => ({ ticker: 'X', side: 'long', features: { residual: { byHorizon: { 10: { residual: resid10 } } }, transition: { ret20 } } });

test('prosecutor: a parabolic name flags excessiveExtension with elevated failure score', () => {
  const para = engineSig(7.67, 1.5);   // ABTC-like
  assert.ok(excessiveExtension(para) > 0.9, `parabolic → high extension severity, got ${excessiveExtension(para)}`);
  const p = prosecute(para, {});
  assert.ok(p.failureModes.some(m => m.mode === 'excessiveExtension'), 'excessiveExtension mode present');
  assert.ok(p.failureScore >= 0.20, `parabolic reaches at least the 'low' band, got ${p.failureScore}`);
  assert.ok(['low', 'moderate', 'high'].includes(p.severity), `severity should not be 'none', got ${p.severity}`);
  assert.equal(p.binding, false, 'still non-binding while shadow');
});

test('prosecutor: a constructive ~20% name is NOT flagged as extended', () => {
  const ok = engineSig(0.20, 0.10);    // GPRE-like: below the 25% / 30% start thresholds
  assert.equal(excessiveExtension(ok), 0, 'constructive name not flagged');
  const p = prosecute(ok, {});
  assert.ok(!p.failureModes.some(m => m.mode === 'excessiveExtension'), 'no excessiveExtension mode');
});

test('prosecutor: a down move never flags extension', () => {
  assert.equal(excessiveExtension(engineSig(-0.5, -0.4)), 0);
});

test('prosecutor: extension reads flat resid10/ret20 too (not only the engine shape)', () => {
  assert.ok(excessiveExtension({ resid10: 1.2 }) > 0.9);
  assert.ok(excessiveExtension({ ret20: 1.3 }) > 0.9);
});
