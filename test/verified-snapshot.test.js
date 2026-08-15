'use strict';
// VERIFIED MARKET SNAPSHOT — guard tests: stale refusal, empty ⇒ anti-fabrication
// sentinel (never a silent omission), deterministic arithmetic, source-of-truth
// contract language, prediction-market line honesty, and the gameplan wiring.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const VS = require('../lib/verified-snapshot');
const gp = require('../lib/gameplan');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const mk = (n, lastDate = '2026-08-14') => {
  // n candles ending at lastDate, one calendar day apart, close ramping 100 → 100+n-1.
  const end = Date.parse(lastDate + 'T00:00:00Z');
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(end - (n - 1 - i) * 864e5).toISOString().slice(0, 10),
    close: 100 + i, high: 100 + i + 1, low: 100 + i - 1,
  }));
};

test('snapshotRow computes close, trailing %s and the 3-month range deterministically', () => {
  const row = VS.snapshotRow(mk(30), '2026-08-15');
  assert.equal(row.ok, true);
  assert.equal(row.close, 129);
  assert.equal(row.d1, +(((129 - 128) / 128) * 100).toFixed(2));
  assert.equal(row.d5, +(((129 - 124) / 124) * 100).toFixed(2));
  assert.equal(row.d20, +(((129 - 109) / 109) * 100).toFixed(2));
  assert.equal(row.hi3m, 130, 'range uses highs/lows, not closes');
  assert.equal(row.lo3m, 99);
  assert.ok(row.fromHi3mPct < 0 && row.fromLo3mPct > 0);
});

test('STALE REFUSAL: a frame older than MAX_STALE_DAYS renders the sentinel, never stale numbers', () => {
  const stale = mk(30, '2026-08-01');
  const row = VS.snapshotRow(stale, '2026-08-15');
  assert.equal(row.ok, false);
  assert.match(row.reason, /stale/);
  const block = VS.snapshotBlock({ SPY: stale }, '2026-08-15');
  assert.match(block, /SPY: DATA UNAVAILABLE/);
  assert.doesNotMatch(block, /close 129/, 'stale numbers must not render');
  // Within tolerance the same frame is fine.
  assert.equal(VS.snapshotRow(stale, '2026-08-04').ok, true);
});

test('EMPTY ⇒ SENTINEL: missing frames render an explicit do-not-fabricate line per symbol', () => {
  const block = VS.snapshotBlock({ SPY: mk(30), QQQ: null, '^VIX': [] }, '2026-08-15');
  assert.match(block, /- SPY: close 129/);
  assert.match(block, /- QQQ: DATA UNAVAILABLE — do not estimate or fabricate/);
  assert.match(block, /- \^VIX: DATA UNAVAILABLE/);
  assert.equal(VS.snapshotBlock({}, '2026-08-15'), '');
});

test('snapshotBlock carries the source-of-truth contract: flag, never reconcile; no underivable levels', () => {
  const block = VS.snapshotBlock({ SPY: mk(30) }, '2026-08-15');
  assert.match(block, /ONLY source of truth/);
  assert.match(block, /flag the discrepancy/);
  assert.match(block, /do not invent a reconciled number/);
  assert.match(block, /cannot be derived from this table/);
  assert.match(block, /deterministic/i);
});

test('predMarketsLine renders top markets with probability + 1-day drift, framed as crowd odds not edge', () => {
  const line = VS.predMarketsLine([
    { venue: 'Kalshi', id: 'KXFED-25DEC', group: 'Fed', title: 'Fed cuts rates in December', prob: 0.78, probPrev: 0.72, movePts: 6, heat: 90 },
    { venue: 'Polymarket', id: 'poly-1', title: 'CPI YoY above 3% in September', prob: 0.31, probPrev: 0.31, movePts: 0.4, heat: 60 },
  ]);
  assert.match(line, /"Fed cuts rates in December" 78% \(↑6pts\/1d\)/, 'drift states its 1-day window');
  assert.match(line, /"CPI YoY above 3% in September" 31%/);
  assert.doesNotMatch(line, /31% \(/, 'sub-1pt drift is noise — not rendered');
  assert.match(line, /NOT an edge/);
  assert.match(line, /market-implied/);
  assert.equal(VS.predMarketsLine([]), '');
  assert.equal(VS.predMarketsLine([{ title: 'bad prob', prob: 1.4 }]), '', 'out-of-range probabilities are dropped');
});

test('predMarketsLine honesty guards: no fabricated drift, no confident 0%, no strike-ladder floods', () => {
  // A first-traded-today market (probPrev coerced to 0 upstream) must not show a giant fake swing.
  const firstDay = VS.predMarketsLine([{ venue: 'Kalshi', id: 'KXINX-A', group: 'S&P', title: 'S&P above 6400', prob: 0.65, probPrev: 0, movePts: 65, heat: 99 }]);
  assert.match(firstDay, /"S&P above 6400" 65%/);
  assert.doesNotMatch(firstDay, /pts/, 'no prior trade → no drift rendered');
  // prob=0 from a num() coercion of a missing price must not render as near-impossibility odds.
  assert.equal(VS.predMarketsLine([{ venue: 'Kalshi', id: 'x', group: 'g', title: 'broken price', prob: 0, probPrev: 0.4, movePts: 40 }]), '');
  // One Kalshi series ladder can't fill the block: dedup keeps the hottest strike per series.
  const ladder = VS.predMarketsLine([
    { venue: 'Kalshi', id: 'KXINX-6400', group: 'S&P index', title: 'S&P above 6400', prob: 0.62, probPrev: 0.6, movePts: 2, heat: 95 },
    { venue: 'Kalshi', id: 'KXINX-6450', group: 'S&P index', title: 'S&P above 6450', prob: 0.48, probPrev: 0.46, movePts: 2, heat: 94 },
    { venue: 'Kalshi', id: 'KXFED-DEC', group: 'Fed', title: 'Fed cuts in December', prob: 0.78, probPrev: 0.72, movePts: 6, heat: 80 },
  ]);
  assert.match(ladder, /S&P above 6400/);
  assert.doesNotMatch(ladder, /S&P above 6450/, 'sibling strike deduped by series');
  assert.match(ladder, /Fed cuts in December/);
});

test('buildUserMessage places predMarkets with the context lines and the snapshot before headlines', () => {
  const msg = gp.buildUserMessage({
    date: '2026-08-15', macro: null, headlines: [{ title: 'h1' }], signals: null,
    snapshot: VS.snapshotBlock({ SPY: mk(30) }, '2026-08-15'),
    predMarkets: 'Event probabilities (prediction markets, market-implied crowd odds — positioning context, NOT an edge and NOT a forecast endorsement): "Fed cuts" 78%.',
  });
  assert.match(msg, /VERIFIED MARKET SNAPSHOT/);
  assert.match(msg, /Event probabilities/);
  assert.ok(msg.indexOf('Event probabilities') < msg.indexOf('VERIFIED MARKET SNAPSHOT'));
  assert.ok(msg.indexOf('VERIFIED MARKET SNAPSHOT') < msg.indexOf('h1'), 'snapshot renders before headlines');
  assert.doesNotMatch(gp.buildUserMessage({ date: 'd', headlines: [] }), /VERIFIED MARKET SNAPSHOT/);
});

test('FORMING-BAR GUARD: bars newer than the last completed session never render as verified closes', () => {
  const withToday = mk(30, '2026-08-14');                       // last bar 08-14 — a live session's forming bar
  const guarded = VS.snapshotRow(withToday, '2026-08-14', '2026-08-13');
  assert.equal(guarded.date, '2026-08-13', 'forming bar dropped — last completed session renders');
  assert.equal(guarded.close, 128);
  const unguarded = VS.snapshotRow(withToday, '2026-08-14', '2026-08-14');
  assert.equal(unguarded.close, 129, 'post-close the same-day completed bar renders');
});

test('SYSTEM prompt binds the model to the snapshot contract with the EXACT rendered marker', () => {
  assert.match(gp.SYSTEM, /VERIFIED MARKET SNAPSHOT/);
  assert.match(gp.SYSTEM, /ONLY source of truth/);
  assert.match(gp.SYSTEM, /flag \(rather than reconcile\)/);
  const marker = VS.NO_DATA_SENTINEL.split(' — ')[0];
  assert.ok(gp.SYSTEM.includes(marker), 'SYSTEM must reference the marker the snapshot actually renders');
  assert.match(read('lib/gameplan.js'), /require\('\.\/verified-snapshot'\)\.NO_DATA_SENTINEL/, 'marker imported, not a diverging copy');
});

test('route wiring: snapshot symbols fetched in the parallel gather, bench frame shared with reflection', () => {
  const src = read('lib/gameplan-routes.js');
  const R = require('../lib/gameplan-reflection');
  assert.match(src, /require\('\.\/verified-snapshot'\)/);
  assert.match(src, /SNAPSHOT_SYMBOLS = \[reflection\.BENCH_SYMBOL, 'QQQ', 'IWM'\]/, 'benchmark coupling is explicit; VIX stays with fetchMacro');
  assert.equal(R.BENCH_SYMBOL, 'SPY');
  assert.match(src, /gatherSnapshotCandles\(\),\n\s*gatherPredMarkets\(\),/, 'both gathered inside the Promise.all');
  assert.match(src, /snapCandles\[reflection\.BENCH_SYMBOL\]/, 'reflection reuses the snapshot bench frame — no duplicate fetch');
  assert.match(src, /lastCompletedRegularSession\(new Date\(\)\)/, 'forming-bar guard wired');
  assert.match(src, /loadScoredMarkets/, 'shared predmarkets pipeline, not a fourth inline copy');
  assert.match(src, /Promise\.race/, 'pred-markets gather is deadline-raced — a hung venue cannot stall the plan');
  assert.match(src, /snapshot: snapshotText, predMarkets: predMarketsText/);
  assert.match(src, /out\[sym\] = d && Array\.isArray\(d\.candles\) \? d\.candles : null/, 'failed fetch yields null → sentinel line, never a missing key');
});

test('predmarkets getJSON carries an abort timeout so a hung venue cannot stall callers', () => {
  assert.match(read('lib/predmarkets.js'), /AbortSignal\.timeout\(8000\)/);
});

test('frozen integrity constants', () => {
  assert.equal(VS.MAX_STALE_DAYS, 5);
  assert.equal(VS.LOOKBACK_HI_LO_SESSIONS, 63);
  assert.match(VS.NO_DATA_SENTINEL, /do not estimate or fabricate/);
});
