// DOWN-DAY MODE — pure logic for routing each name to the play that actually fits
// a red / risk-off tape, plus the honest "what a down day really gives you" stats.
// No network, no state (like lib/gapgo.js) so the route handler and the tests share
// one source of truth.
//
// WHY THIS EXISTS (and what the research says — see research/42,43, 2y PIT, entry at
// the TRADEABLE next-day open, excess vs SPY):
//   • Momentum-continuation LONGS do NOT work on down days. Names holding up green
//     while SPY bleeds win only ~50% at the next open and MEAN-REVERT DOWN over 2-3
//     sessions (the "leaders" decile is the WORST forward decile). So Down-Day Mode
//     deliberately has NO "buy the leaders" lane — that's the trap it protects
//     against.
//   • What DOES pay on a red tape is REVERSION: a capitulation → turn (V-Reversal)
//     earns +0.3-0.8%/3d excess ON RED DAYS but is flat/negative on normal days —
//     an edge that only exists when the whole market puked. Counter-intuitively the
//     EARLIER/less-confirmed the turn, the better the red-day bounce (catch it
//     early; a "CONFIRMED" reversal is already spent).
//   • The mirror pattern (blow-off top rolling over) is the short-side complement.
// The router therefore classifies each name into its single best-fit bucket and
// leads with honest expectations, not false long setups.

const { analyzeVReversal, analyzeInvertedV } = require('./vreversal');

// ── liquidity gate (matches the research floors) ──
const PRICE_FLOOR = 5, DVOL_FLOOR = 25e6;
function liquidity(candles) {
  const n = candles.length; if (n < 21) return null;
  const px = candles[n - 1].close;
  if (!(px >= PRICE_FLOOR)) return null;
  let dv = 0; for (let k = n - 20; k < n; k++) dv += candles[k].close * candles[k].volume;
  const dollarVol = dv / 20;
  if (!(dollarVol >= DVOL_FLOOR)) return null;
  return { price: +px.toFixed(2), dollarVol: Math.round(dollarVol) };
}

// ── the honest reality panel (constants sourced from the two backtests) ──
// Rounded conservatively; provenance kept so the UI can cite it and it never drifts
// into false precision.
const DOWNDAY_REALITY = {
  // red-day momentum "leaders" (green + above 50/200 + RS>0), next-open entry:
  leaderWinPct: 50,          // ~coin flip
  leaderExcessH1: 0.04,      // %/1d ≈ 0; NEGATIVE at h2/h3 → they give it back
  leaderVerdict: 'mean-revert down',
  // V-Reversal bounce ON red days (next-open, h=3, excess vs SPY):
  bounceEmergingExcessH3: 0.34, bounceEmergingWinPct: 52,
  bounceWatchExcessH3: 0.76, bounceWatchWinPct: 56,
  bounceNormalDayExcessH3: -0.06,   // NEGATIVE off red days → the edge is red-tape-specific
  source: 'research/42-43 · 2y point-in-time · entry at next-day open · excess vs SPY',
};

// ── is today a down / risk-off tape? ──
// spyChangePct = SPY latest close vs prior close (updates through the session on the
// partial daily bar). regime from lib/macro. severity drives how loud the UI gets.
const RED_LIGHT = -0.4, RED_MODERATE = -0.9, RED_HEAVY = -1.8;   // % SPY same-day
function tapeState(spyChangePct, regime) {
  const chg = Number.isFinite(spyChangePct) ? spyChangePct : 0;
  const macroOff = regime === 'risk-off';
  const down = chg <= RED_LIGHT || macroOff;
  let severity = 'calm';
  if (chg <= RED_HEAVY) severity = 'heavy';
  else if (chg <= RED_MODERATE) severity = 'moderate';
  else if (chg <= RED_LIGHT) severity = 'light';
  else if (macroOff) severity = 'light';
  const reason = macroOff && chg > RED_LIGHT
    ? 'macro risk-off (VIX / credit stress) even though SPY is flat'
    : chg <= RED_LIGHT ? `SPY ${chg.toFixed(1)}% on the day` : 'tape is not red';
  return { down, severity, spyChangePct: +chg.toFixed(2), regime: regime || 'unknown', reason };
}

// ── per-name best-fit classifier ──
// Returns the ONE play that fits, or null. Bounce (long) is checked first; if the
// name isn't an oversold turn we check the mirror (blow-off top → short). Most names
// on a red day match neither — that's correct (the honest answer is usually "sit out").
//
// TRADEABILITY GATES. The raw V-detectors fire broadly — including stale "CONFIRMED"
// reversals that already rallied to their target (tiny reward left) and multi-week
// setups with impractically wide structural stops. The backtest says the edge lives
// in EARLY turns with room to run, so we require: real reward left (R:R floor), a
// stop a day-trader can actually take (risk % cap), and a turn caught EARLY (recovery
// not already extended). These structurally implement "earlier turns bounce more".
const MIN_RR = 1.2;         // measured-move reward must beat risk
const MAX_RISK_PCT = 20;    // structural stop within 20% — anything wider isn't tradeable
const MAX_RALLY_PCT = 18;   // bounce already run >18% off the low = late, edge is spent
const MAX_DROP_OFF_HIGH_PCT = 18;   // short: already fallen >18% off the peak = late

// downScore RE-RANKS against the raw engine score on purpose: the engine rewards
// confirmations (which favors late "CONFIRMED" turns), but the backtest says early,
// DEEP turns with room to run bounce more on red days. downScore rewards capitulation
// depth + oversold + freshness + R:R + a WATCH/EMERGING tilt, so a fresh EMERGING turn
// outranks a stale CONFIRMED one. Shorts keep the engine score (shorting an UNconfirmed
// top is the dangerous side, so confirmations SHOULD rank higher there).
function bounceTilt(tier) { return tier === 'WATCH' ? 15 : tier === 'EMERGING' ? 12 : 6; }
function bounceDownScore(v) {
  const g = v.geometry, rr = v.signals.rr || 0;
  const depth = Math.min(g.dropPct / 40, 1) * 22;
  const oversold = Math.max(0, (35 - Math.min(g.rsiAtPivot, 35)) / 35) * 16;
  const fresh = Math.max(0, (MAX_RALLY_PCT - Math.min(g.rallyOffLowPct, MAX_RALLY_PCT)) / MAX_RALLY_PCT) * 20;
  const rrBonus = Math.min(rr, 3) / 3 * 15;
  const conf = (v.confirmations.length / 4) * 10;
  return Math.round(Math.max(0, Math.min(100, depth + oversold + fresh + rrBonus + conf + bounceTilt(v.tier))));
}

function classify(candles, opts = {}) {
  const liq = liquidity(candles);
  if (!liq) return null;

  const v = analyzeVReversal(candles, opts.vrev || {});
  if (v && !v.signals.expired && v.signals.rr >= MIN_RR
    && v.signals.riskPct <= MAX_RISK_PCT && v.geometry.rallyOffLowPct <= MAX_RALLY_PCT) {
    return {
      bucket: 'bounce', side: 'long', label: 'Oversold Bounce',
      tier: v.tier, score: v.score, downScore: bounceDownScore(v),
      price: liq.price, dollarVol: liq.dollarVol,
      geometry: v.geometry, confirmations: v.confirmations, signals: v.signals,
    };
  }

  const iv = analyzeInvertedV(candles, opts.ivrev || {});
  if (iv && !iv.signals.expired && iv.signals.rr >= MIN_RR
    && iv.signals.riskPct <= MAX_RISK_PCT && iv.geometry.dropOffHighPct <= MAX_DROP_OFF_HIGH_PCT) {
    return {
      bucket: 'fade', side: 'short', label: 'Overheated / Rollover',
      tier: iv.tier, score: iv.score, downScore: iv.score,
      price: liq.price, dollarVol: liq.dollarVol,
      geometry: iv.geometry, confirmations: iv.confirmations, signals: iv.signals,
    };
  }
  return null;
}

module.exports = {
  classify, tapeState, liquidity, bounceTilt, bounceDownScore,
  DOWNDAY_REALITY, PRICE_FLOOR, DVOL_FLOOR, RED_LIGHT, RED_MODERATE, RED_HEAVY,
  MIN_RR, MAX_RISK_PCT, MAX_RALLY_PCT, MAX_DROP_OFF_HIGH_PCT,
};
