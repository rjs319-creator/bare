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

const { dayMetrics, orbLevels, atr } = require('./daytrade');

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
// GAP-CAUSE tagging (research/27-gapcause + ALPHA-RESEARCH-2026-07 "Round 2"). A recent-
// window PILOT found the gap edge DE-LUMPS by cause: offering/dilution gaps and M&A
// (buyout target-pop) FADE (21d cont -0.42% / -5.69%) while FDA/guidance/contract
// CONTINUE (+5.00% vs +3.58% baseline). NOT confirmed (single risk-on regime, 32% news
// coverage, tiny n) — so we log cause FORWARD to accrue >=150/class before trusting it,
// and the skip is OPT-IN (default off). Pure: news rows in → cause tag out (route fetches).
const GAP_CAUSE_RX = {
  FADE_OFFERING: /offering|dilut|priced at|prices \$|registered direct|at-the-market|\bATM\b|convertible|\bshelf\b|secondary offering|public offering|private placement|\bwarrant|pricing of/i,
  MA: /acqui|merger|to be acquired|buyout|takeover|to acquire|agrees? to buy|going private/i,
  FDA: /\bFDA\b|approval|approved|clearance|phase [123]|clinical|topline|breakthrough|orphan|PDUFA|trial (met|data|results)/i,
  CONTRACT: /contract|awarded|\baward\b|partnership|collaborat|\bagreement\b|selected by|order worth|wins |secures |deal with/i,
  GUIDE: /raises? guidance|raised guidance|\bbeats?\b|tops estimates|record (revenue|quarter|results)|upgrade|initiat.*buy|price target rais/i,
};
// Causes that FADE (don't continue) → the opt-in skip targets these.
const GAP_CAUSE_FADE = new Set(['FADE_OFFERING', 'MA']);

// Classify a gap's cause from news rows [{title, ...}]. Matches on HEADLINES only —
// article bodies carry aggregated boilerplate ("...priced its offering..." market
// recaps) that false-flags unrelated names, especially for heavily-covered large-caps.
// Priority: dilution first (dominates + is the clearest FADE), then M&A, then the
// continue-catalysts. 'NONE' = no news (kept, never dropped — ~68% of gaps are
// newsless), 'OTHER' = news present but no category matched.
function classifyGapCause(newsRows) {
  if (!Array.isArray(newsRows) || !newsRows.length) return 'NONE';
  const blob = newsRows.map(r => r.title || '').join(' \n ');
  if (GAP_CAUSE_RX.FADE_OFFERING.test(blob)) return 'FADE_OFFERING';
  if (GAP_CAUSE_RX.MA.test(blob)) return 'MA';
  if (GAP_CAUSE_RX.FDA.test(blob)) return 'FDA';
  if (GAP_CAUSE_RX.CONTRACT.test(blob)) return 'CONTRACT';
  if (GAP_CAUSE_RX.GUIDE.test(blob)) return 'GUIDE';
  return 'OTHER';
}

// TAKE if not risk-off and score >= threshold. Opt-in `skipFadeCauses` also skips
// offering/M&A gaps (the pilot's FADE classes) — default OFF until the forward ledger
// confirms (>=150/class across regimes). Backward-compatible: old 2-arg calls unaffected.
function gapTake(score, regime, opts = {}) {
  if (regime === 'risk-off' || score < TAKE_THRESHOLD) return false;
  if (opts.skipFadeCauses && GAP_CAUSE_FADE.has(opts.cause)) return false;
  return true;
}

// SUGGESTED RISK (% of capital) — fractional Kelly by tier, scaled by the
// continuation score, ZEROED in risk-off (no new longs — the one durable lever).
// 1R = the ORB stop distance, so shares = riskPct% * equity / (entry - stop).
function suggestedRiskPct(tier, score, regime) {
  if (regime === 'risk-off') return 0;
  const st = TIER_STATS[tier]; if (!st) return 0;
  const scoreScale = Math.max(0.35, Math.min(1, (score || 0) / 70));   // stronger signal → up to full fractional
  return +(st.fullKelly * KELLY_FRACTION * scoreScale * 100).toFixed(2);
}

// ── META-LABEL (LR) — FORWARD-TRACKED, NOT A GATE (research/intraday exp11) ─────
// A purged-walk-forward logistic meta-filter on entry-time features was tested head-on
// against the edge (the "does the triple-barrier/meta-labeling upgrade help?" question).
// Verdict: NO LIFT — rank-IC ~0.007, does not beat ranking by gap size, and raises
// lumpiness. So we DON'T gate on it; we log its probability per pick and split the live
// ledger HIGH vs LOW so the out-of-sample record can falsify it (the standing discipline:
// the live ledger is the only real OOS). META_MODEL is the final serve model exported by
// `python experiments/11_metalabel.py export`; metaProbFromVector is pinned to it by
// test/gapgo.test.js so JS and the study can never silently drift.
const META_MODEL = {"features":["gap","atr_pct","log_adv","prior_ret","gap_to_atr","reg_norm","dow","rel_vol"],"mean":[0.067878,0.100338,8.432739,0.013277,0.82057,0.539533,1.852,1.241403],"std":[0.043578,0.054856,1.292306,0.08133,0.777901,0.410179,1.308726,0.871517],"coef":[0.00387,0.008754,-0.09337,-0.231733,-0.060042,0.072523,0.129637,-0.03423],"intercept":-0.003728,"median_prob":0.498998};

// Weekday with Monday=0 (matches Python datetime.weekday()) from a 'YYYY-MM-DD' string.
function metaDow(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;   // Sun=0..Sat=6 → Mon=0..Sun=6
}

// Entry-time features for the meta-label, computed to EXACTLY match the rig (exp11): all
// from daily candles with the gap day as the LAST candle. reg_norm is added by the caller
// (the route knows the regime). Returns null if history is insufficient.
function gapMetaFeatures(candles) {
  const n = candles.length;
  if (n < 22) return null;
  const gapDay = candles[n - 1], prev = candles[n - 2];
  if (!(prev.close > 0) || !(prev.open > 0) || !(gapDay.open > 0)) return null;
  const gap = gapDay.open / prev.close - 1;
  const atrPct = atr(candles.slice(0, n - 1)) / prev.close;   // ATR over history EXCL. the gap day
  if (!(atrPct > 0)) return null;
  let advSum = 0, volSum = 0;                                 // 20 sessions BEFORE the gap day
  for (let k = n - 21; k < n - 1; k++) { advSum += candles[k].close * candles[k].volume; volSum += candles[k].volume; }
  const adv = advSum / 20, avgVol = volSum / 20;
  if (!(adv > 0) || !(avgVol > 0)) return null;
  return {
    gap: +gap.toFixed(5),
    atr_pct: +atrPct.toFixed(5),
    log_adv: +Math.log10(adv).toFixed(4),
    prior_ret: +(prev.close / prev.open - 1).toFixed(5),
    gap_to_atr: +(gap / atrPct).toFixed(4),
    reg_norm: null,                                           // filled by metaProb(regime)
    dow: metaDow(gapDay.date),
    rel_vol: +(prev.volume / avgVol).toFixed(4),
  };
}

function metaRegimeNorm(regime) { return regime === 'risk-on' ? 1 : regime === 'risk-off' ? 0 : 0.55; }

// Standardize → linear → sigmoid. `feat` must carry every META_MODEL.features key (incl.
// reg_norm). This is the exact sklearn LogisticRegression forward pass — pinned by tests.
function metaProbFromVector(feat) {
  let z = META_MODEL.intercept;
  META_MODEL.features.forEach((f, k) => { z += META_MODEL.coef[k] * ((feat[f] - META_MODEL.mean[k]) / META_MODEL.std[k]); });
  return 1 / (1 + Math.exp(-z));
}

// Live meta-probability for a pick: complete the candle-only features with the regime, run
// the model. Returns null if features couldn't be built. NB reg_norm's SOURCE differs
// slightly (rig=IWM tape, live=macro VIX/credit) — immaterial: coef≈0.07 on a ~zero-IC model.
function metaProb(candleFeat, regime) {
  if (!candleFeat) return null;
  return +metaProbFromVector({ ...candleFeat, reg_norm: metaRegimeNorm(regime) }).toFixed(4);
}

// HIGH if at/above the training-set median probability, else LOW (the falsifiable class split).
function metaTier(prob) { return prob == null ? null : (prob >= META_MODEL.median_prob ? 'HIGH' : 'LOW'); }

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
    metaFeat: gapMetaFeatures(candles),   // candle-only features; route adds regime → metaProb
  };
}

module.exports = {
  scoreGapGo, GAP_STRONG, GAP_MODERATE, MIN_DOLLAR_VOL,
  continuationScore, gapTake, suggestedRiskPct, TIER_STATS, KELLY_FRACTION, TAKE_THRESHOLD,
  classifyGapCause, GAP_CAUSE_FADE,
  META_MODEL, gapMetaFeatures, metaProbFromVector, metaProb, metaTier,
};
