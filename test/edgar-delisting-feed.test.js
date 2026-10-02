'use strict';
// Delisting-pending flag: daily-index parsing (Form 25 / 25-NSE / 15-12G / 15-15D + amendments,
// Form 4 noise ignored), Form 25 effective-date math (validated case ATVI), CIK→ticker join
// confidence, pending-set window boundaries, union-monotonic shard merge, the injectable tick,
// the privileged/public registration pins, the nightly root, and the honesty of rendered strings.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DF = require('../lib/edgar-delisting-feed');
const ROUTES = require('../lib/edgar-delisting-routes');
const WC = require('../lib/warm-chains');
const REG = require('../lib/research/hypothesis-registry');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const INDEX = [
  'Description:           Daily Index of EDGAR Dissemination Feed by Form Type',
  'Form Type   Company Name                                                  CIK         Date Filed  File Name',
  '---------------------------------------------------------------------------------------------------------------',
  '25-NSE      Activision Blizzard, Inc.                                     718877      20231013    edgar/data/718877/0000718877-23-000001.txt',
  '25          Some Multi Class Co                                           1000001     20231013    edgar/data/1000001/0001000001-23-000002.txt',
  '25/A        Some Multi Class Co                                           1000001     20231013    edgar/data/1000001/0001000001-23-000003.txt',
  '15-12G      Gone Private Corp                                             1000002     20231013    edgar/data/1000002/0001000002-23-000004.txt',
  '15-15D      Debt Only Issuer LLC                                          1000003     20231013    edgar/data/1000003/0001000003-23-000005.txt',
  '4           Insider Person                                                1000004     20231013    edgar/data/1000004/0001000004-23-000006.txt',
  '8-K         Noise Corp                                                    1000005     20231013    edgar/data/1000005/0001000005-23-000007.txt',
  '15-12B      Not Modeled Form Co                                           1000006     20231013    edgar/data/1000006/0001000006-23-000008.txt',
  '',
].join('\n');

const CIK_MAP = { ATVI: '0000718877', MCA: '0001000001', MCB: '0001000001', MC: '0001000001' };

test('parseDailyIndex keeps the four delisting forms and their amendments, drops everything else', () => {
  const rows = DF.parseDailyIndex(INDEX);
  assert.deepEqual(rows.map((r) => r.form), ['25-NSE', '25', '25/A', '15-12G', '15-15D']);
  assert.deepEqual(rows[0], { form: '25-NSE', baseForm: '25-NSE', amended: false, company: 'Activision Blizzard, Inc.', cik: '0000718877', dateFiled: '2023-10-13', fileName: 'edgar/data/718877/0000718877-23-000001.txt', accession: '0000718877-23-000001' });
  assert.equal(rows[2].amended, true);
  assert.equal(rows[2].baseForm, '25');
  assert.deepEqual(DF.parseDailyIndex(''), []);
});

test('effectiveDateFor: Form 25 / 25-NSE = filing + 10 calendar days (ATVI 2023-10-13 → 2023-10-23); Form 15 = on filing; unknown → null', () => {
  assert.equal(DF.effectiveDateFor('25-NSE', '2023-10-13'), '2023-10-23');
  assert.equal(DF.effectiveDateFor('25', '2026-12-28'), '2027-01-07', 'crosses the year boundary');
  assert.equal(DF.effectiveDateFor('15-12G', '2023-10-13'), '2023-10-13');
  assert.equal(DF.effectiveDateFor('15-15D', '2024-02-29'), '2024-02-29');
  assert.equal(DF.effectiveDateFor('15-12B', '2023-10-13'), null);
  assert.equal(DF.effectiveDateFor('25', 'not-a-date'), null);
  assert.equal(DF.FORM25_EFFECTIVE_CALENDAR_DAYS, 10);
});

test('joinTicker confidence: one ticker → high, several → medium with the shortest as primary, none → null', () => {
  const idx = DF.buildCikTickerIndex(CIK_MAP);
  assert.deepEqual(DF.joinTicker('718877', idx), { ticker: 'ATVI', confidence: 'high', alternates: [] });
  assert.deepEqual(DF.joinTicker('0001000001', idx), { ticker: 'MC', confidence: 'medium', alternates: ['MCA', 'MCB'] });
  assert.deepEqual(DF.joinTicker('0001000002', idx), { ticker: null, confidence: 'none', alternates: [] });
});

test('toEvent carries form, kind, dates, rule and join confidence', () => {
  const idx = DF.buildCikTickerIndex(CIK_MAP);
  const ev = DF.parseDailyIndex(INDEX).map((r) => DF.toEvent(r, idx));
  assert.equal(ev[0].ticker, 'ATVI'); assert.equal(ev[0].kind, 'exchange-delisting'); assert.equal(ev[0].effectiveAt, '2023-10-23');
  assert.equal(ev[3].kind, 'deregistration'); assert.equal(ev[3].confidence, 'none'); assert.equal(ev[3].effectiveAt, '2023-10-13');
  assert.equal(ev[4].kind, 'reporting-suspension');
  assert.match(ev[0].effectiveRule, /12d2-2/);
});

test('mergeShard is a union by accession, sorted, never mutating its inputs', () => {
  const prior = { version: 'x', date: '2023-10-13', events: [{ accession: 'b', ticker: 'B' }], count: 1 };
  const incoming = [{ accession: 'a', ticker: 'A' }, { accession: 'b', ticker: 'B-dup' }];
  const out = DF.mergeShard(prior, incoming, { date: '2023-10-13', now: '2023-10-13T22:00:00.000Z' });
  assert.deepEqual(out.events.map((e) => e.accession), ['a', 'b']);
  assert.equal(out.events[1].ticker, 'B', 'an existing accession is never overwritten');
  assert.equal(out.count, 2);
  assert.equal(prior.events.length, 1, 'prior untouched');
  assert.equal(incoming.length, 2, 'incoming untouched');
  assert.equal(DF.mergeShard(null, [], { date: 'd', now: 'n' }).count, 0);
});

test('buildPendingSet: window boundaries, pending vs effective, latest filing wins, unresolved counted', () => {
  const asOf = '2026-10-02';
  const mk = (ticker, filedAt, form = '25', extra = {}) => ({ accession: `${ticker}-${filedAt}-${form}`, ticker, form, baseForm: form, kind: DF.FROZEN.forms[form].kind, filedAt, effectiveAt: DF.effectiveDateFor(form, filedAt), confidence: ticker ? 'high' : 'none', ...extra });
  const set = DF.buildPendingSet([
    mk('FRESH', '2026-10-01'),            // 1d: pending (effective 10-11)
    mk('EFF', '2026-09-15'),              // 17d: effective (09-25)
    mk('EDGE', '2026-08-18'),             // 45d: last day inside the window
    mk('OUT', '2026-08-17'),              // 46d: outside
    mk('FUTURE', '2026-10-03'),           // filed after asOf: a PIT violation → excluded
    mk('TWICE', '2026-09-01'), mk('TWICE', '2026-09-20'),   // latest filing wins, filings counted
    mk(null, '2026-09-30'),               // unresolved ticker: counted, not flagged
    mk('DEREG', '2026-09-28', '15-12G'),
  ], asOf);
  assert.deepEqual(Object.keys(set.symbols).sort(), ['DEREG', 'EDGE', 'EFF', 'FRESH', 'TWICE']);
  assert.equal(set.symbols.FRESH.status, 'pending');
  assert.equal(set.symbols.EFF.status, 'effective');
  assert.equal(set.symbols.EDGE.ageDays, 45);
  assert.equal(set.symbols.TWICE.filedAt, '2026-09-20');
  assert.equal(set.symbols.TWICE.filings, 2);
  assert.equal(set.symbols.DEREG.status, 'effective', 'Form 15 is effective on filing');
  assert.deepEqual(set.counts, { flagged: 5, pending: 1, effective: 4, exchangeDelisting: 4, deregistration: 1, eventsInWindow: 7, unresolvedTicker: 1 });
  assert.equal(set.windowDays, 45);
});

// ── the tick, without a network or a store ───────────────────────────────────
function fakeStore() {
  const docs = {};
  return {
    docs,
    async updateJSON(p, fn, { initial = null } = {}) { docs[p] = fn(docs[p] === undefined ? initial : docs[p]); return { doc: docs[p] }; },
    async writeJSON(p, obj) { docs[p] = obj; },
    async readAllByPrefix(prefix, re) { return Object.keys(docs).filter((k) => k.startsWith(prefix) && re.test(k)).sort().map((k) => docs[k]); },
  };
}

test('tickCore: two index days → events joined → filing-date shards (CAS union) → snapshot; a re-tick adds nothing', async () => {
  const store = fakeStore();
  const fetchIndex = async (d) => (d === '2023-10-13' ? { date: d, missing: false, rows: DF.parseDailyIndex(INDEX) } : { date: d, missing: true, rows: [] });
  let t = 0;
  const now = () => (t += 1000);
  const r1 = await ROUTES.tickCore({ date: '2023-10-13', store, fetchIndex, cikMap: async () => CIK_MAP, now });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.indexDates, [{ date: '2023-10-12', missing: true, rows: 0 }, { date: '2023-10-13', missing: false, rows: 5 }]);
  assert.deepEqual(r1.joined, { high: 1, medium: 2, none: 2 });
  assert.deepEqual(r1.shardsWritten, [{ date: '2023-10-13', events: 5 }]);
  assert.equal(store.docs['delist/2023-10-13.json'].count, 5);
  const snap = store.docs['delist/current.json'];
  assert.equal(snap.asOf, '2023-10-13');
  assert.deepEqual(Object.keys(snap.symbols).sort(), ['ATVI', 'MC']);
  assert.equal(snap.symbols.ATVI.status, 'pending');
  assert.equal(snap.counts.unresolvedTicker, 2);
  assert.equal(snap.shardsRead, 1);

  const r2 = await ROUTES.tickCore({ date: '2023-10-13', store, fetchIndex, cikMap: async () => CIK_MAP, now });
  assert.equal(store.docs['delist/2023-10-13.json'].count, 5, 'idempotent: the union gained nothing');
  assert.equal(r2.events, 5);
});

test('tickCore fails closed: an index fetch error propagates before any write', async () => {
  const store = fakeStore();
  await assert.rejects(ROUTES.tickCore({ date: '2023-10-13', store, fetchIndex: async () => { throw new Error('EDGAR daily index 2023-10-13: 403 (not a missing-key response — blocked?)'); }, cikMap: async () => CIK_MAP }), /403/);
  assert.deepEqual(Object.keys(store.docs), [], 'nothing written');
});

// ── wiring pins ──────────────────────────────────────────────────────────────
test('the writer is PRIVILEGED, the read is public, both dispatched', () => {
  const tracker = read('api/tracker.js');
  const privileged = tracker.slice(tracker.indexOf('const PRIVILEGED_OPS'), tracker.indexOf('const EXPENSIVE_OPS'));
  assert.ok(privileged.includes("'delistingtick'"), 'delistingtick writes durable state and must require the bearer');
  assert.ok(!/'delisting',/.test(privileged), 'op=delisting (read) stays public');
  for (const op of ['delisting', 'delistingtick']) assert.ok(tracker.includes(`op === '${op}'`), `${op} dispatched`);
});

test('the nightly step is its own root chain and the GitHub matrix carries it', () => {
  assert.deepEqual(WC.CHAINS.delisting, ['op=delistingtick']);
  assert.ok(WC.ROOT_CHAINS.includes('delisting'));
  assert.match(read('.github/workflows/nightly-chains.yml'), /, delisting[,\]]/);
});

test('registry row: weight-0 shadow with a placebo and a minimum N, open, exploratory', () => {
  const row = REG.HYPOTHESES.find((h) => h.id === 'delisting-pending-avoid');
  assert.ok(row, 'registry row present');
  assert.equal(row.status, 'open');
  assert.equal(row.mode, 'exploratory');
  assert.match(row.primaryMetric, /placebo/i);
  assert.match(row.primaryMetric, /200/);
  assert.match(row.stoppingRule, /weight-0|weight 0/i);
  assert.equal(REG.validateHypothesis(row).valid, true);
});

test('every rendered string is shadow-honest: unvalidated, not a sell signal, no rank effect', () => {
  const routes = read('lib/edgar-delisting-routes.js') + read('lib/edgar-delisting-feed.js');
  assert.match(routes, /NOT a sell signal/);
  assert.match(routes, /unvalidated/i);
  const badge = read('public/js/delisting-badge.js');
  assert.match(badge, /NOT a sell signal/);
  assert.match(badge, /SHADOW research flag/);
  assert.match(badge, /changes no ranking/);
  assert.doesNotMatch(badge, /sell now|short this|avoid buying/i, 'the badge informs; it must not instruct');
});

test('the badge is wired next to the dilution badge behind the same data-live contract; the Session Board carries the flag', () => {
  const app = read('public/js/app.js');
  assert.match(app, /import \{ startDelistingBadges, DELISTING_BADGE_TABS \} from '\.\/delisting-badge\.js'/);
  assert.match(app, /DELISTING_BADGE_TABS\.has\(sub\)/);
  assert.match(read('public/js/delisting-badge.js'), /\[data-live\]/);
  assert.match(read('public/js/session-board.js'), /F\.delisting/);
  const sb = read('lib/session-board.js');
  assert.match(sb, /check\('delisting'/);
  assert.match(sb, /delisting: row\.delisting == null/);
});

test('the empty state is never CDN-cached', () => {
  assert.match(read('lib/edgar-delisting-routes.js'), /if \(snap\) cached\(res\); else noStore\(res\);/);
});
