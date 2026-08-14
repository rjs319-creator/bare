'use strict';
// TREND-CORE WIRING (audit 2026-08-14) — lib/trend-core.js was built to consolidate the
// correlated trend-continuation engines into ONE price-trend evidence unit (the repo
// measured the sleeve re-reading one price series at ~0.96 return correlation), but
// lib/decision.js only referenced it in a comment. These tests pin the wiring:
//
//   • Multiple PRICE_TREND_ENGINES whose only backing is the asserted same-family PRIOR
//     (CORR_DISCOUNT) now count as ONE unit — the prior credits are consolidated to zero.
//   • A trend pair the redundancy model actually MEASURED keeps its earned credit:
//     zeroing it too would charge the same redundancy twice (no double-correction).
//   • Uncorrelated family mixes and every unmeasured path are byte-identical to before.
//   • PROPERTY: the wired evidenceMultiplier can only DECREASE vs the unwired
//     computation — consolidation may never raise the rank.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/decision');
const R = require('../lib/redundancy');
const TC = require('../lib/trend-core');

const famOf = (s) => D.SOURCE_FAMILY[s] || null;
const DATES = Array.from({ length: 20 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);

// Ledger rows: `algorithm` fires on `tickers` for every date, excess from fn.
function rows(algorithm, dates, tickers, exFn) {
  const out = [];
  for (const date of dates) for (const ticker of tickers) out.push({ date, ticker, algorithm, excess: exFn(date, ticker) });
  return out;
}

// Identical excess streams ⇒ the pair is measured as a near-duplicate (like prod's 0.96).
const dupEx = (d, t) => (t.charCodeAt(0) % 5) - 2 + DATES.indexOf(d) * 0.1;

// Model where screener↔momentum is the ONLY measured pair (a near-duplicate trend pair).
function measuredTrendPairModel() {
  return R.buildRedundancyModel(
    [...rows('screener', DATES, ['AAA', 'BBB'], dupEx), ...rows('momentum', DATES, ['AAA', 'BBB'], dupEx)],
    { priorCredit: D.CORR_DISCOUNT, familyOf: famOf },
  );
}

// Model where screener↔ghost (DIFFERENT families) is the only measured pair.
function ghostScreenerModel() {
  return R.buildRedundancyModel(
    [...rows('screener', DATES, ['NVDA', 'AMD'], dupEx), ...rows('ghost', DATES, ['NVDA', 'AMD'], dupEx)],
    { priorCredit: D.CORR_DISCOUNT, familyOf: famOf },
  );
}

const mkSig = (over = {}) => D.makeSignal({
  ticker: 'AAA', source: 'screener', sources: ['screener'], horizon: 'swing', side: 'long',
  rawConfidence: 70, price: 10, family: 'priceTrend', evidenceFamilies: ['priceTrend'],
  liquidity: { dollarVol: 5e7 }, ...over,
}).signal;

// The UNWIRED computation, verbatim: what evidenceFor's measured path used before
// trend-core was wired (the raw redundancy-library crediting).
const unwiredEff = (engines, model) =>
  R.effectiveEvidence(engines, { model, priorCredit: D.CORR_DISCOUNT, familyOf: famOf });

// ── (a) correlated trend pile → ONE unit ────────────────────────────────────

test('a pile of correlated trend engines counts as ONE price unit — asserted prior credits are consolidated', () => {
  // Arrange: 4 trend engines; only screener↔momentum is measured. Before the wiring,
  // apex and trendrider each stacked the asserted 0.3 prior on top.
  const model = measuredTrendPairModel();
  const sig = mkSig({ sources: ['screener', 'momentum', 'apex', 'trendrider'] });

  // Act
  const ev = D.evidenceFor(sig, model);
  const unwired = unwiredEff(['screener', 'momentum', 'apex', 'trendrider'], model);

  // Assert
  assert.equal(ev.measured, true);
  assert.equal(ev.unconsolidatedCount, unwired.score, 'the pre-wiring number stays visible for audit');
  for (const engine of ['apex', 'trendrider']) {
    const c = ev.credits.find(x => x.source === engine);
    assert.equal(c.credit, 0, `${engine} backed only by the asserted trend prior must add ZERO`);
    assert.equal(c.consolidatedBy, 'trend-core');
  }
  const momo = ev.credits.find(x => x.source === 'momentum');
  assert.ok(momo.credit > 0 && momo.credit < D.CORR_DISCOUNT,
    `the MEASURED near-duplicate keeps its earned (sub-prior) credit, got ${momo.credit}`);
  assert.equal(momo.consolidatedBy, undefined, 'a measured trend pair is the redundancy model\'s territory');
  // wired units = 1 (the one price domain) + only the measured residual
  assert.ok(Math.abs(ev.effectiveCount - (1 + momo.credit)) < 0.02,
    `expected ~${1 + momo.credit}, got ${ev.effectiveCount}`);
  assert.ok(ev.effectiveCount < unwired.score, 'consolidation must LOWER the evidence count');
  assert.deepEqual(ev.trendCore.consolidatedEngines, ['apex', 'trendrider']);
  assert.ok(ev.trendCore.creditRemoved > 0.59 && ev.trendCore.creditRemoved < 0.61);
  // familyCount answers a different question (kinds of evidence) and is untouched.
  assert.equal(ev.familyCount, 1);
});

test('the wired evidenceMultiplier is lower than the unwired one for a trend pile', () => {
  const model = measuredTrendPairModel();
  const sig = mkSig({ sources: ['screener', 'momentum', 'apex', 'trendrider'] });
  const ranked = D.rankSignals([sig], { regime: { riskOn: true }, scoreboard: null, redundancy: model })[0];
  const oldMult = D.evidenceMultiplier({ measured: true, effectiveCount: ranked.evidence.unconsolidatedCount, familyCount: 1 });
  assert.ok(ranked.evidenceMult < oldMult,
    `wired ${ranked.evidenceMult} must be below unwired ${oldMult}`);
});

// ── (b) uncorrelated mixes and measured pairs are untouched ─────────────────

test('an uncorrelated family mix is unaffected — nothing to consolidate', () => {
  const model = ghostScreenerModel();
  const sig = mkSig({
    ticker: 'NVDA',
    evidenceFamilies: ['priceTrend', 'volumeAccum', 'insider'],
    evidenceOrigins: { priceTrend: 'screener', volumeAccum: 'ghost', insider: 'insider' },
  });
  const ev = D.evidenceFor(sig, model);
  const unwired = unwiredEff(['screener', 'ghost', 'insider'], model);
  assert.equal(ev.measured, true);
  assert.equal(ev.effectiveCount, unwired.score, 'no trend pair on the signal ⇒ identical crediting');
  assert.equal(ev.trendCore, undefined, 'the consolidation marker only appears when it bound');
  assert.deepEqual(ev.credits.map(c => ({ source: c.source, credit: c.credit })),
    unwired.credits.map(c => ({ source: c.source, credit: c.credit })));
});

test('a MEASURED trend pair keeps its earned credit — trend-core never overrides a measurement', () => {
  // The redundancy model already discounted this pair from data; consolidating it too
  // would charge the same redundancy twice.
  const model = measuredTrendPairModel();
  const sig = mkSig({ sources: ['screener', 'momentum'] });
  const ev = D.evidenceFor(sig, model);
  const unwired = unwiredEff(['screener', 'momentum'], model);
  assert.equal(ev.measured, true);
  assert.equal(ev.effectiveCount, unwired.score);
  assert.equal(ev.trendCore, undefined);
  assert.ok(ev.effectiveCount > 1, 'the measured residual stands (two 0.96-correlated engines ≈ 1.1, not 1)');
});

test('the unmeasured/no-model paths are byte-identical to the static family rule', () => {
  // No model at all → exactly independentEvidence(), as always.
  const sig = mkSig({ sources: ['screener', 'momentum', 'apex'] });
  assert.deepEqual(D.evidenceFor(sig, null), D.independentEvidence(sig.evidenceFamilies));
  // A model with no measured pair among THIS signal's engines → same static fallback.
  const model = ghostScreenerModel(); // knows nothing about momentum/apex
  assert.deepEqual(D.evidenceFor(sig, model), D.independentEvidence(sig.evidenceFamilies));
});

// ── (c) PROPERTY: the multiplier can only DECREASE vs the unwired computation ──

test('property: over every engine subset, wired evidence ≤ unwired and multiplier never rises', () => {
  // A mixed pool: measured trend pair, measured cross-family pair, unmeasured trend
  // engines, and genuinely distinct unmeasured engines.
  const model = R.buildRedundancyModel([
    ...rows('screener', DATES, ['AAA', 'BBB'], dupEx),
    ...rows('momentum', DATES, ['AAA', 'BBB'], dupEx),
    ...rows('ghost', DATES, ['AAA', 'BBB'], dupEx),
  ], { priorCredit: D.CORR_DISCOUNT, familyOf: famOf });

  const pool = ['screener', 'momentum', 'apex', 'trendrider', 'coil', 'ghost', 'insider', 'attention'];
  for (let mask = 1; mask < (1 << pool.length); mask++) {
    const engines = pool.filter((_, i) => mask & (1 << i));
    const [source, ...rest] = engines;
    const sig = mkSig({ source, sources: engines, family: famOf(source) || 'priceTrend' });
    const ev = D.evidenceFor(sig, model);
    const unwired = unwiredEff(engines, model);
    if (ev.measured) {
      assert.equal(ev.unconsolidatedCount, unwired.score);
      assert.ok(ev.effectiveCount <= unwired.score + 1e-9,
        `[${engines}] wired ${ev.effectiveCount} > unwired ${unwired.score}`);
      const wiredMult = D.evidenceMultiplier(ev);
      const unwiredMult = D.evidenceMultiplier({ measured: true, effectiveCount: unwired.score, familyCount: ev.familyCount });
      assert.ok(wiredMult <= unwiredMult + 1e-9,
        `[${engines}] wired mult ${wiredMult} > unwired ${unwiredMult}`);
    } else {
      // Unmeasured → the static family rule, bit-for-bit.
      assert.deepEqual(ev, D.independentEvidence(sig.evidenceFamilies));
    }
    void rest;
  }
});

test('property: over the frozen all-source fixture, wired evidence never exceeds unwired', () => {
  const { buildToday } = require('../lib/decision-routes');
  const { SOURCES } = require('./fixtures/today-sources');

  // A model measuring screener↔downday (cross-family) as near-duplicates; the
  // screener↔coil trend pair stays UNMEASURED (asserted prior only).
  const model = R.buildRedundancyModel([
    ...rows('screener', DATES, ['AAA', 'BBB'], dupEx),
    ...rows('downday', DATES, ['AAA', 'BBB'], dupEx),
  ], { priorCredit: D.CORR_DISCOUNT, familyOf: famOf });

  // The frozen fixture carries only single-engine rows — the measured path (and thus the
  // consolidation) cannot engage on it, WITH or WITHOUT a model. Assert that honestly:
  // the golden ranking is untouched by this change by construction, not by coincidence.
  const frozen = buildToday(SOURCES, null, model, null, { eligibilityMode: 'annotate' });
  const frozenRows = Object.values(frozen.horizons || {}).flat();
  assert.ok(frozenRows.length > 0, 'fixture must produce rows');
  assert.equal(frozenRows.filter(r => r.evidence && r.evidence.measured).length, 0,
    'the frozen fixture has no multi-engine row — nothing for measurement or consolidation to touch');

  // Augment a CLONE of the fixture so ticker AAA merges across screener + coil + downday
  // (a real multi-engine swing row through the full normalize→merge→rank pipeline).
  const aug = JSON.parse(JSON.stringify(SOURCES));
  aug.coil.picks.push({ ticker: 'AAA', company: 'Alpha', sector: 'Technology', price: 100,
    decile: 10, band: 'high', entry: 101.5, stop: 97, target: 118, rr: 3.6 });
  aug.downday.bounces.push({ ticker: 'AAA', sector: 'Technology', price: 100, tier: 'EMERGING',
    bucket: 'v-reversal', score: 60, dollarVol: 5e8,
    signals: { entry: 102, stop: 96, target: 118, rr: 2.7, side: 'long' }, label: 'oversold bounce' });

  const payload = buildToday(aug, null, model, null, { eligibilityMode: 'annotate' });
  const rowsAll = Object.values(payload.horizons || {}).flat();
  const measuredRows = rowsAll.filter(r => r.evidence && r.evidence.measured);
  assert.ok(measuredRows.length >= 1, 'the augmented fixture must produce a measured row');

  for (const r of measuredRows) {
    assert.ok(r.evidence.effectiveCount <= r.evidence.unconsolidatedCount + 1e-9,
      `${r.id}: wired ${r.evidence.effectiveCount} > unwired ${r.evidence.unconsolidatedCount}`);
    const unwiredMult = D.evidenceMultiplier({ measured: true, effectiveCount: r.evidence.unconsolidatedCount, familyCount: r.evidence.familyCount });
    assert.ok(r.evidenceMult <= unwiredMult + 1e-9,
      `${r.id}: wired mult ${r.evidenceMult} > unwired ${unwiredMult}`);
  }

  // And the consolidation actually BINDS on the merged AAA row: coil's asserted trend
  // prior against the screener is zeroed; downday's measured cross-family credit stands.
  const aaa = measuredRows.find(r => r.ticker === 'AAA' && r.horizon === 'swing');
  assert.ok(aaa, 'merged AAA row must be measured');
  assert.deepEqual(aaa.evidence.trendCore.consolidatedEngines, ['coil']);
  const coil = aaa.evidence.credits.find(c => c.source === 'coil');
  assert.equal(coil.credit, 0);
  const dd = aaa.evidence.credits.find(c => c.source === 'downday');
  assert.ok(dd.credit > 0, 'the measured cross-family pair keeps its earned credit');
  assert.ok(aaa.evidence.effectiveCount < aaa.evidence.unconsolidatedCount);
});

// ── The wiring is guarded against drift in the consolidated set ─────────────

test('consolidation acts on exactly trend-core\'s PRICE_TREND_ENGINES, not the wider family map', () => {
  // omega maps priceTrend in SOURCE_FAMILY but is NOT a trend-core engine — its asserted
  // prior against screener is family-map territory and must survive the consolidation.
  assert.equal(famOf('omega'), 'priceTrend');
  assert.equal(TC.PRICE_TREND_ENGINES.includes('omega'), false);
  const model = measuredTrendPairModel();
  const sig = mkSig({ sources: ['screener', 'momentum', 'omega'] });
  const ev = D.evidenceFor(sig, model);
  const omega = ev.credits.find(c => c.source === 'omega');
  assert.equal(omega.credit, D.CORR_DISCOUNT, 'a non-trend-core engine keeps the family prior');
  assert.equal(omega.consolidatedBy, undefined);
});
