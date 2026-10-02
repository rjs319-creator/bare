// RISK BUDGET — deterministic position sizing and capacity, computed client-side.
//
// WHY CLIENT-SIDE. Alerts decisions and options events are built server-side on a cron,
// long before any particular person opens the page. A per-user risk budget therefore
// cannot participate in that computation. Rather than ship a fake default server-side —
// which is exactly the "missing evidence gets favorable credit" defect this redesign
// exists to remove — sizing is derived here, from evidence the payload already carries
// (dollar ADV, price, invalidation, contract open interest and quote).
//
// This is still DETERMINISTIC code owning the numbers: it is plain arithmetic over served
// measurements, not a model and not an LLM. It just runs in the browser because that is
// where the budget lives.
//
// Every function refuses rather than guesses: no budget, no invalidation, or no ADV each
// produce an explicit `available:false` with a reason. A size is never assumed.

const KEY = 'riskBudget';
const DEFAULTS = { equityUsd: null, riskPctPerTrade: null };

const isNum = v => v != null && Number.isFinite(+v) && !Number.isNaN(+v);
const round = (n, d = 2) => (isNum(n) ? +(+n).toFixed(d) : null);
const unavailable = reason => ({ available: false, reason });

/** Read the persisted budget. Per-browser (localStorage), never transmitted. */
export function loadBudget() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
    return {
      equityUsd: isNum(raw.equityUsd) && +raw.equityUsd > 0 ? +raw.equityUsd : null,
      riskPctPerTrade: isNum(raw.riskPctPerTrade) && +raw.riskPctPerTrade > 0 && +raw.riskPctPerTrade <= 100
        ? +raw.riskPctPerTrade : null,
    };
  } catch { return { ...DEFAULTS }; }
}

export function saveBudget(budget) {
  const clean = {
    equityUsd: isNum(budget && budget.equityUsd) && +budget.equityUsd > 0 ? +budget.equityUsd : null,
    riskPctPerTrade: isNum(budget && budget.riskPctPerTrade) && +budget.riskPctPerTrade > 0 && +budget.riskPctPerTrade <= 100
      ? +budget.riskPctPerTrade : null,
  };
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { /* private mode — session-only */ }
  return clean;
}

export function budgetIsSet(b) {
  return !!(b && isNum(b.equityUsd) && isNum(b.riskPctPerTrade));
}

/** Dollars at risk per trade. Pure. */
export function dollarRisk(budget) {
  if (!budgetIsSet(budget)) return unavailable('no risk budget set — enter account size and risk per trade to size positions');
  return { available: true, value: round(budget.equityUsd * (budget.riskPctPerTrade / 100)) };
}

/**
 * Share size from the risk budget and the DETERMINISTIC stop distance. Pure.
 *
 * Uses `entry − invalidation`, not a percentage guess: the invalidation is chart math the
 * server already computed. Without it there is no defensible size, and this says so.
 */
export function shareSize({ budget, entry, invalidation, side = 'long' }) {
  const dr = dollarRisk(budget);
  if (!dr.available) return dr;
  if (!isNum(entry) || !isNum(invalidation)) {
    return unavailable('no deterministic invalidation on this setup — share size cannot be derived from risk');
  }
  const perShare = side === 'short' ? +invalidation - +entry : +entry - +invalidation;
  if (!(perShare > 0)) {
    return unavailable(`invalidation is on the wrong side of entry for a ${side} — refusing to size`);
  }
  const shares = Math.floor(dr.value / perShare);
  if (shares < 1) {
    return unavailable(`risk budget $${dr.value} is smaller than the $${round(perShare)} per-share stop distance — position would be under one share`);
  }
  return {
    available: true,
    shares,
    perShareRisk: round(perShare),
    dollarRisk: dr.value,
    notionalUsd: round(shares * +entry),
    note: 'Size is risk-derived: dollar risk ÷ (entry − invalidation). It is not a recommendation.',
  };
}

/**
 * Capacity: what share of average daily dollar volume this order would be. Pure.
 * `advUsd` comes from the served execution evidence — absent it, this is unevaluated.
 */
export function capacity({ notionalUsd, advUsd }) {
  if (!isNum(notionalUsd)) return unavailable('no order size — capacity not evaluated');
  if (!isNum(advUsd) || advUsd <= 0) return unavailable('no dollar-ADV evidence for this name — capacity cannot be evaluated');
  const participation = notionalUsd / advUsd;
  return {
    available: true,
    participation: round(participation, 5),
    pctOfAdv: round(participation * 100, 3),
    // Same thresholds the server-side execution module uses, kept in sync deliberately.
    comfortable: participation <= 0.02,
    constrained: participation > 0.10,
    note: participation > 0.10
      ? 'Order exceeds 10% of average daily dollar volume — capacity-constrained at this size.'
      : participation <= 0.02 ? 'Low participation rate.' : 'Moderate participation rate.',
  };
}

/**
 * Hard position cap — the SAME number lib/omega-sizing (MAX_POSITION_PCT), lib/position-sizing
 * and lib/risk-kelly enforce; test/risk-kelly.test.js pins them to one value. The server also
 * serves it per lane (`maxPositionFraction`); whichever is SMALLER wins, so a corrupted or
 * stale server value can never loosen the cap from the browser.
 */
export const MAX_POSITION_FRACTION = 0.20;
const DRAWDOWN_THRESHOLDS = [0.10, 0.20];

/** P(maxDD > threshold) from the served percentile table of 20-trade max drawdown in R. */
export function drawdownExceedProbability(quantilesR, thresholdFrac, riskPerTradeFrac) {
  if (!Array.isArray(quantilesR) || !quantilesR.length || !(riskPerTradeFrac > 0) || !(thresholdFrac > 0)) return null;
  const limitR = thresholdFrac / riskPerTradeFrac;
  const exceeding = quantilesR.filter(q => isNum(q) && q > limitR).length;
  return round(exceeding / quantilesR.length, 3);
}

function effectiveCap(lane) {
  const served = lane && isNum(lane.maxPositionFraction) && lane.maxPositionFraction > 0 ? +lane.maxPositionFraction : MAX_POSITION_FRACTION;
  return Math.min(served, MAX_POSITION_FRACTION);
}

/**
 * Lane sizing — quarter Kelly, vol-target and drawdown odds for the decision's lane, from the
 * SERVED per-lane evidence (op=alerts `sizing`, built on the grade cron by lib/alerts-sizing).
 * The browser does no statistics here: it scales a served fraction by the budget, takes the
 * minimum of Kelly / vol-target / hard cap, and reads drawdown odds off a served percentile
 * table at the reader's own risk per trade. Fail-closed at every step.
 */
export function laneSizing({ budget, sizing, dec }) {
  if (!budgetIsSet(budget)) return unavailable('no risk budget set — Kelly and drawdown odds need your account size and risk per trade');
  const laneKey = dec && dec.sizingLane;
  if (!sizing || !sizing.lanes) return unavailable('lane sizing not served yet — it is built on the nightly grade');
  if (!laneKey || !sizing.lanes[laneKey]) return unavailable(`no graded record for lane ${laneKey || '(unknown)'} — size unevaluated`);
  const lane = sizing.lanes[laneKey];
  const n = lane.inputs && isNum(lane.inputs.n) ? lane.inputs.n : 0;
  if (!isNum(lane.kelly) || !isNum(lane.kellyFractional) || lane.size === null || !isNum(lane.size)) {
    const noEdge = isNum(lane.kelly) && lane.kelly <= 0;
    const reason = noEdge
      ? `no size — this lane has no measured edge (Kelly ${round(lane.kelly, 2)} over ${n} graded episodes)`
      : (lane.reason || 'lane sizing unavailable');
    return { ...unavailable(reason), noEdge, laneKey, n };
  }
  if (!(lane.kelly > 0) || !(lane.kellyFractional > 0)) {
    return { ...unavailable(`no size — this lane has no measured edge (Kelly ${round(lane.kelly, 2)} over ${n} graded episodes)`), noEdge: true, laneKey, n };
  }
  const cap = effectiveCap(lane);
  const vol = dec.volTarget && isNum(dec.volTarget.fraction) && dec.volTarget.fraction > 0 ? +dec.volTarget.fraction : null;
  const caps = [['kelly', +lane.kellyFractional], ['max-position', cap]];
  if (vol != null) caps.push(['vol-target', vol]);
  const binding = caps.reduce((m, c) => (c[1] < m[1] ? c : m), caps[0]);
  const fraction = Math.min(Math.max(binding[1], 0), cap);
  if (!(fraction > 0)) return unavailable('lane size collapsed to zero under the caps');
  const riskFrac = budget.riskPctPerTrade / 100;
  const q = lane.drawdown && Array.isArray(lane.drawdown.quantilesR) ? lane.drawdown.quantilesR : null;
  const [p10, p20] = DRAWDOWN_THRESHOLDS.map(t => (q ? drawdownExceedProbability(q, t, riskFrac) : null));
  return {
    available: true,
    laneKey, n,
    fraction,
    notionalUsd: round(budget.equityUsd * fraction),
    bindingConstraint: binding[0],
    kellyPct: round(lane.kelly * 100, 1),
    kellyFractionalPct: round(lane.kellyFractional * 100, 1),
    kellyFractionUsed: isNum(lane.kellyFractionUsed) ? lane.kellyFractionUsed : 0.25,
    volTargetPct: vol != null ? round(vol * 100, 1) : null,
    realizedVol20d: isNum(dec.realizedVol20d) ? round(dec.realizedVol20d, 1) : null,
    capPct: round(cap * 100, 0),
    drawdown: q ? { p10, p20, trades: lane.drawdown.trades, n: lane.drawdown.n } : null,
    note: 'Quarter Kelly over the lane\'s graded record, under the hard position cap and a 25% vol target. Arithmetic over served evidence — not a recommendation.',
  };
}

/** One call for an alerts decision card. Pure. `sizing` is the served op=alerts lane doc. */
export function sizeAlertDecision(dec, budget, sizing = null) {
  const lane = laneSizing({ budget, sizing, dec });
  const entry = dec && (dec.trigger != null ? dec.trigger : dec.priceNow);
  const size = shareSize({ budget, entry, invalidation: dec && dec.invalidation, side: dec && dec.side });
  if (!size.available) return { size, capacity: unavailable('no size to evaluate capacity against'), lane };
  // The server publishes measured dollar ADV on the liquidity component.
  const liq = dec && dec.execution && dec.execution.components && dec.execution.components.liquidity;
  const advUsd = liq && liq.state === 'MEASURED' && isNum(liq.value) ? liq.value : null;
  return { size, capacity: capacity({ notionalUsd: size.notionalUsd, advUsd }), lane };
}

/**
 * Contract count for an options idea, and whether that size fits the CONTRACT. Pure.
 *
 * Sizing an option off the stop distance is not meaningful — the defined risk of a long
 * option is the premium. So this sizes to the premium and says so.
 */
export function sizeOptionContracts({ budget, contractPrice, openInterest, sessionVolume }) {
  const dr = dollarRisk(budget);
  if (!dr.available) return { size: dr, fit: unavailable('no size to check against the contract') };
  if (!isNum(contractPrice) || contractPrice <= 0) {
    return { size: unavailable('no usable contract price — contract count cannot be derived'), fit: unavailable('no size') };
  }
  const perContract = contractPrice * 100;
  const contracts = Math.floor(dr.value / perContract);
  if (contracts < 1) {
    return {
      size: unavailable(`risk budget $${dr.value} is below the $${round(perContract)} cost of one contract`),
      fit: unavailable('no size'),
    };
  }
  const size = {
    available: true, contracts, perContractUsd: round(perContract), dollarRisk: dr.value,
    note: 'Sized to PREMIUM AT RISK (a long option\'s defined max loss), not to a stop distance.',
  };
  const oi = isNum(openInterest) ? openInterest : null;
  const vol = isNum(sessionVolume) ? sessionVolume : null;
  if (oi == null && vol == null) return { size, fit: unavailable('contract reports neither open interest nor volume — capacity unknown') };
  const vsOi = oi ? contracts / oi : null;
  const vsVol = vol ? contracts / vol : null;
  return {
    size,
    fit: {
      available: true,
      pctOfOpenInterest: vsOi != null ? round(vsOi * 100, 2) : null,
      pctOfSessionVolume: vsVol != null ? round(vsVol * 100, 2) : null,
      comfortable: (vsOi == null || vsOi <= 0.02) && (vsVol == null || vsVol <= 0.05),
      constrained: (vsOi != null && vsOi > 0.10) || (vsVol != null && vsVol > 0.5),
    },
  };
}

export const RISK_BUDGET_NOTE =
  'Position sizing is arithmetic over the risk you set and the deterministic invalidation — '
  + 'not a recommendation, and not evidence that the trade is sound.';
