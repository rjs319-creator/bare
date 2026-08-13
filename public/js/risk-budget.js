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

/** One call for an alerts decision card. Pure. */
export function sizeAlertDecision(dec, budget) {
  const entry = dec && (dec.trigger != null ? dec.trigger : dec.priceNow);
  const size = shareSize({ budget, entry, invalidation: dec && dec.invalidation, side: dec && dec.side });
  if (!size.available) return { size, capacity: unavailable('no size to evaluate capacity against') };
  // The server publishes measured dollar ADV on the liquidity component.
  const liq = dec && dec.execution && dec.execution.components && dec.execution.components.liquidity;
  const advUsd = liq && liq.state === 'MEASURED' && isNum(liq.value) ? liq.value : null;
  return { size, capacity: capacity({ notionalUsd: size.notionalUsd, advUsd }) };
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
