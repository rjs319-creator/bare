'use strict';
// 📈 CHART ENGINE — pure data-shaping helpers behind the single chart component
// (lightweight-charts v5), plus the source pins that make the vendoring, the Apache-2.0
// attribution and the retirement of the hand-drawn canvas convention properties of the
// code rather than promises in a PR description. DOM-less: every helper under test is
// payload-in / plain-objects-out; the engine itself is only imported lazily by mountCandles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const mod = (p) => import(pathToFileURL(path.join(ROOT, 'public', 'js', p)).href);

let CE, PC, PR;
test.before(async () => {
  CE = await mod('chart-engine.js');
  PC = await mod('pattern-chart.js');
  PR = await mod('chart-primitives.js');
});

// Daily candles from /api/chart (lib/signal.js) and the pattern payload (o/h/l/c/v).
const DAILY = [
  { date: '2026-09-03', open: 10, high: 12, low: 9, close: 11, volume: 100 },
  { date: '2026-09-01', open: 9, high: 10, low: 8, close: 10, volume: 50 },
  { date: '2026-09-02', open: 10, high: 11, low: 9.5, close: 9.8, volume: 80 },
  { date: '2026-09-02', open: 10, high: 11, low: 9.5, close: 9.8, volume: 80 }, // duplicate day
  { date: '2026-09-04', open: 'x', high: 12, low: 9, close: 11, volume: 100 }, // non-finite → dropped
];
const PATTERN = [
  { date: '2026-09-01', o: 9, h: 10, l: 8, c: 10, v: 50 },
  { date: '2026-09-02', o: 10, h: 11, l: 9.5, c: 9.8, v: 80 },
  { date: '2026-09-03', o: 10, h: 12, l: 9, c: 11, v: 100 },
];
// Six bars: the pattern chart refuses to draw fewer than five.
const PATTERN6 = PATTERN.concat([
  { date: '2026-09-04', o: 11, h: 12.5, l: 10.5, c: 12, v: 90 },
  { date: '2026-09-08', o: 12, h: 12.2, l: 11, c: 11.2, v: 70 },
  { date: '2026-09-09', o: 11.2, h: 13, l: 11, c: 12.8, v: 120 },
]);

// ── time mapping ────────────────────────────────────────────────────────────────────
test('toChartTime: business-day strings pass through, intraday ISO becomes unix seconds, junk is null', () => {
  assert.equal(CE.toChartTime('2026-09-03'), '2026-09-03');
  assert.equal(CE.toChartTime('2026-09-03T14:30:00.000Z'), Date.UTC(2026, 8, 3, 14, 30) / 1000);
  assert.equal(CE.toChartTime(1_700_000_000), 1_700_000_000);
  assert.equal(CE.toChartTime('not a date'), null);
  assert.equal(CE.toChartTime(null), null);
});

test('isIntraday is true only when a time is a timestamp rather than a business day', () => {
  assert.equal(CE.isIntraday(CE.shapeCandles(DAILY)), false);
  const intra = CE.shapeCandles([{ date: '2026-09-03T14:30:00Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }]);
  assert.equal(CE.isIntraday(intra), true);
});

// ── candles / volume / indicator lines ──────────────────────────────────────────────
test('shapeCandles accepts both payload shapes, sorts ascending, dedups, drops non-finite rows', () => {
  const a = CE.shapeCandles(DAILY);
  assert.deepEqual(a.map((c) => c.time), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(a[0], { time: '2026-09-01', date: '2026-09-01', open: 9, high: 10, low: 8, close: 10, volume: 50 });
  const b = CE.shapeCandles(PATTERN);
  assert.deepEqual(b.map((c) => c.close), [10, 9.8, 11]);
  assert.deepEqual(CE.shapeCandles(null), []);
  assert.deepEqual(CE.shapeCandles('nope'), []);
});

test('shapeCandles does not mutate its input', () => {
  const input = DAILY.map((c) => ({ ...c }));
  const snapshot = JSON.stringify(input);
  CE.shapeCandles(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('shapeVolume colours each bar by candle direction with translucent app greens/reds', () => {
  const v = CE.shapeVolume(CE.shapeCandles(PATTERN));
  assert.equal(v.length, 3);
  assert.deepEqual(v.map((x) => x.value), [50, 80, 100]);
  assert.match(v[0].color, /^rgba\(16,\s*217,\s*138/, 'up bar → green');
  assert.match(v[1].color, /^rgba\(239,\s*80,\s*80/, 'down bar → red');
});

test('shapeLine aligns an indicator array to candle times and skips nulls', () => {
  const shaped = CE.shapeCandles(PATTERN);
  const line = CE.shapeLine([null, 9.9, 10.5], shaped);
  assert.deepEqual(line, [{ time: '2026-09-02', value: 9.9 }, { time: '2026-09-03', value: 10.5 }]);
  assert.deepEqual(CE.shapeLine(null, shaped), []);
  assert.deepEqual(CE.shapeLine([1, 2, 3, 4, 5], shaped).length, 3, 'extra indicator points beyond the candles are ignored');
});

// ── frozen levels ───────────────────────────────────────────────────────────────────
test('levelLines coerces string prices, drops non-finite ones, and keeps the app palette', () => {
  const lines = CE.levelLines({ entry: '101.5', stop: 'n/a', target: 110 });
  assert.deepEqual(lines.map((l) => [l.key, l.price]), [['target', 110], ['entry', 101.5]]);
  const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
  assert.equal(byKey.entry.color, CE.CHART_THEME.entry);
  assert.equal(byKey.target.color, CE.CHART_THEME.target);
  assert.equal(byKey.entry.title, 'Entry / breakout');
  assert.deepEqual(CE.levelLines(null), []);
});

test('levelLines accepts custom titles (the pattern chart says TRIG/STOP/TGT)', () => {
  const lines = CE.levelLines({ entry: 5, stop: 4, target: 7 }, { titles: { entry: 'TRIG', stop: 'STOP', target: 'TGT' } });
  assert.deepEqual(lines.map((l) => l.title), ['TGT', 'TRIG', 'STOP']);
});

// ── glyphs → markers ────────────────────────────────────────────────────────────────
test('signalMarkers keeps the ▲ buy below / ▼ sell above semantics and drops unknown times', () => {
  const shaped = CE.shapeCandles(PATTERN);
  const m = CE.signalMarkers([
    { time: '2026-09-03', side: 'sell', price: 11 },
    { time: '2026-09-01', side: 'buy', price: 9 },
    { time: '2099-01-01', side: 'buy', price: 1 },
  ], shaped);
  assert.deepEqual(m.map((x) => x.time), ['2026-09-01', '2026-09-03'], 'sorted ascending, unknown dropped');
  assert.equal(m[0].position, 'belowBar'); assert.equal(m[0].shape, 'arrowUp'); assert.equal(m[0].color, CE.CHART_THEME.up);
  assert.equal(m[1].position, 'aboveBar'); assert.equal(m[1].shape, 'arrowDown'); assert.equal(m[1].color, CE.CHART_THEME.down);
});

test('eventMarkers snap to the nearest candle and carry the ⧫ glyph', () => {
  const shaped = CE.shapeCandles(PATTERN);
  const m = CE.eventMarkers([{ date: '2026-09-02T20:00:00Z', label: 'Earnings' }, { when: 'garbage' }], shaped);
  assert.equal(m.length, 1);
  assert.equal(m[0].time, '2026-09-02');
  assert.equal(m[0].text, '⧫');
  assert.equal(m[0].color, CE.CHART_THEME.event);
});

test('pivotPoints match by date and pivotSegments connect consecutive pivots for the trend-line primitive', () => {
  const shaped = CE.shapeCandles(PATTERN);
  const pts = CE.pivotPoints([{ date: '2026-09-01', price: 8 }, { date: '2026-09-03', price: 12 }, { date: '1999-01-01', price: 1 }, { date: '2026-09-02' }], shaped);
  assert.deepEqual(pts, [{ time: '2026-09-01', price: 8 }, { time: '2026-09-03', price: 12 }]);
  const segs = CE.pivotSegments(pts);
  assert.deepEqual(segs, [{ p1: pts[0], p2: pts[1] }]);
  assert.deepEqual(CE.pivotSegments([pts[0]]), []);
});

test('highlightColors paints only the named bars and leaves the rest transparent', () => {
  const shaped = CE.shapeCandles(PATTERN);
  const hl = CE.highlightColors(shaped, [{ date: '2026-09-03', color: 'rgba(1,2,3,0.2)' }]);
  assert.equal(hl.length, 3);
  assert.equal(hl[2].color, 'rgba(1,2,3,0.2)');
  assert.equal(hl[0].color, 'rgba(0,0,0,0)');
});

// ── pattern chart keeps its API, renders via the engine ─────────────────────────────
test('patternChartSpec maps plan.trigger/stop/target to levels, pivots and the confirmation bar', () => {
  const det = {
    patternLabel: 'Cup & handle', direction: 'long', timeframe: 'swing',
    plan: { trigger: 11.2, stop: 8.9, target: 14 },
    pivotsUsed: [{ date: '2026-09-01', price: 8 }, { date: '2026-09-03', price: 12 }],
    confirmation: { confirmBarDate: '2026-09-03', closedThrough: true },
  };
  const spec = PC.patternChartSpec({ candles: PATTERN6 }, det);
  assert.deepEqual(spec.levels, { entry: 11.2, stop: 8.9, target: 14 });
  assert.deepEqual(spec.levelTitles, { entry: 'TRIG', stop: 'STOP', target: 'TGT' });
  assert.equal(spec.pivots.length, 2);
  assert.equal(spec.highlights[0].date, '2026-09-03');
  assert.match(spec.label, /Cup & handle long swing/);
  assert.equal(PC.patternChartSpec({ candles: PATTERN6 }, null).label, '');
  assert.equal(PC.patternChartSpec({ candles: PATTERN }, det), null, 'fewer than 5 bars → nothing to draw');
});

// ── primitives are plain-JS ports with the lightweight-charts primitive contract ─────
test('the ported primitives expose the ISeriesPrimitive surface (paneViews/updateAllViews/attached)', () => {
  for (const name of ['TrendLine', 'AnchoredText', 'SessionHighlighting']) {
    const Cls = PR[name];
    assert.equal(typeof Cls, 'function', `${name} exported`);
    assert.equal(typeof Cls.prototype.paneViews, 'function', `${name}.paneViews`);
    assert.equal(typeof Cls.prototype.updateAllViews, 'function', `${name}.updateAllViews`);
    assert.equal(typeof Cls.prototype.attached, 'function', `${name}.attached`);
  }
  const text = new PR.AnchoredText({ text: 'hi' });
  assert.equal(text.paneViews().length, 1);
  assert.equal(typeof text.paneViews()[0].renderer().draw, 'function');
  const hl = new PR.SessionHighlighting([{ time: '2026-09-01', color: 'red' }]);
  assert.equal(hl.paneViews()[0].zOrder(), 'bottom', 'highlights paint behind the candles');
});

// ── source pins: vendoring, attribution, retired canvas convention ───────────────────
test('the vendored engine is pinned to 5.2.1 with its Apache-2.0 header, license and NOTICE', () => {
  const vendor = read('public/js/vendor/lightweight-charts-5.2.1.standalone.mjs');
  assert.match(vendor.slice(0, 400), /Lightweight Charts™ v5\.2\.1/);
  assert.match(vendor.slice(0, 400), /Apache License 2\.0/);
  assert.match(read('public/js/vendor/LICENSE-lightweight-charts'), /Apache License/);
  assert.match(read('public/js/vendor/NOTICE'), /TradingView/);
  assert.match(read('public/js/vendor/NOTICE'), /d3-hierarchy/);
  assert.match(read('public/js/vendor/LICENSE-d3-hierarchy'), /Mike Bostock/);
});

test('chart-engine loads the vendored ESM lazily and renders the visible TradingView attribution', () => {
  const src = read('public/js/chart-engine.js');
  assert.match(src, /import\(\s*['"]\.\/vendor\/lightweight-charts-5\.2\.1\.standalone\.mjs['"]\s*\)/, 'dynamic import() — the 193 KB loads only when a chart mounts');
  assert.ok(!/^import .* from ['"]\.\/vendor\/lightweight-charts/m.test(src), 'no static import of the engine');
  assert.match(src, /Charts by TradingView/, 'Apache-2.0 NOTICE attribution text');
  assert.match(src, /https:\/\/www\.tradingview\.com\//, 'attribution links to TradingView');
  assert.equal(CE.ATTRIBUTION_HTML.includes('rel="noopener"'), true);
  assert.match(read('public/css/app.css'), /\.chart-attrib\b/, 'attribution is styled, so it stays visible');
});

test('app.js and pattern-chart.js draw through the engine — no hand-drawn canvas candles remain', () => {
  const app = read('public/js/app.js');
  assert.match(app, /import \{[^}]*mountCandles[^}]*\} from '\.\/chart-engine\.js'/, 'app.js imports the engine');
  assert.match(app, /function drawChart\(/, 'drawChart keeps its name (ticker-lookup and the card toggles call renderChart → drawChart)');
  assert.match(app, /function renderChart\(panel, data, opts = \{\}\)/, 'renderChart signature unchanged');
  assert.ok(!/<div class="chart-canvas-wrap"><canvas><\/canvas><\/div>/.test(app), 'the live chart no longer renders a <canvas>');
  assert.ok(!/ctx\.fillRect\(cx - bw \/ 2/.test(app), 'the hand-drawn candle body loop is gone');
  const pc = read('public/js/pattern-chart.js');
  assert.ok(!/getContext\('2d'\)/.test(pc), 'pattern chart no longer draws on a 2d context');
  assert.ok(!/repo convention: canvas only/.test(pc), 'the "canvas only" convention is retired, not restated');
  assert.match(pc, /export function drawPatternChart\(host, chart, det\)/, 'pattern-chart keeps its API');
  assert.match(pc, /mountCandles/, 'pattern-chart renders via the engine');
  assert.ok(!/<canvas/.test(app.slice(app.indexOf('async function prLoadChart'), app.indexOf('async function prLoadChart') + 2500)), 'pattern chart slot mounts a host div, not a canvas');
});

test('Session Board and Ignition Live expand cards mount the same component', () => {
  const sb = read('public/js/session-board.js');
  assert.match(sb, /from '\.\/chart-engine\.js'/);
  assert.match(sb, /sb-chart/, 'card carries a chart expander');
  const igl = read('public/js/ignition-live.js');
  assert.match(igl, /from '\.\/chart-engine\.js'/);
  assert.match(igl, /data-igchart/, 'why-panel carries a chart loader');
});

test('the vendor folder is outside the module-parse and full-source globs (non-recursive public/js/*.js)', () => {
  assert.match(read('test/module-parse.test.js'), /readdirSync\(dir\)\.filter\(f => f\.endsWith\('\.js'\)\)/);
  assert.match(read('scripts/gen-full-source.js'), /'public\/js\/\*\.js'/);
});
