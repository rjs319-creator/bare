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

test('the full scan delegates to the pure, exported merge (behavior is tested below)', () => {
  // The cap-band caches are rebuilt by the daily warm cron; `expanded` has no cron at all
  // (op=universescan → op=universecompile is manual), so merging them blends vintages.
  // The merge lives in mergeCoilScopes so its CONTRACT can be exercised, not regex-matched.
  assert.match(src, /return mergeCoilScopes\(\[\['large', lg\]/);
  assert.match(src, /function mergeCoilScopes\(scopes\)/);
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

// ── The merge CONTRACT, exercised for real ──────────────────────────────────
// The first cut of this merge inlined its logic and silently dropped `ranked` from the
// returned object. Every test above passed (they were source scans) and op=coil 500'd in
// production on `ranked.slice(...)`. These tests call the function.
const { mergeCoilScopes } = require('../lib/screener-routes');
const scope = (session, tickers, scanned) => ({
  cohortCount: scanned, rankedCount: tickers.length, decisionSession: session,
  excludedStale: scanned - tickers.length,
  ranked: tickers.map((t, i) => ({ ticker: t, score: 100 - i })),
});

test('mergeCoilScopes RETURNS A RANKED ARRAY (the regression that 500\'d production)', () => {
  const out = mergeCoilScopes([['large', scope('2026-08-05', ['A', 'B'], 10)]]);
  assert.ok(Array.isArray(out.ranked), 'ranked must be present and an array');
  assert.deepEqual(out.ranked.map(r => r.ticker), ['A', 'B']);
  assert.equal(out.rankedCount, 2);
  // the shape runCoil destructures must be complete
  for (const k of ['ranked', 'cohortCount', 'rankedCount', 'decisionSession', 'excludedStale', 'excludedScopes', 'byScope']) {
    assert.ok(k in out, `missing ${k}`);
  }
});

test('mergeCoilScopes admits only the scopes at the NEWEST adjudicated session', () => {
  const out = mergeCoilScopes([
    ['large', scope('2026-08-05', ['A', 'B'], 10)],
    ['small', scope('2026-08-05', ['C'], 5)],
    ['expanded', scope('2026-07-20', ['D'], 900)],
  ]);
  assert.deepEqual(out.ranked.map(r => r.ticker), ['A', 'C', 'B'], 'stale scope excluded, rest merged by score');
  assert.equal(out.decisionSession, '2026-08-05');
  assert.deepEqual(out.excludedScopes.map(s => s.scope), ['expanded']);
  assert.match(out.excludedScopes[0].reason, /behind the newest/);
  assert.equal(out.byScope.expanded.session, '2026-07-20', 'the lag stays visible per scope');
});

test('mergeCoilScopes dedupes overlapping scopes, cap-band ranking wins', () => {
  const out = mergeCoilScopes([
    ['large', scope('2026-08-05', ['DUP'], 5)],
    ['expanded', { ...scope('2026-08-05', ['DUP', 'NEW'], 900), ranked: [{ ticker: 'DUP', score: 99 }, { ticker: 'NEW', score: 98 }] },
    ],
  ]);
  assert.equal(out.ranked.filter(r => r.ticker === 'DUP').length, 1);
  assert.deepEqual(out.ranked.map(r => r.ticker).sort(), ['DUP', 'NEW']);
});

test('mergeCoilScopes on empty / malformed input returns an empty ranking, never undefined', () => {
  for (const input of [[], null, [['large', null]], [['large', { cohortCount: 0 }]]]) {
    const out = mergeCoilScopes(input);
    assert.ok(Array.isArray(out.ranked));
    assert.equal(out.ranked.length, 0);
    assert.equal(out.decisionSession, null);
  }
});

test('runCoil cannot 500 on a scan that returns no ranking', () => {
  assert.match(src, /const picks = \(ranked \|\| \[\]\)\.slice/, 'the call site must tolerate a missing ranking');
});
