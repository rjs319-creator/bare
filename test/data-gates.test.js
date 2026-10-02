'use strict';
// PHASE 8 — pre-ranking data freshness & coverage gates.
// Freshness must CONTROL actionability (block new entries), not decorate the payload
// after the ranking already happened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const DG = require('../lib/data-gates');
const EL = require('../lib/eligibility');
const { buildToday } = require('../lib/decision-routes');
const { SOURCES } = require('./fixtures/today-sources');

const NOW = Date.parse('2026-07-24T14:00:00Z');   // Friday
const iso = (h) => new Date(NOW - h * 3600_000).toISOString();
const fresh = (over = {}) => ({
  generatedAt: iso(1),
  freshness: { decisionSession: '2026-07-23', counts: { scanned: 900 } },
  results: [{ ticker: 'AAA', factors: { dollarVol: 5e7 } }],
  ...over,
});

test('a source with a current timestamp, cutoff, coverage and liquidity PASSES', () => {
  const g = DG.evaluateSource('screener', fresh(), { horizon: 'swing', minScanned: 100 }, { nowMs: NOW, available: {} });
  assert.equal(g.ok, true, g.staleInputs.join('; '));
  assert.equal(g.cutoff, '2026-07-23');
});

test('a source that did not answer fails closed', () => {
  const g = DG.evaluateSource('screener', null, {}, { nowMs: NOW });
  assert.equal(g.ok, false);
  assert.match(g.reason, /did not answer/);
});

test('NO timestamp ⇒ stale (freshness unprovable is not freshness)', () => {
  const g = DG.evaluateSource('screener', fresh({ generatedAt: undefined }), {}, { nowMs: NOW, available: {} });
  assert.equal(g.ok, false);
  assert.match(g.staleInputs.join(' '), /no source timestamp/);
});

test('an over-age payload fails for its OWN contract horizon (intraday is stricter than swing)', () => {
  const old = fresh({ generatedAt: iso(26) });
  assert.equal(DG.evaluateSource('gapgo', old, { horizon: 'intraday' }, { nowMs: NOW, available: {} }).ok, false);
  assert.equal(DG.evaluateSource('screener', old, { horizon: 'swing' }, { nowMs: NOW, available: {} }).ok, true);
});

test('a fresh RESPONSE over a stale information cutoff still fails — generatedAt cannot launder old data', () => {
  const laundered = fresh({ generatedAt: iso(0.2), freshness: { decisionSession: '2026-07-01', counts: { scanned: 900 } } });
  const g = DG.evaluateSource('screener', laundered, { horizon: 'swing' }, { nowMs: NOW, available: {} });
  assert.equal(g.ok, false);
  assert.match(g.staleInputs.join(' '), /information cutoff/);
  assert.ok(g.cutoffSessions > 2);
});

test('a missing information cutoff fails closed (the session it could observe is unproven)', () => {
  const g = DG.evaluateSource('coil', { generatedAt: iso(1), picks: [] }, { horizon: 'swing' }, { nowMs: NOW, available: {} });
  assert.equal(g.ok, false);
  assert.match(g.staleInputs.join(' '), /information cutoff/);
});

test('partial universe coverage is a blocker, and an unreported coverage count is too', () => {
  const thin = fresh({ freshness: { decisionSession: '2026-07-23', counts: { scanned: 12 } } });
  assert.equal(DG.evaluateSource('screener', thin, { horizon: 'swing', minScanned: 500 }, { nowMs: NOW, available: {} }).ok, false);
  const silent = fresh({ freshness: { decisionSession: '2026-07-23' } });
  assert.equal(DG.evaluateSource('screener', silent, { horizon: 'swing', minScanned: 500 }, { nowMs: NOW, available: {} }).ok, false);
});

test('a required reference feed (sector/benchmark data) being down blocks the source', () => {
  const g = DG.evaluateSource('screener', fresh(), { horizon: 'swing', requires: ['sectors'] }, { nowMs: NOW, available: { sectors: false } });
  assert.equal(g.ok, false);
  assert.match(g.staleInputs.join(' '), /sectors/);
});

test('liquidity coverage is measured across the app\'s several row shapes', () => {
  const noLiq = fresh({ results: [{ ticker: 'A' }, { ticker: 'B' }] });
  assert.equal(DG.evaluateSource('screener', noLiq, { horizon: 'swing' }, { nowMs: NOW, available: {} }).ok, false);
  assert.equal(DG.dollarVolOf({ factors: { dollarVol: 3 } }), 3);
  assert.equal(DG.dollarVolOf({ avgDollarVol: 4 }), 4);
  assert.equal(DG.dollarVolOf({ liquidity: { dollarVol: 5 } }), 5);
  assert.equal(DG.dollarVolOf({ ticker: 'X' }), null);
});

test('evaluateDataGates aggregates a degraded-data banner and the blocked-source list', () => {
  const out = DG.evaluateDataGates({ screener: fresh(), coil: { picks: [] }, sectors: { sectors: [] }, scoreboard: { groups: [] } },
    { specs: { screener: { horizon: 'swing' }, coil: { horizon: 'swing' } }, nowMs: NOW });
  assert.equal(out.perSource.screener.ok, true);
  assert.equal(out.perSource.coil.ok, false);
  assert.deepEqual(out.newEntriesBlocked, ['coil']);
  assert.equal(out.degraded, true);
  assert.match(out.banner, /Degraded data/);
});

test('a stale source cannot originate a NEW entry: eligibility fails closed with DATA_STALE', () => {
  const src = { source: 'screener', staticStatus: 'production', pinned: false, governance: { status: 'production', weight: 1 }, displayEligible: true, tradeEligible: true, sizingWeight: 1, reasons: [] };
  const sig = { source: 'screener', ticker: 'AAA', side: 'long', entry: 10, stop: 9, target: 12, liquidity: { dollarVol: 5e7 } };
  const ok = EL.assessSignal(sig, src, { dataGate: { ok: true } });
  assert.equal(ok.signalClass, 'ACTIONABLE');
  const stale = EL.assessSignal(sig, src, { dataGate: { ok: false, reason: 'information cutoff 9 sessions behind' } });
  assert.equal(stale.tradeEligible, false);
  assert.equal(stale.signalClass, 'RESEARCH');
  assert.ok(stale.reasonCodes.includes(EL.REASON_CODE.DATA_STALE));
});

test('retained picks are labeled, never silently dropped: INVALIDATED > DATA_STALE > HOLD > MONITOR', () => {
  assert.equal(DG.retainedLabelFor({ state: 'failed' }, { ok: false }), 'INVALIDATED');
  assert.equal(DG.retainedLabelFor({ state: 'expired' }, { ok: true }), 'INVALIDATED');
  assert.equal(DG.retainedLabelFor({ state: 'ready' }, { ok: false }), 'DATA_STALE');
  assert.equal(DG.retainedLabelFor({ state: 'triggered' }, { ok: true }), 'HOLD');
  assert.equal(DG.retainedLabelFor({ state: 'early' }, { ok: true }), 'MONITOR');
  for (const k of ['INVALIDATED', 'DATA_STALE', 'HOLD', 'MONITOR']) assert.ok(DG.RETAINED_LABEL_BLURB[k]);
});

test('buildToday runs the gate BEFORE ranking and reports it on the payload', () => {
  const p = buildToday(SOURCES, null, null, null, { nowMs: NOW });
  assert.ok(p.dataGate, 'the payload carries the pre-ranking verdicts');
  assert.equal(p.dataGate.version, DG.DATA_GATE_VERSION);
  // The fixture has no timestamps at all ⇒ every non-pinned source is blocked, and the
  // board therefore contains only the pinned Day Trade rows.
  assert.ok(p.dataGate.newEntriesBlocked.includes('screener'));
  const sources = new Set(Object.values(p.horizons).flat().map(x => x.source));
  assert.deepEqual([...sources], ['daytrade']);
  // every served row still carries an honest retained label for someone already holding it
  for (const r of Object.values(p.horizons).flat()) {
    assert.ok(['MONITOR', 'HOLD', 'INVALIDATED', 'DATA_STALE'].includes(r.retainedLabel));
  }
});

// ── Liquidity rule per row shape (site audit 2026-10-02 #9) ──────────────────────────────
// optionsflow rows are option CONTRACTS and the AI screeners publish LEADS; neither carries
// an equity dollar-volume, so measuring liquidity coverage on them blocked every one of
// those sources every day ("liquidity data on only 0% of rows").
const CONTRACT_ROWS = () => ({
  generatedAt: iso(1),
  freshness: { decisionSession: '2026-07-23' },
  signals: [
    { ticker: 'AAA', side: 'call', strike: 100, expiry: '2026-08-21', volume: 5000, openInterest: 1200, bid: 1.1, ask: 1.3 },
    { ticker: 'BBB', side: 'put', strike: 50, expiry: '2026-08-21', volume: 900, openInterest: 300, bid: 0.4, ask: 0.5 },
  ],
});
const LEAD_ROWS = () => ({ generatedAt: iso(1), asOf: '2026-07-23', items: [{ ticker: 'AAA', thesis: 'x' }, { ticker: 'BBB', thesis: 'y' }] });

test('lead-only sources skip the equity liquidity-coverage control (contracts and AI leads)', () => {
  const opt = DG.evaluateSource('optionsflow', CONTRACT_ROWS(), { horizon: 'swing', liquidity: DG.LIQUIDITY_RULES.LEAD_ONLY }, { nowMs: NOW, available: {} });
  assert.equal(opt.ok, true, opt.staleInputs.join('; '));
  assert.equal(opt.liquidityCoverage, null);
  assert.equal(opt.liquidityRule, 'lead-only');
  assert.equal(opt.rows, 2);
  const lead = DG.evaluateSource('sw', LEAD_ROWS(), { horizon: 'position', liquidity: DG.LIQUIDITY_RULES.LEAD_ONLY }, { nowMs: NOW, available: {} });
  assert.equal(lead.ok, true, lead.staleInputs.join('; '));
  assert.equal(lead.liquidityCoverage, null);
});

test('the same contract rows under the equity rule are still blocked — the rule is explicit, not a loophole', () => {
  const g = DG.evaluateSource('optionsflow', CONTRACT_ROWS(), { horizon: 'swing' }, { nowMs: NOW, available: {} });
  assert.equal(g.ok, false);
  assert.match(g.reason, /liquidity data on only 0%/);
  assert.equal(g.liquidityRule, 'equity');
});

test('specsFromContracts derives the liquidity rule from the contract fill policy', () => {
  const specs = DG.specsFromContracts(['screener', 'optionsflow', 'biotech']);
  assert.equal(specs.screener.liquidity, 'equity');
  assert.equal(specs.biotech.liquidity, 'equity');
  assert.equal(specs.optionsflow.liquidity, 'lead-only');
});

test('buildToday no longer blocks optionsflow / second-wave / cross-asset on liquidity', () => {
  const fresh23 = { generatedAt: iso(1), freshness: { decisionSession: '2026-07-23' } };
  const sources = {
    ...SOURCES,
    optionsflow: { ...fresh23, ...CONTRACT_ROWS() },
    sectors: SOURCES.sectors, scoreboard: SOURCES.scoreboard,
  };
  const ai = { ...(sources.ai || {}), sw: LEAD_ROWS(), ca: LEAD_ROWS() };
  const p = buildToday({ ...sources, ai }, null, null, null, { nowMs: NOW });
  const ps = p.dataGate.perSource;
  for (const k of ['optionsflow', 'sw', 'ca']) {
    assert.ok(ps[k], `no gate for ${k}`);
    assert.ok(!(ps[k].staleInputs || []).some(s => /liquidity data/.test(s)), `${k} still blocked on liquidity: ${ps[k].staleInputs}`);
  }
});
