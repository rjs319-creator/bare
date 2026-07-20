'use strict';
// EXPERIMENT #4 harness tests. Like #3, the point is leakage: the baseline must not see future
// bars, the outcome must be a real elapsed forward fill, and the accounting-forensics signal must
// be invisible until its XBRL facts are FILED — AND a later-filed restatement must never overwrite
// the original reported vintage. If any of these leak, a verdict could hide a real edge or invent
// one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/nsl/forensics-incremental');

// Weekday-aware series: close moves by `step`/day from `start` (same generator as #3).
function series(from, n, start = 100, step = 1) {
  const out = []; const d = new Date(from + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const close = start + i * step;
    out.push({ date: d.toISOString().slice(0, 10), open: close, high: close + 0.5, low: close - 0.5, close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const CFG = { lookbackBars: 20, skipBars: 2, horizonBars: 5 };

// Build a minimal companyfacts payload. `conceptVals` maps a CONCEPTS key to
// [[periodEnd, val, filed], ...] annual (10-K) points.
const ALIAS = { revenue: 'Revenues', receivables: 'AccountsReceivableNetCurrent', inventory: 'InventoryNet',
  netIncome: 'NetIncomeLoss', cfo: 'NetCashProvidedByUsedInOperatingActivities', assets: 'Assets', shares: 'CommonStockSharesOutstanding' };
function xbrl(conceptVals) {
  const gaap = {};
  for (const k of Object.keys(conceptVals)) {
    const unitKey = k === 'shares' ? 'shares' : 'USD';
    gaap[ALIAS[k]] = { units: { [unitKey]: conceptVals[k].map(([end, val, filed]) => ({ end, val, form: '10-K', filed })) } };
  }
  return { facts: { 'us-gaap': gaap } };
}

// A healthy filer with two annual vintages: FY2022 (filed 2023-02-15) and FY2023 (filed 2024-02-15).
const healthy = () => xbrl({
  revenue: [['2022-12-31', 1000, '2023-02-15'], ['2023-12-31', 1100, '2024-02-15']],
  receivables: [['2022-12-31', 200, '2023-02-15'], ['2023-12-31', 210, '2024-02-15']],
  netIncome: [['2022-12-31', 100, '2023-02-15'], ['2023-12-31', 120, '2024-02-15']],
  cfo: [['2022-12-31', 110, '2023-02-15'], ['2023-12-31', 140, '2024-02-15']],
  assets: [['2022-12-31', 2000, '2023-02-15'], ['2023-12-31', 2100, '2024-02-15']],
});

// ── signal PIT / leakage guard ───────────────────────────────────────────────
test('forensicsSignal is null before the 2nd annual is FILED, finite after', () => {
  const f = healthy();
  // As-of 2023-06-01 only FY2022 is public → a single annual → no transition → null (excluded).
  assert.equal(H.forensicsSignal(f, '2023-06-01'), null, 'one visible annual cannot form a transition');
  // As-of 2024-06-01 both annuals are public → a finite composite.
  const after = H.forensicsSignal(f, '2024-06-01');
  assert.ok(Number.isFinite(after), `two filed annuals should read a finite composite, got ${after}`);
});

test('forensicsSignal never sees a fact filed after asOf', () => {
  const f = healthy();
  // Append a FY2023 restatement with a wildly different value, filed LATE (2024-08-01).
  f.facts['us-gaap'].Revenues.units.USD.push({ end: '2023-12-31', val: 5000, form: '10-K/A', filed: '2024-08-01' });
  // As-of 2024-06-01 the restatement does not exist yet → identical to the un-restated payload.
  assert.equal(H.forensicsSignal(f, '2024-06-01'), H.forensicsSignal(healthy(), '2024-06-01'),
    'a not-yet-filed restatement must be invisible');
});

test('forensicsSignal keeps the ORIGINAL vintage even once a restatement is public', () => {
  const f = healthy();
  f.facts['us-gaap'].Revenues.units.USD.push({ end: '2023-12-31', val: 5000, form: '10-K/A', filed: '2024-08-01' });
  // As-of 2024-09-01 BOTH the original and the restatement are public, but the earliest-filed value
  // per period-end wins → the composite equals the pre-restatement reading the market first saw.
  assert.equal(H.forensicsSignal(f, '2024-09-01'), H.forensicsSignal(healthy(), '2024-06-01'),
    'a later restatement must not overwrite the reported vintage');
});

test('forensicsSignal is null for a name with no facts or too few concepts', () => {
  assert.equal(H.forensicsSignal(null, '2024-06-01'), null, 'no payload → excluded');
  assert.equal(H.forensicsSignal({ facts: { 'us-gaap': {} } }, '2024-06-01'), null, 'no concepts → excluded');
  // Only ONE concept present (need ≥3) → insufficient → null, never a fabricated 0.
  const thin = xbrl({ revenue: [['2022-12-31', 1000, '2023-02-15'], ['2023-12-31', 1100, '2024-02-15']] });
  assert.equal(H.forensicsSignal(thin, '2024-06-01'), null, 'one concept cannot form a transition');
});

// ── panel assembly ───────────────────────────────────────────────────────────
test('assembleSamples emits one complete PIT row per (date,ticker) and drops incomplete ones', () => {
  const candles = series('2024-02-19', 120, 100, 1);
  const tickerData = [
    { ticker: 'AAA', candles, facts: healthy() },                       // finite signal at both dates
    { ticker: 'BBB', candles, facts: { facts: { 'us-gaap': {} } } },    // no facts → dropped (noSignal)
  ];
  const dates = ['2024-05-01', '2024-06-03'];
  const { samples, diagnostics } = H.assembleSamples(tickerData, dates, CFG);
  assert.equal(samples.length, 2, 'AAA contributes both dates; BBB none');
  assert.ok(samples.every(s => s.ticker === 'AAA'));
  assert.ok(diagnostics.dropped.noSignal >= 2, 'the factless name is dropped for lack of signal');
  assert.ok(samples.every(s => Number.isFinite(s.baseline) && Number.isFinite(s.signal) && Number.isFinite(s.outcome)));
});

test('runForensicsIncremental returns an evaluation (insufficient on a tiny panel, honestly)', () => {
  const candles = series('2024-02-19', 120, 100, 1);
  const tickerData = [{ ticker: 'AAA', candles, facts: healthy() }];
  const r = H.runForensicsIncremental(tickerData, ['2024-05-01'], CFG, { minPerDate: 8, minDates: 8 });
  assert.ok(r.evaluation.insufficient, 'one name on one date cannot support a cross-sectional IC');
  assert.equal(typeof r.nSamples, 'number');
});
