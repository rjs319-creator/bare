'use strict';
// House book + My book frontend: pure render helpers (payload in, HTML out) and the UI
// registration pins (imports, containers, ops, nightly root, stylesheet).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = join(__dirname, '..');
const APP = readFileSync(join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'css', 'app.css'), 'utf8');
const TRACKER = readFileSync(join(ROOT, 'api', 'tracker.js'), 'utf8');
const SBJS = readFileSync(join(ROOT, 'public', 'js', 'session-board.js'), 'utf8');

let HB, MB;
test.before(async () => {
  HB = await import(pathToFileURL(join(ROOT, 'public', 'js', 'house-book.js')).href);
  MB = await import(pathToFileURL(join(ROOT, 'public', 'js', 'my-book.js')).href);
});

function assertClean(html) {
  assert.ok(!html.includes('${'), 'unresolved template');
  assert.ok(!/\bundefined\b/.test(html), `literal undefined leaked: ${html.match(/.{40}undefined.{40}/) || ''}`);
  assert.ok(!/\bNaN\b/.test(html), 'literal NaN leaked');
  assert.ok(!/\bInfinity\b/.test(html), 'Infinity leaked');
  assert.ok(!/\[object Object\]/.test(html), 'object stringified');
}

const POINTS = [
  { date: '2026-09-15', equity: 1000000, spyClose: 501, openPositions: 3 },
  { date: '2026-09-16', equity: 1001200, spyClose: 502, openPositions: 3 },
  { date: '2026-09-17', equity: 1000400, spyClose: 503, openPositions: 2 },
  { date: '2026-09-18', equity: 1002100, spyClose: 504, openPositions: 1 },
];
const PAYLOAD = {
  ok: true, state: 'SHADOW', weight: 0, asOfDate: '2026-09-18',
  book: { cash: 995000, equity: 1002100, initialCash: 1000000, realizedPnl: 1500, unrealizedPnl: 600, counts: { open: 1, closed: 2, pending: 0 },
    openPositions: [{ symbol: 'MNO', timeframe: 'position', fillDate: '2026-09-15', fillPrice: 101.303, mark: { price: 103, date: '2026-09-18' }, unrealizedPct: 1.675 }],
    recentClosed: [{ symbol: 'ABC', timeframe: 'swing', fillDate: '2026-09-15', fillPrice: 100.3, exit: { reason: 'target', price: 114.655, gapThrough: false }, netReturnPct: 14.31 }] },
  equity: { points: POINTS },
  metrics: { n: 3, totalReturn: 0.0021, annualReturn: 0.19, annualVolatility: 0.21, sortino: 1.9, calmar: null, omega: 2.5, maxDrawdown: -0.0008, beta: 0.4, latestRollingBeta: null, rollingBetaWindow: 63, benchmarkTotalReturn: 0.006 },
  reconcile: { status: 'ok', rows: 1, divergencePct: 0.003, tolerancePct: 0.16, bookMeanNetPct: 1.837, scoreboardMeanNetPct: 1.84, duplicateBuys: 0, ledgerIdentityGapUsd: 0, rowsMissingInScoreboard: [{ ticker: 'MNO', section: 'CERN' }], rowsMissingInBook: { counts: { 'grade-below-B': 4 } }, problems: [], basis: 'horizon exits' },
  disclosure: 'Simulated paper book.',
};

test('UI registration: imports, Scoreboard host, my-book container, ops, nightly root, styles', () => {
  assert.match(APP, /import \{ renderHouseBook \} from '\.\/house-book\.js'/);
  assert.match(APP, /import \{ initMyBook \} from '\.\/my-book\.js'/);
  assert.match(APP, /<div id="sb-housebook"><\/div>/, 'Scoreboard panel host');
  assert.match(APP, /loadLazyPanel\('sb-housebook', '\/api\/tracker\?op=housebook', renderHouseBook/);
  assert.match(APP, /function ensureSessionBoard\(\) \{ _lowFloatLoaders\.session\(\); _lowFloatLoaders\.mybook\(\); \}/);
  assert.match(HTML, /id="mybook-container"/);
  assert.match(SBJS, /class="sb-take" data-id=/, 'Taking-this button on every card');
  assert.match(TRACKER, /'housebooktick',/, 'tick is privileged');
  assert.match(TRACKER, /'housebook', 'mybook',/, 'reads are throttled');
  assert.match(TRACKER, /op === 'housebooktick'\) return require\('\.\.\/lib\/house-book-routes'\)\.runHouseBookTick/);
  assert.match(TRACKER, /op === 'mybook'\) return require\('\.\.\/lib\/house-book-routes'\)\.runMyBook/);
  const WC = require('../lib/warm-chains');
  assert.deepEqual(WC.CHAINS.housebook, ['op=housebooktick']);
  assert.ok(WC.ROOT_CHAINS.includes('housebook'));
  assert.ok(WC.ROOT_CHAINS.indexOf('housebook') < WC.ROOT_CHAINS.indexOf('challenger'), 'challenger stays last');
  assert.match(CSS, /\.hb-chart \{/); assert.match(CSS, /#session \.sb-take \{/); assert.match(CSS, /\.mb-panel \{/);
});

test('equityChartSvg: one axis, two indexed series, legend + end labels, per-session hover titles', () => {
  const svg = HB.equityChartSvg(POINTS);
  assertClean(svg);
  assert.equal((svg.match(/<polyline/g) || []).length, 2);
  assert.match(svg, /Book 100\.2/); assert.match(svg, /SPY 100\.6/);
  assert.equal((svg.match(/<title>/g) || []).length, 4, 'a hover title per session');
  assert.match(svg, /hb-legend/);
  assert.match(svg, new RegExp(HB.BOOK_COLOR)); assert.match(svg, new RegExp(HB.BENCH_COLOR));
  assert.match(HB.equityChartSvg([POINTS[0]]), /Not enough sessions/);
  assert.deepEqual(HB.indexed([{ v: 50 }, { v: 75 }, { v: null }], 'v'), [100, 150, null]);
});

test('renderHouseBook: full panel, null-safe metrics, reconciliation badge; empty and error states', () => {
  const html = HB.renderHouseBook(PAYLOAD);
  assertClean(html);
  assert.match(html, /📒 House book/); assert.match(html, /shadow · weight 0/);
  assert.match(html, /Reconciled/); assert.match(html, /MNO<\/b> \(CERN\)/);
  assert.match(html, /Calmar<\/span><b class="hb-tile-v">–</, 'null metric renders a dash');
  assert.match(html, /Sortino<\/span><b class="hb-tile-v">1\.90</);
  assert.match(html, /target/); assert.match(html, /\+14\.31%/);
  assert.match(HB.renderHouseBook({ ok: true, empty: true, note: 'No book yet.', disclosure: 'x' }), /No book yet/);
  assert.match(HB.renderHouseBook({ ok: false, error: 'HTTP 503' }), /HTTP 503/);
  const bad = HB.renderHouseBook({ ...PAYLOAD, reconcile: { ...PAYLOAD.reconcile, status: 'divergent', problems: ['3 duplicate BUY activities'] } });
  assert.match(bad, /DIVERGENT/); assert.match(bad, /3 duplicate BUY/);
  assertClean(bad);
});

test('my-book: ledger ops are pure, storage never throws, rows param is sanitised', () => {
  const item = { id: 'Ignition:swing:ABC', ticker: 'abc', horizon: 'swing', timeframe: { key: 'swing' }, levels: { stop: 95, target: 115 }, grade: { letter: 'A' }, section: 'Ignition' };
  const e = MB.entryFromItem(item, '2026-09-14T21:00:00Z', '2026-09-14T22:00:00Z');
  assert.equal(e.ticker, 'ABC');
  const one = MB.toggleEntry([], e);
  assert.equal(one.length, 1);
  assert.deepEqual(MB.toggleEntry(one, e), [], 'toggling again removes');
  assert.equal(MB.toggleEntry(one, null), one);
  assert.equal(MB.rowsParam(one), 'ABC~2026-09-14T21:00:00Z~swing~95~115~A~Ignition');
  assert.equal(MB.rowsParam([{ ...e, section: 'a,b~c', stop: null, target: null }]), 'ABC~2026-09-14T21:00:00Z~swing~~~A~abc', 'separators stripped');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(MB.readLedger(broken), []);
  assert.equal(MB.writeLedger(one, broken), false);
  const mem = (() => { let v = null; return { getItem: () => v, setItem: (k, x) => { v = x; } }; })();
  assert.equal(MB.writeLedger(one, mem), true);
  assert.deepEqual(MB.readLedger(mem), one);
  assert.equal(MB.entryFromItem(null), null);
});

test('renderMyBook: empty prompt, listed rows with valuation, stale and loading notes', () => {
  assert.match(MB.renderMyBook([], null), /Taking this/);
  const e = MB.entryFromItem({ id: 'x:swing:ABC', ticker: 'ABC', horizon: 'swing', levels: {}, grade: { letter: 'B' }, section: 'x' }, '2026-09-14');
  const valuation = { ok: true, asOfDate: '2026-09-18', cash: 995000, initialCash: 1000000, rows: [{ ticker: 'ABC', signalDate: '2026-09-14', status: 'closed', fillDate: '2026-09-15', fillPrice: 100.3, exit: { reason: 'target', price: 114.655 }, netReturnPct: 14.31 }], equity: { points: POINTS }, metrics: PAYLOAD.metrics, unpriced: [], disclosure: 'paper' };
  const html = MB.renderMyBook([e], valuation);
  assertClean(html);
  assert.match(html, /🏁 closed/); assert.match(html, /\+14\.31%/); assert.match(html, /mb-remove/); assert.match(html, /<polyline/);
  assertClean(MB.renderMyBook([e], null, { loading: true }));
  assert.match(MB.renderMyBook([e], null, { stale: 'Valuation failed (x)' }), /sb-stale/);
});
