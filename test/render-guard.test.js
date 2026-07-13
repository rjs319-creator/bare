'use strict';
// RENDER-INTEGRITY GUARDS — the app renders payloads straight into innerHTML template
// strings, so a NaN, a stray `undefined`, an unresolved `${…}`, or a duplicate DOM id
// in a builder's output shows up as visible garbage (or a broken key) on the page. These
// tests scan every pure builder's output for exactly those defects, at the data layer
// where they originate (the DOM render itself is browser-only). They also assert each
// builder returns a TERMINAL object (never a perpetual "loading" shape) for real input.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const D = require('../lib/decision');
const { composeWhyNow } = require('../lib/whynow');
const { governRegistry } = require('../lib/governance');
const { classifyStrategies } = require('../lib/maturity');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');

// Deep-scan any value for the four render hazards. `path` is carried for a useful failure
// message. Strings must not contain an unresolved template marker or a stringified
// undefined/NaN; numbers must be finite (NaN never survives to a template).
function scanClean(value, path = '$') {
  if (value == null) return;                               // null/undefined leaf is fine (fields are nullable)
  if (typeof value === 'number') {
    assert.ok(!Number.isNaN(value), `NaN number at ${path}`);
    return;
  }
  if (typeof value === 'string') {
    assert.ok(!value.includes('${'), `unresolved template string at ${path}: ${value}`);
    assert.ok(!/\bundefined\b/.test(value), `literal "undefined" leaked at ${path}: ${value}`);
    assert.ok(!/\bNaN\b/.test(value), `literal "NaN" leaked at ${path}: ${value}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => scanClean(v, `${path}[${i}]`)); return; }
  if (typeof value === 'object') { for (const k of Object.keys(value)) scanClean(value[k], `${path}.${k}`); }
}

// Assert no two entries share an id (would collide as DOM ids / dedup keys).
function assertUniqueIds(arr, key = 'id') {
  const seen = new Set();
  for (const x of arr) {
    const id = x[key];
    if (id == null) continue;
    assert.ok(!seen.has(id), `duplicate id "${id}"`);
    seen.add(id);
  }
}

const REGIME = { riskOn: true, bearish: false, breadthPct: 62, condition: 'trending' };
const SCOREBOARD = { groups: [
  { section: 'screener', tier: 'apex', horizons: { '5d': { excessN: 25, avgExcess: 2.1, avg: 1.8, median: 1.2, avgCI: { lo: -0.4, hi: 4.0, level: 90 }, winRate: 58, beatMktRate: 60, n: 25 } } },
] };

function sampleSignals() {
  const raw = [
    { ticker: 'nvda', source: 'screener', horizon: 'swing', rawConfidence: 80, entry: 100, stop: 94, target: 118,
      price: 101, section: 'screener', tier: 'apex', sector: 'Technology', evidenceFamilies: ['priceTrend', 'volumeAccum', 'fundamentalsRevisions'], percentile: 96 },
    { ticker: 'nvda', source: 'ghost', horizon: 'swing', rawConfidence: 70, evidenceFamilies: ['volumeAccum'] }, // merges with above
    { ticker: 'amd', source: 'gapgo', horizon: 'intraday', rawConfidence: 65, evidenceFamilies: ['priceTrend'] },
    { ticker: '', source: 'coil', horizon: 'nonsense', rawConfidence: 'x' }, // deliberately malformed — must degrade, not corrupt
  ];
  const made = raw.map(r => D.makeSignal(r).signal);
  const merged = D.mergeSignals(made);
  return D.rankSignals(merged, { regime: REGIME, scoreboard: SCOREBOARD, includeInactive: true });
}

test('rankSignals output is render-clean (no NaN / undefined / template leak)', () => {
  scanClean(sampleSignals(), 'signals');
});

test('every ranked signal carries a domainBreadth and finite score', () => {
  for (const s of sampleSignals()) {
    assert.ok(s.breadth && Number.isFinite(s.breadth.litCount), `breadth missing on ${s.ticker}`);
    assert.ok(Number.isFinite(s.score), `non-finite score on ${s.ticker}`);
  }
});

test('new Today card fields (holdWindow, strategyFamily, expectancy median/CI) are present + clean', () => {
  for (const s of sampleSignals()) {
    assert.ok(typeof s.holdWindow === 'string' && s.holdWindow.length, `holdWindow missing on ${s.ticker}`);
    assert.ok(D.STRATEGY_FAMILY_META[s.strategyFamily], `bad strategyFamily on ${s.ticker}`);
    assert.ok(Array.isArray(s.strategyFamilies), `strategyFamilies not an array on ${s.ticker}`);
    // expectancy distribution stats, when known, must be finite or null — never NaN/undefined leaks.
    if (s.expectancy && s.expectancy.known) {
      for (const k of ['avg', 'median']) assert.ok(s.expectancy[k] === null || Number.isFinite(s.expectancy[k]), `${k} not finite on ${s.ticker}`);
    }
  }
});

test('signal ids are unique after merge (no duplicate DOM keys)', () => {
  assertUniqueIds(sampleSignals());
});

test('a malformed source record degrades to a flagged signal, never corrupts the batch', () => {
  const bad = D.makeSignal({ ticker: '', source: 'coil', horizon: 'nonsense', rawConfidence: 'x' });
  assert.equal(bad.signal.valid, false);
  assert.ok(bad.signal.errors.length > 0);
  scanClean(bad.signal, 'bad'); // still clean to render (no NaN/undefined leak)
});

test('composeWhyNow payloads are render-clean across quiet / firing / risk-off', () => {
  const cases = [
    composeWhyNow({ ticker: 'ZZZ', macro: { riskOn: true } }),
    composeWhyNow({ ticker: 'NVDA', macro: { riskOn: true }, ghost: { tier: 'GHOST', score: 84, strongPillars: ['RM'] }, apex: { tier: 'apex', score: 78 } }),
    composeWhyNow({ ticker: 'AAA', macro: { riskOff: true, vix: { level: 31, pctile: 95 } }, ghost: { tier: 'STALKING', score: 66, strongPillars: [] } }),
  ];
  cases.forEach((c, i) => scanClean(c, `whynow[${i}]`));
});

test('governRegistry output is render-clean and status ids are unique', () => {
  const classified = classifyStrategies(SCOREBOARD, STRATEGY_REGISTRY);
  const gov = governRegistry(classified, new Map());
  scanClean(gov, 'governance');
  assertUniqueIds(gov.strategies);
  // Terminal: every governed strategy has a concrete status + numeric weight (never a
  // perpetual "pending"/"loading" placeholder).
  for (const s of gov.strategies) {
    assert.ok(typeof s.status === 'string' && s.status, `missing status for ${s.id}`);
    assert.ok(Number.isFinite(s.weight), `non-finite weight for ${s.id}`);
  }
});

test('classifyStrategies output is render-clean over the real registry', () => {
  const classified = classifyStrategies(SCOREBOARD, STRATEGY_REGISTRY);
  scanClean(classified, 'maturity');
  assertUniqueIds(classified.strategies);
});

test('builders return terminal objects (not a stuck-loading shape) even with empty inputs', () => {
  // Empty scoreboard / no signals must still yield a definite, renderable object.
  const empty = D.rankSignals([], { regime: {}, scoreboard: null });
  assert.deepEqual(empty, []);
  const wn = composeWhyNow({ ticker: 'NONE' });
  assert.equal(wn.verdict.level, 'quiet');       // a definite verdict, not undefined
  assert.ok(Array.isArray(wn.coverage));         // coverage always present
  const gov = governRegistry({ strategies: [] }, new Map());
  assert.equal(gov.clearedWeight, 0);            // concrete number, not NaN/undefined
});
