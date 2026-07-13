'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/decision');

// ── domainBreadth (#2 — signal-domain breadth) ──────────────────────────────
test('domainBreadth: distinct families across domains light distinct domains', () => {
  const b = D.domainBreadth(['priceTrend', 'volumeAccum', 'fundamentalsRevisions']);
  assert.equal(b.of, 8);
  assert.equal(b.litCount, 3);
  assert.deepEqual(b.lit.sort(), ['fundamentals', 'price', 'volume']);
  assert.equal(b.domains.length, 8);
  assert.equal(b.domains.find(d => d.key === 'price').lit, true);
  assert.equal(b.domains.find(d => d.key === 'options').lit, false);
});

test('domainBreadth: two families sharing one domain light it ONCE (no double-count)', () => {
  // sectorRegime + crossAsset both map to the single "regime" domain.
  const b = D.domainBreadth(['sectorRegime', 'crossAsset']);
  assert.equal(b.litCount, 1);
  assert.deepEqual(b.lit, ['regime']);
});

test('domainBreadth: correlated price-only stack is honestly one domain', () => {
  const b = D.domainBreadth(['priceTrend', 'priceTrend', 'priceTrend']);
  assert.equal(b.litCount, 1);
  assert.deepEqual(b.lit, ['price']);
});

test('domainBreadth: empty / unknown families → zero lit, still 8 slots', () => {
  const b = D.domainBreadth([]);
  assert.equal(b.litCount, 0);
  assert.equal(b.of, 8);
  assert.equal(b.domains.every(d => d.lit === false), true);
});

test('rankSignals attaches a domainBreadth object to every enriched signal', () => {
  const { signal } = D.makeSignal({ ticker: 'ABC', source: 'screener', horizon: 'swing', rawConfidence: 70,
    evidenceFamilies: ['priceTrend', 'volumeAccum'] });
  const [r] = D.rankSignals([signal], { regime: { riskOn: true }, scoreboard: null });
  assert.ok(r.breadth);
  assert.equal(r.breadth.litCount, 2);
  assert.equal(r.breadth.of, 8);
});

test('rankSignals attaches a plain-English holdWindow per horizon (#1 holding period)', () => {
  const mk = h => D.rankSignals([D.makeSignal({ ticker: 'ABC', source: 'screener', horizon: h, rawConfidence: 70 }).signal],
    { regime: { riskOn: true }, scoreboard: null })[0];
  assert.equal(mk('intraday').holdWindow, D.HOLD_WINDOW.intraday);
  assert.equal(mk('swing').holdWindow, D.HOLD_WINDOW.swing);
  assert.equal(mk('position').holdWindow, D.HOLD_WINDOW.position);
  assert.equal(mk('portfolio').holdWindow, D.HOLD_WINDOW.portfolio);
  assert.ok(/session|weeks|months/i.test(mk('intraday').holdWindow));
});

// ── independentEvidence (#3) ────────────────────────────────────────────────
test('independentEvidence: distinct families count once, extras discounted', () => {
  // 3 price-trend screeners + 1 volume = should read as 2 independent families, not 4.
  const e = D.independentEvidence(['priceTrend', 'priceTrend', 'priceTrend', 'volumeAccum']);
  assert.equal(e.familyCount, 2);
  assert.equal(e.screenerCount, 4);
  // score = 1 + 0.3 + 0.3 (price) + 1 (volume) = 2.6
  assert.equal(e.score, 2.6);
  assert.equal(e.singleFamily, false);
});

test('independentEvidence: multiple correlated screeners flagged as one dressed-up family', () => {
  const e = D.independentEvidence(['priceTrend', 'priceTrend']);
  assert.equal(e.familyCount, 1);
  assert.equal(e.singleFamily, true); // "2 agree" but same factor
});

test('independentEvidence: empty → nothing', () => {
  const e = D.independentEvidence([]);
  assert.equal(e.familyCount, 0);
  assert.equal(e.score, 0);
});

// ── lifecycle (#6) ──────────────────────────────────────────────────────────
test('lifecycleState: long transitions across price', () => {
  const base = { entry: 100, stop: 90, target: 130, horizon: 'swing', ageBars: 3 };
  assert.equal(D.lifecycleState({ ...base, price: 88 }), 'failed');   // stop hit
  assert.equal(D.lifecycleState({ ...base, price: 131 }), 'resolved'); // target hit
  assert.equal(D.lifecycleState({ ...base, price: 101 }), 'triggered'); // just over entry
  assert.equal(D.lifecycleState({ ...base, price: 115 }), 'extended'); // >1R past entry (risk 10)
  assert.equal(D.lifecycleState({ ...base, price: 97 }), 'ready');     // within 0.5R below entry
  assert.equal(D.lifecycleState({ ...base, price: 93 }), 'early');     // further from trigger
});

test('lifecycleState: un-triggered setup past max age expires', () => {
  assert.equal(D.lifecycleState({ price: 92, entry: 100, stop: 90, target: 130, horizon: 'intraday', ageBars: 5 }), 'expired');
});

test('lifecycleState: brand-new is detected; no levels degrades gracefully', () => {
  assert.equal(D.lifecycleState({ price: 95, entry: 100, stop: 90, target: 130, horizon: 'swing', ageBars: 0 }), 'detected');
  assert.equal(D.lifecycleState({ price: 95, horizon: 'swing', ageBars: 1 }), 'detected'); // no levels
  assert.equal(D.lifecycleState({ horizon: 'swing', ageBars: 99 }), 'expired');
});

test('lifecycleState: short side mirrors', () => {
  const s = { entry: 100, stop: 110, target: 80, horizon: 'swing', ageBars: 2, price: 99 };
  assert.equal(D.lifecycleState(s), 'triggered');       // dropped below entry
  assert.equal(D.lifecycleState({ ...s, price: 111 }), 'failed'); // stop up hit
  assert.equal(D.lifecycleState({ ...s, price: 79 }), 'resolved'); // target down hit
});

// ── execution realism (#7) ──────────────────────────────────────────────────
test('executionQuality: thin names penalized below liquid ones', () => {
  const liquid = D.executionQuality({ dollarVol: 5e7, price: 50 });
  const thin = D.executionQuality({ dollarVol: 5e5, price: 50 });
  assert.equal(liquid.quality, 1);
  assert.ok(thin.quality < 0.5);
  assert.ok(thin.penalties.includes('thin dollar-volume'));
});

test('executionQuality: frictions stack and floor at 0.1', () => {
  const bad = D.executionQuality({ dollarVol: 1e5, price: 1.5, spreadPct: 3, haltRisk: true });
  assert.ok(bad.quality >= 0.1 && bad.quality < 0.3);
  assert.ok(bad.penalties.length >= 3);
});

// ── regime fit (the validated lever) ────────────────────────────────────────
test('regimeFit: longs stand down in risk-off, shorts favored', () => {
  const off = { bearish: true };
  assert.ok(D.regimeFit('long', off) < 0.5);
  assert.equal(D.regimeFit('short', off), 1);
  const on = { riskOn: true };
  assert.equal(D.regimeFit('long', on), 1);
});

// ── expectancy from scoreboard (#4/#5) ──────────────────────────────────────
const SUMMARY = {
  groups: [
    { section: 'Ghost', tier: 'GHOST', horizons: { '1m': { avgExcess: 4, winRate: 60, n: 40 } } },
    { section: 'Ghost', tier: 'WATCH', horizons: { '1m': { avgExcess: -3, winRate: 40, n: 30 } } },
    { section: 'New', tier: 'X', horizons: { '1m': { avgExcess: 8, winRate: 70, n: 2 } } },
  ],
};

test('expectancyFor: looks up section:tier at the horizon metric', () => {
  const e = D.expectancyFor('Ghost', 'GHOST', 'position', SUMMARY); // position → 1m
  assert.equal(e.avgExcess, 4);
  assert.equal(e.n, 40);
  assert.equal(e.known, true);
  assert.equal(D.expectancyFor('Nope', 'Nope', 'position', SUMMARY).known, false);
});

test('expectancyTilt: winners boost, losers trim, tiny samples barely move', () => {
  const win = D.expectancyTilt(D.expectancyFor('Ghost', 'GHOST', 'position', SUMMARY));
  const lose = D.expectancyTilt(D.expectancyFor('Ghost', 'WATCH', 'position', SUMMARY));
  const tiny = D.expectancyTilt(D.expectancyFor('New', 'X', 'position', SUMMARY));
  assert.ok(win.tilt > 1.02);
  assert.ok(lose.tilt < 0.98);
  assert.ok(Math.abs(tiny.tilt - 1) < 0.08); // n=2 → a maxed raw signal is shrunk to <0.08
  assert.ok(Math.abs(tiny.tilt - 1) < Math.abs(win.tilt - 1) + 0.05); // and far below its unshrunk potential (+0.3)
});

// ── makeSignal validation (#11) ─────────────────────────────────────────────
test('makeSignal: fills defaults, computes rr, flags missing fields, never throws', () => {
  const { signal, errors } = D.makeSignal({ ticker: 'aapl', source: 'ghost', horizon: 'swing', entry: 100, stop: 95, target: 115 });
  assert.equal(signal.ticker, 'AAPL');
  assert.equal(signal.rr, 3);            // (115-100)/(100-95)
  assert.equal(signal.family, 'volumeAccum'); // ghost → volumeAccum
  assert.equal(signal.valid, true);
  assert.equal(errors.length, 0);

  const bad = D.makeSignal({ source: 'x', horizon: 'nope' });
  assert.equal(bad.signal.valid, false);
  assert.ok(bad.errors.includes('missing ticker'));
  assert.equal(bad.signal.horizon, 'swing'); // bad horizon coerced to default
});

// ── end-to-end rank (#1) ────────────────────────────────────────────────────
test('rankSignals: multiplicative rank — validated winner beats untradeable theory', () => {
  const regime = { riskOn: true };
  const signals = [
    // Strong: proven-winning tier, liquid, 2 families, triggered.
    { ticker: 'WIN', source: 'ghost', section: 'Ghost', tier: 'GHOST', horizon: 'position', side: 'long',
      price: 101, entry: 100, stop: 92, target: 130, rawConfidence: 70,
      evidenceFamilies: ['volumeAccum', 'fundamentalsRevisions'], liquidity: { dollarVol: 5e7, price: 101 } },
    // Weak: losing tier, illiquid, single family, but high raw confidence.
    { ticker: 'THIN', source: 'ghost', section: 'Ghost', tier: 'WATCH', horizon: 'position', side: 'long',
      price: 4.1, entry: 4, stop: 3.6, target: 6, rawConfidence: 95,
      evidenceFamilies: ['volumeAccum'], liquidity: { dollarVol: 3e5, price: 4.1 } },
  ];
  const ranked = D.rankSignals(signals, { regime, scoreboard: SUMMARY });
  assert.equal(ranked[0].ticker, 'WIN');   // liquid + validated wins despite lower raw confidence
  assert.equal(ranked[0].rank, 1);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].evidence.familyCount === 2);
});

test('rankSignals: inactive states filtered unless requested; risk-off collapses longs', () => {
  const signals = [
    { ticker: 'GONE', source: 'ghost', section: 'Ghost', tier: 'GHOST', horizon: 'swing', side: 'long',
      price: 80, entry: 100, stop: 90, target: 130, rawConfidence: 80, liquidity: { dollarVol: 5e7 } }, // stop hit → failed
  ];
  assert.equal(D.rankSignals(signals, { scoreboard: SUMMARY }).length, 0);
  assert.equal(D.rankSignals(signals, { scoreboard: SUMMARY, includeInactive: true })[0].state, 'failed');

  // Same liquid long ranks far lower in risk-off than risk-on.
  const s = [{ ticker: 'L', source: 'ghost', section: 'Ghost', tier: 'GHOST', horizon: 'swing', side: 'long',
    price: 101, entry: 100, stop: 92, target: 130, rawConfidence: 80, liquidity: { dollarVol: 5e7 } }];
  const on = D.rankSignals(s, { regime: { riskOn: true }, scoreboard: SUMMARY })[0].score;
  const off = D.rankSignals(s, { regime: { bearish: true }, scoreboard: SUMMARY })[0].score;
  assert.ok(off < on * 0.6);
});
