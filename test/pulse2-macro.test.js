'use strict';
// FRED adapter + strategic macro legs. Every fetch is injected — no network.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fred = require('../lib/fred');
const macro = require('../lib/pulse2-macro');

const NOW = Date.parse('2026-08-13T12:00:00Z');
const KEY = 'test-key';

// Monthly observations ending `daysAgo` before NOW, following `shape(i)`.
function obsSeries(n, shape, { stepDays = 30, endDaysAgo = 5 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(NOW - (endDaysAgo + (n - 1 - i) * stepDays) * 86_400_000);
    return { date: d.toISOString().slice(0, 10), value: shape(i) };
  });
}
const okFetch = byId => async url => {
  const id = decodeURIComponent((url.match(/series_id=([^&]+)/) || [])[1]);
  if (!(id in byId)) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => ({ observations: byId[id] }) };
};
const toFredRows = rows => rows.map(r => ({ date: r.date, value: String(r.value) }));

// ── Key gating ──────────────────────────────────────────────────────────────

test('FRED: with no key, every series is UNAVAILABLE with an actionable reason', async () => {
  const r = await fred.fetchSeries('INDPRO', { key: '', now: NOW });
  assert.equal(r.available, false);
  assert.match(r.reason, /FRED_API_KEY is not set/);
  assert.match(r.reason, /stays UNAVAILABLE rather than being guessed from price/i);
});

test('MACRO: with no key, inputs are null so the strategic layer stays UNAVAILABLE', async () => {
  const { inputs, diagnostics } = await macro.buildMacroInputs({ key: '' });
  assert.equal(inputs, null);
  assert.equal(diagnostics.available, false);
  assert.match(diagnostics.reason, /fredaccount\.stlouisfed\.org/);
});

// ── Series handling ─────────────────────────────────────────────────────────

test('FRED: missing values ("." ) are dropped, never coerced to zero', async () => {
  const rows = [{ date: '2026-06-01', value: '100' }, { date: '2026-07-01', value: '.' }, { date: '2026-08-01', value: '102' }];
  const r = await fred.fetchSeries('INDPRO', { key: KEY, now: NOW, fetchImpl: okFetch({ INDPRO: rows }) });
  assert.equal(r.available, true);
  assert.equal(r.observations.length, 2);
  assert.ok(r.observations.every(o => o.value > 0));
});

test('FRED: an all-missing series is UNAVAILABLE, not an empty success', async () => {
  const r = await fred.fetchSeries('INDPRO', { key: KEY, now: NOW, fetchImpl: okFetch({ INDPRO: [{ date: '2026-08-01', value: '.' }] }) });
  assert.equal(r.available, false);
  assert.match(r.reason, /no usable observations/i);
});

test('FRED: an HTTP failure degrades with the status, never throws', async () => {
  const r = await fred.fetchSeries('INDPRO', { key: KEY, now: NOW, fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal(r.available, false);
  assert.match(r.reason, /HTTP 429/);
});

test('FRED: a thrown fetch is caught and reported', async () => {
  const r = await fred.fetchSeries('INDPRO', { key: KEY, now: NOW, fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.equal(r.available, false);
  assert.match(r.reason, /socket hang up/);
});

test('FRED: a stale release is FLAGGED rather than presented as current', async () => {
  const old = obsSeries(20, i => 100 + i, { endDaysAgo: 200 });
  const r = await fred.fetchSeries('INDPRO', { key: KEY, now: NOW, fetchImpl: okFetch({ INDPRO: toFredRows(old) }) });
  assert.equal(r.available, true);
  assert.equal(r.stale, true);
  assert.match(r.staleReason, /release delayed or the series was discontinued/i);
});

test('FRED: every observation declares it is NOT backtest-safe (latest vintage)', async () => {
  const r = await fred.fetchSeries('INDPRO', { key: KEY, now: NOW, fetchImpl: okFetch({ INDPRO: toFredRows(obsSeries(20, i => 100 + i)) }) });
  assert.equal(r.backtestSafe, false);
  assert.match(r.vintageNote, /ALFRED vintage endpoints/);
});

// ── Trend ───────────────────────────────────────────────────────────────────

const mk = (rows, extra = {}) => ({ available: true, id: 'X', label: 'X', observations: rows, latest: rows[rows.length - 1], invert: false, stale: false, ...extra });

test('TREND: direction comes from the series own history, scaled by its own volatility', async () => {
  const rising = mk(obsSeries(20, i => 100 + i * 3));
  assert.equal(fred.trendOf(rising).trend, 'up');
  const falling = mk(obsSeries(20, i => 100 - i * 3));
  assert.equal(fred.trendOf(falling).trend, 'down');
});

test('TREND: a flat series is flat, not forced into a direction', async () => {
  // Genuinely flat: dispersion is float-noise relative to the level. Without a noise
  // floor this divides by a near-zero SD and reports a confident (spurious) trend.
  const flat = mk(obsSeries(20, i => 100 + (i % 2 === 0 ? 0.0001 : -0.0001)));
  const t = fred.trendOf(flat);
  assert.equal(t.trend, 'flat');
  assert.equal(t.belowNoiseFloor, true);
  // A series with real dispersion is still read normally.
  const real = mk(obsSeries(20, i => 100 + i * 3));
  assert.equal(fred.trendOf(real).belowNoiseFloor, false);
});

test('TREND: `invert` flips the reading — a rising drain is falling liquidity', async () => {
  const rows = obsSeries(20, i => 100 + i * 3);
  assert.equal(fred.trendOf(mk(rows, { invert: false })).trend, 'up');
  const inv = fred.trendOf(mk(rows, { invert: true }));
  assert.equal(inv.trend, 'down');
  assert.equal(inv.inverted, true);
});

test('TREND: too short a history yields no trend, with a reason', async () => {
  const t = fred.trendOf(mk(obsSeries(4, i => 100 + i)));
  assert.equal(t.available, false);
  assert.match(t.reason, /no trend can be established/i);
});

// ── Legs ────────────────────────────────────────────────────────────────────

const fullSet = () => ({
  INDPRO: toFredRows(obsSeries(30, i => 100 + i * 2)),
  GDPC1: toFredRows(obsSeries(30, i => 20000 + i * 50, { stepDays: 90, endDaysAgo: 40 })),
  PCEPILFE: toFredRows(obsSeries(30, i => 120 + i * 0.4)),
  CPIAUCSL: toFredRows(obsSeries(30, i => 300 + i)),
  WALCL: toFredRows(obsSeries(30, i => 7_000_000 + i * 10_000, { stepDays: 7, endDaysAgo: 3 })),
  RRPONTSYD: toFredRows(obsSeries(60, () => 400, { stepDays: 3, endDaysAgo: 1 })),
  WTREGEN: toFredRows(obsSeries(30, () => 700_000, { stepDays: 7, endDaysAgo: 3 })),
  DGS10: toFredRows(obsSeries(60, i => 4.2 - i * 0.01, { stepDays: 3, endDaysAgo: 1 })),
});

test('MACRO: builds the leg shape the regime stack already accepts', async () => {
  const { inputs, diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: okFetch(fullSet()) });
  assert.ok(inputs);
  for (const leg of ['growth', 'inflation', 'liquidity']) {
    assert.ok(inputs[leg], `${leg} must be present`);
    assert.ok(['up', 'down', 'flat'].includes(inputs[leg].trend));
    assert.ok(inputs[leg].source);
  }
  assert.ok(diagnostics.legsAvailable >= 3);
});

test('MACRO: net liquidity subtracts BOTH drains — a partial net is refused', async () => {
  const s = fullSet(); delete s.WTREGEN;
  const { inputs, diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: okFetch(s) });
  assert.equal(inputs.liquidity, undefined);
  assert.match(diagnostics.legs.liquidity.reason, /A partial net is NOT computed/);
  assert.match(diagnostics.legs.liquidity.reason, /flips the sign/);
});

test('MACRO: a rising drain reduces net liquidity even as the balance sheet grows', async () => {
  const s = fullSet();
  // Balance sheet flat, reverse repo climbing hard ⇒ net liquidity must read DOWN.
  s.WALCL = toFredRows(obsSeries(30, () => 7_000_000, { stepDays: 7, endDaysAgo: 3 }));
  s.RRPONTSYD = toFredRows(obsSeries(60, i => 100 + i * 20, { stepDays: 3, endDaysAgo: 1 }));
  const { inputs } = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: okFetch(s) });
  assert.equal(inputs.liquidity.trend, 'down');
});

test('MACRO: valuation refuses without an earnings yield — no constant is substituted', async () => {
  const { inputs, diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: okFetch(fullSet()) });
  assert.equal(inputs.valuation, undefined);
  assert.match(diagnostics.legs.valuation.reason, /a constant is NOT substituted/);
});

test('MACRO: with an earnings yield the valuation leg computes and states its orientation', async () => {
  const { inputs, diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, earningsYieldPct: 4.5, fetchImpl: okFetch(fullSet()) });
  assert.ok(inputs.valuation);
  assert.match(diagnostics.legs.valuation.orientationNote, /headwind/i);
});

test('MACRO: a failing series falls back to the next in the leg, recording the attempt', async () => {
  const s = fullSet(); delete s.PCEPILFE;               // core PCE down, CPI should carry
  const { inputs, diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: okFetch(s) });
  assert.ok(inputs.inflation);
  assert.match(inputs.inflation.source, /CPIAUCSL/);
  assert.ok(diagnostics.legs.inflation.attempts.some(a => a.id === 'PCEPILFE' && !a.ok));
});

test('MACRO: earningsRevisions is declared a KNOWN GAP, not silently absent', async () => {
  const { diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: okFetch(fullSet()) });
  assert.match(diagnostics.knownGap, /earningsRevisions/);
  assert.match(diagnostics.knownGap, /blocked-on-data/);
});

test('MACRO: the whole build is marked NOT backtest-safe', async () => {
  const { diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: okFetch(fullSet()) });
  assert.equal(diagnostics.backtestSafe, false);
  assert.match(diagnostics.vintageNote, /LIVE read only/i);
});

test('MACRO: total provider failure yields null inputs, never fabricated legs', async () => {
  const { inputs, diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(inputs, null);
  assert.equal(diagnostics.available, false);
  for (const leg of Object.values(diagnostics.legs)) assert.equal(leg.available, false);
});

// ── End-to-end into the regime stack ────────────────────────────────────────

test('STACK: real macro inputs move the strategic layer off UNAVAILABLE', async () => {
  const rs = require('../lib/pulse2-regime-stack');
  const { inputs } = await macro.buildMacroInputs({ key: KEY, now: NOW, earningsYieldPct: 4.5, fetchImpl: okFetch(fullSet()) });
  const before = rs.buildRegimeStack({ marketState: {}, macroInputs: null, now: new Date(NOW) });
  const after = rs.buildRegimeStack({ marketState: {}, macroInputs: inputs, now: new Date(NOW) });
  assert.equal(before.layers.strategic.state, 'UNAVAILABLE');
  assert.notEqual(after.layers.strategic.state, 'UNAVAILABLE');
  assert.equal(after.layers.strategic.available, true);
  assert.ok(after.layers.strategic.supporting.length + after.layers.strategic.contradicting.length > 0);
});

test('STACK: one usable leg is still not enough — the two-leg floor holds', async () => {
  const rs = require('../lib/pulse2-regime-stack');
  const s = fullSet();
  delete s.PCEPILFE; delete s.CPIAUCSL; delete s.WTREGEN;   // leaves growth only
  const { inputs } = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: okFetch(s) });
  assert.equal(Object.keys(inputs).length, 1);
  const stack = rs.buildRegimeStack({ marketState: {}, macroInputs: inputs, now: new Date(NOW) });
  assert.equal(stack.layers.strategic.state, 'UNAVAILABLE');
  assert.match(stack.layers.strategic.unavailableReason, /only 1\/5/);
});
