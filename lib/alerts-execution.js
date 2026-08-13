'use strict';
// EXECUTION EVIDENCE — no favorable default credit for missing data.
//
// THE P0 DEFECT THIS REPLACES: the score used to hand out 0.7 of the execution weight
// whenever liquidity evidence was *absent* (`liquidityOk === null` → the `false` branch
// never fired, so unknown scored the same as verified-liquid). A name nobody could
// measure therefore looked as executable as a mega-cap. Missing evidence must REDUCE
// actionability, never receive near-full credit.
//
// The contract here:
//   • Every component is either MEASURED (with a value and a source) or MISSING (with a
//     reason). There is no third "assume fine" state.
//   • `creditFraction` is bounded by `coverage`: credit can never exceed the share of
//     required evidence that actually exists. Zero evidence ⇒ zero credit.
//   • `state` is UNKNOWN whenever required coverage is below the floor, and the decision
//     layer turns UNKNOWN into WAIT — never into a tradeable card.
//   • Borrow is REQUIRED for shorts and NOT_APPLICABLE for longs, so a long is not
//     punished for a field that cannot exist and a short cannot skip it.
//
// Pure. Every input is injected; nothing here fetches.

const STATE = Object.freeze({
  OK: 'OK',              // required evidence present and acceptable
  DEGRADED: 'DEGRADED',  // present but materially unfavorable (wide/thin/hard-to-borrow)
  BLOCKED: 'BLOCKED',    // measured and disqualifying
  UNKNOWN: 'UNKNOWN',    // required evidence missing — NOT a pass
});

const COMPONENT_STATE = Object.freeze({ MEASURED: 'MEASURED', MISSING: 'MISSING', NOT_APPLICABLE: 'NOT_APPLICABLE' });

// Deterministic thresholds — explicit hypotheses, versioned with the module.
const T = Object.freeze({
  ADV_FLOOR_USD: 3e6,        // dollar ADV below this = not executably tradeable
  ADV_COMFORT_USD: 25e6,     // full liquidity credit at/above this
  SPREAD_OK_BPS: 25,         // ≤ this = tight enough to work a limit
  SPREAD_WIDE_BPS: 75,       // > this = materially costly
  PARTICIPATION_OK: 0.02,    // order ≤ 2% of ADV = low impact
  PARTICIPATION_MAX: 0.10,   // > 10% of ADV = capacity-constrained
  MIN_COVERAGE: 0.5,         // below this share of required evidence ⇒ UNKNOWN
  EVENT_NEAR_DAYS: 3,        // earnings/event inside this window = gap risk flagged
  MIN_ADV_CANDLES: 20,
});

const VERSION = 'alerts-execution-v1';

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));
const clamp01 = v => Math.max(0, Math.min(1, v));

const measured = (value, credit, note, source) => ({
  state: COMPONENT_STATE.MEASURED, value, credit: clamp01(credit), note, source: source || null, reason: null,
});
const missing = reason => ({ state: COMPONENT_STATE.MISSING, value: null, credit: 0, note: null, source: null, reason });
const notApplicable = reason => ({ state: COMPONENT_STATE.NOT_APPLICABLE, value: null, credit: null, note: null, source: null, reason });

/** Dollar ADV over the trailing window. Returns null when the window is too short. Pure. */
function dollarADV(candles, window = T.MIN_ADV_CANDLES) {
  if (!Array.isArray(candles) || candles.length < window) return null;
  const recent = candles.slice(-window);
  let sum = 0, n = 0;
  for (const c of recent) {
    if (!c || c.close == null || c.volume == null) continue;
    sum += c.close * c.volume; n++;
  }
  return n >= Math.ceil(window * 0.75) ? sum / n : null;
}

// ── Individual component readings ────────────────────────────────────────────

function liquidityComponent({ candles, advUsd, liquidityVerdict = null }) {
  const adv = advUsd != null && Number.isFinite(advUsd) ? advUsd : dollarADV(candles);
  if (adv == null) {
    // A caller may supply only a pre-computed pass/fail verdict (the pipeline's older
    // `liquidityOk` read). A boolean is real evidence; `null`/`undefined` is NOT — that
    // distinction is exactly the defect this module exists to close.
    if (liquidityVerdict === true) return measured(true, 1, 'dollar ADV clears the executability floor (verdict only — no ADV value supplied)', 'liquidity-verdict');
    if (liquidityVerdict === false) return { ...measured(false, 0, 'dollar ADV is below the executability floor', 'liquidity-verdict'), blocking: true };
    return missing('no dollar-ADV evidence (insufficient daily history for this name)');
  }
  if (adv < T.ADV_FLOOR_USD) {
    return { ...measured(round(adv, 0), 0, `dollar ADV $${Math.round(adv / 1e6 * 10) / 10}M is below the $${T.ADV_FLOOR_USD / 1e6}M executability floor`, 'daily-candles'), blocking: true };
  }
  const credit = clamp01((adv - T.ADV_FLOOR_USD) / (T.ADV_COMFORT_USD - T.ADV_FLOOR_USD));
  return measured(round(adv, 0), credit, `dollar ADV $${Math.round(adv / 1e6 * 10) / 10}M`, 'daily-candles');
}

function spreadComponent({ spreadBps }) {
  if (spreadBps == null || !Number.isFinite(spreadBps)) {
    return missing('no quoted spread available from any configured provider — execution cost is unmeasured');
  }
  const credit = spreadBps <= T.SPREAD_OK_BPS ? 1
    : spreadBps >= T.SPREAD_WIDE_BPS ? 0
      : 1 - (spreadBps - T.SPREAD_OK_BPS) / (T.SPREAD_WIDE_BPS - T.SPREAD_OK_BPS);
  return measured(round(spreadBps, 1), credit, `${round(spreadBps, 1)} bps quoted spread`, 'quote');
}

/** Impact needs BOTH an order size and an ADV — either one missing leaves it unmeasured. */
function impactComponent({ orderNotionalUsd, advUsd, candles }) {
  const adv = advUsd != null && Number.isFinite(advUsd) ? advUsd : dollarADV(candles);
  if (orderNotionalUsd == null || !Number.isFinite(orderNotionalUsd)) {
    return missing('no risk budget / order size supplied — market impact and capacity cannot be evaluated');
  }
  if (adv == null) return missing('no dollar-ADV evidence — participation rate cannot be computed');
  const participation = orderNotionalUsd / adv;
  if (participation > T.PARTICIPATION_MAX) {
    return { ...measured(round(participation, 4), 0, `order is ${(participation * 100).toFixed(1)}% of ADV — capacity-constrained`, 'derived'), blocking: true };
  }
  const credit = participation <= T.PARTICIPATION_OK ? 1
    : 1 - (participation - T.PARTICIPATION_OK) / (T.PARTICIPATION_MAX - T.PARTICIPATION_OK);
  return measured(round(participation, 4), credit, `${(participation * 100).toFixed(2)}% of ADV`, 'derived');
}

/** Borrow: REQUIRED for a short, NOT_APPLICABLE for a long. Unknown borrow never passes a short. */
function borrowComponent({ side, borrow }) {
  if (side !== 'short') return notApplicable('long side — no borrow required');
  if (!borrow || borrow.available == null) {
    return missing('no borrow availability / fee evidence — a short cannot be assumed locatable');
  }
  if (borrow.available === false) {
    return { ...measured(false, 0, 'no borrow available — the short is not executable', borrow.source || 'borrow-provider'), blocking: true };
  }
  const feePct = borrow.feePct != null && Number.isFinite(borrow.feePct) ? borrow.feePct : null;
  if (feePct == null) return measured(true, 0.5, 'borrow located but the fee is unknown', borrow.source || 'borrow-provider');
  const credit = feePct <= 1 ? 1 : feePct >= 25 ? 0 : 1 - (feePct - 1) / 24;
  return measured(feePct, credit, `borrow located at ${feePct}% fee`, borrow.source || 'borrow-provider');
}

/** Gap / event risk: scheduled events inside the window are a known execution hazard. */
function gapRiskComponent({ earnings, asOfDate }) {
  if (!earnings || !earnings.nextDate) {
    return missing('no earnings/event calendar evidence — overnight gap risk is unquantified');
  }
  if (!asOfDate) return missing('no as-of date — event proximity cannot be computed');
  const a = Date.parse(`${String(asOfDate).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(earnings.nextDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return missing('unparseable event date');
  const days = Math.round((b - a) / 86_400_000);
  if (days < 0) return measured(days, 1, 'no scheduled event ahead in the calendar window', 'earnings-calendar');
  const credit = days <= T.EVENT_NEAR_DAYS ? 0 : days <= 10 ? 0.6 : 1;
  return measured(days, credit, days <= T.EVENT_NEAR_DAYS ? `earnings/event in ${days}d — elevated gap risk` : `next event in ${days}d`, 'earnings-calendar');
}

// Which components are REQUIRED for this side. Non-required components still report,
// but only required ones drive coverage.
function requiredKeys(side) {
  return side === 'short'
    ? ['liquidity', 'spread', 'borrow']
    : ['liquidity', 'spread'];
}

/**
 * Assess execution feasibility from injected evidence. Pure.
 *
 * @param {object} p
 * @param {'long'|'short'|null} p.side
 * @param {Array}  p.candles           daily candles for dollar-ADV (optional)
 * @param {number} p.advUsd            pre-computed dollar ADV (optional, wins over candles)
 * @param {number} p.spreadBps         quoted spread in basis points (optional)
 * @param {number} p.orderNotionalUsd  intended order size in dollars (optional)
 * @param {object} p.borrow            { available:boolean, feePct:number, source } (optional)
 * @param {object} p.earnings          { nextDate } (optional)
 * @param {string} p.asOfDate          YYYY-MM-DD for event-proximity math
 * @returns {object} execution evidence record — never a silent pass
 */
function assessExecution({
  side = null, candles = null, advUsd = null, spreadBps = null,
  orderNotionalUsd = null, borrow = null, earnings = null, asOfDate = null,
  liquidityVerdict = null,
} = {}) {
  const components = {
    liquidity: liquidityComponent({ candles, advUsd, liquidityVerdict }),
    spread: spreadComponent({ spreadBps }),
    impact: impactComponent({ orderNotionalUsd, advUsd, candles }),
    borrow: borrowComponent({ side, borrow }),
    gapRisk: gapRiskComponent({ earnings, asOfDate }),
  };

  const required = requiredKeys(side);
  const measuredRequired = required.filter(k => components[k].state === COMPONENT_STATE.MEASURED);
  const missingRequired = required.filter(k => components[k].state === COMPONENT_STATE.MISSING);
  const coverage = required.length ? measuredRequired.length / required.length : 0;

  // Every MEASURED component (required or not) contributes; nothing missing contributes.
  const contributing = Object.entries(components).filter(([, c]) => c.state === COMPONENT_STATE.MEASURED);
  const rawCredit = contributing.length
    ? contributing.reduce((s, [, c]) => s + c.credit, 0) / contributing.length
    : 0;

  // THE FIX: credit is capped by coverage. Unmeasured evidence cannot be borrowed against.
  const creditFraction = round(clamp01(rawCredit) * clamp01(coverage), 4);

  const blocking = Object.entries(components).filter(([, c]) => c.blocking).map(([k]) => k);
  const notes = [];
  for (const [k, c] of Object.entries(components)) {
    if (c.state === COMPONENT_STATE.MISSING) notes.push(`${k}: ${c.reason}`);
    else if (c.state === COMPONENT_STATE.MEASURED && c.note) notes.push(`${k}: ${c.note}`);
  }

  let state;
  if (blocking.length) state = STATE.BLOCKED;
  else if (coverage < T.MIN_COVERAGE) state = STATE.UNKNOWN;
  else if (creditFraction < 0.35) state = STATE.DEGRADED;
  else state = STATE.OK;

  return {
    version: VERSION,
    state,
    side: side || null,
    coverage: round(coverage, 3),
    creditFraction,
    components,
    requiredKeys: required,
    missingRequired,
    blocking,
    // The single sentence the UI shows when it cannot promise executability.
    unavailableReason: state === STATE.UNKNOWN
      ? `Execution evidence incomplete (${missingRequired.join(', ')}) — treated as UNKNOWN, not as acceptable.`
      : null,
    notes,
  };
}

/** Does this execution read permit an actionable card? UNKNOWN and BLOCKED never do. */
function executionPermitsAction(exec) {
  return !!exec && (exec.state === STATE.OK || exec.state === STATE.DEGRADED);
}

module.exports = {
  STATE, COMPONENT_STATE, T, VERSION,
  dollarADV, assessExecution, executionPermitsAction,
  liquidityComponent, spreadComponent, impactComponent, borrowComponent, gapRiskComponent,
};
