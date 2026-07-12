'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/sectionscore');

// Build a candle series with a constant compounding daily rate.
function ramp(n, rate, startMs = Date.UTC(2025, 0, 1)) {
  const out = [];
  let px = 50;
  for (let i = 0; i < n; i++) {
    const d = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
    const vol = 1_000_000 + (i % 7) * 50_000;
    out.push({ date: d, open: +px.toFixed(3), high: +(px * 1.01).toFixed(3), low: +(px * 0.99).toFixed(3), close: +px.toFixed(3), volume: vol });
    px *= (1 + rate / 100);
  }
  return out;
}

test('rankPct: 0-100 average-rank; nulls map to neutral 50; ties share', () => {
  assert.deepEqual(S.rankPct([1, 2, 3, 4, 5]), [0, 25, 50, 75, 100]);
  const withNull = S.rankPct([10, null, 30]);
  assert.equal(withNull[1], 50);         // null → neutral
  assert.equal(withNull[0], 0);
  assert.equal(withNull[2], 100);
  const ties = S.rankPct([5, 5, 9]);
  assert.equal(ties[0], ties[1]);
});

test('factorsFor: reconstructs a real screener factor vector from candle slice as-of date', () => {
  const c = ramp(300, 0.3);
  const fac = S.factorsFor(c, c[250].date, 'TEST', null);
  assert.ok(fac && fac.f, 'should return factors');
  assert.ok(Number.isFinite(fac.f.mom63));
  assert.ok(Number.isFinite(fac.f.trendTemplate));
  // point-in-time: no look-ahead past the as-of date
  const facEarly = S.factorsFor(c, c[100].date, 'TEST', null);
  assert.ok(facEarly && facEarly.f);
});

test('factorsFor: null when history too short', () => {
  assert.equal(S.factorsFor(ramp(20, 1), '2025-01-15', 'X', null), null);
  assert.equal(S.factorsFor([], '2025-01-15', 'X', null), null);
});

test('reconstruct: screener picks are scored by the real Apex scorer; Ghost by the Ghost scorer', () => {
  const up = ramp(300, 0.4);    // strong uptrend
  const flat = ramp(300, 0.0);
  const down = ramp(300, -0.3);
  const candlesByT = { UP: up, FLAT: flat, DOWN: down };
  const picks = [
    { ticker: 'UP', date: up[260].date, section: 'screener', regime: 'risk-on' },
    { ticker: 'DOWN', date: down[260].date, section: 'screener', regime: 'risk-on' },
    { ticker: 'FLAT', date: flat[260].date, section: 'Ghost', regime: 'risk-on' },
  ];
  const spyByDate = {}; flat.forEach(c => { spyByDate[c.date] = c.close; });
  const out = S.reconstruct(picks, { candlesFor: t => candlesByT[t], spyByDate });
  assert.equal(out[0].method, 'apex');
  assert.equal(out[1].method, 'apex');
  assert.equal(out[2].method, 'ghost');
  out.forEach(o => assert.ok(o.score >= 0 && o.score <= 100, `score in range: ${o.score}`));
  // Within the apex cohort, the strong uptrend outscores the downtrend.
  assert.ok(out[0].score > out[1].score, `UP ${out[0].score} should beat DOWN ${out[1].score}`);
});

test('reconstruct: non-reconstructable sections fall back to the proxy, tagged as such', () => {
  const c = ramp(300, 0.2);
  const picks = [
    { ticker: 'A', date: c[260].date, section: 'CERN', regime: 'neutral' },
    { ticker: 'B', date: c[260].date, section: 'ReadThrough', regime: 'neutral' },
  ];
  const out = S.reconstruct(picks, { candlesFor: () => c, proxyScore: i => [42, 88][i] });
  assert.deepEqual(out.map(o => o.method), ['proxy', 'proxy']);
  assert.equal(out[0].score, 42);
  assert.equal(out[1].score, 88);
});

test('reconstruct: a pick with no candles and no proxy yields a null score, method none', () => {
  const out = S.reconstruct([{ ticker: 'Z', date: '2025-06-01', section: 'screener', regime: 'neutral' }],
    { candlesFor: () => undefined });
  assert.equal(out[0].score, null);
  assert.equal(out[0].method, 'none');
});

test('momentumScore: real momentum scorer — uptrend is bullish, and StrongSell negates it (directional)', () => {
  const up = ramp(120, 0.5);   // steady strong uptrend
  const asOf = up[110].date;
  const longC = S.momentumScore(up, { date: asOf, tier: 'StrongBuy' });
  const shortC = S.momentumScore(up, { date: asOf, tier: 'StrongSell' });
  assert.ok(longC > 0, `uptrend long conviction should be positive: ${longC}`);
  assert.equal(shortC, -longC);           // a short on a strong uptrend is low conviction
});

test('momentumScore: null when history is too short for a trend read', () => {
  assert.equal(S.momentumScore(ramp(30, 1), { date: '2025-01-20', tier: 'StrongBuy' }), null);
});

test('daytradeScore: real intraday ranker — a volume+price burst scores above a quiet bar', () => {
  const base = ramp(40, 0.05);
  const quiet = base.slice();
  const burst = base.slice();
  // append a high-volume up-gap bar to `burst`, a normal bar to `quiet`
  const nextDate = new Date(Date.UTC(2025, 0, 1) + 40 * 86400000).toISOString().slice(0, 10);
  const prev = base[base.length - 1].close;
  burst.push({ date: nextDate, open: prev * 1.05, high: prev * 1.12, low: prev * 1.04, close: prev * 1.10, volume: 8_000_000 });
  quiet.push({ date: nextDate, open: prev, high: prev * 1.005, low: prev * 0.995, close: prev * 1.001, volume: 900_000 });
  const sB = S.daytradeScore(burst, { date: nextDate });
  const sQ = S.daytradeScore(quiet, { date: nextDate });
  assert.ok(sB > sQ, `burst ${sB} should outrank quiet ${sQ}`);
});

test('reconstruct: momentum & daytrade picks use their OWN scorers (not proxy)', () => {
  const up = ramp(120, 0.4);
  const base = ramp(120, 0.05);
  const nextDate = new Date(Date.UTC(2025, 0, 1) + 120 * 86400000).toISOString().slice(0, 10);
  const prev = base[base.length - 1].close;
  base.push({ date: nextDate, open: prev * 1.04, high: prev * 1.1, low: prev * 1.03, close: prev * 1.08, volume: 7_000_000 });
  const candlesByT = { MOM: up, DAY: base };
  const picks = [
    { ticker: 'MOM', date: up[110].date, section: 'momentum', tier: 'StrongBuy', regime: 'risk-on' },
    { ticker: 'DAY', date: nextDate, section: 'daytrade', regime: 'risk-on' },
  ];
  const out = S.reconstruct(picks, { candlesFor: t => candlesByT[t], proxyScore: () => 50 });
  assert.equal(out[0].method, 'momentum');
  assert.equal(out[1].method, 'daytrade');
  assert.ok(Number.isFinite(out[0].score) && Number.isFinite(out[1].score));
});

test('apexRegime: maps macro buckets to the Apex preset keys', () => {
  assert.equal(S.apexRegime('risk-on'), 'RISK_ON');
  assert.equal(S.apexRegime('risk-off'), 'RISK_OFF');
  assert.equal(S.apexRegime(null), 'NEUTRAL');
});
