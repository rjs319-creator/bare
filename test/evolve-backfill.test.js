'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const B = require('../lib/evolve-backfill');
const L = require('../lib/evolve-labels');

// Deterministic synthetic OHLC (no wall clock): a steady uptrend so every horizon's upper
// barrier resolves quickly — including micro (+3% in 2 sessions).
function makeCandles(n = 400, startPx = 100, dayStep = 1.02) {
  const out = [];
  let px = startPx;
  let t = Date.UTC(2022, 0, 3);
  const DAY = 86400000;
  for (let i = 0; i < n; i++) {
    const close = px;
    out.push({
      date: new Date(t).toISOString().slice(0, 10),
      open: i === 0 ? close : out[i - 1].close,
      high: close * 1.006, low: close * 0.997, close, volume: 1e6,
    });
    t += DAY;
    px = close * dayStep;
  }
  return out;
}

// Injected deps that drive runEvolveBackfill's full orchestration offline: every symbol
// returns the same synthetic history, macro is neutral, and screenTicker always fires the
// momentumIgnition specialist so cohorts produce labels.
function fakeDeps() {
  const candles = makeCandles();
  return {
    tickers: ['T1', 'T2'],
    fetchDailyHistory: async (sym) => ({ candles, meta: { symbol: sym } }),
    buildMacroLookup: async () => ({ at: () => ({ regime: 'neutral' }) }),
    screenTicker: (slice) => {
      const last = slice[slice.length - 1];
      return { qualifies: true, aboveSma200: true, sector: 'Technology', metrics: {},
        factors: { dollarVol: 5e7, atr: last.close * 0.02 } };
    },
  };
}

test('specialistsFiring: breakout / emerging-leader → momentumIgnition', () => {
  assert.deepStrictEqual(B.specialistsFiring({ qualifies: true, metrics: {} }), ['momentumIgnition']);
  assert.deepStrictEqual(B.specialistsFiring({ emergingLeader: true, metrics: {} }), ['momentumIgnition']);
});

test('specialistsFiring: accumulation footprint (not yet broken out) → quietAccumulation', () => {
  const r = { qualifies: false, aboveSma200: true, metrics: { accumRatio: 1.6, udVol: 1.2 } };
  assert.deepStrictEqual(B.specialistsFiring(r), ['quietAccumulation']);
});

test('specialistsFiring: weak accumulation or below 200DMA → nothing', () => {
  assert.deepStrictEqual(B.specialistsFiring({ qualifies: false, aboveSma200: true, metrics: { accumRatio: 1.1, udVol: 1.2 } }), []);
  assert.deepStrictEqual(B.specialistsFiring({ qualifies: false, aboveSma200: false, metrics: { accumRatio: 1.9, udVol: 1.5 } }), []);
});

test('specialistsFiring: a confirmed breakout is momentum, NOT double-counted as accumulation', () => {
  const r = { qualifies: true, aboveSma200: true, metrics: { accumRatio: 1.9, udVol: 1.5 } };
  assert.deepStrictEqual(B.specialistsFiring(r), ['momentumIgnition']);   // quiet requires !qualifies
});

// ── canonical barrier coverage (the micro-horizon defect) ───────────────────
test('every declared EVOLVE horizon has its own finite, positive up/down/window barrier', () => {
  for (const h of L.EVOLVE_HORIZONS) {
    // OWN entry, not the swing fallback — a future horizon added to EVOLVE_HORIZONS without
    // its own barriers must fail this test rather than silently borrow swing's.
    assert.ok(L.HORIZON_META[h], `HORIZON_META missing own entry for "${h}"`);
    const b = L.barriersFor(h);
    for (const k of ['up', 'down', 'window']) {
      assert.ok(Number.isFinite(b[k]) && b[k] > 0, `${h}.${k} must be finite & positive, got ${b[k]}`);
    }
  }
});

// ── runEvolveBackfill orchestration (regression for the undefined-barrier crash) ──
test('runEvolveBackfill: default volAdjust=false processes a firing cohort WITHOUT crashing on micro', async () => {
  // Before the fix this threw `Cannot read properties of undefined (reading 'window')` on the
  // first (micro) horizon because the local barrier map omitted it.
  const { additions, stats } = await B.runEvolveBackfill({ limit: 2, months: 18, volAdjust: false, deps: fakeDeps() });
  assert.ok(stats && !stats.error, `unexpected error: ${stats && stats.error}`);
  assert.ok(stats.rows > 0, 'expected at least one resolved backfill row');
  assert.ok('micro' in stats.byHorizon, 'byHorizon must include the micro horizon');
});

test('runEvolveBackfill: output INCLUDES micro-horizon rows once they resolve', async () => {
  const { additions, stats } = await B.runEvolveBackfill({ limit: 2, months: 18, volAdjust: false, deps: fakeDeps() });
  const microKeys = Object.keys(additions).filter((k) => k.endsWith('|micro'));
  assert.ok(microKeys.length > 0, 'expected resolved micro-horizon additions');
  assert.ok(stats.byHorizon.micro > 0, 'micro horizon counter should be > 0');
  // Every addition carries its horizon and a resolved outcome.
  for (const k of microKeys) {
    assert.equal(additions[k].horizon, 'micro');
    assert.ok(['number'].includes(typeof additions[k].terminalReturn));
  }
});

test('runEvolveBackfill: vol-adjusted path also processes all horizons including micro', async () => {
  const { stats } = await B.runEvolveBackfill({ limit: 2, months: 18, volAdjust: true, deps: fakeDeps() });
  assert.ok(stats && !stats.error, `unexpected error: ${stats && stats.error}`);
  assert.ok(stats.rows > 0, 'vol-adjusted backfill should resolve rows');
  assert.ok('micro' in stats.byHorizon && stats.byHorizon.micro > 0, 'micro must resolve under volAdjust=true too');
});
