'use strict';
// 🗺 SECTOR TREEMAP — pure hierarchy shaping + layout + SVG string over d3-hierarchy
// (vendored ISC). DOM-less: the module exports the helpers that renderSectorTreemap
// composes, so the layout math and the chips fallback contract are testable here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let TM;
test.before(async () => { TM = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'sector-treemap.js')).href); });

const SECTORS = [
  { symbol: 'SPY', name: 'S&P 500', price: '500.00', changePct: 0.4, dollarVol: 9e9 },
  { symbol: 'QQQ', name: 'Nasdaq', price: '400.00', changePct: 0.9, dollarVol: 8e9 },
  { symbol: 'XLK', name: 'Technology', price: '200.00', changePct: 1.8, dollarVol: 2e9 },
  { symbol: 'XLF', name: 'Financials', price: '40.00', changePct: -0.7, dollarVol: 1e9 },
  { symbol: 'XLV', name: 'Healthcare', price: '140.00', changePct: 0.1, dollarVol: 5e8 },
];
const TICKERS = [
  { ticker: 'NVDA', company: 'NVIDIA', sector: 'Technology', changePct: 3.1, dollarVol: 4e10 },
  { ticker: 'AAPL', company: 'Apple', sector: 'Technology', changePct: -0.2, dollarVol: 1e10 },
  { ticker: 'JPM', company: 'JPMorgan', sector: 'Financials', changePct: -1.1, dollarVol: 2e9 },
  { ticker: 'LLY', company: 'Lilly', sector: 'Health Care', changePct: 0.8, dollarVol: 3e9 }, // screener spelling ≠ ETF name
  { ticker: 'ZZZ', company: 'No size', sector: 'Technology', changePct: 1, dollarVol: null },
];
const style = (pct) => ({ bg: pct >= 0 ? '#040' : '#400', border: '#111', col: pct >= 0 ? '#0f0' : '#f00' });

test('hasSizeData is the chips-fallback switch: true only when a sector tile carries a positive size', () => {
  assert.equal(TM.hasSizeData(SECTORS), true);
  assert.equal(TM.hasSizeData(SECTORS.map((s) => ({ ...s, dollarVol: null }))), false);
  assert.equal(TM.hasSizeData([]), false);
  assert.equal(TM.hasSizeData(null), false);
});

test('splitBenchmarks keeps SPY/QQQ out of the area (they would dwarf every sector)', () => {
  const { benchmarks, sectors } = TM.splitBenchmarks(SECTORS);
  assert.deepEqual(benchmarks.map((b) => b.symbol), ['SPY', 'QQQ']);
  assert.deepEqual(sectors.map((s) => s.symbol), ['XLK', 'XLF', 'XLV']);
});

test('shapeHierarchy builds sector → ticker, matching the screener sector spelling to the ETF name', () => {
  const root = TM.shapeHierarchy(SECTORS, TICKERS);
  assert.equal(root.name, 'market');
  const tech = root.children.find((c) => c.symbol === 'XLK');
  assert.deepEqual(tech.children.map((t) => t.symbol), ['NVDA', 'AAPL'], 'sized tickers nest under their sector; size-less ones are dropped');
  const hc = root.children.find((c) => c.symbol === 'XLV');
  assert.deepEqual(hc.children.map((t) => t.symbol), ['LLY'], '"Health Care" (screener) resolves to "Healthcare" (ETF)');
  const fin = root.children.find((c) => c.symbol === 'XLF');
  assert.equal(fin.children[0].changePct, -1.1);
  assert.equal(fin.children[0].kind, 'ticker');
});

test('shapeHierarchy without tickers is a one-level sector map sized by dollar volume', () => {
  const root = TM.shapeHierarchy(SECTORS, []);
  assert.equal(root.children.length, 3);
  assert.ok(root.children.every((c) => !c.children && c.value === c.dollarVol));
  assert.equal(root.children[0].kind, 'sector');
});

test('shapeHierarchy returns null when nothing has a size (caller falls back to chips)', () => {
  assert.equal(TM.shapeHierarchy(SECTORS.map((s) => ({ ...s, dollarVol: 0 })), []), null);
  assert.equal(TM.shapeHierarchy(null, []), null);
});

test('layoutTreemap fills the box, keeps every tile inside it, and sizes area by value', () => {
  const nodes = TM.layoutTreemap(TM.shapeHierarchy(SECTORS, []), 600, 300);
  const leaves = nodes.filter((n) => n.depth === 1);
  assert.equal(leaves.length, 3);
  for (const n of leaves) {
    assert.ok(n.x0 >= 0 && n.y0 >= 0 && n.x1 <= 600 + 1e-6 && n.y1 <= 300 + 1e-6, 'inside the box');
    assert.ok(n.x1 > n.x0 && n.y1 > n.y0, 'positive area');
  }
  const area = (n) => (n.x1 - n.x0) * (n.y1 - n.y0);
  const byKey = Object.fromEntries(leaves.map((n) => [n.data.symbol, area(n)]));
  const ratio = byKey.XLK / byKey.XLF;
  assert.ok(ratio > 1.7 && ratio < 2.3, `XLK (2e9) ≈ 2× XLF (1e9), got ${ratio.toFixed(2)} (padding costs a little)`);
  assert.ok(byKey.XLF > byKey.XLV);
});

test('layoutTreemap nests tickers inside their sector tile', () => {
  const nodes = TM.layoutTreemap(TM.shapeHierarchy(SECTORS, TICKERS), 600, 300);
  const tech = nodes.find((n) => n.depth === 1 && n.data.symbol === 'XLK');
  const nvda = nodes.find((n) => n.depth === 2 && n.data.symbol === 'NVDA');
  assert.ok(nvda.x0 >= tech.x0 - 1e-6 && nvda.x1 <= tech.x1 + 1e-6 && nvda.y0 >= tech.y0 - 1e-6 && nvda.y1 <= tech.y1 + 1e-6);
});

test('treemapSvg emits inline SVG rects coloured by the app sectorStyle scale, labels hidden under 40px, text escaped', () => {
  const sectors = SECTORS.map((s) => s.symbol === 'XLV' ? { ...s, name: '<b>H</b>', dollarVol: 1 } : s);
  const nodes = TM.layoutTreemap(TM.shapeHierarchy(sectors, []), 600, 300);
  const svg = TM.treemapSvg(nodes, { width: 600, height: 300, style });
  assert.match(svg, /^<svg[^>]*viewBox="0 0 600 300"/);
  assert.match(svg, /<rect[^>]*data-symbol="XLK"[^>]*fill="#040"/, 'XLK up → style(pct).bg');
  assert.match(svg, /<rect[^>]*data-symbol="XLF"[^>]*fill="#400"/, 'XLF down');
  assert.match(svg, /<text[^>]*>XLK<\/text>/, 'big tile gets a label');
  assert.ok(!/<text[^>]*>XLV<\/text>/.test(svg), 'a sliver (dollarVol 1) has no label');
  assert.ok(!svg.includes('<b>H</b>'), 'names are escaped');
  assert.match(svg, /<title>[^<]*&lt;b&gt;H&lt;\/b&gt;/, 'the tooltip title carries the escaped name');
  assert.ok(!/\bundefined\b|\bNaN\b|\$\{/.test(svg), 'no render hazards');
});

test('treemapSvg marks ticker tiles clickable (data-ticker) and sector tiles not', () => {
  const nodes = TM.layoutTreemap(TM.shapeHierarchy(SECTORS, TICKERS), 800, 400);
  const svg = TM.treemapSvg(nodes, { width: 800, height: 400, style });
  assert.match(svg, /<rect[^>]*data-ticker="NVDA"/);
  assert.ok(!/<rect[^>]*data-ticker="XLK"/.test(svg), 'sector rects are frames, not ticker routes');
  assert.match(svg, /class="tm-sector-label"[^>]*>Technology/);
});

test('benchmarkChips renders SPY/QQQ as the original chip markup (same classes the CSS styles)', () => {
  const html = TM.benchmarkChips(TM.splitBenchmarks(SECTORS).benchmarks, style);
  assert.match(html, /class="sector-tile"/);
  assert.match(html, /SPY/); assert.match(html, /\+0\.4%/);
});

test('app.js replaces the equal-size chips with the treemap and keeps the chips fallback', () => {
  const app = read('public/js/app.js');
  assert.match(app, /import \{[^}]*renderSectorTreemap[^}]*\} from '\.\/sector-treemap\.js'/);
  assert.match(app, /function renderSectorHeatmap\(sectors\)/, 'entry point keeps its name');
  assert.match(app, /hasSizeData\(sectors\)/, 'payload without size data → chips');
  assert.match(app, /renderSectorTreemap\(/);
  assert.match(read('public/css/app.css'), /\.sector-treemap\b/);
  assert.match(read('api/sectors.js'), /dollarVol/, '/api/sectors carries the size the treemap needs');
});

test('the d3-hierarchy vendor file is the pinned ISC build and is statically imported (15 KB)', () => {
  const vendor = read('public/js/vendor/d3-hierarchy-3.1.2.esm.js');
  assert.match(vendor.slice(0, 400), /d3-hierarchy@3\.1\.2/);
  assert.match(read('public/js/sector-treemap.js'), /from '\.\/vendor\/d3-hierarchy-3\.1\.2\.esm\.js'/);
});
