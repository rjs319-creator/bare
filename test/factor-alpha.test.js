'use strict';
// Factor-adjusted alpha for the Scoreboard: date-level ridge regression of a lane's
// cost-net forward return on factor window returns, HAC t-stat, n ≥ 60 guard, FF-first
// with ETF-proxy fallback, and the proxy-vs-FF beta correlation diagnostic.
const test = require('node:test');
const assert = require('node:assert/strict');
const FA = require('../lib/factors/factor-alpha');
const FM = require('../lib/orbit-factor-model');

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `expected ${b}, got ${a}`);
function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }
const dateAt = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);

// Closed-form OLS for y = a + b·x (one factor), the oracle the ridge must match at λ=0.
function ols1(xs, ys) {
  const n = xs.length, mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

test('residualWindow accepts custom factorKeys (FF / proxy sets) and still defaults to the ORBIT order', () => {
  const rnd = lcg(5);
  const L = 100;
  const f1 = Array.from({ length: L }, () => (rnd() - 0.5) * 2), f2 = Array.from({ length: L }, () => (rnd() - 0.5) * 2);
  const y = f1.map((a, i) => 0.3 + 1.5 * a - 0.7 * f2[i]);
  const out = FM.residualWindow(y, { smb: f1, hml: f2 }, { factorKeys: ['mktRf', 'smb', 'hml'], window: L, minObs: 60, lambda: 1e-6 });
  assert.ok(out.sufficient);
  assert.deepEqual(out.factorsUsed, ['smb', 'hml']);
  close(out.exposures.smb, 1.5, 1e-3); close(out.exposures.hml, -0.7, 1e-3); close(out.exposures.alpha, 0.3, 1e-3);
  assert.equal(out.exposures.mktRf, 0, 'an absent requested factor reports a zero exposure, not undefined');
  const dflt = FM.residualWindow(y, { market: f1 }, { window: L, minObs: 60 });
  assert.deepEqual(Object.keys(dflt.exposures), ['alpha', 'market', 'sector', 'size', 'vol']);
});

test('fitFactorAlpha at λ→0 reproduces closed-form OLS alpha and beta', () => {
  const rnd = lcg(9);
  const n = 80;
  const rows = Array.from({ length: n }, (_, i) => {
    const x = (rnd() - 0.5) * 6;
    return { date: dateAt(i), y: 0.4 + 1.2 * x + (rnd() - 0.5) * 0.8, f: { mkt: x } };
  });
  const o = ols1(rows.map(r => r.f.mkt), rows.map(r => r.y));
  const cell = FA.fitFactorAlpha(rows, ['mkt'], { horizonBars: 5, lambda: 1e-9, minN: 60 });
  assert.equal(cell.insufficient, undefined);
  assert.equal(cell.n, n);
  close(cell.exact.alpha, o.a, 1e-6);
  close(cell.betas.mkt, o.b, 1e-4);
  assert.ok(Number.isFinite(cell.exact.t) && Number.isFinite(cell.exact.p) && cell.exact.p > 0 && cell.exact.p < 1);
  assert.equal(cell.alpha, +o.a.toFixed(2));
  assert.ok(cell.ci95.lo < cell.exact.alpha && cell.ci95.hi > cell.exact.alpha);
  assert.equal(cell.hacLags, 4);
});

test('ridge shrinkage pulls betas toward zero relative to OLS and never touches the intercept penalty', () => {
  const rnd = lcg(21);
  const n = 70;
  const rows = Array.from({ length: n }, (_, i) => { const x = (rnd() - 0.5) * 2; return { date: dateAt(i), y: 2 * x + (rnd() - 0.5) * 0.1, f: { mkt: x } }; });
  const loose = FA.fitFactorAlpha(rows, ['mkt'], { horizonBars: 1, lambda: 1e-9, minN: 60 });
  const tight = FA.fitFactorAlpha(rows, ['mkt'], { horizonBars: 1, lambda: 50, minN: 60 });
  assert.ok(Math.abs(tight.betas.mkt) < Math.abs(loose.betas.mkt), 'shrunk');
  assert.ok(tight.betas.mkt > 0.5, 'but not destroyed');
});

test('n ≥ 60 guard: fewer usable dates → insufficient with the reason, no numbers fabricated', () => {
  const rows = Array.from({ length: 59 }, (_, i) => ({ date: dateAt(i), y: 0.1, f: { mkt: i % 3 - 1 } }));
  const cell = FA.fitFactorAlpha(rows, ['mkt'], { horizonBars: 5 });
  assert.equal(cell.insufficient, true);
  assert.match(cell.reason, /59.*< 60/);
  assert.equal(cell.alpha, null);
  assert.equal(FA.MIN_DATES, 60);
});

test('dateLevelFactorRows equal-weights same-day picks and drops rows with a missing factor', () => {
  const rows = [
    { date: '2026-01-05', net: 1, fx: { proxy: { mkt: 0.5, size: 0.1 } } },
    { date: '2026-01-05', net: 3, fx: { proxy: { mkt: 0.5, size: 0.1 } } },
    { date: '2026-01-06', net: 2, fx: { proxy: { mkt: 0.2, size: null } } },
    { date: '2026-01-07', net: -1, fx: { proxy: { mkt: -0.3, size: 0.4 } } },
    { date: '2026-01-08', net: null, fx: { proxy: { mkt: 0.1, size: 0.1 } } },
  ];
  const out = FA.dateLevelFactorRows(rows, { source: 'proxy', factorKeys: ['mkt', 'size'] });
  assert.deepEqual(out.map(r => r.date), ['2026-01-05', '2026-01-07']);
  close(out[0].y, 2); close(out[0].f.mkt, 0.5);
  assert.equal(out[0].picks, 2);
});

test('FF rows subtract the risk-free window return from the cost-net return', () => {
  const rows = [{ date: '2026-01-05', net: 1.5, fx: { ff: { mktRf: 0.5, smb: 0, hml: 0, rmw: 0, cma: 0, mom: 0, rf: 0.1 } } }];
  const out = FA.dateLevelFactorRows(rows, { source: 'ff', factorKeys: FA.FF_KEYS });
  close(out[0].y, 1.4);
});

test('buildFactorAlphaBlock: FF-sourced alpha when enough FF dates, proxy fallback otherwise, BH q across cells, correlation diagnostic', () => {
  const rnd = lcg(33);
  const nDates = 90;
  // One lane whose return is pure factor exposure (true alpha 0) + another with a real +0.5 alpha.
  const mkRows = (alpha, withFF) => Array.from({ length: nDates }, (_, i) => {
    const m = (rnd() - 0.5) * 4, s = (rnd() - 0.5) * 2;
    const noise = (rnd() - 0.5) * 0.2;
    const net = alpha + 1.1 * m + 0.4 * s + noise;
    const fx = { proxy: { mkt: m, size: s, value: 0.01 * i % 0.3, mom: (rnd() - 0.5), quality: (rnd() - 0.5) * 0.5 } };
    // FF mirrors the proxies closely (so betas should correlate) but only for the first 70 dates.
    fx.ff = (withFF && i < 70) ? { mktRf: m + (rnd() - 0.5) * 0.05, smb: s + (rnd() - 0.5) * 0.05, hml: fx.proxy.value, rmw: fx.proxy.quality, cma: (rnd() - 0.5) * 0.2, mom: fx.proxy.mom, rf: 0.01 } : null;
    return { date: dateAt(i), net, fx, ret: net + 0.2 };
  });
  const groups = {
    'screener:Breakout:large': { section: 'screener', tier: 'Breakout', scope: 'large', h: { '5d': mkRows(0, true), '20d': mkRows(0.5, true) } },
    'Ghost:Hot:': { section: 'Ghost', tier: 'Hot', scope: null, h: { '5d': mkRows(0.3, false) } },
    'Thin:Lane:': { section: 'Thin', tier: 'Lane', scope: null, h: { '5d': mkRows(0, true).slice(0, 20) } },
  };
  const horizons = [['5d', 5], ['20d', 20]];
  const block = FA.buildFactorAlphaBlock(groups, horizons, { ff: { available: true, lastDate: '2025-03-11', lagDays: 32, stale: false } });
  assert.equal(block.version, FA.FACTOR_ALPHA_VERSION);
  assert.equal(block.state, 'SHADOW'); assert.equal(block.weight, 0);
  const b5 = block.groups['screener:Breakout:large']['5d'];
  assert.equal(b5.source, 'ff', '70 FF dates ≥ 60 → French factors carry the estimate');
  assert.ok(Math.abs(b5.exact.alpha) < 0.15, `pure-exposure lane has ~0 alpha, got ${b5.exact.alpha}`);
  assert.ok(Math.abs(b5.betas.mktRf - 1.1) < 0.1);
  assert.ok(b5.proxy && b5.proxy.n === nDates, 'the proxy fit rides along for the correlation diagnostic');
  const b20 = block.groups['screener:Breakout:large']['20d'];
  assert.ok(b20.exact.alpha > 0.3 && b20.exact.t > 2, `real alpha recovered: ${b20.exact.alpha} t ${b20.exact.t}`);
  assert.ok(Number.isFinite(b20.q) && b20.q <= 1 && b20.q >= b20.p, 'BH q attached');
  const g5 = block.groups['Ghost:Hot:']['5d'];
  assert.equal(g5.source, 'proxy', 'no FF rows → ETF proxies carry the live window, labelled as such');
  assert.ok(g5.exact.alpha > 0.1);
  const t5 = block.groups['Thin:Lane:']['5d'];
  assert.equal(t5.insufficient, true);
  assert.equal(t5.source, null);
  // Correlation diagnostic: betas from the ff fit vs the proxy fit on the same lanes.
  assert.ok(block.proxyBetaCorrelation.pairs >= 5);
  assert.ok(block.proxyBetaCorrelation.r > 0.8, `r ${block.proxyBetaCorrelation.r}`);
  assert.equal(block.proxyBetaCorrelation.threshold, 0.8);
  assert.equal(block.proxyBetaCorrelation.passes, true);
  assert.equal(block.ff.lastDate, '2025-03-11');
  assert.equal(block.cells, 4);
  assert.match(block.basis, /cost-net/);
  // Rounded display fields are consistent with the exact block (evidence-stats v2 shape).
  assert.equal(b20.alpha, +b20.exact.alpha.toFixed(2));
  assert.equal(b20.se, +b20.exact.se.toFixed(4));
  assert.ok(Array.isArray(block.gate.rule) || typeof block.gate.rule === 'string');
});

test('buildFactorAlphaBlock with no factor data at all is an honest empty block', () => {
  const groups = { 'a:b:': { section: 'a', tier: 'b', scope: null, h: { '5d': Array.from({ length: 70 }, (_, i) => ({ date: dateAt(i), net: 0.1, fx: { proxy: null, ff: null } })) } } };
  const block = FA.buildFactorAlphaBlock(groups, [['5d', 5]], { ff: { available: false } });
  assert.equal(block.groups['a:b:']['5d'].insufficient, true);
  assert.equal(block.proxyBetaCorrelation.pairs, 0);
  assert.equal(block.proxyBetaCorrelation.r, null);
  assert.equal(block.proxyBetaCorrelation.passes, false);
});
