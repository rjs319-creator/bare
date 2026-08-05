'use strict';
// DECLARED INFORMATION CUTOFFS — the follow-up to the 2026-08-05 live verification, where
// five endpoints were blocked by the pre-ranking data gate for publishing no session they
// could attest (coil, gapdown, optionsflow, readthrough, anomaly).
//
// The fix is NOT "make the gate pass". It is: publish the session each source actually
// observed, and keep refusing anything that only proves what time the response was built.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DG = require('../lib/data-gates');
const { cohortFreshness } = require('../lib/screener-routes');
const MS = require('../lib/market-session');

const NOW = Date.parse('2026-08-05T14:00:00Z');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');

test('the gate reads the session fields these routes genuinely publish', () => {
  assert.equal(DG.cutoffOf({ freshness: { decisionSession: '2026-08-04' } }), '2026-08-04');
  assert.equal(DG.cutoffOf({ dataFreshness: { sessionDate: '2026-08-04' } }), '2026-08-04');
  assert.equal(DG.cutoffOf({ spyLastDate: '2026-08-04' }), '2026-08-04');
  assert.equal(DG.cutoffOf({ asOf: '2026-08-04' }), '2026-08-04');
  assert.equal(DG.cutoffOf({ triggerDate: '2026-07-17' }), '2026-07-17', 'a read-through lead names its ledger day');
  assert.equal(DG.cutoffOf({ baselineAsOf: '2026-08-01' }), '2026-08-01');
});

test('THE POINT OF THE FIX: a bare `date` is the clock, not a cutoff, and is still refused', () => {
  // Several routes set `date = new Date().toISOString().slice(0,10)`. Accepting it would
  // let a three-week-old options chain or a half-stale cache present as current.
  assert.equal(DG.cutoffOf({ date: '2026-08-05' }), null);
  const g = DG.evaluateSource('optionsflow', { generatedAt: new Date(NOW).toISOString(), date: '2026-08-05', signals: [] },
    { horizon: 'swing' }, { nowMs: NOW, available: {} });
  assert.equal(g.ok, false);
  assert.match(g.staleInputs.join(' '), /information cutoff/);
  // but the same payload WITH a declared observed session passes
  const ok = DG.evaluateSource('optionsflow',
    { generatedAt: new Date(NOW).toISOString(), date: '2026-08-05', freshness: { decisionSession: '2026-08-04' }, signals: [{ ticker: 'A', dollarVol: 5e7 }] },
    { horizon: 'swing' }, { nowMs: NOW, available: {} });
  assert.equal(ok.ok, true, ok.staleInputs.join('; '));
});

test('a declared-but-STALE cutoff is now provably stale rather than merely unprovable', () => {
  // Read-through's triggerDate is genuinely weeks old; mapping it converts "we cannot
  // tell" into "we can tell, and it is old" — the block is the same, the reason is honest.
  const g = DG.evaluateSource('readthrough', { generatedAt: new Date(NOW).toISOString(), triggerDate: '2026-07-17', items: [] },
    { horizon: 'position' }, { nowMs: NOW, available: {} });
  assert.equal(g.ok, false);
  assert.equal(g.cutoff, '2026-07-17');
  assert.ok(g.cutoffSessions > 5);
  assert.match(g.staleInputs.join(' '), /sessions behind/);
});

test('cohortFreshness: the MODAL newest-bar date, with the stragglers counted', () => {
  const rows = [
    { candles: [{ date: '2026-08-03' }, { date: '2026-08-04' }] },
    { candles: [{ date: '2026-08-04' }] },
    { candles: [{ date: '2026-08-04' }] },
    { candles: [{ date: '2026-08-01' }] },
  ];
  const f = cohortFreshness(rows);
  assert.equal(f.decisionSession, '2026-08-04');
  assert.equal(f.atSession, 3);
  assert.equal(f.behind, 1, 'a half-refreshed cache must be visible, not averaged away');
});

test('cohortFreshness: one stray row cannot speak for the cohort, and ties break NEWER', () => {
  const stray = [
    ...Array.from({ length: 9 }, () => ({ candles: [{ date: '2026-08-04' }] })),
    { candles: [{ date: '2026-08-05' }] },
  ];
  assert.equal(cohortFreshness(stray).decisionSession, '2026-08-04', 'the max alone would let one row set the session');
  const tie = [{ candles: [{ date: '2026-08-04' }] }, { candles: [{ date: '2026-08-03' }] }];
  assert.equal(cohortFreshness(tie).decisionSession, '2026-08-04');
});

test('cohortFreshness: nothing dated ⇒ NO session is invented (the source stays blocked)', () => {
  assert.equal(cohortFreshness([]).decisionSession, null);
  assert.equal(cohortFreshness([{ candles: [] }, { }]).decisionSession, null);
});

test('COIL publishes the session its candle cohort was actually read through', () => {
  const s = src('screener-routes.js');
  assert.match(s, /const coilFreshness = cohortFreshness\(ranked\)/);
  assert.match(s, /decisionSession: coilFreshness\.decisionSession/);
  assert.match(s, /staleCandidates: coilFreshness\.behind/);
});

test('GAP-DOWN publishes the benchmark session it already computed but never emitted', () => {
  const s = src('screener-routes.js');
  assert.match(s, /earningsExcluded, scanned, spyLastDate \} = live/);
  assert.match(s, /dataFreshness: \{ sessionDate: spyLastDate/);
});

test('OPTIONS FLOW declares the last COMPLETED session — an in-progress one cannot be attested', () => {
  const s = src('optionsflow-routes.js');
  assert.match(s, /lastCompletedRegularSession/);
  assert.match(s, /decisionSession: observedSession/);
  // mid-session the helper must NOT claim the session it is inside
  assert.equal(MS.lastCompletedRegularSession(new Date('2026-08-04T19:00:00Z')), '2026-08-03');
  assert.equal(MS.lastCompletedRegularSession(new Date('2026-08-05T00:00:00Z')), '2026-08-04');
});

test('ANOMALY advances asOf for every name it READ, not only for the movers it found', () => {
  const s = src('anomaly-routes.js');
  const scanBlock = s.slice(s.indexOf('const out = []; let asOf = null;'), s.indexOf('return { movers:'));
  const asOfAt = scanBlock.indexOf('if (!asOf || last > asOf) asOf = last;');
  const filterAt = scanBlock.indexOf('if (!isAnomalyCandidate(m)) continue;');
  assert.ok(asOfAt > -1 && filterAt > -1);
  assert.ok(asOfAt < filterAt, 'asOf must be set BEFORE the candidate filter, or a quiet tape reports asOf:null');
});

test('the five previously-blocked sources now pass the gate on realistic payloads', () => {
  const fresh = new Date(NOW).toISOString();
  const cases = {
    coil: { generatedAt: fresh, freshness: { decisionSession: '2026-08-04', counts: { scanned: 900 } }, picks: [{ ticker: 'A', dollarVol: 5e7 }] },
    gapdown: { generatedAt: fresh, dataFreshness: { sessionDate: '2026-08-04' }, strong: [{ ticker: 'B', avgDollarVol: 5e7 }] },
    optionsflow: { generatedAt: fresh, freshness: { decisionSession: '2026-08-04' }, signals: [{ ticker: 'C', dollarVol: 5e7 }] },
    anomaly: { generatedAt: fresh, asOf: '2026-08-04', items: [{ ticker: 'D', dollarVol: 5e7 }] },
  };
  for (const [id, payload] of Object.entries(cases)) {
    const g = DG.evaluateSource(id, payload, { horizon: 'swing' }, { nowMs: NOW, available: {} });
    assert.equal(g.ok, true, `${id}: ${g.staleInputs.join('; ')}`);
    assert.equal(g.cutoff, '2026-08-04');
  }
});
