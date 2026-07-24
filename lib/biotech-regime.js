'use strict';
// 🧬 BIOTECH REGIME (Phase 5) — a biotech-specific regime read, not the broad macro tape.
//
// Small-cap biotech momentum only pays when the group itself is healthy, so the regime that
// gates a biotech swing is XBI's own trend and structure — its 20/50-day slope and where it
// sits relative to them — NOT the S&P risk-on/off signal alone. Pure over XBI candles; when
// XBI is missing we return UNKNOWN with a data-quality flag rather than assuming risk-on.

const { DATA_QUALITY } = require('./biotech-config');

function smaAt(candles, period, endIdx) {
  if (endIdx - period + 1 < 0) return null;
  let s = 0;
  for (let k = endIdx - period + 1; k <= endIdx; k++) s += candles[k].close;
  return s / period;
}

/**
 * @param {Array} xbi ascending XBI daily candles
 * @returns {{regime, xbiAbove20, xbiAbove50, sma20Rising, xbiRet20, dataQuality, note}}
 */
function biotechRegime(xbi) {
  if (!Array.isArray(xbi) || xbi.length < 55) {
    return { regime: 'unknown', xbiAbove20: null, xbiAbove50: null, sma20Rising: null, xbiRet20: null, dataQuality: DATA_QUALITY.MISSING, note: 'XBI history unavailable' };
  }
  const i = xbi.length - 1;
  const last = xbi[i].close;
  const s20 = smaAt(xbi, 20, i), s50 = smaAt(xbi, 50, i), s20Prev = smaAt(xbi, 20, i - 5);
  const above20 = last > s20, above50 = last > s50;
  const rising = s20 != null && s20Prev != null && s20 > s20Prev;
  const base20 = xbi[i - 20] ? xbi[i - 20].close : null;
  const ret20 = base20 > 0 ? (last - base20) / base20 * 100 : null;

  // risk-on: above both rising SMAs; risk-off: below both, 20 falling; neutral otherwise.
  let regime = 'neutral';
  if (above20 && above50 && rising) regime = 'risk-on';
  else if (!above20 && !above50 && !rising) regime = 'risk-off';

  return {
    regime, xbiAbove20: above20, xbiAbove50: above50, sma20Rising: rising,
    xbiRet20: ret20 == null ? null : +ret20.toFixed(2),
    dataQuality: DATA_QUALITY.OK, note: null,
  };
}

module.exports = { biotechRegime };
