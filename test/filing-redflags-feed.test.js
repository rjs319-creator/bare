'use strict';
// lib/filing-redflags-feed (network injected) + lib/filing-redflags-store (pure merges):
// index fetch 403-vs-404 semantics, CIK join, the four classification stages with budget
// truncation, shard/state/current merge rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const FEED = require('../lib/filing-redflags-feed');
const ST = require('../lib/filing-redflags-store');
const RF = require('../lib/filing-redflags');

const res = (status, body = '', ok = status >= 200 && status < 300) => ({ status, ok, text: async () => body, json: async () => JSON.parse(body) });
const IDX = [
  '8-K         ACME WIDGETS INC                   1234567     20261001    edgar/data/1234567/0001234567-26-000012.txt',
  'NT 10-K     BIG SPACES CORP                    7654321     20261001    edgar/data/7654321/0000950170-26-000001.txt',
].join('\n');

test('fetchDailyIndex: 200 → rows; 404 and 403 AccessDenied → missing day; any other 403 or 5xx → throws (fail closed)', async () => {
  const ok = await FEED.fetchDailyIndex('2026-10-01', { fetchImpl: async () => res(200, IDX) });
  assert.equal(ok.missing, false); assert.equal(ok.rows.length, 2);
  assert.deepEqual(await FEED.fetchDailyIndex('2026-10-03', { fetchImpl: async () => res(404) }), { date: '2026-10-03', missing: true, rows: [] });
  assert.deepEqual(await FEED.fetchDailyIndex('2026-10-04', { fetchImpl: async () => res(403, '<Error><Code>AccessDenied</Code></Error>') }), { date: '2026-10-04', missing: true, rows: [] });
  await assert.rejects(FEED.fetchDailyIndex('2026-10-05', { fetchImpl: async () => res(403, '<html>Request Rate Threshold Exceeded</html>') }), /blocked/);
  await assert.rejects(FEED.fetchDailyIndex('2026-10-06', { fetchImpl: async () => res(503) }), /503/);
});

test('cikToTickerMap + selectRows: SEC map inverted (shortest ticker per CIK), unknown CIKs and known accessions dropped', () => {
  const map = FEED.cikToTickerMap({ ACME: '0001234567', 'ACME-B': '0001234567', BIG: 7654321 });
  assert.equal(map.get('0001234567'), 'ACME'); assert.equal(map.get('0007654321'), 'BIG');
  const rows = RF.parseDailyIndex(IDX);
  const sel = FEED.selectRows(rows, map, new Set(['0000950170-26-000001']));
  assert.deepEqual(sel.map((r) => r.ticker), ['ACME']);
  assert.deepEqual(FEED.selectRows(rows, new Map()), []);
});

test('ntEvents: NT rows become NT_FIRST once per window; the returned state advanced, the input state untouched', () => {
  const rows = [
    { form: 'NT 10-Q', ticker: 'BIG', cik: '0007654321', accession: 'n1', dateFiled: '2026-10-01' },
    { form: 'NT 10-K', ticker: 'BIG', cik: '0007654321', accession: 'n2', dateFiled: '2026-10-01' },
    { form: '8-K', ticker: 'ACME', cik: '0001234567', accession: 'e1', dateFiled: '2026-10-01' },
  ];
  const s0 = RF.emptyState();
  const r = FEED.ntEvents(rows, s0);
  assert.equal(r.events.length, 1, 'two NT forms on one day are one first-in-window event');
  assert.equal(r.events[0].flag, 'NT_FIRST'); assert.equal(r.events[0].accession, 'n1');
  assert.equal(r.state.byTicker.BIG.NT, '2026-10-01'); assert.deepEqual(s0.byTicker, {});
  const later = FEED.ntEvents([{ form: 'NT 10-Q', ticker: 'BIG', cik: 'x', accession: 'n3', dateFiled: '2027-02-01' }], r.state);
  assert.equal(later.events.length, 0, 'inside the window — not first');
});

test('classify8kRows: items from submissions JSON → 4.02/4.01/3.01 events, 5.02 → text candidate; budget truncation counted', async () => {
  const rec = { accessionNumber: ['a1', 'a2', 'a3', 'a4'], items: ['4.02,9.01', '2.02,4.01', '5.02', '3.01'], primaryDocument: ['d1.htm', 'd2.htm', 'd3.htm', 'd4.htm'] };
  const rows = ['a1', 'a2', 'a3', 'a4'].map((a) => ({ form: '8-K', ticker: 'ACME', cik: '0001234567', accession: a, dateFiled: '2026-10-01' }));
  const r = await FEED.classify8kRows(rows, { fetchSubmissions: async () => rec, budgetMs: 1e9, throttleMs: 0 });
  assert.deepEqual(r.events.map((e) => [e.accession, e.flag]), [['a1', 'ITEM_4_02'], ['a4', 'ITEM_3_01']]);
  assert.deepEqual(r.textCandidates.map((c) => c.accession), ['a3']); assert.equal(r.textCandidates[0].primaryDoc, 'd3.htm');
  assert.equal(r.stats.looked, 4); assert.equal(r.stats.truncated, 0);
  let t = 0;
  const cut = await FEED.classify8kRows(rows, { fetchSubmissions: async () => rec, budgetMs: 100, throttleMs: 0, now: () => (t += 60) });
  assert.ok(cut.stats.truncated > 0, 'budget exhausted → remaining rows counted, not silently dropped');
  const miss = await FEED.classify8kRows(rows.slice(0, 1), { fetchSubmissions: async () => null, budgetMs: 1e9, throttleMs: 0 });
  assert.equal(miss.stats.noItems, 1); assert.equal(miss.events.length, 0);
});

test('classify502Rows: primary doc text → ITEM_5_02_CXO only for CEO/CFO departures; cap + budget + misses counted', async () => {
  const docs = { c1: '<p>Mr. A resigned as Chief Executive Officer.</p>', c2: '<p>The Board appointed Ms. B as Chief Technology Officer.</p>', c3: null };
  const cands = ['c1', 'c2', 'c3', 'c4'].map((a) => ({ ticker: 'ACME', cik: '0001234567', accession: a, dateFiled: '2026-10-01', items: ['5.02'], primaryDoc: `${a}.htm` }));
  const r = await FEED.classify502Rows(cands, { fetchDoc: async (row) => docs[row.accession] || null, budgetMs: 1e9, throttleMs: 0, cap: 3 });
  assert.deepEqual(r.events.map((e) => e.accession), ['c1']); assert.deepEqual(r.events[0].detail.roles, ['CEO']);
  assert.equal(r.stats.overCap, 1); assert.equal(r.stats.noDoc, 1); assert.equal(r.stats.fetched, 2);
  assert.equal(FEED.primaryDocUrl('0001234567', '0001234567-26-000012', 'x.htm'), 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000012/x.htm');
});

test('parseFtsHit + goingConcernEvents: ticker from display_names, first-in-window per ticker, known accessions skipped', () => {
  const hit = (t, d, adsh) => ({ _source: { file_date: d, adsh, display_names: [`${t} Corp  (${t})  (CIK 0000000${t.length})`], ciks: ['1'], form: '10-Q' } });
  assert.equal(FEED.parseFtsHit({ _source: { file_date: '2026-10-01' } }), null, 'no adsh → null');
  assert.equal(FEED.parseFtsHit({ _source: { file_date: '2026-10-01', adsh: 'x', display_names: ['Nameless Fund  (CIK 0001)'] } }), null, 'no ticker → null');
  const p = FEED.parseFtsHit({ _source: { file_date: '2026-10-01', adsh: 'x', display_names: ['Berkshire  (BRK.B)  (CIK 0001067983)'], ciks: ['1067983'] } });
  assert.equal(p.ticker, 'BRK-B'); assert.equal(p.cik, '0001067983');
  const r = FEED.goingConcernEvents([hit('AAA', '2026-10-01', 'g1'), hit('AAA', '2026-10-01', 'g2'), hit('BBB', '2026-09-30', 'g3')].map(FEED.parseFtsHit), RF.emptyState(), new Set(['g3']));
  assert.deepEqual(r.events.map((e) => e.accession), ['g1']);
  assert.equal(r.events[0].flag, 'GOING_CONCERN_FIRST');
  assert.equal(r.state.byTicker.AAA.GC, '2026-10-01');
  assert.equal(r.state.byTicker.BBB, undefined, 'a known accession is neither emitted nor advances the state');
});

test('fetchGoingConcernHits: paginates until a short page; non-ok → throws (fail closed)', async () => {
  const page = (n, adshs) => JSON.stringify({ hits: { hits: adshs.map((a) => ({ _source: { file_date: '2026-10-01', adsh: a, display_names: [`X  (XYZ)  (CIK 1)`], ciks: ['1'], form: '10-K' } })) } });
  const urls = [];
  const full = Array.from({ length: 100 }, (_, i) => `f${i}`);
  const fetchImpl = async (url) => { urls.push(url); return res(200, urls.length === 1 ? page(0, full) : page(1, ['last'])); };
  const hits = await FEED.fetchGoingConcernHits({ startdt: '2026-09-30', enddt: '2026-10-01', fetchImpl, throttleMs: 0 });
  assert.equal(hits.length, 101); assert.equal(urls.length, 2);
  assert.match(urls[0], /q=%22substantial%20doubt%22%20%22going%20concern%22/); assert.match(urls[0], /forms=10-K%2C10-Q/); assert.match(urls[1], /from=100/);
  await assert.rejects(FEED.fetchGoingConcernHits({ startdt: 'a', enddt: 'b', fetchImpl: async () => res(429), throttleMs: 0 }), /429/);
});

// ── Store merges ─────────────────────────────────────────────────────────────
const row = (ticker, flag, acc, tier = flag) => ({ ticker, flag, accession: acc, tier, key: `${ticker}|${flag}|${acc}`, eventDate: '2026-10-01' });

test('mergeDay: union by key (first writer wins), stats appended, partial clears only on a complete pass, counts recomputed', () => {
  const d1 = ST.mergeDay(null, { date: '2026-10-01', picks: [row('AAA', 'NT_FIRST', 'n1')], stats: { stage: 1 }, partial: true });
  assert.equal(d1.partial, true); assert.equal(d1.counts.rows, 1);
  const d2 = ST.mergeDay(d1, { date: '2026-10-01', picks: [{ ...row('AAA', 'NT_FIRST', 'n1'), close: 99 }, row('BBB', 'ITEM_4_02', 'e1', RF.EXCLUDED_TIER)], stats: { stage: 2 }, partial: false });
  assert.equal(d2.picks.length, 2); assert.equal(d2.picks.find((p) => p.ticker === 'AAA').close, undefined, 'existing row kept verbatim');
  assert.equal(d2.partial, false); assert.equal(d2.stats.length, 2);
  assert.deepEqual(d2.counts, { rows: 2, excluded: 1, policy: 1, byFlag: { NT_FIRST: 1, ITEM_4_02: 1 } });
  assert.equal(d1.picks.length, 1, 'previous doc not mutated');
  const d3 = ST.mergeDay(d2, { date: '2026-10-01', picks: [], partial: true });
  assert.equal(d3.partial, false, 'a later partial writer cannot un-complete a complete day');
});

test('mergeState: monotone latest-date union per ticker/kind', () => {
  const a = RF.advanceState(RF.emptyState(), 'AAA', 'NT', '2026-10-01');
  const b = RF.advanceState(RF.advanceState(RF.emptyState(), 'AAA', 'NT', '2026-09-01'), 'BBB', 'GC', '2026-10-02');
  const m = ST.mergeState(a, b);
  assert.equal(m.byTicker.AAA.NT, '2026-10-01'); assert.equal(m.byTicker.BBB.GC, '2026-10-02');
});

test('buildCurrent: symbols flagged inside the 91-day window with their flag set and the newest event; stale events drop', () => {
  const days = [
    { date: '2026-07-01', picks: [{ ...row('OLD', 'NT_FIRST', 'o1'), eventDate: '2026-06-30' }] },
    { date: '2026-10-01', picks: [{ ...row('AAA', 'NT_FIRST', 'n1'), eventDate: '2026-09-30' }, { ...row('AAA', 'ITEM_4_02', 'e1', RF.EXCLUDED_TIER), eventDate: '2026-10-01' }] },
  ];
  const cur = ST.buildCurrent(days, '2026-10-01');
  assert.deepEqual(Object.keys(cur.symbols), ['AAA']);
  assert.deepEqual(cur.symbols.AAA, { flags: ['ITEM_4_02', 'NT_FIRST'], lastDate: '2026-10-01', ageDays: 0, events: 2 });
  assert.deepEqual(cur.counts, { flagged: 1, events: 2 });
});
