'use strict';
// Wiring pins for proposals #12/#13: registry row, tracker ops, nightly step, CERN SPLIT_FLOW +
// state hydration, Ignition feature pass-through, Session Board earnings-today, and the
// Treasury-first / FRED-fallback / BLS-third macro legs. No network (every fetch injected).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HR = require('../lib/research/hypothesis-registry');
const WC = require('../lib/warm-chains');
const { CERN, EVENT_TYPES } = require('../lib/cern');
const SB = require('../lib/session-board');
const macro = require('../lib/pulse2-macro');
const fred = require('../lib/fred');

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('registry: the short-volume decile hypothesis is preregistered, open, weight-0, with a cross-sectional placebo and a minimum N', () => {
  const h = HR.find('short-volume-ratio-top-decile');
  assert.ok(h, 'row missing');
  assert.deepEqual(HR.validateHypothesis(h), { valid: true, errors: [] });
  assert.equal(h.status, 'open');
  assert.equal(h.familyId, 'alt-signals');
  assert.equal(h.mode, 'confirmatory');
  assert.match(h.baseline, /MIDDLE decile/);
  assert.match(h.primaryMetric, /Benjamini-Hochberg/);
  assert.match(h.stoppingRule, /60 decision dates AND 600 top-decile events/);
  assert.match(h.note, /never as score inputs/);
  assert.match(h.note, /non-commercial/);
});

test('tracker: shortvoltick is PRIVILEGED, shortvol is a public read, both routed', () => {
  const t = src('api/tracker.js');
  assert.match(t, /\n\s*'shortvoltick',/);
  assert.doesNotMatch(t, /\n\s*'shortvol',/, 'the read op must stay public');
  assert.match(t, /op === 'shortvol'\) return require\('\.\.\/lib\/finra-shortvol-routes'\)\.runShortVol\(/);
  assert.match(t, /op === 'shortvoltick'\) return require\('\.\.\/lib\/finra-shortvol-routes'\)\.runShortVolTick\(/);
});

test('nightly: op=shortvoltick rides the altprobes chain (no new root → matrix unchanged)', () => {
  assert.ok(WC.CHAINS.altprobes.includes('op=shortvoltick'));
  assert.ok(WC.ROOT_CHAINS.includes('altprobes'));
  assert.equal(WC.ROOT_CHAINS.filter((r) => /shortvol/.test(r)).length, 0);
});

test('CERN: SPLIT_FLOW is a logOnly candidate type and a legacy persisted state gains it on load (withCurrentTypes) so addEvent accepts it', () => {
  assert.equal(EVENT_TYPES.SPLIT_FLOW.logOnly, true);
  const legacy = JSON.parse(JSON.stringify(CERN.freshState()));
  delete legacy.types.SPLIT_FLOW;
  legacy.ledger.push({ marker: 'keep-me' });
  const c = CERN.load(legacy);
  assert.ok(c.s.types.SPLIT_FLOW, 'missing type added with fresh priors');
  assert.equal(c.s.types.SPLIT_FLOW.mu, EVENT_TYPES.SPLIT_FLOW.priorKappa);
  assert.deepEqual(c.s.ledger, [{ marker: 'keep-me' }], 'everything else preserved');
  assert.deepEqual(legacy.types.SPLIT_FLOW, undefined, 'input state not mutated');
  const full = CERN.freshState();
  assert.equal(CERN.withCurrentTypes(full), full, 'same object when nothing is missing');
  const added = c.addEvent({ type: 'SPLIT_FLOW', symbol: 'DXJ', dateMs: Date.parse('2026-10-09T00:00:00Z'), estFlowShares: 1000, direction: 1, meta: {} });
  assert.equal(added, true);
});

test('Ignition: shortVolume rides the view next to shortPressure as a feature, and the score never reads it', () => {
  const live = src('lib/ignition-live.js');
  assert.match(live, /shortVolume: ctx\.shortVolume \|\| null,/);
  assert.doesNotMatch(live, /ctx\.shortVolume\.(z20|shortVolRatio)/, 'no score arithmetic touches the feature');
  const routes = src('lib/ignition-live-routes.js');
  assert.match(routes, /shortVolume: SV\.featuresFor\(shortVolDoc, r\.ticker\)/);
  const cernRun = src('lib/cern-run.js');
  assert.match(cernRun, /shortVolume: SV\.featuresFor\(svDoc, sym\)/);
  assert.match(cernRun, /splitsToCernEvents\(rows, \{ nowMs, advShares \}\)/);
});

test('Session Board: earnings-today check/flag come only from the calendar; absent calendar → null, never "no"', () => {
  const row = { ticker: 'ABC', source: 'screener', section: 'Screener', horizon: 'swing', side: 'long', entry: 10, stop: 9, target: 12 };
  const with_ = SB.assembleSessionBoard({ now: new Date('2026-10-02T13:00:00Z'), todayRows: [row], earningsToday: { date: '2026-10-02', source: 'nasdaq', tickers: ['ABC'] } });
  const item = [...with_.items, ...with_.heldOut].find((i) => i.ticker === 'ABC');
  assert.equal(item.flags.earningsToday, true);
  const chk = item.checks.find((c) => c.key === 'earningsToday');
  assert.equal(chk.value, 'yes');
  assert.equal(chk.ok, false);
  assert.deepEqual(with_.calendar, { date: '2026-10-02', source: 'nasdaq', earningsCount: 1, onBoard: ['ABC'] });
  const without = SB.assembleSessionBoard({ now: new Date('2026-10-02T13:00:00Z'), todayRows: [row] });
  const it2 = [...without.items, ...without.heldOut].find((i) => i.ticker === 'ABC');
  assert.equal(it2.flags.earningsToday, null);
  assert.equal(it2.checks.find((c) => c.key === 'earningsToday').value, null);
  assert.equal(without.calendar, null);
});

// ── pulse2-macro: Treasury first, FRED fallback, BLS third ──────────────────
const NOW = Date.parse('2026-10-02T12:00:00Z');
const KEY = 'test-key';
function obsSeries(n, shape, { stepDays = 30, endDaysAgo = 5 } = {}) {
  return Array.from({ length: n }, (_, i) => ({ date: new Date(NOW - (endDaysAgo + (n - 1 - i) * stepDays) * 86_400_000).toISOString().slice(0, 10), value: shape(i) }));
}
const fredRows = (rows) => rows.map((r) => ({ date: r.date, value: String(r.value) }));
const fredFetch = (byId) => async (url) => {
  const id = decodeURIComponent((url.match(/series_id=([^&]+)/) || [])[1]);
  if (!(id in byId)) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => ({ observations: byId[id] }) };
};
const daily = (n, shape) => obsSeries(n, shape, { stepDays: 1, endDaysAgo: 1 });
const curveOk = () => {
  const obs = daily(40, (i) => i).map((o, i) => ({ date: o.date, y2: 4.0, y10: 4.5 + i * 0.01, spreadBp: +((0.5 + i * 0.01) * 100).toFixed(1), tenors: {} }));
  return { available: true, source: 'treasury', observations: obs, latest: obs[obs.length - 1], ageDays: 1, stale: false, fetchedAt: 'x' };
};
const curveDown = async () => ({ available: false, reason: 'treasury HTTP 503', source: 'treasury' });
const blsOk = async () => ({ available: true, id: 'CUUR0000SA0', label: 'CPI-U', source: 'BLS', invert: false, observations: obsSeries(24, (i) => 300 + i), latest: { date: 'd', value: 323 }, stale: false });
const blsDown = async () => ({ available: false, reason: 'BLS down' });
const FRED_ALL = {
  INDPRO: fredRows(obsSeries(24, (i) => 100 + i)), PCEPILFE: fredRows(obsSeries(24, (i) => 120 + i * 0.2)),
  WALCL: fredRows(obsSeries(60, (i) => 7_000_000 + i * 1000, { stepDays: 7 })), RRPONTSYD: fredRows(daily(400, () => 500)), WTREGEN: fredRows(obsSeries(60, () => 700_000, { stepDays: 7 })),
  DGS10: fredRows(daily(60, (i) => 4.2 - i * 0.01)), DGS2: fredRows(daily(60, (i) => 3.8 - i * 0.02)),
};

test('macro: Treasury supplies the 10y and the 2s10s when available; FRED is not consulted for them', async () => {
  const { diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, earningsYieldPct: 5, fetchImpl: fredFetch(FRED_ALL), fetchCurve: async () => curveOk(), fetchBls: blsDown });
  assert.equal(diagnostics.version, 'pulse2-macro-v2');
  assert.match(diagnostics.legs.valuation.source, /^TREASURY:10Y/);
  assert.equal(diagnostics.curve.available, true);
  assert.equal(diagnostics.curve.source, 'TREASURY:2s10s');
  assert.equal(diagnostics.curve.twoTenBp, 89);
  assert.equal(diagnostics.curve.inverted, false);
  assert.equal(diagnostics.curve.backtestSafe, true);
  assert.deepEqual(diagnostics.sources, { tenYear: 'treasury', curve: 'TREASURY:2s10s' });
});

test('macro: with Treasury down, FRED DGS10 carries valuation and DGS10−DGS2 carries the curve; the attempt trail says why', async () => {
  const { diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, earningsYieldPct: 5, fetchImpl: fredFetch(FRED_ALL), fetchCurve: curveDown, fetchBls: blsDown });
  assert.match(diagnostics.legs.valuation.source, /^FRED:DGS10/);
  assert.equal(diagnostics.curve.source, 'FRED:DGS10−DGS2');
  assert.ok(Number.isFinite(diagnostics.curve.twoTenBp));
  assert.equal(diagnostics.curve.backtestSafe, false);
  assert.ok(diagnostics.curve.attempts.some((a) => a.id === 'TREASURY_2S10S' && !a.ok && /503/.test(a.reason)));
  assert.equal(diagnostics.sources.tenYear, 'FRED');
  // Both down: valuation names both failures.
  const none = await macro.buildMacroInputs({ key: KEY, now: NOW, earningsYieldPct: 5, fetchImpl: fredFetch({ INDPRO: FRED_ALL.INDPRO }), fetchCurve: curveDown, fetchBls: blsDown });
  assert.match(none.diagnostics.legs.valuation.reason, /treasury: treasury HTTP 503; FRED DGS10:/);
  assert.equal(none.diagnostics.curve.available, false);
});

test('macro: BLS CPI is the third inflation attempt — used when both FRED inflation series fail, labeled BLS', async () => {
  const noInflation = { ...FRED_ALL }; delete noInflation.PCEPILFE;
  const { inputs, diagnostics } = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: fredFetch(noInflation), fetchCurve: curveDown, fetchBls: blsOk });
  assert.equal(diagnostics.legs.inflation.available, true);
  assert.equal(diagnostics.legs.inflation.source, 'BLS:CUUR0000SA0');
  assert.equal(diagnostics.legs.inflation.trend, 'up');
  assert.deepEqual(diagnostics.legs.inflation.attempts.map((a) => [a.id, a.ok]), [['PCEPILFE', false], ['CPIAUCSL', false], ['CUUR0000SA0', true]]);
  assert.equal(inputs.inflation.source, 'BLS:CUUR0000SA0');
  // FRED present → FRED wins and BLS is corroboration, not the pick.
  const withFred = await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl: fredFetch(FRED_ALL), fetchCurve: curveDown, fetchBls: blsOk });
  assert.equal(withFred.diagnostics.legs.inflation.source, 'FRED:PCEPILFE');
  assert.ok(withFred.diagnostics.legs.inflation.corroboration.some((a) => a.id === 'CUUR0000SA0'));
});

test('macro: no FRED key still reports the keyless curve as a diagnostic while inputs stay null', async () => {
  const { inputs, diagnostics } = await macro.buildMacroInputs({ key: '', now: NOW, fetchCurve: async () => curveOk(), fetchBls: blsDown });
  assert.equal(inputs, null);
  assert.equal(diagnostics.available, false);
  assert.equal(diagnostics.curve.source, 'TREASURY:2s10s');
  assert.ok(fred.SERIES.DGS2, 'DGS2 registered as the FRED fallback leg');
  assert.equal(fred.SERIES.DGS2.leg, 'curve');
});

test('macro: an injected fetchImpl reaches Treasury and BLS too (no provider can touch the network under test)', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return fredFetch(FRED_ALL)(url); };
  await macro.buildMacroInputs({ key: KEY, now: NOW, fetchImpl });
  assert.ok(urls.some((u) => /home\.treasury\.gov/.test(u)), 'treasury went through the injected fetch');
  assert.ok(urls.some((u) => /api\.bls\.gov/.test(u)), 'BLS went through the injected fetch');
});
