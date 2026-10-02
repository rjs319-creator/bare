'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseResult, rankItems, CLASSES } = require('../lib/toneshift');
const { tierFor } = require('../lib/toneshift-routes');

const CANDS = [{ ticker: 'AAA' }, { ticker: 'BBB' }];

test('parseResult: keeps allowed, clamps shift/confidence, drops hallucinations', () => {
  const { items } = parseResult({ items: [
    { ticker: 'aaa', shift: 'BRIGHTENING', change: 'dropped hedges', confidence: 9, thesis: 't' },
    { ticker: 'ZZZ', shift: 'BRIGHTENING', change: 'x', confidence: 3, thesis: 't' },   // not a candidate → dropped
    { ticker: 'BBB', shift: 'BOGUS', change: 'y', confidence: 2, thesis: 't' },           // bad enum → STABLE
  ] }, CANDS);
  assert.equal(items.length, 2);
  assert.equal(items.find(x => x.ticker === 'AAA').confidence, 5);       // clamped
  assert.equal(items.find(x => x.ticker === 'BBB').shift, 'STABLE');
  assert.ok(items.every(i => CLASSES.includes(i.shift)));
});

test('parseResult: bad input → empty', () => {
  assert.deepEqual(parseResult(null, CANDS).items, []);
});

test('rankItems: BRIGHTENING first, then STABLE, then DARKENING; confidence breaks ties', () => {
  const items = [
    { ticker: 'D', shift: 'DARKENING', confidence: 5 },
    { ticker: 'S', shift: 'STABLE', confidence: 5 },
    { ticker: 'B1', shift: 'BRIGHTENING', confidence: 3 },
    { ticker: 'B2', shift: 'BRIGHTENING', confidence: 4 },
  ];
  assert.deepEqual(rankItems(items).map(x => x.ticker), ['B2', 'B1', 'S', 'D']);
});

test('tierFor: shift → Scoreboard tier', () => {
  assert.equal(tierFor({ shift: 'BRIGHTENING' }), 'Brightening');
  assert.equal(tierFor({ shift: 'STABLE' }), 'Stable');
  assert.equal(tierFor({ shift: 'DARKENING' }), 'Darkening');
});

// ── Honest proxy labeling (coverage tone, not transcript tone) ────────────────
const TSR = require('../lib/toneshift-routes');
test('toneshift labels its coverage-proxy data basis honestly (not transcript tone)', () => {
  assert.equal(TSR.DATA_BASIS, 'coverage-proxy');
  assert.match(TSR.PROXY_NOTE, /coverage/i);
  assert.match(TSR.PROXY_NOTE, /not raw transcripts/i);
  // The user-facing disclaimer must also disclose the proxy, never imply transcripts.
  assert.match(TSR.DISCLAIMER, /coverage/i);
});

test('a stale cached document cannot override the data-basis label', () => {
  // The label must describe what THIS code does, not whatever a doc written by an older
  // deploy happened to carry — otherwise a cache entry could silently claim transcript
  // provenance the engine never had.
  const cached = { dataBasis: 'transcript', proxyNote: 'stale claim', items: [] };
  const payload = { disclaimer: TSR.DISCLAIMER, ...cached, dataBasis: TSR.DATA_BASIS, proxyNote: TSR.PROXY_NOTE };

  assert.equal(payload.dataBasis, 'coverage-proxy');
  assert.equal(payload.proxyNote, TSR.PROXY_NOTE);
});

// ── Candidate detection reads the FLAT tone ledger correctly (site audit 2026-10-02 #9) ──
const FLAT_LEDGER = [
  { date: '2026-09-11', ticker: 'JBHT', tone: 7, callDate: '2026-09-10' },
  { date: '2026-09-30', ticker: 'MU', tone: 8, callDate: '2026-09-23' },
  { date: '2026-09-30', ticker: 'NKE', tone: -3, callDate: '2026-09-30' },
  { date: '2026-09-30', ticker: 'MU', tone: 8, callDate: '2026-09-23' },     // duplicate → deduped
  { date: '2026-08-02', ticker: 'OLD', tone: 2 },
];

test('latestLedgerDay groups flat signals back into the newest day that holds signals', () => {
  const day = TSR.latestLedgerDay(FLAT_LEDGER);
  assert.equal(day.date, '2026-09-30');
  assert.equal(day.signals.length, 3);
  assert.equal(TSR.latestLedgerDay([]), null);
  assert.equal(TSR.latestLedgerDay([{ ticker: 'X' }]), null);     // undated rows are not a day
});

test('detect returns the newest day\'s reporters, deduped and strongest |tone| first, with asOf = that day', async () => {
  const { cands, asOf } = await TSR.detect(5, { signals: FLAT_LEDGER });
  assert.equal(asOf, '2026-09-30');
  assert.deepEqual(cands.map(c => c.ticker), ['MU', 'NKE']);
  assert.equal(cands[0].callDate, '2026-09-23');
});

test('detect on an empty ledger is honestly empty (not a throw, not a stale date)', async () => {
  assert.deepEqual(await TSR.detect(5, { signals: [] }), { cands: [], asOf: null });
});

test('freshness: leads declare the ledger day as cutoff; an empty read declares the evaluated session', () => {
  const NOW = Date.parse('2026-10-01T22:01:00Z');                 // Thu after the close (ET)
  const withLeads = TSR.freshnessFor({ asOf: '2026-09-11', hasCandidates: true, nowMs: NOW });
  assert.equal(withLeads.freshness.decisionSession, '2026-09-11');
  assert.equal(withLeads.ledger.latestDay, '2026-09-11');
  assert.ok(withLeads.ledger.sessionsBehind >= 13, `expected the ledger to trail by weeks, got ${withLeads.ledger.sessionsBehind}`);
  const empty = TSR.freshnessFor({ asOf: '2026-09-11', hasCandidates: false, nowMs: NOW });
  assert.equal(empty.freshness.decisionSession, '2026-10-01');
  assert.equal(empty.freshness.ledgerDay, '2026-09-11');          // the stale ledger stays visible
  // And the data gate reads the declared cutoff, not the ledger day.
  const DG = require('../lib/data-gates');
  assert.equal(DG.cutoffOf({ asOf: '2026-09-11', ...empty }), '2026-10-01');
});
