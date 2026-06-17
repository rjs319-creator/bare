// Apex Runner — the 4-pillar, regime-adaptive scoring model (server side).
//
// This is the single source of truth for the model that also runs client-side in
// public/index.html (the Custom Screener tab). The formulas here MUST stay in
// sync with that copy — they are intentionally identical so the live tab and the
// logged signal ledger agree on which names are Apex / Loaded.
//
// Operates on a screener candidate object (an item of /api/screener `results`):
//   c.pct = { rs, mom, trend, volAdj, base, vol, prox }   // 0-100 percentiles
//   c.narrativeStrength                                    // 1-10 or null
//   c.fundamentals = { revGrowth, epsGrowth, ... }         // optional
//   c.status                                               // 'Breakout' | 'Setup' | 'Early'

// Regime-dependent pillar weight presets (Module 1 of the v3 spec).
const PRESETS = {
  RISK_ON:  { p1: 30, p2: 25, p3: 20, p4: 25 },
  NEUTRAL:  { p1: 25, p2: 25, p3: 27, p4: 23 },
  RISK_OFF: { p1: 20, p2: 25, p3: 35, p4: 20 },
};
const RG_LABEL = { RISK_ON: 'Risk-On', NEUTRAL: 'Neutral', RISK_OFF: 'Risk-Off' };
const PILLAR_LABEL = { p1: 'Momentum / RS', p2: 'Technical structure', p3: 'Fundamental acceleration', p4: 'Supply / smart money' };
const KEYS = ['p1', 'p2', 'p3', 'p4'];

// 3-state regime from the screener's binary read (regime: { bearish, riskOn }).
function rawRegime(rg) {
  if (!rg) return 'NEUTRAL';
  if (rg.bearish) return 'RISK_OFF';
  if (rg.riskOn) return 'RISK_ON';
  return 'NEUTRAL';
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Hard-fundamental score (0-100) for Pillar 3, grounded in real numbers: revenue
// & EPS growth, their ACCELERATION (2nd derivative — the "A" in CAN SLIM), margin
// trend (expanding/contracting), and margin level.
function fundamentalScore(fd) {
  let s = 50;
  if (fd.revGrowth != null) s += clamp(fd.revGrowth * 0.8, -25, 28);   // sales growth leads (CAN SLIM)
  if (fd.epsGrowth != null) s += clamp(fd.epsGrowth * 0.4, -20, 20);   // earnings growth (noisier → lighter)
  if (fd.revAccel != null) s += clamp(fd.revAccel * 0.5, -10, 12);     // accelerating sales = strong tailwind
  if (fd.epsAccel != null) s += clamp(fd.epsAccel * 0.25, -8, 8);      // accelerating earnings
  if (fd.marginExpanding === true) s += 10; else if (fd.marginExpanding === false) s -= 5;
  if (fd.netMargin != null) s += clamp(fd.netMargin * 0.4, -10, 8);    // profitability level
  return Math.max(0, Math.min(100, Math.round(s)));
}

// Map a candidate's percentiles + fundamentals onto the four pillars (0-100 each).
function pillarsOf(c) {
  const q = c.pct || {};
  const p1 = Math.round(((q.rs || 0) + (q.mom || 0)) / 2);                     // momentum / relative strength
  const p2 = Math.round(((q.trend || 0) + (q.base || 0) + (q.prox || 0)) / 3); // trend + base + pivot proximity
  // Pillar 4 — supply / smart money. Research showed raw volume-surge has ~zero
  // forward-return edge (rank-IC −0.004), while accumulation ratio (0.075) and
  // up/down volume (0.071) do. Use those + vol-adjusted momentum; fall back to
  // the old volume-surge blend only if the newer percentiles aren't present.
  const p4 = (q.accum != null || q.ud != null)
    ? Math.round(((q.accum || 0) + (q.ud || 0) + (q.volAdj || 0)) / 3)
    : Math.round(((q.vol || 0) + (q.volAdj || 0)) / 2);
  // Pillar 3 — fundamental acceleration. Hard fundamentals lead; the LLM
  // narrative is a 40% overlay. Neither available → neutral default (45).
  const narr = c.narrativeStrength != null ? Math.round((c.narrativeStrength / 10) * 100) : null;
  const fund = c.fundamentals ? fundamentalScore(c.fundamentals) : null;
  const p3 = (fund != null && narr != null) ? Math.round(0.6 * fund + 0.4 * narr)
           : fund != null ? fund
           : narr != null ? narr
           : 45;
  return { p1, p2, p3, p4 };
}

function composite(pl, preset) {
  const sum = preset.p1 + preset.p2 + preset.p3 + preset.p4;
  return Math.round((pl.p1 * preset.p1 + pl.p2 * preset.p2 + pl.p3 * preset.p3 + pl.p4 * preset.p4) / sum);
}

// Balance rule: Apex requires no weak pillar AND a confirmed setup.
function tierOf(score, pl, c) {
  const minP = Math.min(pl.p1, pl.p2, pl.p3, pl.p4);
  const confirmed = c.status === 'Breakout' || c.status === 'Early';
  if (score >= 72 && minP >= 45 && confirmed) return 'apex';
  if (score >= 58 && minP >= 35) return 'loaded';
  if (score >= 45) return 'watch';
  return null;
}

// Score one candidate for a given regime → { pillars, score, tier } (tier may be null).
// `weights` overrides the regime preset (used when a Module 2 recalibration is active).
function scoreCandidate(c, regime, weights) {
  const w = weights || PRESETS[regime] || PRESETS.NEUTRAL;
  const pillars = pillarsOf(c);
  const score = composite(pillars, w);
  return { pillars, score, tier: tierOf(score, pillars, c) };
}

module.exports = { PRESETS, RG_LABEL, PILLAR_LABEL, KEYS, rawRegime, pillarsOf, composite, tierOf, scoreCandidate };
