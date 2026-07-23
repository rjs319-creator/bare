'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildEvents, runComparison, promotionReadout, DEFAULT_RANKERS, SURVIVORSHIP_REASON,
} = require('../lib/atlasx-research');

// ── deterministic synthetic fixtures (index-based sin/cos, no RNG) ───────────────
function weekdayDates(n, startYmd = '2023-01-02') {
  const out = [];
  const d = new Date(`${startYmd}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function series(dates, { base = 100, phase = 0, trend = 0, ampl = 0.06 } = {}) {
  const out = [];
  let prev = base;
  for (let i = 0; i < dates.length; i++) {
    const wave = ampl * Math.sin(i / 9 + phase) + 0.4 * ampl * Math.cos(i / 4 + phase * 2);
    const close = +(base * (1 + trend * i) * (1 + wave)).toFixed(4);
    const open = +((prev + close) / 2).toFixed(4);
    const high = +(Math.max(open, close) * (1 + 0.5 * ampl * Math.abs(Math.sin(i / 3 + phase)))).toFixed(4);
    const low = +(Math.min(open, close) * (1 - 0.5 * ampl * Math.abs(Math.cos(i / 3 + phase)))).toFixed(4);
    out.push({ date: dates[i], open, high, low, close, volume: 1_000_000 + i * 100 });
    prev = close;
  }
  return out;
}

const N_BARS = 100;
const DATES = weekdayDates(N_BARS);
const HORIZON = 'fast';          // window 5 → keeps fixtures small but resolvable
const WINDOW = 5;

function fixture() {
  const tickers = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
  const candleMap = {};
  const sectorMap = {};
  const sector = series(DATES, { base: 70, phase: 0.4, trend: 0.0005, ampl: 0.03 });
  tickers.forEach((t, k) => {
    candleMap[t] = series(DATES, { base: 40 + 9 * k, phase: 0.6 * k, trend: (k % 2 ? -0.0004 : 0.0009), ampl: 0.05 });
    sectorMap[t] = sector;
  });
  const spyCandles = series(DATES, { base: 400, phase: 0.2, trend: 0.0005, ampl: 0.02 });
  const decisionDates = [];
  for (let i = 34; i <= N_BARS - WINDOW - 2; i += 2) decisionDates.push(DATES[i]);
  return { candleMap, spyCandles, sectorMap, decisionDates };
}

function buildFixtureEvents(extra = {}) {
  const f = fixture();
  if (extra.candleMap) Object.assign(f.candleMap, extra.candleMap);
  return buildEvents({
    candleMap: f.candleMap, spyCandles: f.spyCandles,
    sectorMap: f.sectorMap, decisionDates: f.decisionDates, horizon: HORIZON,
  });
}

// ── tests ────────────────────────────────────────────────────────────────────────
test('buildEvents: eligibleEntryTs and labelEndDate are strictly after decisionTs (no lookahead)', () => {
  const events = buildFixtureEvents();
  assert.ok(events.length > 0, 'expected some resolved events');
  for (const e of events) {
    assert.ok(e.eligibleEntryTs > e.decisionTs, `eligibleEntryTs ${e.eligibleEntryTs} must be > decisionTs ${e.decisionTs}`);
    assert.ok(e.labelEndDate > e.decisionTs, `labelEndDate ${e.labelEndDate} must be > decisionTs ${e.decisionTs}`);
    assert.ok(e.labelEndDate >= e.eligibleEntryTs, 'labelEndDate must be at/after entry');
    assert.ok(Number.isFinite(e.outcome), 'outcome must be finite');
  }
});

test('buildEvents: thin-history tickers are skipped, not fabricated', () => {
  // A ticker with only 12 bars can never satisfy MIN_HISTORY_BARS → zero events for it.
  const thin = series(DATES.slice(0, 12), { base: 25, phase: 1.1, trend: 0.001, ampl: 0.05 });
  const events = buildFixtureEvents({ candleMap: { THIN: thin } });
  assert.equal(events.filter((e) => e.ticker === 'THIN').length, 0, 'thin-history ticker must produce no events');
  assert.ok(events.some((e) => e.ticker === 'AAA'), 'well-covered tickers still produce events');
});

test('runComparison: returns per-ranker IC for the full baseline ladder incl. atlasx-baseline', () => {
  const events = buildFixtureEvents();
  const cmp = runComparison(events);
  const expected = DEFAULT_RANKERS.map((r) => r.name);
  for (const name of expected) {
    assert.ok(name in cmp.perRankerIC, `perRankerIC missing ${name}`);
    assert.ok(name in cmp.perRankerMetrics, `perRankerMetrics missing ${name}`);
  }
  // atlasxRanker actually participated (produced dated OOS ICs).
  assert.ok(cmp.rankers.includes('atlasx-baseline'), 'atlasx-baseline must be in the ladder');
  assert.ok((cmp.perRankerMetrics['atlasx-baseline'].datedICs || 0) > 0, 'atlasx-baseline must have OOS dated ICs');
  // The required minimum ladder members are all present.
  for (const need of ['control-random', 'simple-momentum', 'residual-momentum', 'production-composite', 'atlasx-baseline']) {
    assert.ok(cmp.rankers.includes(need), `ladder missing ${need}`);
  }
});

test('runComparison: verdict is survivorship-unsafe and fail-closed', () => {
  const cmp = runComparison(buildFixtureEvents());
  assert.equal(cmp.verdict.survivorshipSafe, false);
  assert.equal(cmp.verdict.productionEligible, false);
  assert.equal(cmp.verdict.survivorshipReason, SURVIVORSHIP_REASON);
  assert.match(cmp.verdict.summary, /survivorship/i);
});

test('promotionReadout: gate UNMET (fail-closed) even if atlasx tops the IC table', () => {
  const cmp = runComparison(buildFixtureEvents());
  const readout = promotionReadout(cmp);
  assert.equal(readout.survivorshipSafe, false);
  assert.equal(readout.eligible, false, 'must be ineligible while survivorship-unsafe');
  assert.ok(readout.unmet.length > 0, 'at least one gate criterion must be unmet');

  // Force the strongest possible in-favor case: atlasx is champion with a CI excluding
  // zero and plentiful episodes — the readout MUST still be fail-closed.
  const forced = {
    events: 999, distinctDates: 99,
    champion: { ranker: 'atlasx-baseline', meanIC: 0.2, ci90: [0.05, 0.35] },
    perRankerMetrics: {
      'atlasx-baseline': { meanIC: 0.2, ci90: [0.05, 0.35] },
      'production-composite': { meanIC: 0.01, ci90: [-0.02, 0.04] },
    },
    foldReport: [
      { rankers: { 'atlasx-baseline': { meanIC: 0.2 } } },
      { rankers: { 'atlasx-baseline': { meanIC: 0.15 } } },
      { rankers: { 'atlasx-baseline': { meanIC: 0.18 } } },
    ],
    verdict: { survivorshipSafe: false, survivorshipReason: SURVIVORSHIP_REASON },
  };
  const forcedReadout = promotionReadout(forced);
  assert.equal(forcedReadout.atlasxTopsIC, true, 'atlasx should read as champion here');
  assert.equal(forcedReadout.beatsProductionIC, true, 'atlasx should beat production IC here');
  assert.equal(forcedReadout.eligible, false, 'STILL fail-closed: survivorship-unsafe can never promote');
  assert.ok(forcedReadout.unmet.includes('incrementalExcessReturn'), 'trust-gated criteria stay unmet');
});

test('runComparison: deterministic on identical input', () => {
  const events = buildFixtureEvents();
  const a = runComparison(events);
  const b = runComparison(events);
  assert.deepEqual(a.perRankerIC, b.perRankerIC);
  assert.deepEqual(a.perRankerMetrics, b.perRankerMetrics);
  assert.deepEqual(a.champion, b.champion);
  assert.equal(a.manifest.datasetHash, b.manifest.datasetHash);
});
