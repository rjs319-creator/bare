'use strict';
// OMEGA-SWING POSITION SIZING — Phase 11. A portfolio-aware, capped size recommendation that
// can NEVER suggest 100% of equity on one name.
//
// The old riskPlan sized purely off "risk 1% of equity at the stop": sizePct = riskBudget /
// (riskPerShare/entry). A tight 1%-away stop implied a 100%-of-equity position — nonsense as a
// standalone recommendation. This module keeps the risk-budget idea but binds it under HARD
// caps (max position, ADV participation, gap loss) and applies conviction/evidence HAIRCUTS
// (shadow strategy, uncalibrated probabilities, event risk). It reports the BINDING constraint
// so the number is explainable, and always labels the output as an educational estimate — not
// a broker-ready order.
//
// Pure & deterministic. No portfolio holdings feed exists, so it sizes a STANDALONE position
// under conservative assumptions and says so; when the caller supplies existing holdings /
// sector exposure, the sector + correlated-cluster caps bind.

const MAX_POSITION_PCT = 0.20;        // never more than 20% of equity in one name
const MAX_SECTOR_PCT = 0.35;          // ≤35% of equity in one sector
const MAX_CORRELATED_PCT = 0.30;      // ≤30% across a correlated cluster
const MAX_GAP_LOSS_PCT = 0.03;        // cap expected loss from an overnight adverse gap at 3% of equity
const MAX_ADV_PARTICIPATION = 0.02;   // a position may be ≤2% of the name's ADV (capacity)
const DEFAULT_RISK_BUDGET = 0.0075;   // 0.75% of equity risked at the stop (below the old 1%)
const VOL_TARGET_ANNUAL = 0.25;       // volatility-target anchor for the vol cap

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = (x) => Number.isFinite(x);

// Conviction/evidence haircuts — multiply the raw risk-budget size DOWN. A shadow strategy,
// uncalibrated probabilities, and event risk each shrink the position; they never grow it.
function evidenceHaircut({ maturity = 'shadow', calibrated = false, binaryEvent = false, tailLossProb = null } = {}) {
  let m = 1;
  if (maturity !== 'production') m *= 0.5;         // shadow/experimental → half size (weight-0 in live, this is educational)
  if (!calibrated) m *= 0.8;                       // probabilities are a baseline, not calibrated → shrink
  if (binaryEvent) m *= 0.5;                       // binary event inside the hold window
  if (finite(tailLossProb) && tailLossProb > 0.3) m *= 0.75; // fat adverse tail
  return +m.toFixed(3);
}

// Recommend a size as a percent of equity, under all caps. Returns the binding constraint and
// the dollar figures for a specified account size so the number is interpretable.
//
//   entry        : assumed fill price (NOT the signal close)
//   stop         : invalidation price (< entry for a long)
//   dollarVol    : ~20d ADV in $ (capacity)
//   atrPct       : ATR as a fraction of price (volatility targeting)
//   ctx          : { maturity, calibrated, binaryEvent, tailLossProb,
//                    sectorExposurePct, clusterExposurePct }  (exposures optional)
//   accountSize  : $ equity for the dollar-risk illustration (default 100k)
function positionSizing({ entry, stop, dollarVol = null, atrPct = null, ctx = {}, riskBudget = DEFAULT_RISK_BUDGET, accountSize = 100000 } = {}) {
  if (!finite(entry) || entry <= 0 || !finite(stop) || stop >= entry) {
    return { ok: false, reason: 'no valid entry/stop', maxStandalonePct: 0, portfolioAware: false };
  }
  const riskPerShareFrac = (entry - stop) / entry;                 // fractional loss if stopped
  const caps = [];

  // 1) Risk-budget size: lose ~riskBudget of equity if stopped out.
  const byRisk = riskBudget / riskPerShareFrac;
  caps.push(['risk-budget', byRisk]);

  // 2) Hard max position.
  caps.push(['max-position', MAX_POSITION_PCT]);

  // 3) Gap-loss cap: an overnight adverse gap of ~1.5×ATR should not lose more than MAX_GAP_LOSS.
  if (finite(atrPct) && atrPct > 0) {
    const gapLossFrac = Math.max(riskPerShareFrac, 1.5 * atrPct);
    caps.push(['gap-loss', MAX_GAP_LOSS_PCT / gapLossFrac]);
  }

  // 4) Volatility target: scale down high-ATR names toward a constant portfolio vol contribution.
  if (finite(atrPct) && atrPct > 0) {
    const annualVol = atrPct * Math.sqrt(252);
    caps.push(['vol-target', clamp(VOL_TARGET_ANNUAL / annualVol, 0, MAX_POSITION_PCT)]);
  }

  // 5) ADV participation (capacity): position $ ≤ MAX_ADV_PARTICIPATION × ADV.
  if (finite(dollarVol) && dollarVol > 0) {
    caps.push(['adv-capacity', (MAX_ADV_PARTICIPATION * dollarVol) / accountSize]);
  }

  // 6) Sector / correlated-cluster headroom, when the caller knows current exposure.
  if (finite(ctx.sectorExposurePct)) caps.push(['sector-cap', Math.max(0, MAX_SECTOR_PCT - ctx.sectorExposurePct)]);
  if (finite(ctx.clusterExposurePct)) caps.push(['cluster-cap', Math.max(0, MAX_CORRELATED_PCT - ctx.clusterExposurePct)]);

  // Binding = the smallest cap.
  let binding = caps[0];
  for (const c of caps) if (c[1] < binding[1]) binding = c;
  let sizePct = clamp(binding[1], 0, MAX_POSITION_PCT);

  // Evidence/conviction haircut (never increases size).
  const haircut = evidenceHaircut(ctx);
  sizePct = +(sizePct * haircut).toFixed(4);

  const portfolioAware = finite(ctx.sectorExposurePct) || finite(ctx.clusterExposurePct);
  const dollarRisk = +(accountSize * sizePct * riskPerShareFrac).toFixed(0);
  const positionDollars = +(accountSize * sizePct).toFixed(0);

  return {
    ok: true,
    version: 'omega-sizing-v1',
    sizePctOfEquity: +(sizePct * 100).toFixed(1),
    maxStandalonePct: +(MAX_POSITION_PCT * 100).toFixed(0),
    bindingConstraint: binding[0],
    evidenceHaircut: haircut,
    riskPerSharePct: +(riskPerShareFrac * 100).toFixed(2),
    riskBudgetPct: +(riskBudget * 100).toFixed(2),
    accountSize, positionDollars, dollarRisk,
    portfolioAware,
    note: portfolioAware
      ? 'Portfolio-aware size (sector/cluster caps applied).'
      : 'Standalone size under conservative caps — portfolio-aware sizing unavailable (no holdings feed). Educational estimate, NOT a broker-ready order.',
    caps: caps.map(([k, v]) => ({ cap: k, pct: +(clamp(v, 0, 1) * 100).toFixed(1) })),
  };
}

module.exports = {
  MAX_POSITION_PCT, MAX_SECTOR_PCT, MAX_CORRELATED_PCT, MAX_GAP_LOSS_PCT, MAX_ADV_PARTICIPATION,
  DEFAULT_RISK_BUDGET, positionSizing, evidenceHaircut,
};
