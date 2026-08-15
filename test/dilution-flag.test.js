'use strict';
// 424B5 DILUTION FLAG — shadow overlay guard tests: frozen window semantics, PIT-clean
// parsing, write-once ledger selection, the research-identical outcome construction,
// privileged-write registration, and the honesty of every rendered string.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const FLAG = require('../lib/dilution-flag');
const ROUTES = require('../lib/dilution-routes');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const hit = (name, fileDate, adsh = '0000000000-26-000001') => ({ _source: { display_names: [name], ciks: ['0000000001'], file_date: fileDate, adsh } });

test('parseHit extracts the ticker, converts dots to dashes, rejects malformed rows', () => {
  const p = FLAG.parseHit(hit('RadNet, Inc.  (RDNT)  (CIK 0000790526)', '2026-08-10'));
  assert.deepEqual({ ticker: p.ticker, fileDate: p.fileDate }, { ticker: 'RDNT', fileDate: '2026-08-10' });
  assert.equal(FLAG.parseHit(hit('Berkshire Hathaway  (BRK.B)  (CIK 0001067983)', '2026-08-10')).ticker, 'BRK-B');
  assert.equal(FLAG.parseHit(hit('No Ticker Company  (CIK 0000000002)', '2026-08-10')), null);
  assert.equal(FLAG.parseHit({ _source: { display_names: ['X  (ABC)  (CIK 1)'] } }), null, 'missing file_date/adsh rejected');
});

test('buildFlagSet applies the FROZEN 91-day window and 8-day freshness exactly', () => {
  const asOf = '2026-08-15';
  const set = FLAG.buildFlagSet([
    { ticker: 'FRESH', fileDate: '2026-08-08' },   // 7d — fresh
    { ticker: 'EDGE', fileDate: '2026-08-07' },    // 8d — fresh boundary
    { ticker: 'STALE', fileDate: '2026-08-06' },   // 9d — flagged, not fresh
    { ticker: 'LAST', fileDate: '2026-05-16' },    // 91d — last day inside the window
    { ticker: 'OUT', fileDate: '2026-05-15' },     // 92d — outside
    { ticker: 'FUT', fileDate: '2026-08-16' },     // future-dated — never PIT-eligible
  ], asOf);
  assert.equal(set.symbols.FRESH.fresh, true);
  assert.equal(set.symbols.EDGE.fresh, true);
  assert.equal(set.symbols.STALE.fresh, false);
  assert.ok(set.symbols.LAST);
  assert.equal(set.symbols.OUT, undefined);
  assert.equal(set.symbols.FUT, undefined);
  assert.equal(set.counts.flagged, 4);
  assert.equal(set.counts.fresh, 2);
});

test('repeat filers keep the MOST RECENT date and count their filings (ATM programs)', () => {
  const set = FLAG.buildFlagSet([
    { ticker: 'ATM', fileDate: '2026-07-01' },
    { ticker: 'ATM', fileDate: '2026-08-10' },
    { ticker: 'ATM', fileDate: '2026-06-20' },
  ], '2026-08-15');
  assert.equal(set.symbols.ATM.lastFiled, '2026-08-10');
  assert.equal(set.symbols.ATM.filings, 3);
});

test('selectNewFilings takes only filings NEWER than the previous ledger day, one row per ticker', () => {
  const filings = [
    { ticker: 'A', fileDate: '2026-08-14', adsh: 'x1' },
    { ticker: 'A', fileDate: '2026-08-15', adsh: 'x2' },   // same ticker deduped
    { ticker: 'B', fileDate: '2026-08-13', adsh: 'x3' },   // ≤ prevDate — already recorded
    { ticker: 'C', fileDate: '2026-08-16', adsh: 'x4' },   // future vs the day — excluded
  ];
  const rows = ROUTES.selectNewFilings(filings, '2026-08-15', '2026-08-13');
  assert.deepEqual(rows.map((r) => r.ticker), ['A']);
  // first-ever ledger day records only that day's filings, not the whole window
  const first = ROUTES.selectNewFilings(filings, '2026-08-15', null);
  assert.deepEqual(first.map((r) => r.ticker), ['A']);
});

test('excess5 mirrors the research construction: decision bar ≤ fileDate, next-open entry, close(+5), SPY-relative', () => {
  const mk = (closes, opens) => closes.map((c, i) => ({ date: `2026-08-${String(3 + i).padStart(2, '0')}`, open: opens[i], close: c }));
  const stock = mk([100, 102, 101, 103, 104, 105, 110], [99, 101, 100, 102, 103, 104, 109]);
  const spy = mk([50, 50, 50, 50, 50, 50, 51], [50, 50, 50, 50, 50, 50, 50]);
  // fileDate = first bar → entry open 101 (bar 2), exit close bar 6 (105); SPY 50→50
  const r = ROUTES.excess5(stock, spy, '2026-08-03');
  // served value is rounded to 5dp, so the identity holds to 6e-6
  assert.ok(Math.abs(r.excess5 - ((105 / 101 - 1) - (50 / 50 - 1))) < 6e-6, `got ${r.excess5}`);
  // fileDate too recent → not mature, day must be postponed (never a partial resolve)
  assert.equal(ROUTES.excess5(stock, spy, '2026-08-08').reason, 'not-mature');
  assert.equal(ROUTES.excess5(stock, spy, '2026-08-01').reason, 'no-decision-bar');
});

test('the read op fails safe without Blob storage and never fabricates a snapshot', async () => {
  const hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    let payload = null;
    await ROUTES.runDilution({ query: {} }, { setHeader: () => {}, status: () => ({ json: (b) => { payload = b; return b; } }) });
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Blob storage/);
  } finally { if (hadToken) process.env.BLOB_READ_WRITE_TOKEN = hadToken; }
});

test('the writers are PRIVILEGED and the public read is not', () => {
  const tracker = read('api/tracker.js');
  const privileged = tracker.slice(tracker.indexOf('const PRIVILEGED_OPS'), tracker.indexOf('const EXPENSIVE_OPS'));
  assert.ok(privileged.includes("'dilutiontick'"), 'dilutiontick writes durable state and must require the bearer');
  assert.ok(privileged.includes("'dilutionresolve'"), 'dilutionresolve writes durable state and must require the bearer');
  assert.ok(!/'dilution',/.test(privileged), 'op=dilution (read) stays public');
  for (const op of ['dilution', 'dilutiontick', 'dilutionresolve']) assert.ok(tracker.includes(`op === '${op}'`), `${op} dispatched`);
});

test('the nightly chain runs tick before resolve as its own root', () => {
  const wc = read('lib/warm-chains.js');
  assert.match(wc, /dilution: \['op=dilutiontick', 'op=dilutionresolve'\]/);
});

test('every rendered string is shadow-honest: unvalidated, not a sell signal, no rank effect', () => {
  const routes = read('lib/dilution-routes.js') + read('lib/dilution-flag.js');
  assert.match(routes, /NOT a sell signal/);
  assert.match(routes, /unvalidated/i);
  const badge = read('public/js/dilution-badge.js');
  assert.match(badge, /NOT a sell signal/);
  assert.match(badge, /SHADOW research flag/);
  assert.match(badge, /changes no ranking/);
  assert.doesNotMatch(badge, /sell now|short this|avoid buying/i, 'the badge informs; it must not instruct');
});

test('the badge is wired into the candidate tabs behind the same data-live contract as the flow badge', () => {
  const app = read('public/js/app.js');
  assert.match(app, /import \{ startDilutionBadges, DILUTION_BADGE_TABS \} from '\.\/dilution-badge\.js'/);
  assert.match(app, /DILUTION_BADGE_TABS\.has\(sub\)/);
  const badge = read('public/js/dilution-badge.js');
  assert.match(badge, /\[data-live\]/);
});

test('the frozen config cannot silently drift from the research it operationalises', () => {
  assert.equal(FLAG.FROZEN.flagWindowDays, 91);
  assert.equal(FLAG.FROZEN.freshDays, 8);
  assert.equal(FLAG.FROZEN.form, '424B5');
  assert.equal(FLAG.FROZEN.prospectiveGate.minResolvedDates, 50);
  assert.equal(FLAG.FROZEN.experimentId, 'dilution-events-2026-08');
});
