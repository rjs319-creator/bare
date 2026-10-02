// CHART PRIMITIVES — plain-JS ports of three lightweight-charts plugin examples, attached to
// a series via `series.attachPrimitive(...)` (ISeriesPrimitive contract: paneViews /
// updateAllViews / attached / detached, optional autoscaleInfo).
//
// Ported from https://github.com/tradingview/lightweight-charts/tree/master/plugin-examples
//   src/plugins/trend-line/trend-line.ts             → TrendLine
//   src/plugins/anchored-text/anchored-text.ts       → AnchoredText
//   src/plugins/session-highlighting/…               → SessionHighlighting
// Copyright (c) TradingView, Inc. — Apache License 2.0 (see vendor/LICENSE-lightweight-charts
// and vendor/NOTICE). TypeScript types dropped, PluginBase inlined, chart/series taken from
// the `attached()` parameter instead of the constructor so a primitive can be built before
// the chart exists (and unit-tested without one).

const NO_POINT = Object.freeze({ x: null, y: null });
const TRANSPARENT = 'rgba(0,0,0,0)';
const DEFAULT_BAR_WIDTH = 6;

// ── TrendLine: a segment between two {time, price} points ────────────────────────────
const TREND_DEFAULTS = Object.freeze({
  lineColor: '#eab308', width: 1.5, showLabels: false,
  labelBackgroundColor: 'rgba(6,11,20,0.85)', labelTextColor: '#c0d0e8', font: '10px ui-monospace, monospace',
});

class TrendLineRenderer {
  constructor(p1, p2, text1, text2, options) {
    this._p1 = p1; this._p2 = p2; this._text1 = text1; this._text2 = text2; this._options = options;
  }
  draw(target) {
    target.useBitmapCoordinateSpace((scope) => {
      const { _p1: p1, _p2: p2 } = this;
      if (p1.x === null || p1.y === null || p2.x === null || p2.y === null) return;
      const ctx = scope.context;
      const x1 = Math.round(p1.x * scope.horizontalPixelRatio), y1 = Math.round(p1.y * scope.verticalPixelRatio);
      const x2 = Math.round(p2.x * scope.horizontalPixelRatio), y2 = Math.round(p2.y * scope.verticalPixelRatio);
      ctx.lineWidth = this._options.width * scope.horizontalPixelRatio;
      ctx.strokeStyle = this._options.lineColor;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (this._options.showLabels) {
        this._drawTextLabel(scope, this._text1, x1, y1, true);
        this._drawTextLabel(scope, this._text2, x2, y2, false);
      }
    });
  }
  _drawTextLabel(scope, text, x, y, left) {
    const ctx = scope.context;
    ctx.font = this._options.font;
    const offset = 4 * scope.horizontalPixelRatio;
    const textWidth = ctx.measureText(text).width;
    const leftAdjustment = left ? textWidth + offset * 4 : 0;
    const boxH = 12 * scope.verticalPixelRatio;
    ctx.fillStyle = this._options.labelBackgroundColor;
    ctx.beginPath(); ctx.rect(x + offset - leftAdjustment, y - boxH, textWidth + offset * 2, boxH + offset); ctx.fill();
    ctx.fillStyle = this._options.labelTextColor;
    ctx.fillText(text, x + offset * 2 - leftAdjustment, y);
  }
}

class TrendLinePaneView {
  constructor(source) { this._source = source; this._p1 = NO_POINT; this._p2 = NO_POINT; }
  update() {
    const { _series: series, _chart: chart, _p1: p1, _p2: p2 } = this._source;
    if (!series || !chart) { this._p1 = NO_POINT; this._p2 = NO_POINT; return; }
    const ts = chart.timeScale();
    this._p1 = { x: ts.timeToCoordinate(p1.time), y: series.priceToCoordinate(p1.price) };
    this._p2 = { x: ts.timeToCoordinate(p2.time), y: series.priceToCoordinate(p2.price) };
  }
  renderer() {
    return new TrendLineRenderer(this._p1, this._p2, this._source._p1.price.toFixed(2), this._source._p2.price.toFixed(2), this._source._options);
  }
}

export class TrendLine {
  constructor(p1, p2, options = {}) {
    this._p1 = p1; this._p2 = p2;
    this._minPrice = Math.min(p1.price, p2.price); this._maxPrice = Math.max(p1.price, p2.price);
    this._options = { ...TREND_DEFAULTS, ...options };
    this._paneViews = [new TrendLinePaneView(this)];
    this._chart = null; this._series = null;
  }
  attached({ chart, series }) { this._chart = chart; this._series = series; }
  detached() { this._chart = null; this._series = null; }
  updateAllViews() { this._paneViews.forEach((v) => v.update()); }
  paneViews() { return this._paneViews; }
  autoscaleInfo(startTimePoint, endTimePoint) {
    const i1 = this._pointIndex(this._p1), i2 = this._pointIndex(this._p2);
    if (i1 === null || i2 === null) return null;
    if (endTimePoint < i1 || startTimePoint > i2) return null;
    return { priceRange: { minValue: this._minPrice, maxValue: this._maxPrice } };
  }
  _pointIndex(p) {
    if (!this._chart) return null;
    const ts = this._chart.timeScale();
    const coordinate = ts.timeToCoordinate(p.time);
    return coordinate === null ? null : ts.coordinateToLogical(coordinate);
  }
}

// ── AnchoredText: a corner label that does not scroll with the data ──────────────────
const TEXT_DEFAULTS = Object.freeze({
  vertAlign: 'bottom', horzAlign: 'left', text: '', lineHeight: 12,
  font: '10px ui-monospace, monospace', color: '#94a3b8',
});
const TEXT_HORZ_MARGIN = 8;
const TEXT_VERT_MARGIN = 6;

class AnchoredTextRenderer {
  constructor(data) { this._data = data; }
  draw(target) {
    target.useMediaCoordinateSpace((scope) => {
      const ctx = scope.context;
      const d = this._data;
      ctx.font = d.font;
      const textWidth = ctx.measureText(d.text).width;
      const { width, height } = scope.mediaSize;
      const x = d.horzAlign === 'right' ? width - TEXT_HORZ_MARGIN - textWidth
        : d.horzAlign === 'middle' ? width / 2 - textWidth / 2 : TEXT_HORZ_MARGIN;
      const y = d.vertAlign === 'middle' ? height / 2 + d.lineHeight / 2
        : d.vertAlign === 'bottom' ? height - TEXT_VERT_MARGIN : TEXT_VERT_MARGIN + d.lineHeight;
      ctx.fillStyle = d.color;
      ctx.fillText(d.text, x, y);
    });
  }
}

class AnchoredTextPaneView {
  constructor(source) { this._source = source; }
  update() { /* nothing scale-dependent */ }
  renderer() { return new AnchoredTextRenderer(this._source._data); }
}

export class AnchoredText {
  constructor(options = {}) {
    this._data = { ...TEXT_DEFAULTS, ...options };
    this._paneViews = [new AnchoredTextPaneView(this)];
    this._requestUpdate = null;
  }
  attached({ requestUpdate }) { this._requestUpdate = requestUpdate; }
  detached() { this._requestUpdate = null; }
  updateAllViews() { this._paneViews.forEach((v) => v.update()); }
  paneViews() { return this._paneViews; }
  applyOptions(options) {
    this._data = { ...this._data, ...options };
    if (this._requestUpdate) this._requestUpdate();
  }
}

// ── SessionHighlighting: a translucent band behind chosen bars ───────────────────────
// Takes the bands up front ([{time, color}] for EVERY bar, transparent where nothing is
// highlighted) instead of re-reading series.data() on each change — the engine already
// has the shaped candles, and the bar width falls out of the first two consecutive bars.
class SessionHighlightingRenderer {
  constructor(viewData) { this._viewData = viewData; }
  draw(target) {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const height = scope.bitmapSize.height;
      const halfWidth = (scope.horizontalPixelRatio * this._viewData.barWidth) / 2;
      const cutOff = -1 * (halfWidth + 1);
      const maxX = scope.bitmapSize.width;
      for (const point of this._viewData.data) {
        if (point.color === TRANSPARENT) continue;
        const xScaled = point.x * scope.horizontalPixelRatio;
        if (xScaled < cutOff) continue;
        ctx.fillStyle = point.color || TRANSPARENT;
        const x1 = Math.max(0, Math.round(xScaled - halfWidth));
        const x2 = Math.min(maxX, Math.round(xScaled + halfWidth));
        ctx.fillRect(x1, 0, x2 - x1, height);
      }
    });
  }
}

class SessionHighlightingPaneView {
  constructor(source) { this._source = source; this._data = { data: [], barWidth: DEFAULT_BAR_WIDTH }; }
  update() {
    const chart = this._source._chart;
    if (!chart) { this._data = { data: [], barWidth: DEFAULT_BAR_WIDTH }; return; }
    const ts = chart.timeScale();
    const data = this._source._bands.map((b) => ({ x: ts.timeToCoordinate(b.time) ?? -100, color: b.color }));
    const barWidth = data.length > 1 && data[1].x > data[0].x ? data[1].x - data[0].x : ts.options().barSpacing || DEFAULT_BAR_WIDTH;
    this._data = { data, barWidth };
  }
  renderer() { return new SessionHighlightingRenderer(this._data); }
  zOrder() { return 'bottom'; }
}

export class SessionHighlighting {
  constructor(bands = []) {
    this._bands = Array.isArray(bands) ? bands : [];
    this._paneViews = [new SessionHighlightingPaneView(this)];
    this._chart = null;
  }
  attached({ chart }) { this._chart = chart; }
  detached() { this._chart = null; }
  updateAllViews() { this._paneViews.forEach((v) => v.update()); }
  paneViews() { return this._paneViews; }
}
