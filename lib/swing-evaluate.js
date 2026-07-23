'use strict';
// SWING EVALUATION — pure price/thesis math for one open episode against fresh daily bars.
//
// Given an immutable origin and the security's daily candles (plus SPY and the sector ETF), this
// computes everything the lifecycle policy needs to decide the next state: executable next-open
// fill, leakage-safe barrier resolution (stop/target/time — only bars AFTER the fill count),
// returns since suggestion and since fill, MFE/MAE, excess vs SPY and sector, trailing momentum,
// moving averages, relative strength and its acceleration, ATR extension, remaining move to the
// original target, remaining reward:risk after costs, and consumed %.
//
// HONESTY RULES enforced here:
//   • No same-close fill — a fill is dated strictly after the decision date (lib/swing-sessions).
//   • A gap beyond the original max-entry/max-gap is a NO-FILL (gap-skip), never a silent entry.
//   • When both barriers fall in one bar, resolve to the STOP (pessimistic) — never inflate.
//   • Original entry/stop/targets are read-only; management levels are computed separately and
//     never fed back into grading.
//   • Missing data yields nulls, never fabricated numbers (a null feature ≠ a negative feature).
//
// Pure: no network, no clock, no store. `asOfDate` and all bars are supplied by the caller.

const { barDate, sessionDates, sessionsSince, nextSessionBar } = require('./swing-sessions');

const DEFAULT_COST_BPS = 20;   // round-trip cost assumption for remaining-R:R-after-costs
const EPS = 1e-9;

const O = (c) => num(c && (c.open != null ? c.open : c.o));
const H = (c) => num(c && (c.high != null ? c.high : c.h));
const L = (c) => num(c && (c.low != null ? c.low : c.l));
const C = (c) => num(c && (c.close != null ? c.close : c.c));
function num(v) { return (v === null || v === undefined || v === "" || typeof v === "boolean") ? null : (Number.isFinite(+v) ? +v : null); }

// Bars strictly after `date`, chronologically sorted.
function barsAfter(candles, date) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map(c => ({ c, d: barDate(c) }))
    .filter(x => x.d && x.d > date)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    .map(x => x.c);
}
// Bars up to and including `date`.
function barsThrough(candles, date) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map(c => ({ c, d: barDate(c) }))
    .filter(x => x.d && x.d <= date)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    .map(x => x.c);
}
function closeAt(candles, date) {
  const through = barsThrough(candles, date);
  return through.length ? C(through[through.length - 1]) : null;
}
// Trailing simple return over `n` sessions ending at the last bar ≤ asOf.
function trailingReturn(candles, asOf, n) {
  const t = barsThrough(candles, asOf);
  if (t.length < n + 1) return null;
  const a = C(t[t.length - 1 - n]), b = C(t[t.length - 1]);
  return a && b ? (b - a) / a : null;
}
function sma(candles, asOf, n) {
  const t = barsThrough(candles, asOf);
  if (t.length < n) return null;
  const slice = t.slice(t.length - n);
  let s = 0, k = 0;
  for (const c of slice) { const v = C(c); if (v != null) { s += v; k++; } }
  return k === n ? s / n : null;
}
function atr(candles, asOf, n = 14) {
  const t = barsThrough(candles, asOf);
  if (t.length < n + 1) return null;
  const slice = t.slice(t.length - n);
  let s = 0, k = 0;
  for (let i = 0; i < slice.length; i++) {
    const cur = slice[i];
    const prevIdx = t.indexOf(cur) - 1;
    const prev = prevIdx >= 0 ? t[prevIdx] : null;
    const hi = H(cur), lo = L(cur), pc = prev ? C(prev) : null;
    if (hi == null || lo == null) continue;
    const tr = pc == null ? (hi - lo) : Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
    if (Number.isFinite(tr)) { s += tr; k++; }
  }
  return k ? s / k : null;
}

// Signed by side: for a long, favorable = up; for a short, favorable = down.
function dirReturn(from, to, side) {
  if (from == null || to == null || Math.abs(from) < EPS) return null;
  const r = (to - from) / from;
  return side === 'short' ? -r : r;
}

// ── Executable next-open fill ──────────────────────────────────────────────────────
// Returns { status, fillDate, fillPrice, reason }. status ∈ filled | unfilled | gap-skip.
//   • entry trigger present & beyond the suggested price ⇒ breakout: fill the first post-decision
//     bar whose range reaches the entry; a gap open beyond maxEntry/maxGap ⇒ gap-skip (no fill).
//   • no meaningful trigger ⇒ enter-now: fill at the next session open (T+1).
//   • not reached within the fill deadline ⇒ unfilled (a NO-FILL, not a loss).
function resolveFill(origin, candles) {
  const side = origin.side === 'short' ? 'short' : 'long';
  const decision = origin.firstDecisionDate;
  const entry = num(origin.originalEntry);
  const sugg = num(origin.firstSuggestedPrice);
  const after = barsAfter(candles, decision);
  if (!after.length) return { status: 'unfilled', fillDate: null, fillPrice: null, reason: 'NO_SESSION_YET' };

  const deadline = Number.isFinite(+origin.originalHoldingWindow) && +origin.originalHoldingWindow > 0
    ? Math.min(Math.ceil(+origin.originalHoldingWindow), after.length)
    : Math.min(10, after.length);

  // Enter-now: no trigger, or trigger not beyond the suggested price in the trade's direction.
  const triggerBeyond = entry != null && sugg != null &&
    (side === 'long' ? entry > sugg * (1 + 0.001) : entry < sugg * (1 - 0.001));
  if (!triggerBeyond) {
    const first = after[0];
    const fp = O(first) != null ? O(first) : C(first);
    return { status: 'filled', fillDate: barDate(first), fillPrice: fp, reason: 'ENTER_NOW_NEXT_OPEN' };
  }

  const maxEntry = num(origin.originalMaxEntry);
  const maxGapPct = num(origin.originalMaxGap);
  for (let i = 0; i < deadline; i++) {
    const bar = after[i];
    const op = O(bar), hi = H(bar), lo = L(bar);
    const reaches = side === 'long' ? (hi != null && hi >= entry) : (lo != null && lo <= entry);
    if (!reaches) continue;
    // Gap-through beyond the acceptable entry ⇒ skip, never chase.
    const gappedBeyond = op != null && (side === 'long' ? op > entry : op < entry) && (
      (maxEntry != null && (side === 'long' ? op > maxEntry : op < maxEntry)) ||
      (maxGapPct != null && sugg != null && Math.abs((op - sugg) / sugg) * 100 > maxGapPct)
    );
    if (gappedBeyond) return { status: 'gap-skip', fillDate: barDate(bar), fillPrice: null, reason: 'GAP_BEYOND_MAX_ENTRY' };
    // Fill at the entry, or at the open if it gapped through within tolerance.
    const fp = op != null && (side === 'long' ? op > entry : op < entry) ? op : entry;
    return { status: 'filled', fillDate: barDate(bar), fillPrice: fp, reason: 'TRIGGER_REACHED' };
  }
  return { status: 'unfilled', fillDate: null, fillPrice: null, reason: 'TRIGGER_NOT_REACHED' };
}

// ── Leakage-safe barrier resolution ─────────────────────────────────────────────────
// Only bars strictly AFTER the fill date count. Returns which barrier fell first.
//   barrier ∈ target | stop | time | none.  MFE/MAE are signed favorable/adverse magnitudes.
function resolveBarrier(origin, candles, fill, asOf) {
  const side = origin.side === 'short' ? 'short' : 'long';
  const stop = num(origin.originalStop);
  const target = (origin.originalTargets && origin.originalTargets.length) ? num(origin.originalTargets[0]) : null;
  if (fill.status !== 'filled' || !fill.fillDate) {
    return { barrier: 'none', hitDate: null, hitPrice: null, mfe: null, mae: null, sessionsHeld: 0 };
  }
  const hold = Number.isFinite(+origin.originalHoldingWindow) && +origin.originalHoldingWindow > 0
    ? Math.ceil(+origin.originalHoldingWindow) : 10;
  const after = barsAfter(candles, fill.fillDate).filter(b => barDate(b) <= asOf);
  let mfe = 0, mae = 0, held = 0;
  for (let i = 0; i < after.length; i++) {
    const bar = after[i];
    held = i + 1;
    const hi = H(bar), lo = L(bar);
    // favorable/adverse excursions from the fill price
    if (hi != null && lo != null && fill.fillPrice) {
      const upMove = (hi - fill.fillPrice) / fill.fillPrice;
      const downMove = (lo - fill.fillPrice) / fill.fillPrice;
      const fav = side === 'short' ? -downMove : upMove;
      const adv = side === 'short' ? -upMove : downMove;
      if (fav > mfe) mfe = fav;
      if (adv < mae) mae = adv;
    }
    const stopHit = stop != null && (side === 'long' ? (lo != null && lo <= stop) : (hi != null && hi >= stop));
    const targetHit = target != null && (side === 'long' ? (hi != null && hi >= target) : (lo != null && lo <= target));
    // Pessimistic tie-break: if both fall in one bar, the stop resolves first.
    if (stopHit) return { barrier: 'stop', hitDate: barDate(bar), hitPrice: stop, mfe, mae, sessionsHeld: held };
    if (targetHit) return { barrier: 'target', hitDate: barDate(bar), hitPrice: target, mfe, mae, sessionsHeld: held };
    if (held >= hold) return { barrier: 'time', hitDate: barDate(bar), hitPrice: C(bar), mfe, mae, sessionsHeld: held };
  }
  return { barrier: 'none', hitDate: null, hitPrice: after.length ? C(after[after.length - 1]) : null, mfe, mae, sessionsHeld: held };
}

// ── Full evaluation ──────────────────────────────────────────────────────────────────
// origin, {candles, spy, sector, asOf, costBps} → a rich metrics object (all nullable).
function evaluate(origin, ctx = {}) {
  const { candles = [], spy = [], sector = [], costBps = DEFAULT_COST_BPS } = ctx;
  const side = origin.side === 'short' ? 'short' : 'long';
  const dates = sessionDates(candles);
  const asOf = ctx.asOf || (dates.length ? dates[dates.length - 1] : origin.firstDecisionDate);
  const decision = origin.firstDecisionDate;
  const sugg = num(origin.firstSuggestedPrice);
  const entry = num(origin.originalEntry);
  const stop = num(origin.originalStop);
  const target = (origin.originalTargets && origin.originalTargets.length) ? num(origin.originalTargets[0]) : null;

  const currentPrice = closeAt(candles, asOf);
  const fill = resolveFill(origin, candles);
  const barrier = resolveBarrier(origin, candles, fill, asOf);

  const sessionsSinceSuggestion = sessionsSince(decision, candles);
  const sessionsSinceEntry = fill.status === 'filled' && fill.fillDate ? sessionsSince(fill.fillDate, candles) : null;

  const returnSinceSuggestion = dirReturn(sugg, currentPrice, side);
  const returnSinceFill = fill.status === 'filled' ? dirReturn(fill.fillPrice, currentPrice, side) : null;

  // Benchmark excess over the SAME window (decision → asOf).
  const spyFrom = closeAt(spy, decision), spyTo = closeAt(spy, asOf);
  const spyRet = spyFrom && spyTo ? (spyTo - spyFrom) / spyFrom : null;
  const secFrom = closeAt(sector, decision), secTo = closeAt(sector, asOf);
  const secRet = secFrom && secTo ? (secTo - secFrom) / secFrom : null;
  const rawRet = sugg && currentPrice ? (currentPrice - sugg) / sugg : null;   // unsigned, for excess
  const excessVsSpy = rawRet != null && spyRet != null ? (side === 'short' ? (-rawRet) - (-spyRet) : rawRet - spyRet) : null;
  const excessVsSector = rawRet != null && secRet != null ? (side === 'short' ? (-rawRet) - (-secRet) : rawRet - secRet) : null;

  // MFE/MAE since suggestion (from all post-decision bars through asOf).
  let mfeSug = 0, maeSug = 0;
  if (sugg) {
    for (const bar of barsAfter(candles, decision).filter(b => barDate(b) <= asOf)) {
      const hi = H(bar), lo = L(bar);
      if (hi == null || lo == null) continue;
      const up = (hi - sugg) / sugg, dn = (lo - sugg) / sugg;
      const fav = side === 'short' ? -dn : up, adv = side === 'short' ? -up : dn;
      if (fav > mfeSug) mfeSug = fav;
      if (adv < maeSug) maeSug = adv;
    }
  }

  // Momentum, MAs, RS, extension — all as-of asOf.
  const r5 = trailingReturn(candles, asOf, 5), r10 = trailingReturn(candles, asOf, 10), r20 = trailingReturn(candles, asOf, 20);
  const spyR5 = trailingReturn(spy, asOf, 5), spyR10 = trailingReturn(spy, asOf, 10), spyR20 = trailingReturn(spy, asOf, 20);
  const rsSpy5 = r5 != null && spyR5 != null ? r5 - spyR5 : null;
  const rsSpy10 = r10 != null && spyR10 != null ? r10 - spyR10 : null;
  const rsSpy20 = r20 != null && spyR20 != null ? r20 - spyR20 : null;
  const rsAccel = rsSpy5 != null && rsSpy10 != null ? rsSpy5 - rsSpy10 : null;
  const momAccel = r5 != null && r10 != null ? r5 - r10 : null;
  const ma10 = sma(candles, asOf, 10), ma20 = sma(candles, asOf, 20), ma50 = sma(candles, asOf, 50), ma200 = sma(candles, asOf, 200);
  const atr14 = atr(candles, asOf, 14);
  const extensionAtr = currentPrice != null && ma20 != null && atr14 ? (currentPrice - ma20) / atr14 : null;

  // Remaining move / reward:risk / consumed — all vs the IMMUTABLE original levels.
  const remainingToOriginalTarget = target != null && currentPrice ? (side === 'short' ? (currentPrice - target) / currentPrice : (target - currentPrice) / currentPrice) : null;
  const riskRef = stop != null && currentPrice != null ? Math.abs(currentPrice - stop) : null;
  const rewardRef = target != null && currentPrice != null ? Math.abs(target - currentPrice) : null;
  const costFrac = (costBps || 0) / 10000;
  const rewardAfterCosts = rewardRef != null && currentPrice != null ? Math.max(0, rewardRef - currentPrice * costFrac) : null;
  const remainingRewardRisk = rewardAfterCosts != null && riskRef && riskRef > EPS ? +(rewardAfterCosts / riskRef).toFixed(2) : null;
  const anchor = entry != null ? entry : sugg;
  const consumedPct = anchor != null && target != null && currentPrice != null && Math.abs(target - anchor) > EPS
    ? Math.max(0, Math.min(1.5, (side === 'short' ? (anchor - currentPrice) : (currentPrice - anchor)) / Math.abs(target - anchor)))
    : null;

  return {
    asOf, currentPrice,
    fill, barrier,
    sessionsSinceSuggestion, sessionsSinceEntry,
    returnSinceSuggestion, returnSinceFill,
    excessVsSpy, excessVsSector,
    mfeSinceSuggestion: mfeSug, maeSinceSuggestion: maeSug,
    mfeSinceFill: barrier.mfe, maeSinceFill: barrier.mae,
    r5, r10, r20, momAccel,
    rsSpy5, rsSpy10, rsSpy20, rsAccel,
    ma10, ma20, ma50, ma200, atr14, extensionAtr,
    priceVsMa20: currentPrice != null && ma20 != null ? currentPrice - ma20 : null,
    priceVsMa50: currentPrice != null && ma50 != null ? currentPrice - ma50 : null,
    remainingToOriginalTarget, remainingRewardRisk, consumedPct,
    stop, target, entry,
    // A tightened advisory management stop: for a long in profit, trail to breakeven-ish once the
    // move is >1R. Purely advisory — the grader still uses origin.originalStop.
    managementStop: computeManagementStop(origin, currentPrice, side),
    dataAsOf: asOf,
  };
}

// Advisory only — never fed back to grading (see swing-episode makeAssessment/managementStop).
function computeManagementStop(origin, currentPrice, side) {
  const entry = num(origin.originalEntry) != null ? num(origin.originalEntry) : num(origin.firstSuggestedPrice);
  const stop = num(origin.originalStop);
  if (entry == null || stop == null || currentPrice == null) return null;
  const oneR = Math.abs(entry - stop);
  if (oneR < EPS) return null;
  const inProfit = side === 'short' ? (entry - currentPrice) : (currentPrice - entry);
  if (inProfit > oneR) return +entry.toFixed(2);   // move stop to breakeven after >1R
  return null;
}

module.exports = {
  DEFAULT_COST_BPS, evaluate, resolveFill, resolveBarrier,
  // exported for tests / reuse
  trailingReturn, sma, atr, closeAt, barsAfter, dirReturn,
};
