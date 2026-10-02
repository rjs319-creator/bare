// PATTERN CHART — candles with the structural overlays that let a user SEE why the engine
// assigned a label: pivots (joined), frozen trigger / invalidation / target, and the
// confirmation bar. Renders through the shared chart-engine (lightweight-charts v5).
//
// Convention change (deliberate, 2026-10-02): this file used to draw on a 2d canvas by
// hand under a "no chart library" rule. That rule is retired — one vendored, Apache-2.0
// engine now draws every chart in the app, so the pattern radar, the card toggles and the
// Session Board agree on candles, scales and level styling instead of three hand-drawn
// variants drifting apart. `drawPatternChart(host, chart, det)` keeps its signature; the
// host is now a block element (a legacy <canvas> is swapped for its parent).
import { mountCandles } from './chart-engine.js';

const MIN_BARS = 5;
const PATTERN_HEIGHT = 260;
const LEVEL_TITLES = Object.freeze({ entry: 'TRIG', stop: 'STOP', target: 'TGT' });
const CONFIRM_CLOSED_THROUGH = 'rgba(16,217,138,0.16)';
const CONFIRM_PENDING = 'rgba(192,208,232,0.12)';

const numOrNull = (v) => (Number.isFinite(v) ? v : null);

// Pure: chart payload ({candles:[{date,o,h,l,c,v}]}) + canonical detection → mount spec.
// Null when there is nothing worth drawing (fewer than MIN_BARS bars).
export function patternChartSpec(chart, det) {
  const candles = chart && Array.isArray(chart.candles) ? chart.candles : [];
  if (candles.length < MIN_BARS) return null;
  const plan = (det && det.plan) || {};
  const conf = det && det.confirmation;
  const highlights = conf && conf.confirmBarDate
    ? [{ date: String(conf.confirmBarDate), color: conf.closedThrough ? CONFIRM_CLOSED_THROUGH : CONFIRM_PENDING }]
    : [];
  return {
    candles,
    height: PATTERN_HEIGHT,
    levels: { entry: numOrNull(plan.trigger), stop: numOrNull(plan.stop), target: numOrNull(plan.target) },
    levelTitles: LEVEL_TITLES,
    pivots: (det && Array.isArray(det.pivotsUsed)) ? det.pivotsUsed : [],
    highlights,
    label: det ? [det.patternLabel, det.direction, det.timeframe].filter(Boolean).join(' ') : '',
  };
}

function resolveHost(host) {
  if (!host) return null;
  if (host.tagName === 'CANVAS') {
    const parent = host.parentElement;
    host.remove();
    return parent;
  }
  return host;
}

// Resolves to the chart handle (or null). Never throws: a failed mount shows an inline error.
export function drawPatternChart(host, chart, det) {
  const el = resolveHost(host);
  if (!el) return Promise.resolve(null);
  const spec = patternChartSpec(chart, det);
  if (!spec) { el.innerHTML = '<div class="chart-err">Not enough bars to draw this pattern.</div>'; return Promise.resolve(null); }
  return mountCandles(el, spec).catch(() => {
    el.innerHTML = '<div class="chart-err">Chart unavailable.</div>';
    return null;
  });
}
