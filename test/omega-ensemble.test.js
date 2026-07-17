const test = require('node:test');
const assert = require('node:assert');
const OE = require('../lib/omega-ensemble');

const today = (o = {}) => ({
  ok: true,
  generatedAt: '2026-07-16T13:00:00.000Z',
  schemaVersion: 'decision-v1',
  regime: { label: 'Risk-on', riskOn: true, bearish: false, breadthPct: 62, condition: 'melt-up' },
  counts: { signals: 181 },
  redundancy: {
    method: 'measured', version: 'redundancy-v1', verdict: 'agreement does not pay',
    measurablePairs: 6, totalPairs: 28, avgMeasuredCredit: 0.55, avgConfirmationLift: -0.282,
  },
  portfolio: {
    method: 'portfolio-v1', caps: { size: 10, maxPerSector: 3 },
    exposure: { Technology: 3 }, familyExposure: { trend: 4 }, unfilled: 2,
    note: 'sector-proxied',
    selected: [{
      portfolioRank: 1, ticker: 'SNOW', horizon: 'swing', side: 'long', sector: 'Technology',
      strategyFamily: 'trend', score: 99.7, confidence: 88, sources: ['screener', 'ghost'],
      evidenceFamilies: ['priceTrend', 'volumeAccum'],
      evidence: { familyCount: 2, effectiveCount: 1.36, measured: true },
      expectancy: { known: true, avgExcess: 1.2, median: 0.8, n: 30, winRate: 55, horizonKey: '1m' },
      cost: {
        known: true, grossMovePct: 10, roundTripPct: 0.16, netMovePct: 9.84, costShare: 0.016,
        penalty: 0.984, tier: 'liquid', tierLabel: 'large / liquid', tierAssumed: false,
        modelVersion: 'cost-v1',
      },
      execution: { quality: 1, penalties: [] }, regimeFit: 1, state: 'ready',
      entry: 100, stop: 95, target: 110, rr: 2,
    }],
    excluded: [
      { ticker: 'CRWD', score: 99.6, reason: 'sector-cap', label: 'Sector cap reached', detail: 'Technology full', blockedBy: ['SNOW'] },
      { ticker: 'ZZZ', score: 12, reason: 'quality-floor', label: 'Below floor', detail: 'under 50' },
      { ticker: 'YYY', score: 40, reason: 'size', label: 'Below the cut', detail: 'outside top 10' },
    ],
  },
  ...o,
});

// Shape taken VERBATIM from the live op=evolvehealth payload — the first prod run of this
// page reported "op=evolvehealth did not answer" while the source was ok:true, because this
// fixture had been guessed (`dsr`) instead of read (`deflatedSharpe`).
const health = {
  ok: true, version: 'evolve-core-v1', resolved: 672, logged: 9,
  calibrated: true, calibrationError: 0.1844,
  calibration: { brier: 0.105, table: [] },
  deflatedSharpe: { trials: 12, passing: 0, passDSR: 0.95, survivors: [], verdict: 'no cell survives multiple-testing' },
};

test('composes the view from op=today without recomputing a score', () => {
  const v = OE.buildEnsembleView({ today: today(), health });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.ranking.length, 1);
  assert.strictEqual(v.ranking[0].ticker, 'SNOW');
  // Passed through, not re-derived.
  assert.strictEqual(v.ranking[0].score, 99.7);
});

test('degrades honestly when the decision engine is down — renders nothing, invents nothing', () => {
  const v = OE.buildEnsembleView({ today: { ok: false } });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.degraded, true);
  assert.deepStrictEqual(v.ranking, []);
  assert.ok(/did not answer/.test(v.note));
});

test('missing payload entirely does not throw', () => {
  const v = OE.buildEnsembleView({});
  assert.strictEqual(v.ok, false);
});

// ── the honesty contract ────────────────────────────────────────────────────
test('probabilities are reported ABSENT, never synthesized from the composite', () => {
  const v = OE.buildEnsembleView({ today: today(), health });
  const p = v.ranking[0].probabilities;
  assert.strictEqual(p.known, false);
  assert.strictEqual(p.value, null);
  assert.ok(/not a probability/.test(p.why), 'must explain why, not just blank');
});

test('regime probabilities are ABSENT — the engine emits a hard label, not a distribution', () => {
  const v = OE.buildEnsembleView({ today: today(), health });
  assert.strictEqual(v.summary.regime.probabilities.known, false);
  assert.strictEqual(v.summary.regime.label, 'Risk-on');
});

test('0 surviving DSR cells reads as a RESULT, not as missing data', () => {
  const v = OE.buildEnsembleView({ today: today(), health });
  assert.strictEqual(v.summary.validation.known, true);
  assert.strictEqual(v.summary.validation.passing, 0);
  assert.strictEqual(v.summary.validation.trials, 12);
  // The engine that ran the test owns the wording — we pass its verdict through.
  assert.strictEqual(v.summary.validation.verdict, 'no cell survives multiple-testing');
});

test('validation absent when op=evolvehealth did not answer', () => {
  const v = OE.buildEnsembleView({ today: today(), health: null });
  assert.strictEqual(v.summary.validation.known, false);
  assert.ok(/did not answer/.test(v.summary.validation.verdict));
});

// Regression: an absent FIELD and an absent ANSWER are different failures. Prod said
// "did not answer" while sources.evolvehealth was ok:true, because the code read a guessed
// key. A wrong reason is worse than no reason on a page whose whole premise is honesty.
test('a health payload MISSING the dsr block is not reported as "did not answer"', () => {
  const v = OE.buildEnsembleView({ today: today(), health: { ok: true, version: 'evolve-core-v1' } });
  assert.strictEqual(v.summary.validation.known, false);
  assert.ok(!/did not answer/.test(v.summary.validation.verdict),
    'it DID answer — saying otherwise is a false reason');
  assert.ok(/no deflated-Sharpe block/.test(v.summary.validation.verdict));
});

test('surfaces the model version, sample count and calibration quality (§9 summary)', () => {
  const v = OE.buildEnsembleView({ today: today(), health });
  const m = v.summary.model;
  assert.strictEqual(m.known, true);
  assert.strictEqual(m.version, 'evolve-core-v1');
  assert.strictEqual(m.resolvedSamples, 672);
  assert.strictEqual(m.calibrated, true);
  assert.strictEqual(m.brier, 0.105);
  assert.strictEqual(m.calibrationError, 0.1844);
  assert.ok(m.source);
});

test('mode distinguishes measured redundancy from the asserted prior', () => {
  const measured = OE.buildEnsembleView({ today: today(), health });
  assert.ok(/production/.test(measured.summary.mode));
  const prior = OE.buildEnsembleView({ today: today({ redundancy: { method: 'prior' } }), health });
  assert.ok(/fallback/.test(prior.summary.mode));
});

test('every metric block names the engine that produced it', () => {
  const v = OE.buildEnsembleView({ today: today(), health });
  const r = v.ranking[0];
  assert.ok(r.cost.source, 'cost must name its engine');
  assert.ok(r.evidence.source, 'evidence must name its engine');
  assert.ok(r.trackRecord.source, 'track record must name its engine');
  assert.ok(v.summary.regime.source);
});

// ── evidence accounting (§2) ────────────────────────────────────────────────
test('surfaces raw count vs measured units vs how much was discounted', () => {
  const v = OE.buildEnsembleView({ today: today(), health });
  const e = v.ranking[0].evidence;
  assert.strictEqual(e.rawSourceCount, 2);
  assert.strictEqual(e.declaredFamilyCount, 2);
  assert.strictEqual(e.effectiveUnits, 1.36);
  assert.strictEqual(e.discounted, 0.64);
  assert.strictEqual(e.measured, true);
});

test('unmeasured evidence says so rather than implying a measurement happened', () => {
  const t = today();
  t.portfolio.selected[0].evidence = { familyCount: 2, measured: false };
  const v = OE.buildEnsembleView({ today: t, health });
  assert.strictEqual(v.ranking[0].evidence.discounted, null);
  assert.ok(/asserted/.test(v.ranking[0].evidence.source));
});

// ── cost waterfall (§7) ─────────────────────────────────────────────────────
test('the cost waterfall is passed through intact and reconciles', () => {
  const v = OE.buildEnsembleView({ today: today(), health });
  const c = v.ranking[0].cost;
  assert.strictEqual(+(c.grossMovePct - c.roundTripPct).toFixed(2), c.netMovePct);
  assert.strictEqual(c.modelVersion, 'cost-v1');
});

// ── excluded panel (§9) ─────────────────────────────────────────────────────
test('excluded panel shows STRONG names dropped for a real reason, not the long tail', () => {
  const v = OE.buildEnsembleView({ today: today(), health });
  assert.strictEqual(v.excluded.length, 1, 'size + quality-floor drops are not interesting exclusions');
  assert.strictEqual(v.excluded[0].ticker, 'CRWD');
  assert.strictEqual(v.excluded[0].reason, 'sector-cap');
  assert.deepStrictEqual(v.excluded[0].blockedBy, ['SNOW']);
});

test('falls back to top when no portfolio block exists', () => {
  const t = today(); delete t.portfolio;
  t.top = [{ ticker: 'AAA', horizon: 'swing', score: 80 }];
  const v = OE.buildEnsembleView({ today: t, health });
  assert.strictEqual(v.ranking[0].ticker, 'AAA');
  assert.deepStrictEqual(v.excluded, []);
});

test('disclosures state the no-durable-edge wall verbatim', () => {
  const v = OE.buildEnsembleView({ today: today(), health });
  assert.ok(v.disclosures.length >= 4);
  assert.ok(v.disclosures.some(d => /no durable/.test(d)), 'the honesty wall must be on the page');
  assert.ok(v.disclosures.some(d => /computes no score of its own/.test(d)));
});
