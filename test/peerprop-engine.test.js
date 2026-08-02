'use strict';
// PEER PROPAGATION — engine tests. The invariants that matter:
//   1. HARD PIT: bars dated after `asOf` can NEVER influence the snapshot —
//      appending a wild future to every input leaves the output byte-identical.
//   2. Determinism: identical inputs → identical snapshot (no clocks, no RNG).
//   3. Quarantine: an ineligible row lands in `excluded` with a stable reason —
//      never silently dropped, never imputed into the panel.
//   4. Honesty: probabilities are null-with-reason (no calibration sample),
//      affectsLiveRank is false, and the survivorship caveat is present.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runPeerPropagation } = require('../lib/peerprop/engine');

function tradingDates(n) {
  const out = [];
  const d = new Date('2024-11-01T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// Multiplicative price path: r = beta*mkt + idio (small, bounded moves).
function candleSeries(dts, mktRets, { beta = 1, seed = 1, drift = 0 }) {
  const rnd = lcg(seed);
  let px = 50;
  return dts.map((date, i) => {
    const idio = (rnd() - 0.5) * 0.012 + drift;
    const r = i === 0 ? 0 : beta * mktRets[i] + idio;
    px = px * (1 + r);
    return { date, open: +(px * 0.999).toFixed(4), high: +(px * 1.005).toFixed(4), low: +(px * 0.995).toFixed(4), close: +px.toFixed(4), volume: 1_000_000 };
  });
}

function buildWorld(nDays) {
  const dts = tradingDates(nDays);
  const rnd = lcg(99);
  const mktRets = dts.map((_, i) => (i === 0 ? 0 : (rnd() - 0.5) * 0.01));
  const spyBars = candleSeries(dts, mktRets, { beta: 1, seed: 7 });
  const secBars = candleSeries(dts, mktRets, { beta: 1, seed: 8 });
  const tickers = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III'];
  const rows = tickers.map((t, i) => {
    const bars = candleSeries(dts, mktRets, { beta: 1, seed: 100 + i, drift: i < 4 ? 0.001 : 0 });
    return {
      ticker: t, sector: 'Technology', sectorEtf: 'XLK', scope: 'large',
      price: bars[bars.length - 1].close, dollarVol: 5e7, capGroup: 'large', bars,
    };
  });
  return { dts, spyBars, secBars, rows };
}

const N = 200;
const world = buildWorld(N);
const asOf = world.dts[179];                     // 20 sessions of unseen future exist
const ctx = {
  rows: world.rows, spyBars: world.spyBars,
  sectorBarsFor: () => world.secBars,
  asOf, decisionTs: `${asOf}T21:00:00.000Z`,
};

test('PIT: a wild future appended to every input changes NOTHING before asOf', () => {
  const base = runPeerPropagation(ctx);
  // Mutate the future: triple every close after asOf, everywhere.
  const distort = bars => bars.map(b => (b.date > asOf ? { ...b, close: b.close * 3, open: b.open * 3, volume: b.volume * 10 } : b));
  const distorted = runPeerPropagation({
    ...ctx,
    rows: world.rows.map(r => ({ ...r, bars: distort(r.bars) })),
    spyBars: distort(world.spyBars),
    sectorBarsFor: () => distort(world.secBars),
  });
  assert.equal(JSON.stringify(base), JSON.stringify(distorted));
});

test('determinism: identical inputs → byte-identical snapshot', () => {
  assert.equal(JSON.stringify(runPeerPropagation(ctx)), JSON.stringify(runPeerPropagation(ctx)));
});

test('quarantine: an ineligible row is excluded with a stable reason, not dropped silently', () => {
  const thin = { ticker: 'THIN', sector: 'Technology', sectorEtf: 'XLK', price: 50, dollarVol: 5e7, capGroup: 'large', bars: world.rows[0].bars.slice(-10) };
  const snap = runPeerPropagation({ ...ctx, rows: [...world.rows, thin] });
  const ex = snap.excluded.find(e => e.ticker === 'THIN');
  assert.ok(ex, 'THIN must appear in excluded');
  assert.ok(ex.reasons.includes('insufficient-candle-history'));
  assert.ok(!snap.candidates.find(c => c.ticker === 'THIN'));
});

test('honesty: null probabilities with reason, shadow flags, survivorship caveat', () => {
  const snap = runPeerPropagation(ctx);
  assert.equal(snap.affectsLiveRank, false);
  assert.ok(snap.candidates.length >= 5, `expected candidates, got ${snap.candidates.length}`);
  for (const c of snap.candidates) {
    assert.equal(c.probabilities.p21, null);
    assert.equal(c.probabilities.reason, 'insufficient-calibration-sample');
    assert.equal(c.featureObservedAt, asOf);          // featureObservedAt <= decisionTime by construction
  }
  assert.ok(snap.caveats.some(c => /survivorship-unsafe/.test(c)));
  assert.equal(snap.networks.customerSupplier.enabled, false, 'premium networks stay disabled, not simulated');
});

test('candidates are ranked deterministically with ties broken by ticker', () => {
  const snap = runPeerPropagation(ctx);
  for (let i = 1; i < snap.candidates.length; i++) {
    const prev = snap.candidates[i - 1], cur = snap.candidates[i];
    assert.ok(prev.score > cur.score || (prev.score === cur.score && prev.ticker < cur.ticker));
  }
});
