'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreMarkets, scoreSharp, buildBaseline, buildPrevOI, daysToClose, summarizeSharpValidation } = require('../lib/predmarkets');

const mkt = o => Object.assign({ venue: 'Kalshi', id: 't', group: 'CPI', title: 't', vol24: 0, volTotal: 0, oi: 0, liq: 0, prob: 0.5, probPrev: 0.5, closeTime: new Date(Date.now() + 3 * 86400000).toISOString() }, o);

test('daysToClose returns fractional days, null on bad input', () => {
  const d = daysToClose(new Date(Date.now() + 2 * 86400000).toISOString());
  assert.ok(d > 1.9 && d < 2.1);
  assert.equal(daysToClose(null), null);
  assert.equal(daysToClose('not-a-date'), null);
});

test('scoreMarkets flags a big odds move as unusual', () => {
  const out = scoreMarkets([mkt({ id: 'a', vol24: 100, prob: 0.6, probPrev: 0.45 })], {});
  assert.equal(out[0].unusual, true);             // 15pt move ≥ 8pt bigMove bar
  assert.ok(out[0].movePts >= 14);
});

test('scoreMarkets does not flag a flat liquid market', () => {
  const out = scoreMarkets([mkt({ id: 'a', vol24: 100, prob: 0.5, probPrev: 0.5 })], {});
  assert.equal(out[0].unusual, false);
});

test('buildBaseline computes per-id mean/std excluding today', () => {
  const snaps = [
    { date: '2026-06-01', snap: { a: { v: 100, oi: 10 } } },
    { date: '2026-06-02', snap: { a: { v: 200, oi: 20 } } },
    { date: '2026-06-03', snap: { a: { v: 300, oi: 30 } } },
    { date: '2026-06-04', snap: { a: { v: 9999, oi: 99 } } },  // today — excluded
  ];
  const b = buildBaseline(snaps, '2026-06-04');
  assert.equal(b.a.n, 3);
  assert.equal(b.a.mean, 200);
  assert.ok(b.a.std > 81 && b.a.std < 82);                    // popn std of 100/200/300 ≈ 81.6
});

test('buildBaseline accepts legacy numeric snapshots', () => {
  const b = buildBaseline([{ date: '2026-06-01', snap: { a: 50 } }, { date: '2026-06-02', snap: { a: 150 } }], '2026-06-09');
  assert.equal(b.a.mean, 100);
});

test('buildPrevOI takes OI from the most recent prior day', () => {
  const snaps = [
    { date: '2026-06-01', snap: { a: { v: 1, oi: 500 } } },
    { date: '2026-06-02', snap: { a: { v: 1, oi: 800 } } },
  ];
  assert.deepEqual(buildPrevOI(snaps, '2026-06-03'), { a: 800 });
});

test('scoreSharp flags a sized longshot that is rising', () => {
  const m = mkt({ id: 'a', vol24: 9000, oi: 9000, prob: 0.24, probPrev: 0.09 });  // ~$2.1k notional
  const out = scoreSharp([m], {}, {});
  assert.equal(out[0].sharpFlag, true);
  assert.ok(out[0].tells.some(t => /longshot/.test(t)));
});

test('scoreSharp does NOT flag a cheap longshot with tiny money', () => {
  const m = mkt({ id: 'a', vol24: 60, oi: 60, prob: 0.24, probPrev: 0.09 });       // ~$14 notional
  assert.equal(scoreSharp([m], {}, {})[0].sharpFlag, false);
});

test('scoreSharp does NOT flag a liquid market with no conviction', () => {
  const m = mkt({ id: 'a', vol24: 50000, oi: 60000, prob: 0.5, probPrev: 0.5 });
  assert.equal(scoreSharp([m], {}, {})[0].sharpFlag, false);
});

test('scoreSharp flags fresh open-interest build (new money)', () => {
  const m = mkt({ id: 'a', vol24: 6000, oi: 11000, prob: 0.55, probPrev: 0.52 });
  const out = scoreSharp([m], {}, { a: 5000 });               // OI 5000 → 11000 = +120%
  assert.equal(out[0].sharpFlag, true);
  assert.ok(out[0].tells.some(t => /new money/.test(t)));
});

test('scoreSharp ignores a phantom move from probPrev=0', () => {
  const m = mkt({ id: 'a', vol24: 9000, oi: 9000, prob: 0.24, probPrev: 0 });
  assert.equal(scoreSharp([m], {}, {})[0].lc, 0);             // no "from 0%" longshot signal
});

test('summarizeSharpValidation: hit rate + pending + by-tell', () => {
  const evs = [
    { outcome: 'yes', hit: true, tells: ['🎯 longshot conviction — bought YES from 9%'] },
    { outcome: 'no', hit: false, tells: ['🎯 longshot conviction', '📈 new money — open interest +88%'] },
    { outcome: 'no', hit: true, tells: ['📈 new money — open interest +50%'] },
    { outcome: 'yes', hit: true, tells: ['💰 size exceeds open positions (aggressive)'] },
    { id: 'p1' },   // unresolved
  ];
  const s = summarizeSharpValidation(evs);
  assert.equal(s.n, 4);
  assert.equal(s.hits, 3);
  assert.equal(s.rate, 75);
  assert.equal(s.pending, 1);
  assert.deepEqual(s.byTell.longshot, { n: 2, hits: 1 });
  assert.deepEqual(s.byTell.oibuild, { n: 2, hits: 1 });
});

test('summarizeSharpValidation: empty is null rate', () => {
  const s = summarizeSharpValidation([]);
  assert.equal(s.n, 0);
  assert.equal(s.rate, null);
});
