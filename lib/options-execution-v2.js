'use strict';
// OPTIONS CONTRACT-LEVEL EXECUTION + VOLATILITY CONTEXT.
//
// TWO DEFECTS THIS ADDRESSES:
//
//  1. Liquidity was judged at TICKER level — aggregate open interest and a median spread
//     across retained rows. That says nothing about whether YOU can get filled in THE
//     CONTRACT the plan actually names, at THE SIZE you actually want. A name with deep
//     aggregate OI can have a 40%-wide quote and 12 contracts of size on the exact strike
//     the setup calls for. Liquidity is checked here per contract, per requested size.
//
//  2. Strike concentration was computed from RETAINED DISPLAY ROWS. Retention is a ranking
//     and display decision; using it as the denominator makes concentration an artifact of
//     how many rows survived the cut. `strikeConcentration` here takes the FULL-CHAIN
//     aggregate and refuses to compute at all when only a truncated set is supplied.
//
// Plus the volatility context the mission asks for: IV rank/percentile, term-surface and
// skew CHANGE, expected-vs-realized move, a spot-relative strike map, and a crush/theta
// stress. Every one of them reports UNAVAILABLE with a reason when its inputs are absent.
//
// Pure; no I/O.

const EXEC_VERSION = 'options-execution-v2';

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));
const isNum = v => v != null && Number.isFinite(v);
const unavailable = reason => ({ available: false, reason: String(reason) });

// Thresholds — explicit hypotheses, versioned with the module.
const T = Object.freeze({
  SPREAD_TIGHT_FRAC: 0.05,     // ≤5% of mid = workable
  SPREAD_WIDE_FRAC: 0.20,      // >20% of mid = materially costly
  SPREAD_UNUSABLE_FRAC: 0.35,  // >35% of mid = not executable at any sane price
  SIZE_VS_OI_OK: 0.02,         // order ≤2% of contract OI
  SIZE_VS_OI_MAX: 0.10,
  SIZE_VS_VOL_OK: 0.05,        // order ≤5% of the contract's own session volume
  STALE_PRINT_HOURS: 30,
  MIN_IV_HISTORY: 60,          // sessions needed before an IV rank means anything
});

// ── Contract-level executable liquidity ─────────────────────────────────────

/**
 * Can the requested size actually be worked in THIS contract? Pure.
 *
 * @param {object} p
 * @param {object} p.contract    { bid, ask, lastPrice, volume, openInterest, lastTradeTs, strike, expiry, side }
 * @param {number} p.contracts   requested size IN CONTRACTS (not dollars)
 * @param {number} p.nowMs
 * @returns {object} executable-liquidity record; UNKNOWN when the inputs are missing
 */
function contractLiquidity({ contract = null, contracts = null, nowMs = 0 } = {}) {
  const c = contract || {};
  const checks = {};
  const blocking = [];

  // Quote quality.
  if (!isNum(c.bid) || !isNum(c.ask)) {
    checks.quote = unavailable('no two-sided quote on this contract — no limit price can be derived');
  } else if (c.ask <= c.bid) {
    checks.quote = { available: true, crossed: true, spreadFrac: null, reason: 'crossed or locked quote — unusable' };
    blocking.push('crossed quote');
  } else {
    const mid = (c.bid + c.ask) / 2;
    const spreadFrac = mid > 0 ? (c.ask - c.bid) / mid : null;
    checks.quote = {
      available: true, crossed: false,
      bid: round(c.bid), ask: round(c.ask), mid: round(mid),
      spreadFrac: round(spreadFrac, 4),
      spreadPctOfMid: round(spreadFrac * 100, 1),
      workable: spreadFrac <= T.SPREAD_WIDE_FRAC,
    };
    if (spreadFrac > T.SPREAD_UNUSABLE_FRAC) blocking.push(`quote ${round(spreadFrac * 100, 0)}% wide — not executable at a sane price`);
  }

  // Freshness of the last print.
  if (!c.lastTradeTs || !nowMs) {
    checks.printFreshness = unavailable('no last-trade timestamp — the quote cannot be aged');
  } else {
    const ts = c.lastTradeTs < 1e12 ? c.lastTradeTs * 1000 : c.lastTradeTs;
    const hours = (nowMs - ts) / 3_600_000;
    checks.printFreshness = { available: true, hours: round(hours, 1), stale: hours > T.STALE_PRINT_HOURS };
    if (hours > T.STALE_PRINT_HOURS) blocking.push(`last print ${round(hours, 0)}h old`);
  }

  // Size feasibility — REQUIRES a requested size. Without one this is not "fine", it is
  // simply unevaluated, and that is what it reports.
  if (!isNum(contracts) || contracts <= 0) {
    checks.size = unavailable('no requested size supplied — capacity in this contract has NOT been evaluated');
  } else {
    const oi = isNum(c.openInterest) ? c.openInterest : null;
    const vol = isNum(c.volume) ? c.volume : null;
    if (oi == null && vol == null) {
      checks.size = unavailable('this contract reports neither open interest nor session volume — capacity is unknown');
    } else {
      const vsOi = oi ? contracts / oi : null;
      const vsVol = vol ? contracts / vol : null;
      const tooBig = (vsOi != null && vsOi > T.SIZE_VS_OI_MAX) || (vsVol != null && vsVol > 0.5);
      checks.size = {
        available: true, requestedContracts: contracts,
        openInterest: oi, sessionVolume: vol,
        pctOfOpenInterest: vsOi != null ? round(vsOi * 100, 2) : null,
        pctOfSessionVolume: vsVol != null ? round(vsVol * 100, 2) : null,
        comfortable: (vsOi == null || vsOi <= T.SIZE_VS_OI_OK) && (vsVol == null || vsVol <= T.SIZE_VS_VOL_OK),
      };
      if (tooBig) blocking.push(`requested ${contracts} contracts is ${vsOi != null ? round(vsOi * 100, 0) + '% of open interest' : round(vsVol * 100, 0) + '% of session volume'} — capacity-constrained`);
    }
  }

  const evaluated = Object.values(checks).filter(v => v.available).length;
  const coverage = round(evaluated / Object.keys(checks).length, 2);

  // Limit-price rule and maximum acceptable slippage — concrete, derived from THIS quote.
  const q = checks.quote;
  const limitRule = q && q.available && !q.crossed
    ? {
      // Work the mid, never pay the offer on a wide book.
      suggestedLimit: round(q.mid + (q.ask - q.mid) * (q.spreadFrac <= T.SPREAD_TIGHT_FRAC ? 0.5 : 0.25), 2),
      neverPayAbove: round(q.mid * 1.05, 2),
      maxAcceptableSpreadPctOfMid: T.SPREAD_WIDE_FRAC * 100,
      rule: q.spreadFrac <= T.SPREAD_TIGHT_FRAC
        ? 'Tight book: a marketable limit between mid and ask should fill.'
        : 'Wide book: start at mid and improve slowly. Do NOT lift the offer — the spread is a larger cost than the expected edge.',
    }
    : unavailable('no usable two-sided quote — no limit rule can be derived');

  const estimatedSlippageFrac = q && q.available && !q.crossed ? round(q.spreadFrac / 2, 4) : null;

  const state = blocking.length ? 'BLOCKED' : coverage < 0.5 ? 'UNKNOWN' : (q && q.available && q.workable ? 'OK' : 'DEGRADED');

  return {
    version: EXEC_VERSION,
    state,
    contract: { side: c.side || null, strike: c.strike ?? null, expiry: c.expiry || null },
    checks,
    coverage,
    blocking,
    estimatedSlippageFrac,
    // The fraction of the requested size the evidence supports working. Zero when blocked
    // or unevaluated — never an optimistic default.
    executableFraction: state === 'OK' ? 1 : state === 'DEGRADED' ? 0.5 : 0,
    limitRule,
    unavailableReason: state === 'UNKNOWN'
      ? 'Contract-level execution evidence is incomplete — treated as UNKNOWN, not as tradeable.'
      : null,
  };
}

// ── Full-chain strike concentration ─────────────────────────────────────────

/**
 * Strike concentration over the FULL chain aggregate. Pure.
 *
 * Refuses to compute from a truncated/retained set: `chainComplete:false` returns
 * UNAVAILABLE rather than a number that is really a function of the display cut.
 */
function strikeConcentration({ chainRows = null, chainComplete = false } = {}) {
  if (!chainComplete) {
    return unavailable('strike concentration was NOT computed: only retained display rows were supplied. Retention is a ranking decision, so concentration over it measures the display cut, not the chain.');
  }
  const rows = (chainRows || []).filter(r => r && isNum(r.volume) && r.volume > 0);
  if (!rows.length) return unavailable('no full-chain rows with volume supplied');

  const total = rows.reduce((s, r) => s + r.volume, 0);
  const byStrike = new Map();
  for (const r of rows) {
    const k = `${r.side || '?'}|${r.strike}`;
    byStrike.set(k, (byStrike.get(k) || 0) + r.volume);
  }
  const sorted = [...byStrike.entries()].sort((a, b) => b[1] - a[1]);
  const top1 = sorted[0] ? sorted[0][1] / total : 0;
  const top3 = sorted.slice(0, 3).reduce((s, [, v]) => s + v, 0) / total;
  // Herfindahl over strike shares: 1 = a single strike, →0 = perfectly diffuse.
  const hhi = [...byStrike.values()].reduce((s, v) => s + (v / total) ** 2, 0);

  return {
    available: true,
    basis: 'FULL_CHAIN',
    distinctStrikes: byStrike.size,
    totalVolume: total,
    top1Share: round(top1, 3),
    top3Share: round(top3, 3),
    hhi: round(hhi, 4),
    topStrikes: sorted.slice(0, 3).map(([k, v]) => ({ key: k, volume: v, share: round(v / total, 3) })),
    concentrated: top1 >= 0.4 || hhi >= 0.25,
  };
}

// ── Volatility context ──────────────────────────────────────────────────────

/**
 * IV rank and percentile against the name's OWN IV history. Pure.
 * Refuses to report below `MIN_IV_HISTORY` sessions — a rank over 12 observations is noise.
 */
function ivRank({ currentIV = null, ivHistory = null } = {}) {
  if (!isNum(currentIV)) return unavailable('no current ATM implied volatility for this name');
  const h = (ivHistory || []).filter(isNum);
  if (h.length < T.MIN_IV_HISTORY) {
    return unavailable(`only ${h.length} sessions of IV history (need ${T.MIN_IV_HISTORY}) — an IV rank over a short window is noise, so none is reported`);
  }
  const lo = Math.min(...h), hi = Math.max(...h);
  const rank = hi > lo ? (currentIV - lo) / (hi - lo) : null;
  const below = h.filter(v => v < currentIV).length;
  return {
    available: true,
    currentIV: round(currentIV, 2),
    sessions: h.length,
    ivRank: rank != null ? round(rank * 100, 1) : null,
    ivPercentile: round((below / h.length) * 100, 1),
    low: round(lo, 2), high: round(hi, 2),
    note: 'IV rank is a position within this name\'s own realized IV range. It is a CONTEXT statistic, not a forecast and not a probability.',
  };
}

/** Expected move implied by ATM IV over `days`, versus what the stock actually did. */
function expectedVsRealizedMove({ atmIV = null, days = null, spot = null, realizedMovePct = null } = {}) {
  if (!isNum(atmIV) || !isNum(days) || days <= 0) return unavailable('ATM implied volatility and a day count are both required to derive an expected move');
  const expectedPct = round(atmIV * Math.sqrt(days / 365), 2);
  const out = {
    available: true,
    expectedMovePct: expectedPct,
    days,
    spot: isNum(spot) ? round(spot) : null,
    expectedMoveAbs: isNum(spot) ? round((expectedPct / 100) * spot, 2) : null,
    realizedMovePct: isNum(realizedMovePct) ? round(realizedMovePct, 2) : null,
    note: 'A one-standard-deviation move implied by ATM IV under a lognormal assumption. It is a pricing convention, not a probability the mission may present as one.',
  };
  if (isNum(realizedMovePct)) {
    out.realizedVsExpected = round(realizedMovePct / expectedPct, 2);
    out.interpretation = Math.abs(realizedMovePct) > expectedPct
      ? 'The stock has already moved MORE than the options were pricing — the premium may be behind the move.'
      : 'The stock has moved LESS than the options were pricing.';
  }
  return out;
}

/** Term-surface and skew CHANGE — the mission asks for changes, not levels. */
function surfaceChange({ current = null, prior = null } = {}) {
  if (!current || !prior) return unavailable('a prior-session surface snapshot is required to report a CHANGE; only a level is available');
  const d = (a, b) => (isNum(a) && isNum(b) ? round(a - b, 3) : null);
  const termSlope = d(current.termSlope, prior.termSlope);
  const skew = d(current.skew, prior.skew);
  const atm = d(current.atmIV, prior.atmIV);
  if (termSlope == null && skew == null && atm == null) return unavailable('neither snapshot carried comparable term-slope, skew, or ATM IV fields');
  return {
    available: true,
    atmIVChange: atm,
    termSlopeChange: termSlope,
    skewChange: skew,
    steepening: termSlope != null ? termSlope > 0 : null,
    skewSteepening: skew != null ? skew > 0 : null,
  };
}

/** Where the active strikes sit relative to spot — the spot-relative strike map. */
function strikeMap({ chainRows = null, spot = null, chainComplete = false } = {}) {
  if (!isNum(spot) || spot <= 0) return unavailable('no spot price — strikes cannot be placed relative to it');
  const rows = (chainRows || []).filter(r => r && isNum(r.strike) && isNum(r.volume) && r.volume > 0);
  if (!rows.length) return unavailable('no chain rows with volume supplied');
  const buckets = { deepITM: 0, ITM: 0, ATM: 0, OTM: 0, farOTM: 0 };
  for (const r of rows) {
    const rel = (r.strike - spot) / spot;
    const otmDist = r.side === 'put' ? -rel : rel;   // positive = out of the money
    if (Math.abs(rel) <= 0.02) buckets.ATM += r.volume;
    else if (otmDist > 0.20) buckets.farOTM += r.volume;
    else if (otmDist > 0) buckets.OTM += r.volume;
    else if (otmDist < -0.20) buckets.deepITM += r.volume;
    else buckets.ITM += r.volume;
  }
  const total = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;
  return {
    available: true,
    basis: chainComplete ? 'FULL_CHAIN' : 'RETAINED_ROWS_ONLY',
    basisCaveat: chainComplete ? null : 'Computed over retained display rows, so the shares reflect the display cut as well as the chain.',
    spot: round(spot),
    buckets,
    shares: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, round(v / total, 3)])),
    farOTMHeavy: buckets.farOTM / total >= 0.4,
  };
}

/** Volatility-crush and theta stress for a long option through a known event. */
function crushStress({ atmIV = null, dte = null, eventInDays = null, postEventIVDrop = 0.35, optionPrice = null } = {}) {
  if (!isNum(atmIV) || !isNum(dte)) return unavailable('ATM implied volatility and days-to-expiry are both required for a crush/theta stress');
  const out = {
    available: true,
    atmIV: round(atmIV, 2),
    dte,
    // Vega-free approximation: near ATM, option value scales roughly with IV × √T, so a
    // proportional IV drop translates to a proportional value loss. Labelled as such.
    approximation: 'Near-ATM proportional approximation (value ≈ IV × √T). It is an ORDER-OF-MAGNITUDE stress, not a Greeks-based P&L — no vega is supplied by this data source.',
    assumedPostEventIVDropFrac: postEventIVDrop,
    estimatedValueLossPctFromCrush: round(postEventIVDrop * 100, 1),
  };
  if (isNum(eventInDays) && eventInDays >= 0 && eventInDays <= dte) {
    out.eventInDays = eventInDays;
    out.eventBeforeExpiry = true;
    // Time value decays ~√T; the share lost between the event and expiry.
    const remaining = Math.max(0, dte - eventInDays);
    out.thetaDecayPctToEvent = round((1 - Math.sqrt(remaining / dte)) * 100, 1);
    out.combinedStressPct = round(Math.min(95, out.estimatedValueLossPctFromCrush + out.thetaDecayPctToEvent), 1);
    out.warning = `A long option through this event can lose roughly ${out.combinedStressPct}% of its value from volatility crush plus time decay EVEN IF the stock moves the expected way.`;
  } else {
    out.eventBeforeExpiry = false;
  }
  if (isNum(optionPrice)) out.estimatedValueAfterStress = round(optionPrice * (1 - (out.combinedStressPct ?? out.estimatedValueLossPctFromCrush) / 100), 2);
  return out;
}

/**
 * Assemble the full volatility context. Every sub-block independently reports its own
 * availability, so a partial provider does not blank the whole panel.
 */
function volatilityContext(input = {}) {
  const ctx = {
    version: EXEC_VERSION,
    ivRank: ivRank(input),
    expectedMove: expectedVsRealizedMove(input),
    surfaceChange: surfaceChange(input),
    strikeMap: strikeMap(input),
    crushStress: crushStress(input),
  };
  const keys = ['ivRank', 'expectedMove', 'surfaceChange', 'strikeMap', 'crushStress'];
  const avail = keys.filter(k => ctx[k].available);
  ctx.coverage = { available: avail.length, possible: keys.length, fraction: round(avail.length / keys.length, 2), missing: keys.filter(k => !ctx[k].available).map(k => ({ block: k, reason: ctx[k].reason })) };
  return ctx;
}

// ── Greeks / dealer positioning capability disclosure ───────────────────────

/**
 * Greeks and dealer-positioning analysis are only produced when the provider ACTUALLY
 * supplies the inputs. Otherwise this returns a capability disclosure naming exactly what
 * is missing — it never estimates gamma exposure from a delayed chain.
 */
function greeksCapability({ capabilities = {}, chainRows = null } = {}) {
  const rows = chainRows || [];
  const withGreeks = rows.filter(r => r && (isNum(r.delta) || isNum(r.gamma) || isNum(r.vega))).length;
  const supplied = withGreeks > 0 && withGreeks >= rows.length * 0.8;
  return {
    available: supplied,
    rowsWithGreeks: withGreeks,
    rowsTotal: rows.length,
    dealerPositioning: supplied && capabilities.hasFullChainOI
      ? { available: true, note: 'Dealer-positioning aggregates may be computed from supplied Greeks and full-chain open interest.' }
      : { available: false, reason: 'Dealer positioning requires per-contract Greeks AND full-chain open interest for every listed strike. This source supplies neither in full, so gamma/charm exposure is NOT estimated.' },
    disclosure: supplied
      ? 'Greeks are provider-supplied for the analysed rows.'
      : `Greeks are NOT supplied by this data source (${withGreeks}/${rows.length} rows carry any Greek). No delta, gamma, vega, or dealer-positioning analysis is produced — estimating them from a delayed chain would be fabrication.`,
  };
}

module.exports = {
  EXEC_VERSION, T,
  contractLiquidity, strikeConcentration, volatilityContext,
  ivRank, expectedVsRealizedMove, surfaceChange, strikeMap, crushStress, greeksCapability,
};
