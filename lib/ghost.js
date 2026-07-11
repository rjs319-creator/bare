// Ghost Accumulation Index (GAI) v3 — the 6-pillar, regime-adaptive scorer that
// looks for QUIET institutional accumulation rather than confirmed breakouts.
//
// This is the server source of truth. Unlike the Apex model (which is duplicated
// client-side for live weight-tuning), Ghost is computed ONCE here inside
// api/screener.js and the result (c.ghost) is shipped to the client, which only
// renders it. No duplicated scorer → no drift hazard.
//
// The pasted AdaptiveEngine (Phase 2) imports `runGhostAccumulationIndex` and
// `REGIME_WEIGHTS` from this file; the signature and return shape below are what
// that engine expects (res.longs[].{symbol,score,strongPillars,pillars,tier,side},
// res.regime, res.killSwitch).
//
// Operates on a screener candidate object (an item of /api/screener `results`):
//   c.pct          = { rs, mom, trend, volAdj, base, vol, prox, accum, ud }  // 0-100 percentiles
//   c.fundamentals = { revGrowth, epsGrowth, revAccel, epsAccel, earningsInDays, ... }
//   c.narrativeStrength                                                       // 1-10 or null
//   c.insider      = { buys:{value,insiders,tx}, sells:{...}, net:{value,shares} } // or null
//   c.status       = 'Breakout' | 'Setup' | 'Early'

const PILLARS = ['RM', 'AF', 'AV', 'SF', 'BONUS', 'IN'];

// Per-regime pillar weights (0-1, sum ≈ 1). Design intent, documented for review:
//   RM  Relative-strength (Mansfield)  — leads; momentum is the one validated factor (~0.10 IC)
//   AF  Accumulation Footprint         — accumRatio, up-days-on-volume (~0.075 IC)
//   AV  Accumulation Vacuum            — supply dry-up / tight coil. DELIBERATELY STARVED:
//                                        prior research found base/VCP/dry-up edge ≈ 0. Kept so
//                                        the adaptive engine can earn it up later if it proves out.
//   SF  Smart-money Flow               — up/down volume + vol-adjusted momentum (~0.071 IC)
//   BONUS Catalyst overlay             — fundamental acceleration + narrative + earnings runway
//   IN  Insider                        — net insider BUYING; the one genuinely new, untested lever.
//                                        Weighted up in risk-off (insiders buying an ugly tape = signal).
// Formula version stamped on every logged GHOST/STALKING pick (see apex.js note).
const SCORING_VERSION = 'ghost-v1';

const REGIME_WEIGHTS = {
  'risk-on':  { RM: 0.24, AF: 0.20, AV: 0.08, SF: 0.20, BONUS: 0.13, IN: 0.15 },
  'neutral':  { RM: 0.22, AF: 0.20, AV: 0.10, SF: 0.18, BONUS: 0.15, IN: 0.15 },
  'risk-off': { RM: 0.18, AF: 0.22, AV: 0.12, SF: 0.16, BONUS: 0.14, IN: 0.18 },
};

const REGIMES = ['risk-on', 'neutral', 'risk-off'];
const PILLAR_LABEL = {
  RM: 'Relative strength', AF: 'Accumulation footprint', AV: 'Accumulation vacuum',
  SF: 'Smart-money flow', BONUS: 'Catalyst overlay', IN: 'Insider buying',
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r0 = x => Math.round(Math.max(0, Math.min(100, x)));

// Normalize the screener's binary regime read into a 3-state GAI regime string.
// Accepts: a string already in REGIME_WEIGHTS, or { bearish, riskOn }, or null.
function ghostRegime(rg) {
  if (typeof rg === 'string' && REGIMES.includes(rg)) return rg;
  if (rg && typeof rg === 'object') {
    if (rg.bearish) return 'risk-off';
    if (rg.riskOn) return 'risk-on';
  }
  return 'neutral';
}

// ── IN pillar: net insider buying → 0-100 (50 = unknown/neutral, never penalized).
// Cluster buys (multiple distinct insiders buying) are the academically robust
// signal, so a positive net with ≥2 buyers gets an extra kicker.
function insiderScore(ins) {
  if (!ins) return 50;
  const buyVal = (ins.buys && ins.buys.value) || 0;
  const sellVal = (ins.sells && ins.sells.value) || 0;
  const gross = buyVal + sellVal;
  if (gross <= 0) return 50;                              // data present but no open-market tx
  const ratio = (buyVal - sellVal) / gross;              // [-1, 1]
  let s = 50 + ratio * 38;
  const buyers = (ins.buys && ins.buys.insiders) || 0;
  if (ratio > 0 && buyers >= 2) s += 8;                  // cluster-buy kicker
  if (ratio > 0 && buyers >= 4) s += 4;
  if (sellVal > 0 && buyVal === 0) s -= 4;               // pure distribution
  return r0(s);
}

// ── BONUS pillar: is there a real driver behind the quiet accumulation?
// Fundamental acceleration (the "A" in CAN SLIM) leads; LLM narrative is an
// overlay; a near-but-not-imminent earnings date is a mild tailwind (catalyst
// ahead). All optional → neutral 50 when nothing is known.
function catalystScore(c) {
  const fd = c.fundamentals || null;
  let fund = null;
  if (fd) {
    let s = 50;
    if (fd.revGrowth != null) s += clamp(fd.revGrowth * 0.5, -18, 22);
    if (fd.epsGrowth != null) s += clamp(fd.epsGrowth * 0.3, -15, 15);
    if (fd.revAccel != null) s += clamp(fd.revAccel * 0.6, -10, 14);    // accelerating sales = the tell
    if (fd.epsAccel != null) s += clamp(fd.epsAccel * 0.3, -8, 10);
    fund = r0(s);
  }
  const narr = c.narrativeStrength != null ? r0((c.narrativeStrength / 10) * 100) : null;
  let base = (fund != null && narr != null) ? Math.round(0.6 * fund + 0.4 * narr)
           : fund != null ? fund
           : narr != null ? narr
           : 50;
  // Mild catalyst-runway bump: earnings 5-45 sessions out (anticipation), not
  // tomorrow (event risk) and not far away (no near catalyst).
  const ed = fd && fd.earningsInDays;
  if (ed != null && ed >= 5 && ed <= 45) base = r0(base + 4);
  return base;
}

// Map a candidate's percentiles + fundamentals + insider data onto the six
// pillars (0-100 each). Mirrors lib/apex.js `pillarsOf` in spirit.
function pillarsOf(c) {
  const q = c.pct || {};
  // RM — relative strength (Mansfield): RS line + trend template.
  const RM = r0(0.6 * (q.rs || 0) + 0.4 * (q.trend || 0));
  // AF — accumulation footprint: accumulation/distribution ratio (up-days-on-volume).
  const AF = r0(q.accum != null ? q.accum : (q.vol || 0));
  // SF — smart-money flow: up/down volume + vol-adjusted momentum (institutional participation).
  const SF = r0(0.55 * (q.ud || 0) + 0.45 * (q.volAdj || 0));
  // AV — accumulation vacuum: tight base + coiled near pivot + QUIET (low vol surge).
  //      A supply vacuum shows as a tight, high-quality base sitting just under a
  //      pivot on drying volume. (Edge ≈ 0 in prior research; weighted low on purpose.)
  const AV = r0((q.base || 0) * 0.4 + (q.prox || 0) * 0.3 + (100 - (q.vol || 50)) * 0.3);
  const BONUS = catalystScore(c);
  const IN = insiderScore(c.insider);
  return { RM, AF, AV, SF, BONUS, IN };
}

function composite(pl, weights) {
  const t = PILLARS.reduce((s, k) => s + (weights[k] || 0), 0) || 1;
  let s = 0;
  for (const k of PILLARS) s += (pl[k] || 0) * (weights[k] || 0);
  return Math.round(s / t);
}

// A pillar is "strong" at ≥65th percentile. GHOST needs broad confirmation
// (≥3 strong pillars), not one spiking factor.
function strongCount(pl) {
  return PILLARS.reduce((n, k) => n + (pl[k] >= 65 ? 1 : 0), 0);
}

// Base tiers from fixed thresholds (the AdaptiveEngine re-tiers later with its
// own adaptive thresholds; these are the v3 defaults it falls back to).
function tierOf(score, strong) {
  if (score >= 80 && strong >= 3) return 'GHOST';
  if (score >= 65 && strong >= 2) return 'STALKING';
  if (score >= 50) return 'WATCH';
  return 'PASS';
}

// Score one candidate → { pillars, score, strongPillars, tier }.
// `weights` overrides the regime preset (used by the adaptive engine's shadows).
// `killSwitch` (or a risk-off regime) downgrades every tier one notch.
function scoreGhost(c, regime, weights, killSwitch = false) {
  const rg = ghostRegime(regime);
  const w = weights || REGIME_WEIGHTS[rg] || REGIME_WEIGHTS.neutral;
  const pillars = pillarsOf(c);
  const score = composite(pillars, w);
  const strongPillars = strongCount(pillars);
  let tier = tierOf(score, strongPillars);
  if (killSwitch || rg === 'risk-off') {
    tier = tier === 'GHOST' ? 'STALKING' : tier === 'STALKING' ? 'WATCH' : 'PASS';
  }
  return { pillars, score, strongPillars, tier };
}

// Engine entry point. `universe` is an array of screener candidate objects.
// opts: { overrideWeights?, killSwitch?, minTier? }. Returns the shape the
// pasted AdaptiveEngine consumes.
function runGhostAccumulationIndex(universe, regime, opts = {}) {
  const rg = ghostRegime(regime ?? opts.regime ?? null);
  const weightsByRegime = opts.overrideWeights || REGIME_WEIGHTS;
  const w = weightsByRegime[rg] || REGIME_WEIGHTS[rg] || REGIME_WEIGHTS.neutral;
  const killSwitch = opts.killSwitch ?? false;
  const longs = (universe || []).map(c => {
    const g = scoreGhost(c, rg, w, killSwitch);
    return {
      symbol: c.ticker || c.symbol,
      side: 'long',
      score: g.score,
      strongPillars: g.strongPillars,
      pillars: g.pillars,
      tier: g.tier,
      company: c.company, sector: c.sector, price: c.price,
    };
  }).sort((a, b) => b.score - a.score);
  return { regime: rg, killSwitch, longs, shorts: [] };
}

module.exports = {
  REGIME_WEIGHTS, PILLARS, PILLAR_LABEL, REGIMES, SCORING_VERSION,
  ghostRegime, pillarsOf, composite, strongCount, tierOf,
  insiderScore, catalystScore, scoreGhost, runGhostAccumulationIndex,
};
