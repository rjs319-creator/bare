'use strict';
// NOVEL SIGNAL LAB — unit & integration tests.
//
// These exercise the PURE cores with clearly SYNTHETIC fixtures. Per the spec, synthetic data
// tests the workflow; it is NEVER evidence of predictive value. The assertions target the
// acceptance criteria: UNAVAILABLE-not-zero, point-in-time cutoffs, original-vintage integrity,
// publication delays, out-of-support detection, invariance fragility, and — decisively — that a
// signal only "adds value" when it improves the baseline on held-out cross-sections.

const { test } = require('node:test');
const assert = require('node:assert');

const registry = require('../lib/nsl/registry');
const providers = require('../lib/nsl/providers');
const insider = require('../lib/nsl/insider-conviction');
const shortP = require('../lib/nsl/short-pressure');
const acct = require('../lib/nsl/accounting-forensics');
const twin = require('../lib/nsl/twin');
const invar = require('../lib/nsl/invariance');
const incr = require('../lib/nsl/incremental');
const repr = require('../lib/nsl/representation');
const flow = require('../lib/nsl/mechanical-flow');
const { labStatus, detectConflicts } = require('../lib/nsl/lab');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }
const norm = (r) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(6.2831853 * r());

// ── Envelope honesty ────────────────────────────────────────────────────────
test('unavailable envelope has null score and unavailable status — NOT a neutral zero', () => {
  const e = registry.unavailable('x', { engine: 1, ticker: 'ZZZ', asOf: '2024-01-02', reason: 'nope', provider: 'borrow_fee' });
  assert.strictEqual(e.status, registry.STATUS.UNAVAILABLE);
  assert.strictEqual(e.score, null);
  assert.strictEqual(e.coverage, 0);
  assert.ok(e.warnings.length >= 1);
});

test('makeEnvelope forces score null unless usable, and freezes provenance', () => {
  const e = registry.makeEnvelope({ signal: 's', status: registry.STATUS.EXPERIMENTAL, score: 0.5, inputs: { a: 1 } });
  assert.strictEqual(e.score, null); // experimental ⇒ no tradeable score
  assert.throws(() => { e.inputs.a = 2; }); // frozen
});

// ── Provider availability ──────────────────────────────────────────────────
test('licensed providers are UNAVAILABLE; free providers are available', () => {
  assert.strictEqual(providers.providerStatus('borrow_fee').available, false);
  assert.strictEqual(providers.providerStatus('cds_spread').available, false);
  assert.strictEqual(providers.providerStatus('sec_form4').available, true);
  assert.strictEqual(providers.providerStatus('finra_si').available, true);
});

// ── Engine 2: insider — point-in-time & routine-vs-opportunistic ────────────
test('insider classifier hides Form 4 filed after asOf (point-in-time)', () => {
  const txs = [
    { code: 'P', date: '2024-01-10', filingDate: '2024-01-12', value: 600000, owner: 'CEO A', isOfficer: true, shares: 10000 },
    { code: 'P', date: '2024-03-01', filingDate: '2024-03-03', value: 900000, owner: 'CFO B', isOfficer: true, shares: 12000 }, // future filing
  ];
  const cls = insider.classifyInsider(txs, '2024-02-01');
  assert.ok(cls.hasData);
  assert.strictEqual(cls.buyValue, 600000); // only the Jan buy is visible
});

test('a big first open-market buy classifies as opportunistic with positive conviction', () => {
  const txs = [{ code: 'P', date: '2024-01-10', filingDate: '2024-01-12', value: 800000, owner: 'CEO A', isOfficer: true, shares: 10000 }];
  const cls = insider.classifyInsider(txs, '2024-02-01');
  assert.ok(cls.oppShare > 0.6, `oppShare ${cls.oppShare}`);
  assert.ok(cls.conviction > 0);
  const env = insider.toEnvelope(cls, { ticker: 'ABC', asOf: '2024-02-01' });
  assert.strictEqual(env.status, 'usable');
  assert.strictEqual(env.direction, 1);
});

test('a cluster of distinct opportunistic buyers strengthens the signal', () => {
  const txs = [
    { code: 'P', date: '2024-01-10', filingDate: '2024-01-11', value: 600000, owner: 'CEO A', isOfficer: true, shares: 8000 },
    { code: 'P', date: '2024-01-15', filingDate: '2024-01-16', value: 500000, owner: 'CFO B', isOfficer: true, shares: 7000 },
    { code: 'P', date: '2024-01-20', filingDate: '2024-01-21', value: 400000, owner: 'Dir C', isDirector: true, shares: 6000 },
  ];
  const cls = insider.classifyInsider(txs, '2024-02-01');
  assert.ok(cls.clusterBuyers >= 2, `cluster ${cls.clusterBuyers}`);
  assert.ok(cls.clusterStrength > 0);
});

// ── Engine 1: short-pressure publication delay ──────────────────────────────
test('short interest not yet public at asOf ⇒ UNAVAILABLE (publication delay enforced)', () => {
  const rec = { si: 5e6, dtc: 9, adv: 5e5 };
  const a = shortP.assessShortPressure(rec, { sharesOut: 2e7, settlementDate: '2024-01-15', asOf: '2024-01-20' });
  assert.ok(a.notYetPublic, 'settlement 5 days old must not be public');
  const env = shortP.toEnvelope(a, { ticker: 'ABC', asOf: '2024-01-20' });
  assert.strictEqual(env.status, 'unavailable');
});

test('short interest crowding is usable once past the publication delay, and is a short-side tilt', () => {
  const rec = { si: 6e6, dtc: 10, adv: 4e5 }; // 30% of 20M shares, high DTC
  const a = shortP.assessShortPressure(rec, { sharesOut: 2e7, settlementDate: '2024-01-01', asOf: '2024-01-25' });
  assert.strictEqual(a.notYetPublic, undefined);
  assert.ok(a.crowding > 0.5);
  const env = shortP.toEnvelope(a, { ticker: 'ABC', asOf: '2024-01-25' });
  assert.strictEqual(env.direction, -1); // high crowding ⇒ short-side
  assert.ok(env.score < 0);
  assert.ok(env.inputs.borrow_constraint === null); // licensed input stays UNAVAILABLE, not faked
});

// ── Engine 6: accounting — original vintage integrity ───────────────────────
test('a restatement (later filed) does NOT overwrite the original reported vintage', () => {
  const facts = { facts: { 'us-gaap': {
    Revenues: { units: { USD: [
      { end: '2021-12-31', val: 100, form: '10-K', filed: '2022-02-01' },
      { end: '2022-12-31', val: 120, form: '10-K', filed: '2023-02-01' },
      { end: '2022-12-31', val: 90, form: '10-K/A', filed: '2023-11-01' }, // restatement
    ] } },
    NetIncomeLoss: { units: { USD: [ { end: '2021-12-31', val: 10, form: '10-K', filed: '2022-02-01' }, { end: '2022-12-31', val: 12, form: '10-K', filed: '2023-02-01' } ] } },
    NetCashProvidedByUsedInOperatingActivities: { units: { USD: [ { end: '2021-12-31', val: 15, form: '10-K', filed: '2022-02-01' }, { end: '2022-12-31', val: 8, form: '10-K', filed: '2023-02-01' } ] } },
    Assets: { units: { USD: [ { end: '2021-12-31', val: 200, form: '10-K', filed: '2022-02-01' }, { end: '2022-12-31', val: 210, form: '10-K', filed: '2023-02-01' } ] } },
  } } };
  // As-of before the restatement: only the original 120 is visible.
  const before = acct.extractSeries(facts, '2023-06-01');
  const t = acct.lastTwoAnnual(before.revenue);
  assert.strictEqual(t.latest.val, 120);
  // As-of after the restatement exists: the ORIGINAL vintage (120, earliest-filed) still wins.
  const after = acct.extractSeries(facts, '2024-01-01');
  const t2 = acct.lastTwoAnnual(after.revenue);
  assert.strictEqual(t2.latest.val, 120, 'restated 90 must not replace original 120');
});

test('accounting transition: accruals worsening (NI detaching from CFO) yields a negative tilt', () => {
  const mk = (rev, recv, ni, cfo, assets, end, filed) => ({ rev, recv, ni, cfo, assets, end, filed });
  const series = {
    revenue: [{ end: '2021-12-31', val: 100, form: '10-K', filed: '2022-02-01' }, { end: '2022-12-31', val: 110, form: '10-K', filed: '2023-02-01' }],
    receivables: [{ end: '2021-12-31', val: 20, form: '10-K', filed: '2022-02-01' }, { end: '2022-12-31', val: 40, form: '10-K', filed: '2023-02-01' }], // receivables +100% vs rev +10%
    netIncome: [{ end: '2021-12-31', val: 10, form: '10-K', filed: '2022-02-01' }, { end: '2022-12-31', val: 20, form: '10-K', filed: '2023-02-01' }],
    cfo: [{ end: '2021-12-31', val: 12, form: '10-K', filed: '2022-02-01' }, { end: '2022-12-31', val: 2, form: '10-K', filed: '2023-02-01' }], // CFO collapsing
    assets: [{ end: '2021-12-31', val: 200, form: '10-K', filed: '2022-02-01' }, { end: '2022-12-31', val: 210, form: '10-K', filed: '2023-02-01' }],
    shares: [{ end: '2021-12-31', val: 100, form: '10-K', filed: '2022-02-01' }, { end: '2022-12-31', val: 100, form: '10-K', filed: '2023-02-01' }],
  };
  const a = acct.assessAccountingFacts(series, '2024-01-01');
  assert.strictEqual(a.insufficient, false);
  assert.ok(a.revenueQualityChange < 0, 'receivables outrunning revenue = deteriorating');
  assert.ok(a.composite < 0, 'composite should tilt negative');
});

// ── Engine 8: historical twins ──────────────────────────────────────────────
test('twin matching uses only pre-decision resolved states and flags out-of-support', () => {
  const r = lcg(7); const keys = ['mom', 'liq'];
  const pool = [];
  for (let i = 0; i < 200; i++) pool.push({ ticker: 'H' + i, date: '2020-01-0' + (1 + (i % 5)), features: { mom: norm(r) * 0.1, liq: norm(r) }, outcome: norm(r) * 0.05 });
  // future-dated pool member that must be excluded:
  pool.push({ ticker: 'FUTURE', date: '2099-01-01', features: { mom: 0, liq: 0 }, outcome: 999 });
  const central = twin.findTwins({ features: { mom: 0, liq: 0 } }, pool, keys, '2024-01-01');
  assert.strictEqual(central.insufficient, false);
  assert.ok(central.count >= twin.CONFIG.MIN_TWINS);
  assert.ok(!central.examples.some(e => e.ticker === 'FUTURE'), 'future state must never be a twin');
  // A candidate far outside the cloud is out of support.
  const outlier = twin.findTwins({ features: { mom: 50, liq: 50 } }, pool, keys, '2024-01-01');
  assert.ok(outlier.insufficient || outlier.outOfSupport, 'extreme candidate must be flagged');
});

// ── Engine 9: invariance & fragility ────────────────────────────────────────
test('invariance: an effect confined to ONE environment is flagged fragile', () => {
  const r = lcg(11); const samples = [];
  // 4 environments; signal predicts outcome ONLY in env "A".
  for (const env of ['A', 'B', 'C', 'D']) {
    for (let i = 0; i < 40; i++) {
      const sig = norm(r);
      const outcome = env === 'A' ? 0.8 * sig + 0.3 * norm(r) : norm(r); // only A carries it
      samples.push({ env, signal: sig, outcome });
    }
  }
  const res = invar.evaluateInvariance(samples);
  assert.strictEqual(res.insufficient, false);
  assert.ok(res.fragility > 0.4, `fragility ${res.fragility}`);
  assert.ok(res.invariance < 0.6, `invariance ${res.invariance}`);
});

test('invariance: a mechanism stable across environments scores high and low-fragility', () => {
  const r = lcg(3); const samples = [];
  for (const env of ['A', 'B', 'C', 'D']) for (let i = 0; i < 40; i++) { const sig = norm(r); samples.push({ env, signal: sig, outcome: 0.6 * sig + 0.5 * norm(r) }); }
  const res = invar.evaluateInvariance(samples);
  assert.ok(res.directionConsistency > 0.9, `consistency ${res.directionConsistency}`);
  assert.ok(res.fragility < 0.4, `fragility ${res.fragility}`);
});

// ── Incremental-value evaluator — the decisive test ─────────────────────────
function crossSection(seed, kind) {
  const r = lcg(seed); const samples = [];
  for (let d = 0; d < 24; d++) {
    const date = '20' + String(20 + Math.floor(d / 12)).padStart(2, '0') + '-' + String(1 + (d % 12)).padStart(2, '0') + '-01';
    for (let n = 0; n < 30; n++) {
      const baseline = norm(r);
      let signal, outcome;
      if (kind === 'orthogonal') { signal = norm(r); outcome = 0.6 * baseline + 0.6 * signal + 0.6 * norm(r); }         // signal adds beyond baseline
      else if (kind === 'redundant') { signal = baseline + 0.01 * norm(r); outcome = 0.9 * baseline + 0.5 * norm(r); }  // signal ≈ baseline
      else { signal = norm(r); outcome = 0.9 * baseline + 0.6 * norm(r); }                                              // signal is noise
      samples.push({ date, baseline, signal, outcome });
    }
  }
  return samples;
}

test('incremental: a baseline-orthogonal predictive signal is judged to add value', () => {
  const res = incr.evaluateIncremental(crossSection(101, 'orthogonal'), { variantsTested: 1 });
  assert.strictEqual(res.insufficient, false);
  assert.ok(res.incremental.ic > 0 && res.incrementalSignificant, `incr ic ${res.incremental.ic} t ${res.incremental.t}`);
  assert.ok(res.deltaIC > 0);
  assert.strictEqual(res.verdict, 'adds-incremental-value');
});

test('incremental: a signal that merely duplicates the baseline is judged redundant', () => {
  const res = incr.evaluateIncremental(crossSection(202, 'redundant'), { variantsTested: 1 });
  assert.ok(res.alone.ic > 0.02, 'the duplicate looks good standalone');
  assert.ok(!res.incrementalSignificant, 'but adds nothing orthogonal');
  assert.strictEqual(res.verdict, 'redundant-with-existing');
});

test('incremental: a noise signal never earns "adds value"', () => {
  const res = incr.evaluateIncremental(crossSection(303, 'noise'), { variantsTested: 1 });
  assert.notStrictEqual(res.verdict, 'adds-incremental-value');
  assert.ok(['reject', 'observe'].includes(res.recommendation));
});

test('incremental: false-discovery control raises the bar with more variants tested', () => {
  const many = incr.evaluateIncremental(crossSection(101, 'orthogonal'), { variantsTested: 50 });
  assert.ok(many.bonferroniTCrit > 2.0, 'Bonferroni tightens the significance threshold');
});

// ── Engine 7: representation — cutoff & determinism ─────────────────────────
test('representation trains only on pre-cutoff rows, freezes, and hashes deterministically', () => {
  const r = lcg(9); const keys = ['a', 'b', 'c', 'd', 'e']; const rows = [];
  for (let i = 0; i < 120; i++) { const dt = i < 90 ? '2022-01-01' : '2023-01-01'; const f = {}; keys.forEach(k => f[k] = norm(r)); rows.push({ date: dt, features: f }); }
  const fit1 = repr.fitRepresentation(rows, keys, '2022-06-01');
  const fit2 = repr.fitRepresentation(rows, keys, '2022-06-01');
  assert.strictEqual(fit1.insufficient, false);
  assert.strictEqual(fit1.model.cutoff, '2022-06-01');
  assert.strictEqual(fit1.model.datasetHash, fit2.model.datasetHash, 'deterministic dataset hash');
  const latent = repr.encodeRow(fit1.model, rows[100].features);
  assert.strictEqual(latent.length, fit1.model.k);
  const drift = repr.representationDrift(fit1.model, rows);
  assert.ok(drift && drift.n === 30, 'drift measured on post-cutoff rows');
});

// ── Engine 3: mechanical flow reversal ──────────────────────────────────────
test('mechanical flow reversal probability rises once the event date has passed', () => {
  const upcoming = flow.assessMechanicalFlow([{ type: 'lockup', date: '2024-02-10', direction: -1, sizeVsAdv: 2 }], '2024-02-05');
  const passed = flow.assessMechanicalFlow([{ type: 'lockup', date: '2024-02-01', direction: -1, sizeVsAdv: 2 }], '2024-02-05');
  assert.ok(passed.reversalProb > upcoming.reversalProb);
});

// ── Lab status & conflicts ──────────────────────────────────────────────────
test('lab status: licensed engines report unavailable; feasible engines usable/experimental', () => {
  const st = labStatus();
  assert.strictEqual(st.shadowOnly, true);
  const byEngine = Object.fromEntries(st.engines.map(e => [e.engine, e]));
  assert.strictEqual(byEngine[4].availability, 'unavailable'); // operating nowcast — licensed alt-data
  assert.strictEqual(byEngine[5].availability, 'unavailable'); // capital structure — licensed credit
  assert.strictEqual(byEngine[2].availability, 'usable');      // insider — free SEC
  assert.strictEqual(byEngine[6].availability, 'usable');      // accounting — free XBRL
  assert.ok(['usable', 'experimental'].includes(byEngine[8].availability)); // twin — pure
});

test('conflict detection surfaces opposed usable directions', () => {
  const a = registry.makeEnvelope({ signal: 'insider_conviction', status: 'usable', score: 0.5, direction: 1 });
  const b = registry.makeEnvelope({ signal: 'accounting_forensics', status: 'usable', score: -0.4, direction: -1 });
  const c = detectConflicts([a, b]);
  assert.strictEqual(c.length, 1);
});
