'use strict';
// Shared fixtures for the low-float / intraday-continuation tests.
//
// Bars are built on a FIXED session (2026-08-05, a Wednesday) with explicit UTC instants so
// every test is deterministic across machines and time zones. 13:30Z = 09:30 ET in August.

const SESSION_DATE = '2026-08-05';
const OPEN_UTC_H = 13, OPEN_UTC_M = 30;   // 09:30 ET during EDT

// Build 5-minute bars from [open, high, low, close, volume] tuples, starting at the open.
function bars(spec, { startBarIndex = 0 } = {}) {
  return spec.map((s, i) => ({
    t: new Date(Date.UTC(2026, 7, 5, OPEN_UTC_H, OPEN_UTC_M + 5 * (i + startBarIndex))).toISOString(),
    o: s[0], h: s[1], l: s[2], c: s[3], v: s[4],
  }));
}

// An instant `minutesAfterOpen` into the session.
function at(minutesAfterOpen) {
  return new Date(Date.UTC(2026, 7, 5, OPEN_UTC_H, OPEN_UTC_M + minutesAfterOpen));
}

// ── Canonical shapes ─────────────────────────────────────────────────────────

// A tight consolidation under a level after an early push — the "HELP-like compression"
// archetype. 14 bars so the compression ratio (which needs ≥13) actually computes.
const COMPRESSION_BARS = bars([
  [10.00, 10.45, 9.95, 10.40, 90000],
  [10.40, 10.80, 10.35, 10.75, 85000],
  [10.75, 11.05, 10.70, 11.00, 80000],
  [11.00, 11.20, 10.95, 11.15, 70000],
  [11.15, 11.28, 11.05, 11.22, 60000],
  [11.22, 11.30, 11.14, 11.25, 45000],
  [11.25, 11.31, 11.18, 11.24, 38000],
  [11.24, 11.30, 11.19, 11.26, 32000],
  [11.26, 11.31, 11.21, 11.27, 28000],
  [11.27, 11.30, 11.22, 11.26, 25000],
  [11.26, 11.29, 11.23, 11.27, 22000],
  [11.27, 11.30, 11.24, 11.28, 20000],
  [11.28, 11.30, 11.25, 11.28, 19000],
  [11.28, 11.31, 11.26, 11.29, 18000],
]);

// The same base with a COMPLETED breakout bar that closes only just above the level: on
// volume, in the upper half of its range, and still inside the maximum chase price. This is
// the shape a tradeable breakout actually has.
const CONFIRMED_BREAKOUT_BARS = [...COMPRESSION_BARS, {
  t: new Date(Date.UTC(2026, 7, 5, OPEN_UTC_H, OPEN_UTC_M + 70)).toISOString(),
  o: 11.29, h: 11.42, l: 11.28, c: 11.36, v: 95000,
}];

// The SAME confirmed breakout, but extended far above the trigger — a real breakout that has
// already run away from its entry. Used to prove the anti-chase block fires on a good setup.
const EXTENDED_BREAKOUT_BARS = [...COMPRESSION_BARS, {
  t: new Date(Date.UTC(2026, 7, 5, OPEN_UTC_H, OPEN_UTC_M + 70)).toISOString(),
  o: 11.29, h: 11.85, l: 11.27, c: 11.78, v: 95000,
}];

// The same base where price traded above the level and closed back under it.
const FAILED_BREAKOUT_BARS = [...COMPRESSION_BARS, {
  t: new Date(Date.UTC(2026, 7, 5, OPEN_UTC_H, OPEN_UTC_M + 70)).toISOString(),
  o: 11.29, h: 11.85, l: 11.05, c: 11.10, v: 105000,
}];

// A controlled retest: the breakout bar, then a pullback to the level on lighter volume that
// holds it.
const RETEST_BARS = [...EXTENDED_BREAKOUT_BARS,
  { t: new Date(Date.UTC(2026, 7, 5, OPEN_UTC_H, OPEN_UTC_M + 75)).toISOString(), o: 11.78, h: 11.80, l: 11.40, c: 11.45, v: 40000 },
  { t: new Date(Date.UTC(2026, 7, 5, OPEN_UTC_H, OPEN_UTC_M + 80)).toISOString(), o: 11.45, h: 11.50, l: 11.32, c: 11.40, v: 22000 },
];

// A post-spike collapse — the "JLHL-like" archetype: vertical, then a sustained bleed with
// lower highs and a deep drawdown from the high.
const POST_SPIKE_COLLAPSE_BARS = bars([
  [4.00, 5.20, 3.95, 5.10, 400000],
  [5.10, 6.80, 5.05, 6.70, 900000],
  [6.70, 8.40, 6.60, 8.30, 1400000],
  [8.30, 8.60, 7.60, 7.70, 1200000],
  [7.70, 7.90, 7.00, 7.10, 900000],
  [7.10, 7.30, 6.55, 6.65, 700000],
  [6.65, 6.80, 6.10, 6.20, 600000],
  [6.20, 6.35, 5.80, 5.90, 500000],
  [5.90, 6.00, 5.55, 5.65, 420000],
  [5.65, 5.75, 5.30, 5.40, 380000],
]);

// A parabolic, climaxing move — extreme extension above VWAP with a volume blow-off.
const EXHAUSTION_BARS = bars([
  [4.00, 4.20, 3.95, 4.15, 100000],
  [4.15, 4.60, 4.10, 4.55, 180000],
  [4.55, 5.30, 4.50, 5.25, 320000],
  [5.25, 6.40, 5.20, 6.30, 600000],
  [6.30, 8.20, 6.25, 7.90, 2400000],
]);

// An orderly pullback holding VWAP on contracting volume that has RECOVERED on the final
// completed bar — the shape the VWAP-recovery and retest templates look for.
const VWAP_RECOVERY_BARS = bars([
  [10.00, 10.40, 9.95, 10.35, 120000],
  [10.35, 10.90, 10.30, 10.85, 140000],
  [10.85, 11.40, 10.80, 11.35, 160000],
  [11.35, 11.60, 11.28, 11.55, 130000],
  [11.55, 11.60, 11.30, 11.36, 70000],
  [11.36, 11.42, 11.22, 11.28, 45000],
  [11.28, 11.34, 11.20, 11.26, 34000],
  [11.26, 11.45, 11.24, 11.42, 62000],
]);

// A VWAP pullback that has NOT recovered — still drifting down on the last bar.
const PULLBACK_NO_RECOVERY_BARS = bars([
  [10.00, 10.40, 9.95, 10.35, 120000],
  [10.35, 10.90, 10.30, 10.85, 140000],
  [10.85, 11.40, 10.80, 11.35, 160000],
  [11.35, 11.60, 11.28, 11.55, 130000],
  [11.55, 11.60, 11.30, 11.36, 70000],
  [11.36, 11.40, 11.20, 11.24, 45000],
  [11.24, 11.28, 11.12, 11.14, 38000],
]);

// A generic healthy context for the actionability layer: fresh, liquid, spread observed.
function tradeableCtx(over = {}) {
  return {
    price: 11.36, sessionDollarVolume: 45_000_000, barAgeMinutes: 2,
    floatTier: 'NORMAL', floatConfidence: 'HIGH', floatUsable: true,
    supplyRisk: { dilutionRisk: 'LOW' }, spreadObserved: true, regime: 'neutral',
    currentConfigVersion: require('../lib/lowfloat-config').CONFIG_VERSION,
    flags: { ENABLE_LIVE_VALIDATED_SIGNALS: false, ENABLE_INTRADAY_PAPER_SIGNALS: true },
    ...over,
  };
}

module.exports = {
  SESSION_DATE, bars, at, tradeableCtx,
  COMPRESSION_BARS, CONFIRMED_BREAKOUT_BARS, EXTENDED_BREAKOUT_BARS, FAILED_BREAKOUT_BARS, RETEST_BARS,
  POST_SPIKE_COLLAPSE_BARS, EXHAUSTION_BARS, VWAP_RECOVERY_BARS, PULLBACK_NO_RECOVERY_BARS,
};
