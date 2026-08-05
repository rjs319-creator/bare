'use strict';
// COIL COHORT VINTAGE — the follow-up to the live finding that 2,122 of 3,169 scanned
// names carried bars from a session other than the one the route declared.
//
// A coil score is a CROSS-SECTIONAL percentile. Ranking a name whose newest bar is from
// last week against names with today's bar compares two different questions and calls the
// answer one ranking. The fix adjudicates ONE session per cohort and ranks only the names
// that carry it — the same discipline the screener's cohort freshness gate already used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cohortFreshness, avgDollarVol } = require('../lib/screener-routes');
const DG = require('../lib/data-gates');

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'screener-routes.js'), 'utf8');
const bars = (dates, close = 10, volume = 1e6) => dates.map(d => ({ date: d, open: close, high: close, low: close, close, volume }));

test('the scan adjudicates ONE session and ranks only the names carrying it', () => {
  assert.match(src, /const vintage = cohortFreshness\(cohort\)/);
  assert.match(src, /cohort\.filter\(r => r\.candles\[r\.candles\.length - 1\]\.date === vintage\.decisionSession\)/);
  assert.match(src, /ranked: coil\.rankCoil\(atSession, calScope\)/, 'rankCoil must see the session-matched subset, not the raw cohort');
});

test('excluded names are COUNTED, never silently dropped', () => {
  assert.match(src, /excludedStale = cohort\.length - atSession\.length/);
  assert.match(src, /staleCandidates: excludedStale/);
  assert.match(src, /byScope: scan\.byScope/);
  assert.match(src, /excludedScopes: scan\.excludedScopes/);
});

test('the full scan refuses to merge scopes from different sessions', () => {
  // The cap-band caches are rebuilt by the daily warm cron; `expanded` has no cron at all
  // (op=universescan → op=universecompile is manual), so merging them blends vintages.
  assert.match(src, /const admitted = scopes\.filter\(\(\[, r\]\) => r\.decisionSession && r\.decisionSession === decisionSession\)/);
  assert.match(src, /admitted\.flatMap/);
  assert.match(src, /behind the newest adjudicated session/);
});

test('cohortFreshness still names the modal session and counts the stragglers', () => {
  const cohort = [
    { candles: bars(['2026-08-04', '2026-08-05']) },
    { candles: bars(['2026-08-05']) },
    { candles: bars(['2026-08-05']) },
    { candles: bars(['2026-07-20']) },
  ];
  const v = cohortFreshness(cohort);
  assert.equal(v.decisionSession, '2026-08-05');
  assert.equal(v.atSession, 3);
  assert.equal(v.behind, 1);
});

test('LIQUIDITY: a coil pick now publishes the dollar volume the scan already held', () => {
  assert.match(src, /dollarVol: avgDollarVol\(r\.candles, 20\)/);
  assert.match(src, /lastBarDate: r\.candles/);
  assert.equal(avgDollarVol(bars(Array.from({ length: 25 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`), 10, 1e6)), 10_000_000);
});

test('unknown liquidity stays NULL — never 0, which would read as "no volume"', () => {
  assert.equal(avgDollarVol(bars(['2026-08-03', '2026-08-04'])), null);
  assert.equal(avgDollarVol([]), null);
  assert.equal(avgDollarVol([{ date: '2026-08-04', close: 0, volume: 0 }]), null);
});

test('with liquidity published, a coil payload clears the gate\'s coverage rule', () => {
  const NOW = Date.parse('2026-08-05T22:30:00Z');
  const payload = {
    generatedAt: new Date(NOW).toISOString(),
    freshness: { decisionSession: '2026-08-05', staleCandidates: 0, counts: { scanned: 900, atDecisionSession: 900 } },
    picks: [{ ticker: 'A', price: 10, dollarVol: 5e7 }, { ticker: 'B', price: 20, dollarVol: 8e7 }],
  };
  const g = DG.evaluateSource('coil', payload, { horizon: 'swing' }, { nowMs: NOW, available: {} });
  assert.equal(g.ok, true, g.staleInputs.join('; '));
  assert.equal(g.liquidityCoverage, 1);
  // and a payload that still publishes no liquidity is still (correctly) refused
  const noLiq = { ...payload, picks: [{ ticker: 'A', price: 10 }] };
  assert.equal(DG.evaluateSource('coil', noLiq, { horizon: 'swing' }, { nowMs: NOW, available: {} }).ok, false);
});

test('a cohort with no dated bars ranks NOTHING rather than ranking a mixed pile', () => {
  const v = cohortFreshness([{ candles: [] }, {}]);
  assert.equal(v.decisionSession, null);
  // the scan's guard: no adjudicated session ⇒ atSession is empty ⇒ nothing is ranked
  assert.match(src, /const atSession = vintage\.decisionSession\s*\n\s*\? cohort\.filter/);
  assert.match(src, /: \[\];/);
});
