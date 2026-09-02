'use strict';
// Shared deterministic fixtures for the CFR tests. No filesystem, no network, no clock.
// A tiny synthetic panel with a KNOWN planted structure, so a test can assert on the answer
// rather than on "it ran".

const { makePanel } = require('../lib/forecast/panel');
const { resolveConfig } = require('../lib/forecast/config');

/** Deterministic LCG — identical across runs, which is what reproducibility tests need. */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function gaussFrom(rnd) {
  return () => {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** N consecutive weekday ISO dates starting 2022-01-03 — a stand-in trading calendar with gaps. */
function sessionDates(n, { skip = [] } = {}) {
  const out = [];
  let d = Date.UTC(2022, 0, 3);
  const skipSet = new Set(skip);
  while (out.length < n) {
    const dt = new Date(d);
    const dow = dt.getUTCDay();
    const iso = dt.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !skipSet.has(iso)) out.push(iso);
    d += 86400000;
  }
  return out;
}

/** A price series with a market beta, idiosyncratic noise and an optional planted alpha. */
function makeSeries(sessions, marketReturns, { beta = 1, seed = 1, vol = 0.015, start = 50, alphaFn = null } = {}) {
  const rnd = rng(seed);
  const g = gaussFrom(rnd);
  const out = [];
  let px = start;
  for (let i = 0; i < sessions.length; i++) {
    const alpha = alphaFn ? alphaFn(i, out) : 0;
    const r = beta * marketReturns[i] + vol * g() + alpha;
    px *= 1 + r;
    const hi = px * (1 + Math.abs(g()) * 0.005);
    const lo = px * (1 - Math.abs(g()) * 0.005);
    out.push({
      date: sessions[i],
      open: +(px * (1 + g() * 0.002)).toFixed(4),
      high: +Math.max(hi, px).toFixed(4),
      low: +Math.min(lo, px).toFixed(4),
      close: +px.toFixed(4),
      volume: Math.round(2e6 + Math.abs(g()) * 4e5),
    });
  }
  return out;
}

const SECTORS = ['Technology', 'Financials', 'Energy', 'Health Care'];
const SECTOR_ETF = { Technology: 'XLK', Financials: 'XLF', Energy: 'XLE', 'Health Care': 'XLV' };

/**
 * Build a synthetic panel.
 *   plantedAlpha: when true, a name's forward drift depends on its trailing 5-day return
 *                 (a reversal), so a working ranker MUST find it.
 */
function buildPanel({ sessions = 420, names = 40, seed = 7, plantedAlpha = true, skip = [] } = {}) {
  const dates = sessionDates(sessions, { skip });
  const mrnd = rng(seed);
  const mg = gaussFrom(mrnd);
  const marketReturns = dates.map(() => 0.0003 + 0.008 * mg());

  const benchCandles = makeSeries(dates, marketReturns, { beta: 1, seed: seed + 1, vol: 0.001, start: 400 });
  const sectorCandles = new Map();
  SECTORS.forEach((s, i) => sectorCandles.set(SECTOR_ETF[s], makeSeries(dates, marketReturns, { beta: 1 + 0.1 * i, seed: seed + 10 + i, vol: 0.004, start: 100 })));

  const dataset = new Map();
  const sectorOf = {};
  for (let i = 0; i < names; i++) {
    const t = `SYN${String(i).padStart(2, '0')}`;
    sectorOf[t] = SECTORS[i % SECTORS.length];
    dataset.set(t, makeSeries(dates, marketReturns, {
      beta: 0.7 + (i % 7) * 0.1, seed: seed + 100 + i, vol: 0.018, start: 20 + i,
      alphaFn: plantedAlpha ? (k, so) => (k < 6 ? 0 : -0.10 * (so[k - 1].close / so[k - 6].close - 1)) : null,
    }));
  }
  return makePanel({ dataset, benchCandles, sectorCandles, sectorOf, source: 'test-fixture' });
}

/** A config sized for tiny fixtures — every threshold lowered, nothing else changed. */
function testConfig(overrides = {}) {
  return resolveConfig({
    universe: { minHistorySessions: 110, minAvgDollarVolume: 1e6, advLookback: 20, minPrice: 1 },
    target: { betaLookback: 60, betaMinObs: 40 },
    features: { crossSectionMinNames: 5 },
    walkforward: { minTrainSessions: 60, testSessions: 25, innerFolds: 3, holdoutFraction: 0.2 },
    metaRanker: { numRounds: 40, minDataInLeaf: 20 },
    calibration: { minSamples: 200, minPositives: 10, minNegatives: 10 },
    models: { enabled: ['ridge'] },
    ...overrides,
  });
}

module.exports = { rng, gaussFrom, sessionDates, makeSeries, buildPanel, testConfig, SECTORS, SECTOR_ETF };
