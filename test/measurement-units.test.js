'use strict';
// The data-to-claim boundary for Market Pulse: a percent ETF proxy can never be printed
// as a basis-point curve level, and a real yield spread carries its unit and provenance.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/measurement');
const rs = require('../lib/pulse2-regime-stack');
const ca = require('../lib/pulse2-cross-asset');

const NOW = new Date('2026-10-03T16:00:00Z');
const MACRO = {
  growth: { trend: 'up', value: 2.1, source: 'test' },
  liquidity: { trend: 'up', value: 1, source: 'test' },
};
const yieldLevel = (instrument, value, observedAt = '2026-10-02') => M.makeMeasurement({
  metricId: `UST_${instrument}`, value, unit: 'pct', kind: 'level', instrument, isProxy: false, observedAt, source: 'TREASURY',
});
// Two sessions of bars ending on `date`, moving `pct` percent on the last session.
const twoBars = (pct, date = '2026-10-02') => [{ date: '2026-10-01', close: 100 }, { date, close: 100 * (1 + pct / 100) }];
const allText = layer => [...layer.supporting, ...layer.contradicting].map(o => o.text).join(' | ');

test('10Y 4.20% minus 2Y 4.42% is -0.22 pp = -22 bp, with the correct sign and unit', () => {
  const spread = M.yieldSpreadBp({ longLeg: yieldLevel('10Y', 4.20), shortLeg: yieldLevel('2Y', 4.42) });
  assert.equal(spread.valid, true);
  assert.equal(spread.value, -22);
  assert.equal(spread.unit, 'bp');
  assert.equal(spread.kind, 'spread');
  assert.equal(spread.isProxy, false);
  assert.equal(spread.inputs.length, 2, 'a derived measurement keeps its input provenance');
  assert.equal(M.formatMeasurement(spread, { signed: true }), '-22 bp');
});

test('a yield spread refuses a proxy leg, a non-level leg, and legs from different dates', () => {
  const proxy = M.makeMeasurement({ metricId: 'x', value: -0.3, unit: 'pct', kind: 'change', instrument: 'IEF', isProxy: true, source: 'daily-bars' });
  assert.equal(M.yieldSpreadBp({ longLeg: proxy, shortLeg: yieldLevel('2Y', 4.42) }).valid, false);
  const mixedDates = M.yieldSpreadBp({ longLeg: yieldLevel('10Y', 4.20, '2026-10-02'), shortLeg: yieldLevel('2Y', 4.42, '2026-10-01') });
  assert.equal(mixedDates.valid, false);
  assert.equal(mixedDates.value, null);
  assert.match(mixedDates.source, /different_dates/);
});

test('an unknown or invalid input is never a usable measurement', () => {
  for (const value of [null, undefined, NaN, Infinity, '4.2']) {
    const m = M.makeMeasurement({ metricId: 'x', value, unit: 'bp', kind: 'spread', instrument: 'i', isProxy: false, source: 's' });
    assert.equal(m.valid, false);
    assert.equal(M.supports(m, { unit: 'bp', kind: 'spread' }).ok, false);
    assert.equal(M.formatMeasurement(m), null);
  }
  assert.equal(M.supports(null, { unit: 'bp' }).ok, false);
});

test('the live defect: an IEF-vs-SHY relative return of -0.22% cannot become a bp curve sentence', () => {
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: { IEF: twoBars(-0.30), SHY: twoBars(-0.08), SPY: twoBars(0.5) }, equityChangePct: 0.5 });
  const row = m.rows.curve;
  assert.equal(row.changePct, -0.22);
  assert.equal(row.unit, 'pct');
  assert.equal(row.kind, 'relative_return');
  assert.equal(row.isProxy, true);
  assert.equal(row.instrument, 'IEF vs SHY');
  assert.equal(row.observedAt, '2026-10-02');
  assert.equal('value' in row, false, 'no unit-less `value` for a template to misread');
  assert.equal(M.supports({ ...row, value: row.changePct }, { unit: 'bp', kind: 'spread' }).ok, false);

  const stack = rs.buildRegimeStack({ marketState: {}, crossAsset: m, macroInputs: MACRO, now: NOW });
  const text = allText(stack.layers.strategic);
  assert.doesNotMatch(text, /2s10s|invert|bp\b/i, 'the proxy row must not produce any curve-level claim');
  assert.doesNotMatch(stack.layers.strategic.whatWouldFlipIt.join(' '), /2s10s/);
});

test('the proxy row no longer counts as a strategic input', () => {
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: { IEF: twoBars(-0.30), SHY: twoBars(-0.08) }, equityChangePct: 0.5 });
  const one = rs.buildRegimeStack({ marketState: {}, crossAsset: m, macroInputs: { growth: MACRO.growth }, now: NOW });
  assert.equal(one.layers.strategic.state, 'UNAVAILABLE');
  assert.match(one.layers.strategic.unavailableReason, /only 1\/5/);
});

test('a real, fresh 2s10s spread is stated in bp with its definition, source and as-of date', () => {
  const curve = { available: true, twoTenBp: -22, inverted: true, source: 'TREASURY:2s10s', asOf: '2026-10-02', stale: false };
  const stack = rs.buildRegimeStack({ marketState: {}, macroInputs: MACRO, curve, now: NOW });
  const line = stack.layers.strategic.contradicting.find(o => /2s10s/.test(o.text));
  assert.ok(line, 'an inverted curve is a contractionary observation');
  assert.equal(line.text, '2s10s curve inverted at -22 bp (10Y minus 2Y yield, as of 2026-10-02)');
  assert.equal(line.value, -22);
  assert.equal(line.source, 'TREASURY:2s10s');
});

test('a stale, unavailable or non-numeric curve read makes no curve statement', () => {
  const cases = [
    { available: true, twoTenBp: -22, source: 'FRED:DGS10−DGS2', asOf: '2026-09-01', stale: true },
    { available: false, reason: 'no 2s10s source' },
    { available: true, twoTenBp: null, source: 'TREASURY:2s10s', asOf: '2026-10-02', stale: false },
    null,
  ];
  for (const curve of cases) {
    assert.equal(rs.curveMeasurement(curve), null);
    const stack = rs.buildRegimeStack({ marketState: {}, macroInputs: MACRO, curve, now: NOW });
    assert.doesNotMatch(allText(stack.layers.strategic), /2s10s/);
  }
});

test('contradicting legs are named by the instrument measured, not the quantity proxied', () => {
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: { SHY: twoBars(0.4), UUP: twoBars(0.9), SPY: twoBars(0.8) }, equityChangePct: 0.8 });
  const legs = m.summary.contradictingLegs.join(' | ');
  assert.match(legs, /SHY \(proxy for 2-year Treasury yield\): \+0\.4%/);
  assert.match(legs, /UUP \(proxy for US dollar index\): \+0\.9%/);
  assert.doesNotMatch(legs, /(^|\| )2-year Treasury yield: /, 'a SHY price move is not a yield move');
});

test('tactical proxy text stays percent and proxy-labelled — never bp or a yield level', () => {
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: { HYG: twoBars(-0.8), LQD: twoBars(0.1), UUP: twoBars(0.9), SPY: twoBars(0.8) }, equityChangePct: 0.8 });
  const stack = rs.buildRegimeStack({ marketState: {}, crossAsset: m, now: NOW });
  const text = allText(stack.layers.tactical);
  assert.doesNotMatch(text, /\dbp|\d bp|yield/i);
});
