// GAP-AND-GO — unscheduled catalyst gap-up continuation screener (SSOT engine).
//
// VALIDATED EVENT EDGE (research/intraday exp07/08/09, 2026-07-01). An overnight gap-up
// >= 5% that is NOT an earnings reaction, on a liquid name, followed by an opening-range-
// breakout entry (2.5x ATR stop, 1:2 target, <= 3-session hold), showed a clean monotone
// dose-response (1-2% gap NULL negative → 5% gap +1.89%/trade, PF 1.47, positive in all 4
// years, OOS = in-sample) and SURVIVED deflation (Deflated Sharpe 0.99, a pre-registered
// 4-threshold trial set — not a 24-variant sweep). It is the first deflation-surviving
// edge in the whole multi-session investigation.
//
// KEY INVERSION vs the naive "trade earnings catalysts" idea: EARNINGS gaps do NOT
// continue (a one-time repricing to a new equilibrium + IV-crush chop — earnings gap-ups
// underperformed non-earnings gap-ups in every bucket, PF 1.12 vs 2.57 at >=5%). So the
// tradeable event is the UNSCHEDULED catalyst gap, and earnings days are FILTERED OUT.
//
// HONEST CAVEATS (surfaced in the UI): tilts to high-beta gappers (liquid-only half went
// OOS-flat), lumpy right-skewed P&L (a handful of runners carry it), one 3.5y regime
// cycle → a strong lead to forward-track, not a license to size up blind.
//
// Pure: candles in → signal out. Reuses daytrade.dayMetrics (gapPct + liquidity) and
// daytrade.orbLevels (the validated ORB plan). Network/state (skip-earnings, ledger) live
// in the route, never here.

const { dayMetrics, orbLevels } = require('./daytrade');

const GAP_STRONG = 5.0;              // validated PRIMARY threshold (exp08 gap5, DSR 0.99)
const GAP_MODERATE = 3.0;           // secondary tier — positive but weaker (exp08 gap3)
const MIN_DOLLAR_VOL = 10_000_000;  // tradeable liquidity floor (the research ADV floor)

// ── Meta-label + position sizing (research/ALPHA-RESEARCH-2026-07) ──────────────
// Backtested survivorship-CORRECTED (4217 survivor+delisted names, daily-bar ORB,
// 19,326 non-earnings gap events, 2021-2026). Tier base stats (realized R-multiples
// of the 2.5xATR / 1:2 ORB trade): STRONG >=5% win .498 / payoff 1.30 / PF 1.29 /
// full-Kelly .112; MODERATE 3-5% win .487 / payoff 1.21 / full-Kelly .063.
const TIER_STATS = {
  STRONG:   { winRate: 0.498, payoff: 1.30, fullKelly: 0.112 },
  MODERATE: { winRate: 0.487, payoff: 1.21, fullKelly: 0.063 },
};
const KELLY_FRACTION = 0.25;        // fractional Kelly — robust to edge overestimation (half-edge safe)
const TAKE_THRESHOLD = 45;          // continuationScore >= this AND not risk-off ⇒ TAKE

// CONTINUATION SCORE (0-100) — the validated take/skip meta-label. Directions from
// the event backtest: gap size (dose-response) +, relVol (volume confirmation) +,
// regime with risk-off net-NEGATIVE (a hard down-gate). Ranking by this score,
// top-third beat bottom-third in 6/6 years OOS (+0.061R vs -0.011R, ~2x base). It
// ranks/skips a right-skewed edge; it does NOT raise the ~50% hit rate. Pure:
// regime is passed in (the route knows it), so this stays testable + engine-clean.
function continuationScore(gapPct, relVol, regime) {
  const gapN = Math.max(0, Math.min(1, ((gapPct || 0) - GAP_MODERATE) / 12));   // 3%→0, 15%→1
  const rvN  = Math.max(0, Math.min(1, ((relVol || 1) - 1) / 5));               // 1x→0, 6x→1
  const regN = regime === 'risk-on' ? 1 : regime === 'risk-off' ? 0 : 0.55;     // off is the leak
  return Math.round(100 * (0.42 * gapN + 0.28 * rvN + 0.30 * regN));
}
function gapTake(score, regime) { return regime !== 'risk-off' && score >= TAKE_THRESHOLD; }

// SUGGESTED RISK (% of capital) — fractional Kelly by tier, scaled by the
// continuation score, ZEROED in risk-off (no new longs — the one durable lever).
// 1R = the ORB stop distance, so shares = riskPct% * equity / (entry - stop).
function suggestedRiskPct(tier, score, regime) {
  if (regime === 'risk-off') return 0;
  const st = TIER_STATS[tier]; if (!st) return 0;
  const scoreScale = Math.max(0.35, Math.min(1, (score || 0) / 70));   // stronger signal → up to full fractional
  return +(st.fullKelly * KELLY_FRACTION * scoreScale * 100).toFixed(2);
}

// Score one name's daily candles into a gap-and-go signal, or null if it doesn't qualify.
// `spyByDate` optional (only for the excess-vs-market context line). Does NOT apply the
// skip-earnings filter — that needs a network lookup and is applied in the route.
function scoreGapGo(candles, spyByDate) {
  const m = dayMetrics(candles, spyByDate);
  if (!m || m.gapPct == null) return null;
  if (m.gapPct < GAP_MODERATE) return null;          // below the weakest tradeable tier
  if (m.avgDollarVol < MIN_DOLLAR_VOL) return null;  // not tradeable
  const plan = orbLevels(candles);                   // 2.5xATR stop, 1:2 target, ORB trigger
  if (!plan) return null;
  return {
    last: m.last, gapPct: m.gapPct, relVol: m.relVol, pctChange: m.pctChange,
    excessPct: m.excessPct, avgDollarVol: m.avgDollarVol, avgVol: m.avgVol,
    tier: m.gapPct >= GAP_STRONG ? 'STRONG' : 'MODERATE',
    plan,
  };
}

module.exports = {
  scoreGapGo, GAP_STRONG, GAP_MODERATE, MIN_DOLLAR_VOL,
  continuationScore, gapTake, suggestedRiskPct, TIER_STATS, KELLY_FRACTION, TAKE_THRESHOLD,
};
