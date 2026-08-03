'use strict';
// CORPORATE-ACTION / ADJUSTED-PRICE LAYER (corpactions-v1)
//
// The cached FMP `historical-price-eod/full` closes are VENDOR-SPLIT-ADJUSTED
// (verified empirically: CELH 3:1 2023-11-15 and GME 4:1 2022-07-22 show no
// discontinuity) but NOT dividend-adjusted, and carried no provenance. This
// layer makes the basis explicit, verified and versioned:
//
//   * split records + dividend records per symbol, cached with retrievedAt
//     (research/54-corpactions-fetch.js populates the cache);
//   * verifySplitAdjustment — proves (or refutes) that the vendor series is
//     split-adjusted by checking each in-window split for a residual
//     discontinuity; a residual jump at a split date is a CONFLICT, never
//     silently repaired;
//   * withTotalReturn — a total-return index (split-adjusted close reinvesting
//     adjDividend on ex-date) for research features/labels; raw closes remain
//     untouched for execution modeling and display;
//   * extremeReturnAudit — every one-session move beyond tiered thresholds is
//     classified: explained-by-corporate-action, legitimate-persistent-move,
//     conflicting (unadjusted split), or unresolved (spike that reverts /
//     ambiguous). Conflicting and unresolved events POISON the dates around
//     them: labels whose window touches a poisoned date are withheld
//     (fail closed) — an error is never winsorized into trainable data.
//
// Pure module: no network. The fetch script owns I/O.

const CORPACTIONS_VERSION = 'corpactions-v1';

// Detection thresholds by prior-close tier. Detection is deliberately wider
// than "impossible" — classification decides what survives.
const JUMP_THRESHOLDS = Object.freeze([
  { minPrev: 5, up: 0.60, down: -0.45 },
  { minPrev: 1, up: 1.00, down: -0.60 },
  { minPrev: 0, up: 2.00, down: -0.80 },
]);
const SPLIT_MATCH_TOLERANCE = 0.15;     // relative match of jump ratio to split factor
const PERSIST_BARS = 5;                 // bars used to test whether a repricing held
const PERSIST_TOLERANCE = 0.35;         // median stays within ±35% of the new level → persistent
const REVERT_TOLERANCE = 0.20;          // median back within ±20% of the OLD level → spike-revert
const POISON_RADIUS_BARS = 1;           // poisoned bar ± this many bars is untrainable

function thresholdFor(prevClose) {
  for (const t of JUMP_THRESHOLDS) if (prevClose >= t.minPrev) return t;
  return JUMP_THRESHOLDS[JUMP_THRESHOLDS.length - 1];
}

// splits: [{date, numerator, denominator}] → factor numerator/denominator
const splitFactor = (s) => {
  const n = Number(s && s.numerator), d = Number(s && s.denominator);
  return (n > 0 && d > 0) ? n / d : null;
};

// Verify that the series shows NO residual discontinuity at each in-window
// split date (i.e. the vendor already adjusted). Returns
// { basis, splitsInWindow, verified, conflicts:[{date, factor, observedRatio}] }.
function verifySplitAdjustment(series, splits) {
  const inWindow = (splits || []).filter((s) => {
    if (!s || !s.date || !splitFactor(s)) return false;
    const ms = Date.parse(s.date);
    return series.length >= 2 && ms > series[0].ms && ms <= series[series.length - 1].ms;
  });
  if (!inWindow.length) return { basis: 'vendor-split-adjusted-unverifiable', splitsInWindow: 0, verified: null, conflicts: [] };
  const conflicts = [];
  for (const s of inWindow) {
    const ms = Date.parse(s.date);
    let i = series.findIndex((b) => b.ms >= ms);
    if (i <= 0) continue;
    const ratio = series[i - 1].close / series[i].close;
    const factor = splitFactor(s);
    // Adjusted series → ratio ≈ 1 (± normal daily move). Raw series → ratio ≈ factor.
    const looksRaw = Math.abs(ratio / factor - 1) <= SPLIT_MATCH_TOLERANCE
      || Math.abs((1 / ratio) / factor - 1) <= SPLIT_MATCH_TOLERANCE;
    const looksAdjusted = ratio > 1 / (1 + 0.5) && ratio < 1 + 0.5 && Math.abs(factor - 1) > 0.01;
    if (looksRaw && !looksAdjusted) conflicts.push({ date: s.date, factor, observedRatio: +ratio.toFixed(4) });
  }
  return {
    basis: conflicts.length ? 'split-adjustment-conflict' : 'vendor-split-adjusted-verified',
    splitsInWindow: inWindow.length,
    verified: conflicts.length === 0,
    conflicts,
  };
}

// Total-return index over a split-adjusted close series. dividends:
// [{date, adjDividend|dividend}] — adjDividend preferred (split-adjusted,
// matching the close basis). Returns a NEW array of bars with `tr` (index,
// tr[0] = close[0]) and `divAmt` on ex-dates; input is not mutated.
function withTotalReturn(series, dividends) {
  const divByMs = new Map();
  for (const d of dividends || []) {
    const ms = Date.parse(d && d.date);
    const amt = Number.isFinite(d && d.adjDividend) ? d.adjDividend : Number(d && d.dividend);
    if (Number.isFinite(ms) && amt > 0) divByMs.set(ms, (divByMs.get(ms) || 0) + amt);
  }
  const out = new Array(series.length);
  let idx = null;
  for (let i = 0; i < series.length; i++) {
    const b = series[i];
    const divAmt = divByMs.get(b.ms) || 0;
    if (i === 0 || idx == null) idx = b.close;
    else {
      const prev = series[i - 1];
      idx = prev.close > 0 ? idx * ((b.close + divAmt) / prev.close) : idx;
    }
    out[i] = divAmt > 0 ? { ...b, tr: idx, divAmt } : { ...b, tr: idx };
  }
  return out;
}

// Classify every extreme one-session raw move. Returns
// { events: [{date, ret, prevClose, close, class, detail}], poisonedMs: Set }
// class ∈ explained-split-error (conflicting), explained-dividend,
//         legitimate-persistent, spike-revert (unresolved), ambiguous
//         (unresolved), tail-truncated (unresolved).
function extremeReturnAudit(series, { splits = [], dividends = [] } = {}) {
  const events = [];
  const poisonedMs = new Set();
  const splitByApproxMs = (splits || []).map((s) => ({ ms: Date.parse(s.date), factor: splitFactor(s) })).filter((s) => Number.isFinite(s.ms) && s.factor);
  const divByMs = new Map();
  for (const d of dividends || []) {
    const ms = Date.parse(d && d.date);
    const amt = Number.isFinite(d && d.adjDividend) ? d.adjDividend : Number(d && d.dividend);
    if (Number.isFinite(ms) && amt > 0) divByMs.set(ms, (divByMs.get(ms) || 0) + amt);
  }
  const poison = (i) => {
    for (let k = Math.max(0, i - POISON_RADIUS_BARS); k <= Math.min(series.length - 1, i + POISON_RADIUS_BARS); k++) {
      poisonedMs.add(series[k].ms);
    }
  };
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1], cur = series[i];
    if (!(prev.close > 0) || !(cur.close > 0)) continue;
    const ret = cur.close / prev.close - 1;
    const th = thresholdFor(prev.close);
    if (ret <= th.up && ret >= th.down) continue;

    const ev = { date: new Date(cur.ms).toISOString().slice(0, 10), ret: +ret.toFixed(4), prevClose: prev.close, close: cur.close };

    // 1) Matches a known split factor near this date → the vendor FAILED to
    //    adjust here (series is otherwise adjusted) → conflicting.
    const ratio = ret > 0 ? cur.close / prev.close : prev.close / cur.close;
    const nearSplit = splitByApproxMs.find((s) => Math.abs(s.ms - cur.ms) <= 5 * 86400000
      && (Math.abs(ratio / s.factor - 1) <= SPLIT_MATCH_TOLERANCE || Math.abs(ratio * s.factor - 1) <= SPLIT_MATCH_TOLERANCE));
    if (nearSplit) {
      events.push({ ...ev, class: 'explained-split-error', detail: `unadjusted split factor ${nearSplit.factor} at ${new Date(nearSplit.ms).toISOString().slice(0, 10)}` });
      poison(i);
      continue;
    }
    // 2) Large special dividend on the ex-date explains a drop.
    const div = divByMs.get(cur.ms);
    if (ret < 0 && div && div / prev.close >= Math.abs(ret) * 0.6) {
      events.push({ ...ev, class: 'explained-dividend', detail: `dividend ${div} on ex-date` });
      continue;                        // total-return layer handles it; raw label poisoning not needed
    }
    // 3) Persistence: did the market keep the new level?
    const fwd = series.slice(i + 1, i + 1 + PERSIST_BARS).map((b) => b.close).filter((c) => c > 0);
    if (!fwd.length) {
      events.push({ ...ev, class: 'tail-truncated', detail: 'no forward bars to verify persistence' });
      poison(i);
      continue;
    }
    const median = fwd.sort((a, b) => a - b)[Math.floor(fwd.length / 2)];
    if (Math.abs(median / cur.close - 1) <= PERSIST_TOLERANCE) {
      events.push({ ...ev, class: 'legitimate-persistent', detail: `median next-${fwd.length} close ${median} holds the move` });
      continue;
    }
    if (Math.abs(median / prev.close - 1) <= REVERT_TOLERANCE) {
      events.push({ ...ev, class: 'spike-revert', detail: `median next-${fwd.length} close ${median} reverted to prior level` });
      poison(i);
      continue;
    }
    events.push({ ...ev, class: 'ambiguous', detail: `median next-${fwd.length} close ${median} neither holds nor reverts` });
    poison(i);
  }
  return { version: CORPACTIONS_VERSION, events, poisonedMs };
}

const UNRESOLVED_CLASSES = Object.freeze(['explained-split-error', 'spike-revert', 'ambiguous', 'tail-truncated']);

// Does the label window [entryMs, exitMs] touch any poisoned bar?
function windowPoisoned(poisonedMs, entryMs, exitMs) {
  for (const ms of poisonedMs) if (ms > entryMs && ms <= exitMs) return true;
  return false;
}

// Full per-symbol provenance summary for the manifest.
function adjustmentProvenance({ symbol, series, corp }) {
  if (!corp) {
    return { symbol, basis: 'vendor-split-adjusted-unverified', dividendBasis: 'missing', corpActionStatus: 'missing', splitVerification: null };
  }
  const sv = verifySplitAdjustment(series, corp.splits);
  return {
    symbol,
    basis: sv.basis,
    dividendBasis: Array.isArray(corp.dividends) ? 'fmp-dividends-v1' : 'missing',
    corpActionStatus: 'cached',
    retrievedAt: corp.retrievedAt || null,
    splitVerification: sv,
  };
}

module.exports = {
  CORPACTIONS_VERSION, JUMP_THRESHOLDS, SPLIT_MATCH_TOLERANCE, PERSIST_BARS,
  PERSIST_TOLERANCE, REVERT_TOLERANCE, POISON_RADIUS_BARS, UNRESOLVED_CLASSES,
  thresholdFor, splitFactor, verifySplitAdjustment, withTotalReturn,
  extremeReturnAudit, windowPoisoned, adjustmentProvenance,
};
