'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const O = require('../lib/omega-swing');

// ── candle builders ─────────────────────────────────────────────────────────────────────
function series(rows, start = '2025-01-01') {
  let d = new Date(start + 'T00:00:00Z');
  return rows.map(r => {
    const date = d.toISOString().slice(0, 10); d = new Date(d.getTime() + 86400000);
    const close = r.close, vol = r.volume ?? 2e6;
    return { date, open: r.open ?? close, high: r.high ?? close * 1.01, low: r.low ?? close * 0.99, close, volume: vol };
  });
}
// A clean early-to-middle-stage uptrend: gentle, efficient, rising participation, ~modest run.
function healthyUptrend(n = 80, drift = 0.004) {
  const rows = []; let px = 30;
  for (let i = 0; i < n; i++) { px *= (1 + drift + Math.sin(i / 4) * 0.001); rows.push({ close: +px.toFixed(2), volume: 3e6 * (1 + i * 0.004) }); }
  return series(rows);
}
// An early-emergence name: a long quiet base, then a modest recent move (~7%) with a couple
// of down days — the early-to-middle stage OMEGA-SWING targets (not yet extended).
function earlyEmergence() {
  const rows = []; let px = 30;
  for (let i = 0; i < 58; i++) { px *= (1 + (Math.sin(i / 3) * 0.004)); rows.push({ close: +px.toFixed(2), volume: 2e6 }); } // flat base
  const legs = [0.012, 0.008, -0.004, 0.01, 0.006, -0.003, 0.011, 0.007, 0.004, 0.009, -0.002, 0.008];
  for (const g of legs) { px *= (1 + g); rows.push({ close: +px.toFixed(2), volume: 3.2e6 }); }               // recent emergence
  return series(rows);
}
// Flat benchmark (so relative strength = the stock's own move).
function flat(n = 80, px = 400) { const rows = []; for (let i = 0; i < n; i++) rows.push({ close: px, volume: 5e7 }); return series(rows); }
// A parabolic, exhausted late mover.
function parabolic(n = 80) {
  const rows = []; let px = 20;
  for (let i = 0; i < n - 12; i++) { px *= 1.003; rows.push({ close: +px.toFixed(2), volume: 2e6 }); }
  for (let k = 0; k < 12; k++) { px *= 1.06; rows.push({ close: +px.toFixed(2), volume: 6e6, high: px * 1.05, low: px * 0.98 }); } // vertical blowoff
  return series(rows);
}
// A broken-down name (was up, now rolling over).
function brokenDown(n = 80) {
  const rows = []; let px = 50;
  for (let i = 0; i < 50; i++) { px *= 1.004; rows.push({ close: +px.toFixed(2), volume: 2e6 }); }
  for (let k = 0; k < n - 50; k++) { px *= 0.985; rows.push({ close: +px.toFixed(2), volume: 3e6 }); }
  return series(rows);
}

// ── FEATURES ──────────────────────────────────────────────────────────────────────────
test('computeFeatures returns null below the history floor', () => {
  assert.strictEqual(O.computeFeatures(series([{ close: 10 }, { close: 11 }])), null);
});
test('computeFeatures computes momentum + relative strength vs a flat benchmark', () => {
  const f = O.computeFeatures(healthyUptrend(), { spy: flat(), sector: flat() });
  assert.ok(f, 'features present');
  assert.ok(f.r10 > 0 && f.r20 > 0, 'positive momentum');
  assert.ok(f.rsSpy10 > 0, 'leads a flat SPY');
  assert.ok(f.maAlignScore >= 0.66, 'moving averages aligned in an uptrend');
  assert.ok(f.efficiency > 0.3, 'reasonably efficient path');
});

// ── STAGE CLASSIFICATION (§3) ────────────────────────────────────────────────────────────
test('classifyStage: parabolic blowoff is EXHAUSTED, not a buy', () => {
  const f = O.computeFeatures(parabolic(), { spy: flat() });
  assert.strictEqual(O.classifyStage(f), 'EXHAUSTED');
});
test('classifyStage: a rolled-over name is FAILED', () => {
  const f = O.computeFeatures(brokenDown(), { spy: flat() });
  assert.strictEqual(O.classifyStage(f), 'FAILED');
});
test('classifyStage: an early/middle-stage uptrend is selectable', () => {
  const f = O.computeFeatures(earlyEmergence(), { spy: flat(70) });
  assert.ok(O.SELECTABLE_STAGES.has(O.classifyStage(f)), `early/confirmed/continuation, got ${O.classifyStage(f)}`);
});

// ── SETUP DETECTION (§5) ────────────────────────────────────────────────────────────────
test('detectSetups returns a ranked list and a best when a structure is present', () => {
  const f = O.computeFeatures(healthyUptrend(), { spy: flat() });
  const s = O.detectSetups(f, null, {});
  assert.ok(Array.isArray(s.setups) && s.setups.length === 6, 'six setup detectors');
  assert.ok(s.setups[0].strength >= s.setups[1].strength, 'sorted by strength');
});

// ── EXHAUSTION FILTERS (§6) ─────────────────────────────────────────────────────────────
test('exhaustionPenalty punishes an extreme single-day spike + thin liquidity', () => {
  const f = O.computeFeatures(healthyUptrend(), { spy: flat() });
  const spike = { ...f, changePct: 30, dollarVol: 1e6 };
  const pen = O.exhaustionPenalty(spike, {});
  assert.ok(pen.mult < 0.5, 'stacked penalties collapse the multiplier');
  assert.ok(pen.flags.some(x => /spike/.test(x)) && pen.flags.some(x => /liquidity/.test(x)));
});
test('exhaustionPenalty applies the risk-off lever', () => {
  const f = O.computeFeatures(healthyUptrend(), { spy: flat() });
  const on = O.exhaustionPenalty(f, { regime: { riskOn: true } }).mult;
  const off = O.exhaustionPenalty(f, { regime: { bearish: true } }).mult;
  assert.ok(off < on, 'risk-off penalized relative to risk-on');
});

// ── SCORING (§10) ───────────────────────────────────────────────────────────────────────
test('omegaScore is 0..100 and a strong past return alone does not max it out', () => {
  const f = O.computeFeatures(parabolic(), { spy: flat() });
  const sc = O.omegaScore(f, { regime: { riskOn: true } });
  assert.ok(sc.score >= 0 && sc.score <= 100);
  assert.ok(sc.score < 75, 'exhausted parabola is penalized despite a huge return');
});
test('omegaScore: a clean early uptrend outscores a parabolic blowoff', () => {
  const clean = O.computeFeatures(healthyUptrend(70, 0.003), { spy: flat() });
  const blow = O.computeFeatures(parabolic(), { spy: flat() });
  const a = O.omegaScore(clean, { regime: { riskOn: true } }).score;
  const b = O.omegaScore(blow, { regime: { riskOn: true } }).score;
  assert.ok(a > b, `clean ${a} should beat blowoff ${b}`);
});

// ── EXPECTED UTILITY + TIERS (§11/§12) ──────────────────────────────────────────────────
test('expectedUtility favors better reward:downside', () => {
  const good = O.expectedUtility({ expResidual10: 0.06, pPositive: 0.6, expMFE: 0.08, expMAE: -0.02, tailLossProb: 0.15, core: 0.6 }, { dollarVol: 5e7 }, {});
  const bad = O.expectedUtility({ expResidual10: 0.08, pPositive: 0.55, expMFE: 0.1, expMAE: -0.08, tailLossProb: 0.4, core: 0.5 }, { dollarVol: 5e7 }, {});
  assert.ok(good > bad, '6%/-2% beats 8%/-8%');
});
test('classifyTier: illiquid or exhausted names are AVOID; zero Prime is allowed', () => {
  const f = O.computeFeatures(parabolic(), { spy: flat() });
  const t = O.classifyTier({ score: 90, utility: 0.05, pred: { pPositive: 0.7, core: 0.7 }, f, stage: 'EXHAUSTED', entry: { classification: 'BUY_NOW' }, setup: { bestScore: 0.7 }, regime: { riskOn: true } });
  assert.strictEqual(t, 'AVOID', 'exhausted never Prime');
});

// ── ENTRY TIMING (§9) ───────────────────────────────────────────────────────────────────
test('entryTiming avoids BUY_NOW when extended', () => {
  const f = O.computeFeatures(parabolic(), { spy: flat() });
  const e = O.entryTiming(f, 'EXTENDED', { best: 'highTightContinuation' }, null);
  assert.notStrictEqual(e.classification, 'BUY_NOW');
});
test('entryTiming skips failed/exhausted stages', () => {
  const f = O.computeFeatures(healthyUptrend(), { spy: flat() });
  assert.strictEqual(O.entryTiming(f, 'FAILED', null, null).classification, 'SKIP');
});

// ── RISK / INVALIDATION (§13) ───────────────────────────────────────────────────────────
test('riskPlan produces a stop below entry, targets above, and a size', () => {
  const candles = healthyUptrend();
  const f = O.computeFeatures(candles, { spy: flat() });
  const rp = O.riskPlan(candles, f.price, f, { maxRiskPct: 0.01 });
  assert.ok(rp.invalidation < f.price, 'stop below entry');
  assert.ok(rp.target1 > f.price && rp.target2 > rp.target1, 'targets above and laddered');
  assert.ok(rp.sizePctOfEquity > 0, 'positive size suggestion');
});

// ── RESIDUAL LABELING (§ primary target) + NO FUTURE LEAKAGE (§18) ──────────────────────
test('residualForward is point-in-time: uses only bars AFTER predDate', () => {
  const candles = healthyUptrend(90, 0.005);
  const spy = flat(90);
  const predDate = candles[60].date, entry = candles[60].close;
  const lab = O.residualForward({ candles, predDate, entry, window: 10, spyCandles: spy, sectorCandles: spy });
  assert.ok(lab.resolved, 'resolves with enough forward bars');
  assert.ok(lab.residualReturn != null, 'residual computed vs benchmark');
  // Deliberate leakage probe: corrupt a bar BEFORE predDate to an absurd value; the label
  // must be unchanged (it never reads bars at/before predDate).
  const tampered = candles.map((c, i) => (i <= 60 ? { ...c, close: 1e6, high: 1e6, low: 1e6 } : c));
  const lab2 = O.residualForward({ candles: tampered, predDate, entry, window: 10, spyCandles: spy, sectorCandles: spy });
  assert.deepStrictEqual({ r: lab2.rawReturn, res: lab2.residualReturn, mfe: lab2.mfe }, { r: lab.rawReturn, res: lab.residualReturn, mfe: lab.mfe });
});
test('residualForward is PENDING when the window has not elapsed', () => {
  const candles = healthyUptrend(70);
  const predDate = candles[66].date;      // only 3 forward bars
  const lab = O.residualForward({ candles, predDate, entry: candles[66].close, window: 10 });
  assert.strictEqual(lab.resolved, false);
  assert.strictEqual(lab.pending, true);
});
test('residualForward: missing benchmark yields null residual, never a fabricated 0', () => {
  const candles = healthyUptrend(90);
  const lab = O.residualForward({ candles, predDate: candles[60].date, entry: candles[60].close, window: 5, spyCandles: null, sectorCandles: null });
  assert.strictEqual(lab.residualReturn, null);
  assert.ok(lab.rawReturn != null, 'raw return still computed');
});
test('residualForward records ≥3%/≥5% target hits within the window', () => {
  const candles = healthyUptrend(90, 0.02);     // strong forward move
  const lab = O.residualForward({ candles, predDate: candles[60].date, entry: candles[60].close, window: 10, spyCandles: flat(90), sectorCandles: flat(90) });
  assert.strictEqual(lab.hit3pct, true);
  assert.ok(lab.timeTo3pct >= 1 && lab.timeTo3pct <= 10);
});

// ── DETERMINISTIC INFERENCE (§18) ────────────────────────────────────────────────────────
test('evaluateCandidate is deterministic and never throws on thin data', () => {
  const candles = healthyUptrend();
  const bench = { spy: flat(), sector: flat() };
  const a = O.evaluateCandidate({ ticker: 'T', candles, bench, ctx: { regime: { riskOn: true } } });
  const b = O.evaluateCandidate({ ticker: 'T', candles, bench, ctx: { regime: { riskOn: true } } });
  assert.deepStrictEqual(a.score, b.score);
  assert.deepStrictEqual(a.tier, b.tier);
  assert.strictEqual(O.evaluateCandidate({ ticker: 'X', candles: series([{ close: 1 }]), bench, ctx: {} }), null);
});
