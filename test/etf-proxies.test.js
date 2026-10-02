'use strict';
// Style-ETF factor proxies + French pseudo-candles: window returns must agree with the
// Scoreboard's own benchmark window (spyForwardReturn) on every entry basis, or the
// factor regression would be measured on a different ruler than the excess it adjusts.
const test = require('node:test');
const assert = require('node:assert/strict');
const EP = require('../lib/factors/etf-proxies');
const { spyForwardReturn } = require('../lib/apex-routes');

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `expected ${b}, got ${a}`);

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }
function series(seed, n = 60, start = 100) {
  const rnd = lcg(seed);
  const out = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 5 + i));
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const open = c * (1 + (rnd() - 0.5) * 0.01);
    c = open * (1 + (rnd() - 0.5) * 0.02);
    out.push({ date: d.toISOString().slice(0, 10), open, high: Math.max(open, c), low: Math.min(open, c), close: c, volume: 1e6 });
  }
  return out;
}

test('factorWindowReturn matches spyForwardReturn on close, next-open and trigger-verified bases', () => {
  const cs = series(3);
  const dates = cs.map(c => c.date);
  for (const bars of [1, 5, 21]) {
    for (let i = 0; i < dates.length; i += 7) {
      const pick = { date: dates[i] };
      const bases = [
        {},
        { entryBasis: 'next-open' },
        { entryBasis: 'trigger-verified', anchorDate: dates[Math.min(i + 1, dates.length - 1)], anchorAtOpen: true },
        { entryBasis: 'trigger-verified', anchorDate: dates[Math.min(i + 1, dates.length - 1)], anchorAtOpen: false },
      ];
      for (const opts of bases) {
        const a = spyForwardReturn(cs, pick, bars, opts);
        const b = EP.factorWindowReturn(cs, pick, bars, opts);
        if (a == null) assert.equal(b, null); else close(a, b, 1e-9);
      }
    }
  }
  // A pick dated BEFORE the series starts resolves to null on both.
  assert.equal(EP.factorWindowReturn(cs, { date: '2025-01-01' }, 5, {}), null);
  // A weekend pick date anchors to the prior session like the Scoreboard does.
  close(EP.factorWindowReturn(cs, { date: '2026-01-10' }, 5, {}), spyForwardReturn(cs, { date: '2026-01-10' }, 5, {}));
});

test('proxyFactorReturns: long-minus-short legs in percent, null when a leg is missing', () => {
  const hist = new Map([['SPY', series(1)], ['IWM', series(2)], ['IWD', series(4)], ['IWF', series(5)], ['MTUM', series(6)]]);  // QUAL absent
  const pick = { date: '2026-01-12' };
  const fx = EP.proxyFactorReturns(hist, pick, 5, {});
  const w = (t) => EP.factorWindowReturn(hist.get(t), pick, 5, {});
  close(fx.mkt, w('SPY'));
  close(fx.size, w('IWM') - w('SPY'));
  close(fx.value, w('IWD') - w('IWF'));
  close(fx.mom, w('MTUM') - w('SPY'));
  assert.equal(fx.quality, null, 'missing QUAL history → that factor is null, the rest survive');
  assert.deepEqual(Object.keys(fx), EP.PROXY_KEYS);
});

test('ffPseudoCandles compounds the daily factor into an index with open = prior close', () => {
  const doc = { factors: ['mktRf', 'smb', 'hml', 'rmw', 'cma', 'mom', 'rf'], rows: [
    ['2026-01-05', 1.0, 0, 0, 0, 0, 0.5, 0.01],
    ['2026-01-06', -0.5, 0, 0, 0, 0, null, 0.01],
    ['2026-01-07', 2.0, 0, 0, 0, 0, 1.0, 0.01],
  ] };
  const by = EP.ffCandlesByKey(doc);
  const m = by.mktRf;
  assert.equal(m.length, 3);
  close(m[0].close, 100 * 1.01);
  close(m[1].open, m[0].close);
  close(m[1].close, 100 * 1.01 * 0.995);
  close(m[2].close, 100 * 1.01 * 0.995 * 1.02);
  // A null day breaks the compounding chain honestly: that bar is skipped, not zero-filled.
  assert.equal(by.mom.length, 2);
  // Window return over the index equals the compounded factor return in percent.
  const r = EP.factorWindowReturn(m, { date: '2026-01-05' }, 2, {});
  close(r, (0.995 * 1.02 - 1) * 100);
});

test('factorWindowReturns returns both the proxy vector and the FF vector (FF null past its last date)', () => {
  const hist = new Map(EP.PROXY_TICKERS.map((t, k) => [t, series(10 + k)]));
  const doc = { factors: ['mktRf', 'smb', 'hml', 'rmw', 'cma', 'mom', 'rf'], rows: hist.get('SPY').slice(0, 20).map(c => [c.date, 0.1, 0.0, 0.05, -0.02, 0.01, 0.2, 0.01]) };
  const ff = EP.ffCandlesByKey(doc);
  const early = EP.factorWindowReturns({ proxyHist: hist, ffCandles: ff, pick: { date: hist.get('SPY')[2].date }, bars: 5, benchOpts: {} });
  assert.ok(early.proxy && Number.isFinite(early.proxy.mkt));
  assert.ok(early.ff && Number.isFinite(early.ff.mktRf) && Number.isFinite(early.ff.rf));
  assert.deepEqual(Object.keys(early.ff), [...EP.FF_KEYS, 'rf']);
  const late = EP.factorWindowReturns({ proxyHist: hist, ffCandles: ff, pick: { date: hist.get('SPY')[30].date }, bars: 5, benchOpts: {} });
  assert.ok(late.proxy && Number.isFinite(late.proxy.mkt), 'proxies cover the live window');
  assert.equal(late.ff, null, 'French data has not been published for this window yet');
  const none = EP.factorWindowReturns({ proxyHist: new Map(), ffCandles: null, pick: { date: '2026-01-12' }, bars: 5, benchOpts: {} });
  assert.equal(none.proxy, null); assert.equal(none.ff, null);
});

test('PROXY_TO_FF maps every proxy to a French factor the correlation diagnostic can pair', () => {
  for (const k of EP.PROXY_KEYS) assert.ok(EP.FF_KEYS.includes(EP.PROXY_TO_FF[k]), k);
  assert.ok(EP.PROXY_TICKERS.includes('SPY'));
});
