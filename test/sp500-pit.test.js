'use strict';
// S&P 500 PIT membership: daily-snapshot parsing, lossless interval compression (re-additions
// kept), membersAt boundaries (before the record → null; start inclusive; end exclusive), the
// vendored artifact + license, and the secmaster universeFrom membership option.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SP = require('../research/lib/sp500-pit');
const SM = require('../research/lib/secmaster');

const DAILY = [
  'date,tickers',
  '1996-01-02,"AAPL,BF.B,OLD"',
  '1996-03-01,"AAPL,BF.B"',            // OLD removed
  '1997-01-02,"AAPL,BF.B,OLD,NEW"',    // OLD re-added, NEW added
  '1998-06-30,"AAPL,NEW"',             // BF.B and OLD removed
  '',
].join('\n');

test('parseDailyCsv: header check, dot→dash normalization, sorted + deduped tickers, malformed/duplicate rows rejected', () => {
  const rows = SP.parseDailyCsv(DAILY);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { date: '1996-01-02', tickers: ['AAPL', 'BF-B', 'OLD'] });
  assert.throws(() => SP.parseDailyCsv('foo,bar\n1996-01-02,"A"'), /unexpected header/);
  assert.throws(() => SP.parseDailyCsv('date,tickers\nnot-a-date,"A"'), /malformed row/);
  assert.throws(() => SP.parseDailyCsv('date,tickers\n1996-01-02,"A"\n1996-01-02,"B"'), /duplicate date/);
  assert.throws(() => SP.parseDailyCsv('date,tickers\n1996-01-02,""'), /empty membership/);
});

test('compressToIntervals is lossless and keeps re-additions as separate rows (end exclusive)', () => {
  const snaps = SP.parseDailyCsv(DAILY);
  const iv = SP.compressToIntervals(snaps);
  assert.deepEqual(iv, [
    { ticker: 'AAPL', start: '1996-01-02', end: null },
    { ticker: 'BF-B', start: '1996-01-02', end: '1998-06-30' },
    { ticker: 'NEW', start: '1997-01-02', end: null },
    { ticker: 'OLD', start: '1996-01-02', end: '1996-03-01' },
    { ticker: 'OLD', start: '1997-01-02', end: '1998-06-30' },
  ]);
  const m = SP.createMembership(SP.parseIntervalsCsv(SP.intervalsToCsv(iv)));
  for (const s of snaps) assert.deepEqual([...m.membersAt(s.date)].sort(), s.tickers, `round-trip ${s.date}`);
});

test('membersAt boundaries: null before the record, start inclusive, end exclusive, carries forward after the last snapshot', () => {
  const m = SP.createMembership(SP.compressToIntervals(SP.parseDailyCsv(DAILY)));
  assert.equal(m.firstDate, '1996-01-02');
  assert.equal(m.membersAt('1995-12-29'), null, 'before the first snapshot the answer is unknown, not empty');
  assert.deepEqual([...m.membersAt('1996-01-02')].sort(), ['AAPL', 'BF-B', 'OLD'], 'start date inclusive');
  assert.deepEqual([...m.membersAt('1996-02-28')].sort(), ['AAPL', 'BF-B', 'OLD'], 'between snapshots the prior list holds');
  assert.deepEqual([...m.membersAt('1996-03-01')].sort(), ['AAPL', 'BF-B'], 'end date exclusive — removed ON the change date');
  assert.deepEqual([...m.membersAt('1997-06-01')].sort(), ['AAPL', 'BF-B', 'NEW', 'OLD'], 're-added interval active');
  assert.deepEqual([...m.membersAt('2030-01-01')].sort(), ['AAPL', 'NEW'], 'after the last snapshot the current list carries forward');
  assert.deepEqual([...m.membersAt(Date.UTC(1996, 0, 2))].sort(), ['AAPL', 'BF-B', 'OLD'], 'epoch-ms input accepted');
  assert.deepEqual([...m.currentMembers()].sort(), ['AAPL', 'NEW']);
  assert.deepEqual(m.tickers, ['AAPL', 'BF-B', 'NEW', 'OLD']);
  assert.throws(() => m.membersAt('garbage'), /bad date/);
});

test('parseIntervalsCsv rejects a malformed or inverted interval', () => {
  assert.throws(() => SP.parseIntervalsCsv('ticker,start,end\nA,1996-01-02,1995-01-01'), /malformed row/);
  assert.throws(() => SP.parseIntervalsCsv('bad header\n'), /unexpected header/);
  assert.deepEqual(SP.parseIntervalsCsv('ticker,start,end\nbf.b,1996-01-02,\n'), [{ ticker: 'BF-B', start: '1996-01-02', end: null }]);
});

test('the vendored artifact loads, spans 1996→present, and ships with the upstream MIT license + meta', () => {
  const m = SP.loadVendored();
  assert.equal(m.firstDate, '1996-01-02');
  assert.ok(m.intervals > 1000 && m.tickers.length > 1000, 'hundreds of additions/removals since 1996');
  const now = m.currentMembers();
  assert.ok(now.size >= 495 && now.size <= 510, `current S&P 500 has ~500 members, got ${now.size}`);
  assert.ok(now.has('AAPL'));
  assert.ok(!m.membersAt('2023-12-29').has('SIVB'), 'SIVB left the index in 2023');
  assert.ok(m.membersAt('2023-03-01').has('SIVB'), 'SIVB was a member before its failure');
  assert.equal(m.membersAt('1990-01-01'), null);
  const license = fs.readFileSync(path.join(SP.DERIVED_DIR, 'LICENSE-fja05680-sp500'), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /Farrell J\. Aultman/);
  const meta = JSON.parse(fs.readFileSync(path.join(SP.DERIVED_DIR, 'sp500-constituents.meta.json'), 'utf8'));
  assert.equal(meta.upstream.repo, 'fja05680/sp500');
  assert.equal(meta.upstream.license, 'MIT');
  assert.match(meta.rawSha256, /^[0-9a-f]{64}$/);
  assert.equal(meta.intervals, m.intervals);
});

// ── secmaster membership option ───────────────────────────────────────────────
function bars(toISO, n, { close = 10, volume = 1_000_000 } = {}) {
  const rows = []; const d = new Date(toISO + 'T00:00:00Z');
  for (let i = 0; i < n; i++) { rows.push({ date: d.toISOString().slice(0, 10), open: close, high: close, low: close, close, volume }); d.setUTCDate(d.getUTCDate() - 1); }
  return rows;
}
const income = (shares) => [{ date: '2020-12-31', filingDate: '2021-03-01', weightedAverageShsOut: shares }];
const RECS = { AAA: { sym: 'AAA', price: bars('2026-05-20', 400), income: income(1e8) }, BBB: { sym: 'BBB', price: bars('2026-05-20', 400), income: income(1e8) } };
const D = Date.parse('2026-01-15T00:00:00Z');

test('universeFrom membership: Set / function restrict the cross-section; null membership answer → empty + membershipUnknown; absent → unchanged', () => {
  assert.deepEqual(SM.universeFrom(RECS, D).map((r) => r.sym), ['AAA', 'BBB']);
  assert.deepEqual(SM.universeFrom(RECS, D, SM.DEFAULT_BAND, { membership: new Set(['BBB']) }).map((r) => r.sym), ['BBB']);
  assert.deepEqual(SM.universeFrom(RECS, D, SM.DEFAULT_BAND, { membership: () => ['AAA'] }).map((r) => r.sym), ['AAA']);
  const unknown = SM.universeFrom(RECS, D, SM.DEFAULT_BAND, { membership: () => null });
  assert.deepEqual(unknown, []);
  assert.equal(unknown.membershipUnknown, true, 'an unknown membership date is reported, never widened to the whole cache');
  assert.equal(SM.universeFrom(RECS, D, SM.DEFAULT_BAND, { membership: new Set(['AAA']) }).membershipUnknown, undefined);
  assert.deepEqual(SM.resolveMembership(null, D), { set: null, unknown: false });
});
