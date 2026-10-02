// CHART ENGINE — the app's single chart component. Every candle chart (card toggles,
// ticker-lookup, pattern radar, Session Board and Ignition expand cards) mounts through
// `mountCandles(host, spec)`, which wraps TradingView Lightweight Charts™ v5 (vendored,
// Apache-2.0 — see vendor/NOTICE) with the app palette:
//   • candles + volume histogram, EMA/VWAP overlays
//   • frozen entry / stop / target as dashed price lines (series.createPriceLine)
//   • glyph semantics preserved as markers: ▲ buy below the bar, ▼ sell above, ⧫ at real
//     event dates; pivots as dots joined by the trend-line primitive; the confirmation bar
//     as a session highlight; a corner label via anchored-text
//   • ResizeObserver resize, disposal on re-mount, lazy import() of the 193 KB engine so a
//     tab with no chart open never downloads it
// Attribution: the Apache-2.0 NOTICE requires a visible TradingView credit wherever a chart
// renders — every mount appends the "Charts by TradingView" link under the pane.
//
// Everything above mountCandles is pure (payload in, plain objects out) so it is unit-tested
// without a DOM; the module's top level touches no browser global.
import { TrendLine, AnchoredText, SessionHighlighting } from './chart-primitives.js';

export const ENGINE_URL = './vendor/lightweight-charts-5.2.1.standalone.mjs';
export const ATTRIBUTION_HTML = '<a class="chart-attrib" href="https://www.tradingview.com/" target="_blank" rel="noopener" title="Powered by TradingView Lightweight Charts™ (Apache-2.0)">Charts by TradingView</a>';

// App palette (public/css/app.css :root tokens + the colours the legacy canvas used).
export const CHART_THEME = Object.freeze({
  bg: '#060b14', text: '#4d6688', grid: '#16223e',
  up: '#10d98a', down: '#ef5050',
  volUp: 'rgba(16,217,138,0.35)', volDown: 'rgba(239,80,80,0.35)',
  entry: '#06c4d4', stop: '#ef5050', target: '#10d98a',
  ema9: '#06c4d4', ema21: '#f0a832', ema50: '#8a6dff', vwap: '#ff6b35',
  pivot: '#eab308', event: '#f0a832', label: '#94a3b8',
});

const DEFAULT_HEIGHT = 220;
const FALLBACK_WIDTH = 380;
const LEVEL_ORDER = ['target', 'entry', 'stop'];
const LEVEL_TITLES = Object.freeze({ entry: 'Entry / breakout', stop: 'Stop (invalidation)', target: 'Target' });
const INDICATOR_KEYS = ['ema9', 'ema21', 'ema50', 'vwap'];
const TRANSPARENT = 'rgba(0,0,0,0)';
const EVENT_GLYPH = '⧫';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_SECOND = 1000;
const PRICE_SCALE_MARGINS = Object.freeze({ withVolume: { top: 0.06, bottom: 0.26 }, alone: { top: 0.06, bottom: 0.06 } });
const VOLUME_SCALE_MARGINS = Object.freeze({ top: 0.78, bottom: 0 });

// ── time ─────────────────────────────────────────────────────────────────────────────
// Daily bars arrive as 'YYYY-MM-DD' (a business day the engine takes verbatim); intraday
// bars as ISO datetimes → UTC seconds. Anything else is unusable.
export function toChartTime(dateLike) {
  if (typeof dateLike === 'number') return Number.isFinite(dateLike) ? dateLike : null;
  if (typeof dateLike !== 'string' || !dateLike) return null;
  if (DAY_RE.test(dateLike)) return dateLike;
  const ms = Date.parse(dateLike);
  return Number.isFinite(ms) ? Math.floor(ms / MS_PER_SECOND) : null;
}

export function isIntraday(shaped) {
  return Array.isArray(shaped) && shaped.length > 0 && typeof shaped[0].time === 'number';
}

const num = (v) => { const f = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(f) ? f : null; };
const cmpTime = (a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const byTime = (a, b) => cmpTime(a.time, b.time);
const dayOf = (s) => String(s).slice(0, 10);

// ── candles / volume / indicator lines ───────────────────────────────────────────────
// Accepts both payload shapes ({open,high,low,close,volume} from /api/chart and
// {o,h,l,c,v} from the pattern payload); sorts ascending, dedups, drops non-finite rows.
export function shapeCandles(candles) {
  if (!Array.isArray(candles)) return [];
  const seen = new Set();
  const out = [];
  for (const c of candles) {
    if (!c) continue;
    const time = toChartTime(c.date ?? c.time);
    const open = num(c.open ?? c.o), high = num(c.high ?? c.h), low = num(c.low ?? c.l), close = num(c.close ?? c.c);
    if (time == null || open == null || high == null || low == null || close == null) continue;
    const key = String(time);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ time, date: String(c.date ?? c.time), open, high, low, close, volume: num(c.volume ?? c.v) ?? 0 });
  }
  return out.sort(byTime);
}

export function shapeVolume(shaped, theme = CHART_THEME) {
  return shaped.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? theme.volUp : theme.volDown }));
}

export function shapeLine(values, shaped) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (let i = 0; i < shaped.length && i < values.length; i++) {
    const v = num(values[i]);
    if (v != null) out.push({ time: shaped[i].time, value: v });
  }
  return out;
}

// ── frozen levels ────────────────────────────────────────────────────────────────────
export function levelLines(levels, { titles = {}, theme = CHART_THEME } = {}) {
  if (!levels) return [];
  const out = [];
  for (const key of LEVEL_ORDER) {
    const price = num(levels[key]);
    if (price == null) continue;
    out.push({ key, price, color: theme[key], title: titles[key] || LEVEL_TITLES[key], lineStyle: 'dashed' });
  }
  return out;
}

// ── glyphs → markers ─────────────────────────────────────────────────────────────────
function timeIndex(shaped) {
  const byDate = new Map();
  const times = new Set();
  for (const c of shaped) { byDate.set(c.date, c.time); times.add(String(c.time)); }
  return { byDate, times };
}

function resolveTime(raw, idx) {
  if (idx.byDate.has(String(raw))) return idx.byDate.get(String(raw));
  const t = toChartTime(raw);
  return t != null && idx.times.has(String(t)) ? t : null;
}

export function signalMarkers(signals, shaped, theme = CHART_THEME) {
  if (!Array.isArray(signals)) return [];
  const idx = timeIndex(shaped);
  const out = [];
  for (const s of signals) {
    if (!s) continue;
    const time = resolveTime(s.time, idx);
    if (time == null) continue;
    const buy = s.side === 'buy';
    out.push({ time, position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown', color: buy ? theme.up : theme.down, text: '' });
  }
  return out.sort(byTime);
}

function nearestCandle(ms, shaped) {
  let best = null, bestD = Infinity;
  for (const c of shaped) {
    const ct = typeof c.time === 'number' ? c.time * MS_PER_SECOND : Date.parse(c.date);
    const d = Math.abs(ct - ms);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

export function eventMarkers(events, shaped, theme = CHART_THEME) {
  if (!Array.isArray(events) || !shaped.length) return [];
  const idx = timeIndex(shaped);
  const daily = !isIntraday(shaped);
  const out = [];
  for (const ev of events) {
    if (!ev) continue;
    const raw = ev.date || ev.when;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    const exact = daily ? idx.byDate.get(dayOf(raw)) : null;
    const c = exact != null ? { time: exact } : nearestCandle(daily ? Date.parse(dayOf(raw)) : ms, shaped);
    if (!c) continue;
    out.push({ time: c.time, position: 'aboveBar', shape: 'circle', color: theme.event, text: ev.mark || EVENT_GLYPH, size: 0.6 });
  }
  return out.sort(byTime);
}

// ── pivots / highlights (pattern structure) ──────────────────────────────────────────
export function pivotPoints(pivots, shaped) {
  if (!Array.isArray(pivots)) return [];
  const idx = timeIndex(shaped);
  const out = [];
  for (const p of pivots) {
    const price = p && num(p.price);
    const time = p ? resolveTime(p.date, idx) : null;
    if (time == null || price == null) continue;
    out.push({ time, price });
  }
  return out.sort(byTime);
}

export function pivotSegments(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) out.push({ p1: points[i - 1], p2: points[i] });
  return out;
}

export function pivotMarkers(points, theme = CHART_THEME) {
  return points.map((p) => ({ time: p.time, position: 'inBar', shape: 'circle', color: theme.pivot, text: '', size: 0.5 }));
}

export function highlightColors(shaped, highlights) {
  const byDate = new Map((Array.isArray(highlights) ? highlights : []).filter((h) => h && h.date).map((h) => [dayOf(h.date), h.color]));
  return shaped.map((c) => ({ time: c.time, color: byDate.get(dayOf(c.date)) || TRANSPARENT }));
}

// ── engine loading (lazy, once) ──────────────────────────────────────────────────────
let enginePromise = null;
export function loadEngine() {
  if (!enginePromise) {
    enginePromise = import('./vendor/lightweight-charts-5.2.1.standalone.mjs').catch((e) => { enginePromise = null; throw e; });
  }
  return enginePromise;
}

// Theme-aware: read the live CSS tokens when a stylesheet defines them, else the constants.
export function themeFromCss(theme = CHART_THEME) {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return theme;
  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => { const v = css.getPropertyValue(name).trim(); return v || fallback; };
  return { ...theme, bg: token('--bg', theme.bg), text: token('--text-dim', theme.text), up: token('--green', theme.up), down: token('--red', theme.down) };
}

// ── mount ────────────────────────────────────────────────────────────────────────────
function chartOptions(LWC, theme, width, height, intraday) {
  return {
    width, height,
    // attributionLogo off: the visible "Charts by TradingView" link under the pane is the
    // Apache-2.0 NOTICE credit, and the in-pane logo would sit on top of the volume bars.
    layout: { background: { type: 'solid', color: theme.bg }, textColor: theme.text, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10, attributionLogo: false },
    grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
    rightPriceScale: { borderColor: theme.grid },
    timeScale: { borderColor: theme.grid, timeVisible: intraday, secondsVisible: false, rightOffset: 2 },
    crosshair: { mode: LWC.CrosshairMode.Normal },
  };
}

function addVolume(chart, LWC, shaped, theme) {
  const vol = chart.addSeries(LWC.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
  vol.setData(shapeVolume(shaped, theme));
  chart.priceScale('volume').applyOptions({ scaleMargins: VOLUME_SCALE_MARGINS, visible: false });
}

function addIndicatorLines(chart, LWC, indicators, shaped, theme) {
  if (!indicators) return;
  for (const key of INDICATOR_KEYS) {
    const data = shapeLine(indicators[key], shaped);
    if (!data.length) continue;
    const line = chart.addSeries(LWC.LineSeries, {
      color: theme[key], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      lineStyle: key === 'vwap' ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid,
    });
    line.setData(data);
  }
}

function addPriceLines(series, LWC, spec, theme) {
  const lines = [...levelLines(spec.levels, { titles: spec.levelTitles, theme }), ...(Array.isArray(spec.extraLines) ? spec.extraLines : [])];
  for (const l of lines) {
    const price = num(l.price);
    if (price == null) continue;
    series.createPriceLine({ price, color: l.color || theme.label, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: l.title || '' });
  }
}

function addMarkers(series, LWC, spec, shaped, pivots, theme) {
  const markers = [...signalMarkers(spec.signals, shaped, theme), ...eventMarkers(spec.events, shaped, theme), ...pivotMarkers(pivots, theme)].sort(byTime);
  if (markers.length) LWC.createSeriesMarkers(series, markers);
}

function attachPrimitives(series, spec, shaped, pivots, theme) {
  for (const seg of pivotSegments(pivots)) series.attachPrimitive(new TrendLine(seg.p1, seg.p2, { lineColor: theme.pivot }));
  if (Array.isArray(spec.highlights) && spec.highlights.length) series.attachPrimitive(new SessionHighlighting(highlightColors(shaped, spec.highlights)));
  if (spec.label) series.attachPrimitive(new AnchoredText({ text: String(spec.label), color: theme.label, vertAlign: 'top' }));
}

function observeResize(pane, chart) {
  if (typeof ResizeObserver === 'undefined') return null;
  const ro = new ResizeObserver((entries) => {
    const w = Math.floor(entries[0].contentRect.width);
    if (w > 0) chart.applyOptions({ width: w });
  });
  ro.observe(pane);
  return ro;
}

export function disposeChart(host) {
  const prev = host && host.__chart;
  if (prev && typeof prev.dispose === 'function') prev.dispose();
}

// spec: { candles, volume=true, indicators:{ema9,ema21,ema50,vwap}, levels:{entry,stop,target},
//         levelTitles, extraLines:[{price,color,title}], signals, events, pivots, highlights:[{date,color}],
//         label, height, theme }
// Resolves to a handle { chart, series, dispose } (null when there is nothing to draw).
export async function mountCandles(host, spec = {}) {
  if (!host) throw new Error('mountCandles: host element required');
  disposeChart(host);
  const shaped = shapeCandles(spec.candles);
  if (!shaped.length) { host.innerHTML = '<div class="chart-err">No price history to chart.</div>'; return null; }
  const LWC = await loadEngine();
  const theme = { ...themeFromCss(), ...(spec.theme || {}) };
  const height = spec.height || DEFAULT_HEIGHT;

  host.innerHTML = '';
  const pane = document.createElement('div');
  pane.className = 'chart-pane';
  pane.style.height = `${height}px`;
  host.appendChild(pane);
  const attrib = document.createElement('div');
  attrib.className = 'chart-attrib-row';
  attrib.innerHTML = ATTRIBUTION_HTML;
  host.appendChild(attrib);

  const chart = LWC.createChart(pane, chartOptions(LWC, theme, pane.clientWidth || FALLBACK_WIDTH, height, isIntraday(shaped)));
  const withVolume = spec.volume !== false;
  const series = chart.addSeries(LWC.CandlestickSeries, {
    upColor: theme.up, downColor: theme.down, borderVisible: false, wickUpColor: theme.up, wickDownColor: theme.down, priceLineVisible: false,
  });
  series.setData(shaped.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  series.priceScale().applyOptions({ scaleMargins: withVolume ? PRICE_SCALE_MARGINS.withVolume : PRICE_SCALE_MARGINS.alone });
  if (withVolume) addVolume(chart, LWC, shaped, theme);
  addIndicatorLines(chart, LWC, spec.indicators, shaped, theme);
  addPriceLines(series, LWC, spec, theme);
  const pivots = pivotPoints(spec.pivots, shaped);
  addMarkers(series, LWC, spec, shaped, pivots, theme);
  attachPrimitives(series, spec, shaped, pivots, theme);
  chart.timeScale().fitContent();

  const ro = observeResize(pane, chart);
  const handle = {
    chart, series,
    dispose() {
      if (ro) ro.disconnect();
      try { chart.remove(); } catch { /* already removed with its host */ }
      if (host.__chart === handle) host.__chart = null;
    },
  };
  host.__chart = handle;
  return handle;
}
