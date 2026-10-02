'use strict';
// lib/filing-redflags — pure classifiers, daily-index parsing, the first-in-252 state
// machine, placebo date math and the ledger row shape. No network, no clock, no store.
const test = require('node:test');
const assert = require('node:assert/strict');
const RF = require('../lib/filing-redflags');

// ── 8-K item classification ───────────────────────────────────────────────────
test('parseItems: comma list → normalized codes; blank/null → []', () => {
  assert.deepEqual(RF.parseItems('1.01,3.02, 9.01'), ['1.01', '3.02', '9.01']);
  assert.deepEqual(RF.parseItems(''), []);
  assert.deepEqual(RF.parseItems(null), []);
});

test('classify8kItems: 4.02 / 3.01 flag directly; 4.01 only without a 2.02 earnings release; 5.02 needs text', () => {
  assert.deepEqual(RF.classify8kItems(['4.02', '9.01']), { flags: ['ITEM_4_02'], needsText: false });
  assert.deepEqual(RF.classify8kItems(['3.01']), { flags: ['ITEM_3_01'], needsText: false });
  assert.deepEqual(RF.classify8kItems(['4.01']), { flags: ['ITEM_4_01'], needsText: false });
  assert.deepEqual(RF.classify8kItems(['2.02', '4.01']), { flags: [], needsText: false }, 'auditor change bundled with earnings is not the stand-alone event');
  assert.deepEqual(RF.classify8kItems(['5.02']), { flags: [], needsText: true });
  assert.deepEqual(RF.classify8kItems(['4.02', '5.02']), { flags: ['ITEM_4_02'], needsText: true });
  assert.deepEqual(RF.classify8kItems([]), { flags: [], needsText: false });
});

test('classify502Text: CEO/CFO departure language → roles; appointments-only or other officers → none', () => {
  const html = '<html><body><p>Item 5.02. On September 29, 2026, Jane Doe notified the Board of her decision to <b>resign</b> as Chief Financial Officer, effective October 15, 2026.</p></body></html>';
  assert.deepEqual(RF.classify502Text(html), { cxoDeparture: true, roles: ['CFO'] });
  const ceo = 'The Company announced that John Smith will step down as Chief Executive Officer and as a director.';
  assert.deepEqual(RF.classify502Text(ceo), { cxoDeparture: true, roles: ['CEO'] });
  const appoint = 'The Board appointed Mary Roe as Chief Operating Officer. Ms. Roe has served since 2019.';
  assert.deepEqual(RF.classify502Text(appoint), { cxoDeparture: false, roles: [] });
  const vp = 'The Company terminated the employment of its Vice President of Sales.';
  assert.deepEqual(RF.classify502Text(vp), { cxoDeparture: false, roles: [] });
  assert.deepEqual(RF.classify502Text(''), { cxoDeparture: false, roles: [] });
});

// ── Daily form index ──────────────────────────────────────────────────────────
const IDX = [
  'Description: Daily Index of EDGAR Dissemination Feed',
  'Form Type   Company Name                       CIK         Date Filed  File Name',
  '---------------------------------------------------------------------------------',
  '8-K         ACME WIDGETS INC                   1234567     20261001    edgar/data/1234567/0001234567-26-000012.txt',
  '8-K/A       ACME WIDGETS INC                   1234567     20261001    edgar/data/1234567/0001234567-26-000013.txt',
  'NT 10-K     BIG   SPACES CORP                  7654321     20261001    edgar/data/7654321/0000950170-26-000001.txt',
  'NT 10-Q/A   BIG   SPACES CORP                  7654321     20261001    edgar/data/7654321/0000950170-26-000002.txt',
  'NT 10-Q     TINY CO                            11          20261001    edgar/data/11/0000000011-26-000003.txt',
  '4           SOMEONE                            99          20261001    edgar/data/99/0000000099-26-000004.txt',
  '10-K        NOT WANTED                         5           20261001    edgar/data/5/0000000005-26-000005.txt',
].join('\n');

test('parseDailyIndex: keeps 8-K / NT 10-K / NT 10-Q only, drops amendments and other forms, pads CIK, normalizes dates', () => {
  const rows = RF.parseDailyIndex(IDX);
  assert.deepEqual(rows.map((r) => r.form), ['8-K', 'NT 10-K', 'NT 10-Q']);
  assert.equal(rows[0].cik, '0001234567');
  assert.equal(rows[0].dateFiled, '2026-10-01');
  assert.equal(rows[0].accession, '0001234567-26-000012');
  assert.equal(rows[1].company, 'BIG   SPACES CORP', 'company names keep internal spacing');
  assert.equal(rows[2].cik, '0000000011');
  assert.deepEqual(RF.parseDailyIndex(''), []);
});

test('ntFlagFor: NT 10-K / NT 10-Q → NT_FIRST kind; 8-K → null', () => {
  assert.equal(RF.ntKind('NT 10-K'), 'NT');
  assert.equal(RF.ntKind('NT 10-Q'), 'NT');
  assert.equal(RF.ntKind('8-K'), null);
});

// ── First-in-252-sessions state machine (365 calendar-day proxy) ─────────────
test('firstIn: no prior → first; prior inside the window → not first; prior outside → first again; same-day re-tick stays first', () => {
  const s0 = RF.emptyState();
  assert.equal(RF.isFirstIn(s0, 'AAA', 'NT', '2026-10-01'), true);
  const s1 = RF.advanceState(s0, 'AAA', 'NT', '2026-10-01');
  assert.notEqual(s1, s0, 'state is a new object');
  assert.deepEqual(s0.byTicker, {}, 'input not mutated');
  assert.equal(RF.isFirstIn(s1, 'AAA', 'NT', '2026-10-01'), true, 'idempotent: the same event on a re-tick is still the first');
  assert.equal(RF.isFirstIn(s1, 'AAA', 'NT', '2027-01-15'), false, '106 days later — inside the window');
  assert.equal(RF.isFirstIn(s1, 'AAA', 'NT', '2027-09-30'), false, '364 days later — still inside');
  assert.equal(RF.isFirstIn(s1, 'AAA', 'NT', '2027-10-02'), true, '366 days later — window elapsed');
  assert.equal(RF.isFirstIn(s1, 'AAA', 'GC', '2026-12-01'), true, 'kinds are independent');
  assert.equal(RF.isFirstIn(s1, 'BBB', 'NT', '2026-12-01'), true, 'tickers are independent');
});

test('advanceState: keeps the LATEST date per ticker/kind and never moves backwards', () => {
  const s = RF.advanceState(RF.advanceState(RF.emptyState(), 'AAA', 'NT', '2026-10-01'), 'AAA', 'NT', '2026-09-01');
  assert.equal(s.byTicker.AAA.NT, '2026-10-01');
  const s2 = RF.advanceState(s, 'AAA', 'NT', '2026-11-01');
  assert.equal(s2.byTicker.AAA.NT, '2026-11-01');
  assert.equal(s.byTicker.AAA.NT, '2026-10-01', 'prior state untouched');
});

test('FIRST_IN frozen: 252 sessions, 365 calendar-day proxy (stated, not tuned)', () => {
  assert.equal(RF.FROZEN.firstInSessions, 252);
  assert.equal(RF.FROZEN.firstInCalendarDays, 365);
});

// ── Placebo date math ─────────────────────────────────────────────────────────
const candles = (n) => Array.from({ length: n }, (_, i) => ({ date: `D${String(i).padStart(4, '0')}`, close: 10, open: 10, volume: 1e6 }));

test('placeboIndex: decision index − 126, only when ≥ 60 prior bars remain', () => {
  assert.equal(RF.placeboIndex(300), 174);
  assert.equal(RF.placeboIndex(186), 60);
  assert.equal(RF.placeboIndex(185), null);
  assert.equal(RF.placeboIndex(null), null);
  assert.equal(RF.FROZEN.placeboShiftSessions, 126);
});

test('decisionIndex / placeboDecisionDate: the decision bar is the last session ≤ the event date; placebo = 126 sessions earlier', () => {
  const c = candles(400).map((b, i) => ({ ...b, date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10) }));
  const i = RF.decisionIndex(c, c[300].date);
  assert.equal(i, 300);
  assert.equal(RF.decisionIndex(c, '2024-01-01'), -1, 'before the first bar');
  assert.equal(RF.placeboDecisionDate(c, c[300].date), c[174].date);
  assert.equal(RF.placeboDecisionDate(c, c[100].date), null, 'too little history for a placebo');
});

// ── Eligibility + ledger row ─────────────────────────────────────────────────
test('classifyEligibility: kit floors (≥60 bars, close ≥ $2, ADV60 ≥ $2M) with reasons; liquidity tier by dollar volume', () => {
  assert.deepEqual(RF.classifyEligibility({ bars: 120, close: 10, adv60: 3e7 }), { eligible: true, reasons: [], liqTier: 'liquid' });
  assert.deepEqual(RF.classifyEligibility({ bars: 120, close: 10, adv60: 6e6 }), { eligible: true, reasons: [], liqTier: 'small' });
  assert.deepEqual(RF.classifyEligibility({ bars: 120, close: 10, adv60: 2.5e6 }), { eligible: true, reasons: [], liqTier: 'micro' });
  assert.deepEqual(RF.classifyEligibility({ bars: 50, close: 1.5, adv60: 1e6 }), { eligible: false, reasons: ['too-few-bars', 'sub-$2', 'adv60-below-$2M'], liqTier: 'micro' });
  assert.deepEqual(RF.classifyEligibility(null), { eligible: false, reasons: ['no-history'], liqTier: null });
});

test('ledgerRow: eligible → tier = flag id, scope = measured tier; ineligible → EXCLUDED with reasons; next-open long contract', () => {
  const ev = { ticker: 'AAA', cik: '0000000001', flag: 'NT_FIRST', form: 'NT 10-K', accession: 'a1', filingDate: '2026-10-01', detail: null };
  const row = RF.ledgerRow(ev, { close: 12, adv60: 2.5e7, asOf: '2026-10-01', bars: 200 }, '2026-10-01');
  assert.equal(row.tier, 'NT_FIRST'); assert.equal(row.scope, 'large'); assert.equal(row.flag, 'NT_FIRST');
  assert.equal(row.entry, null); assert.equal(row.fillPolicy, 'next-session-open'); assert.equal(row.side, 'long');
  assert.equal(row.date, '2026-10-01'); assert.equal(row.eventDate, '2026-10-01');
  const ex = RF.ledgerRow(ev, null, '2026-10-01');
  assert.equal(ex.tier, RF.EXCLUDED_TIER); assert.deepEqual(ex.reasons, ['no-history']); assert.equal(ex.scope, null);
  const small = RF.ledgerRow(ev, { close: 1, adv60: 6e6, asOf: '2026-10-01', bars: 200 }, '2026-10-01');
  assert.equal(small.tier, RF.EXCLUDED_TIER); assert.equal(small.scope, 'small');
});

test('eventKey: ticker|flag|accession — the union key a re-tick or backfill dedupes on', () => {
  assert.equal(RF.eventKey({ ticker: 'AAA', flag: 'ITEM_4_02', accession: 'x-1' }), 'AAA|ITEM_4_02|x-1');
});

test('FLAGS: six AVOID-side flags, each with a registry id and a plain-English label', () => {
  assert.deepEqual(Object.keys(RF.FLAGS), ['NT_FIRST', 'ITEM_4_02', 'ITEM_4_01', 'ITEM_3_01', 'ITEM_5_02_CXO', 'GOING_CONCERN_FIRST']);
  for (const f of Object.values(RF.FLAGS)) { assert.match(f.hypothesisId, /^redflag-/); assert.ok(f.label.length > 5); }
});
