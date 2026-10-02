// SECTOR TREEMAP — Finviz-style map over sector → ticker, built with d3-hierarchy
// (vendored ISC, 15 KB). Area = today's dollar volume (sector tile = the sector ETF's
// dollar volume; tickers inside a sector share that area in proportion to their own dollar
// volume, so sectors stay comparable whether or not the screener has loaded). Fill = today's
// % change through the app's existing sectorStyle() scale. Output is inline SVG so it stays
// theme-aware and needs no canvas; labels hide under MIN_LABEL_PX. A ticker tile routes to
// the command palette's ticker lookup; a sector tile is a frame.
//
// `hasSizeData()` is the fallback switch: a /api/sectors payload without dollar volume keeps
// the original equal-size chips (renderSectorHeatmap in app.js).
import { hierarchy, treemap, treemapSquarify } from './vendor/d3-hierarchy-3.1.2.esm.js';
import { esc } from './format.js';

export const BENCHMARKS = Object.freeze(new Set(['SPY', 'QQQ']));
const MIN_LABEL_PX = 40;
const SECTOR_LABEL_PX = 12;
const PADDING_INNER = 2;
const PADDING_OUTER = 1;
const SECTOR_PAD_TOP = 14;
const DEFAULT_HEIGHT = 280;
const FALLBACK_WIDTH = 720;
const BILLION = 1e9;
const MILLION = 1e6;

// Screener sector spelling (lib/universe.js SECTOR_GROUPS) → /api/sectors ETF name.
const SECTOR_ALIASES = Object.freeze({
  'health care': 'healthcare', 'consumer discretionary': 'cons discret', 'consumer staples': 'cons staples',
  'communication services': 'comm services', 'information technology': 'technology',
});

const num = (v) => { const f = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(f) ? f : null; };
const sizeOf = (row) => {
  const dv = num(row && row.dollarVol);
  if (dv != null && dv > 0) return dv;
  const cap = num(row && row.marketCap);
  return cap != null && cap > 0 ? cap : null;
};
const fmtPct = (pct) => (pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct}%`);
const fmtMoney = (v) => (v == null ? '' : v >= BILLION ? `$${(v / BILLION).toFixed(1)}B` : `$${Math.round(v / MILLION)}M`);

export function canonSector(name) {
  const k = String(name || '').trim().toLowerCase();
  return SECTOR_ALIASES[k] || k;
}

export function hasSizeData(sectors) {
  return Array.isArray(sectors) && sectors.some((s) => sizeOf(s) != null);
}

export function splitBenchmarks(sectors) {
  const arr = Array.isArray(sectors) ? sectors : [];
  return { benchmarks: arr.filter((s) => s && BENCHMARKS.has(s.symbol)), sectors: arr.filter((s) => s && !BENCHMARKS.has(s.symbol)) };
}

function groupTickers(tickers) {
  const groups = new Map();
  for (const t of Array.isArray(tickers) ? tickers : []) {
    if (!t || !t.ticker || sizeOf(t) == null) continue;
    const key = canonSector(t.sector);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return groups;
}

// Ticker leaves share the sector's area in proportion to their own size.
function tickerChildren(rows, sectorSize) {
  const total = rows.reduce((s, t) => s + sizeOf(t), 0);
  return rows.map((t) => ({
    kind: 'ticker', symbol: String(t.ticker), name: t.company || t.ticker, sector: t.sector || null,
    changePct: num(t.changePct), dollarVol: sizeOf(t), value: sectorSize * (sizeOf(t) / total),
  }));
}

// Pure: {name:'market', children:[sector{…, children?:[ticker…]}]} or null when nothing has a size.
export function shapeHierarchy(sectors, tickers = []) {
  const { sectors: secs } = splitBenchmarks(sectors);
  const groups = groupTickers(tickers);
  const children = secs.map((s) => {
    const size = sizeOf(s);
    if (size == null) return null;
    const base = { kind: 'sector', symbol: String(s.symbol), name: String(s.name || s.symbol), changePct: num(s.changePct), dollarVol: size };
    const rows = groups.get(canonSector(s.name)) || [];
    return rows.length ? { ...base, children: tickerChildren(rows, size) } : { ...base, value: size };
  }).filter(Boolean);
  return children.length ? { name: 'market', children } : null;
}

// d3 layout → plain nodes [{x0,y0,x1,y1,depth,value,data}] (root excluded).
export function layoutTreemap(root, width, height) {
  if (!root) return [];
  const h = hierarchy(root).sum((d) => (d.children ? 0 : d.value || 0)).sort((a, b) => b.value - a.value);
  treemap()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner(PADDING_INNER)
    .paddingOuter(PADDING_OUTER)
    .paddingTop((d) => (d.depth === 1 && d.children ? SECTOR_PAD_TOP : PADDING_OUTER))(h);
  return h.descendants().filter((d) => d.depth > 0).map((d) => ({ x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, depth: d.depth, value: d.value, data: d.data }));
}

const r2 = (v) => Math.round(v * 100) / 100;

function tileRect(n, st, extraAttrs) {
  const w = r2(n.x1 - n.x0), h = r2(n.y1 - n.y0);
  return `<rect class="tm-tile tm-${n.data.kind}"${extraAttrs} x="${r2(n.x0)}" y="${r2(n.y0)}" width="${w}" height="${h}" fill="${esc(st.bg)}" stroke="${esc(st.border)}" rx="3"><title>${esc(n.data.name)} (${esc(n.data.symbol)}) ${esc(fmtPct(n.data.changePct))}${n.data.dollarVol ? ` · ${esc(fmtMoney(n.data.dollarVol))}` : ''}</title></rect>`;
}

function leafLabel(n, st, minLabelPx) {
  const w = n.x1 - n.x0, h = n.y1 - n.y0;
  if (w < minLabelPx || h < minLabelPx) return '';
  const cx = r2((n.x0 + n.x1) / 2), cy = r2((n.y0 + n.y1) / 2);
  return `<text class="tm-label tm-sym" x="${cx}" y="${r2(cy - 2)}" text-anchor="middle" fill="${esc(st.col)}">${esc(n.data.symbol)}</text>` +
    `<text class="tm-label tm-pct" x="${cx}" y="${r2(cy + 11)}" text-anchor="middle" fill="${esc(st.col)}">${esc(fmtPct(n.data.changePct))}</text>`;
}

function sectorFrameLabel(n, st, minLabelPx) {
  if (n.x1 - n.x0 < minLabelPx) return '';
  return `<text class="tm-sector-label" x="${r2(n.x0 + 4)}" y="${r2(n.y0 + SECTOR_LABEL_PX - 2)}" fill="${esc(st.col)}">${esc(n.data.name)}</text>`;
}

// Pure: nodes → inline SVG string. style(pct) → {bg, border, col} (the app's sectorStyle).
export function treemapSvg(nodes, { width, height, style, minLabelPx = MIN_LABEL_PX }) {
  const parts = [];
  for (const n of nodes) {
    const st = style(n.data.changePct);
    if (n.data.kind === 'ticker') {
      parts.push(tileRect(n, st, ` data-ticker="${esc(n.data.symbol)}" data-symbol="${esc(n.data.symbol)}"`) + leafLabel(n, st, minLabelPx));
    } else if (n.data.children) {
      parts.push(tileRect(n, st, ` data-symbol="${esc(n.data.symbol)}"`) + sectorFrameLabel(n, st, minLabelPx));
    } else {
      parts.push(tileRect(n, st, ` data-symbol="${esc(n.data.symbol)}"`) + leafLabel(n, st, minLabelPx));
    }
  }
  return `<svg class="sector-treemap-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" role="img" aria-label="Sector treemap — area is dollar volume, colour is today's change">${parts.join('')}</svg>`;
}

// SPY / QQQ keep the original chip markup above the map (same classes the stylesheet styles).
export function benchmarkChips(benchmarks, style) {
  return (Array.isArray(benchmarks) ? benchmarks : []).map((s) => {
    const pct = num(s.changePct);
    const st = style(pct);
    return `<div class="sector-tile" style="background:${esc(st.bg)};border-color:${esc(st.border)}">
        <div class="st-sym" style="color:${esc(st.col)}">${esc(s.symbol)}</div>
        <div class="st-name">${esc(s.name || '')}</div>
        <div class="st-pct" style="color:${esc(st.col)}">${esc(fmtPct(pct))}</div>
      </div>`;
  }).join('');
}

// Browser: draws into host; returns false (drawing nothing) when the payload has no sizes,
// so the caller can fall back to chips.
export function renderSectorTreemap(host, sectors, { tickers = [], style, onTicker = null, height = DEFAULT_HEIGHT } = {}) {
  if (!host || typeof style !== 'function') return false;
  const root = shapeHierarchy(sectors, tickers);
  if (!root) return false;
  const width = host.clientWidth || FALLBACK_WIDTH;
  const nodes = layoutTreemap(root, width, height);
  const { benchmarks } = splitBenchmarks(sectors);
  const nested = nodes.some((n) => n.depth === 2);
  host.innerHTML = `<div class="sector-treemap fade-in">
      <div class="sector-grid tm-bench">${benchmarkChips(benchmarks, style)}</div>
      ${treemapSvg(nodes, { width, height, style })}
      <div class="tm-foot">area = today's dollar volume · colour = % change${nested ? ' · click a ticker to look it up' : ' · open the Screener tab to nest its large-cap names inside each sector'}</div>
    </div>`;
  if (typeof onTicker === 'function') {
    host.querySelectorAll('[data-ticker]').forEach((el) => el.addEventListener('click', () => onTicker(el.getAttribute('data-ticker'))));
  }
  return true;
}
