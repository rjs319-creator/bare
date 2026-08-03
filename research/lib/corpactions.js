'use strict';
// CORPORATE-ACTION / ADJUSTED-PRICE LAYER (corpactions-v2)
//
// The cached FMP `historical-price-eod/full` closes are VENDOR-SPLIT-ADJUSTED
// (verified empirically: CELH 3:1 2023-11-15 and GME 4:1 2022-07-22 show no
// discontinuity) but NOT dividend-adjusted, and carried no provenance. This
// layer makes the basis explicit, verified and versioned.
//
// v2 CORRECTION (verified defect in v1): v1's extremeReturnAudit looked at ~5
// FUTURE bars to classify an extreme move (persistent vs spike-revert vs
// ambiguous) and then POISONED the reverting/ambiguous ones — so whether an
// observation stayed trainable depended on how the market performed AFTER the
// decision. That is selection leakage. v2 separates two layers:
//
//   A. DECISION-TIME VALIDATION (decisionTimeQualityAudit) — may use only
//      facts knowable at the bar's own timestamp: known splits/dividends,
//      same-session OHLC consistency, duplicate/malformed vendor records,
//      residual unadjusted-split discontinuities. ONLY this layer poisons.
//      An extreme move with no structural inconsistency is an OBSERVED MARKET
//      MOVE: it stays, whatever the future path did. It is flagged
//      ('unconfirmed-extreme', extremeMs) purely so experiments can run the
//      SYMMETRIC sensitivity views (include all / exclude all — never
//      "exclude only the ones that later reverted").
//
//   B. POST-EVENT DIAGNOSTICS (postEventPersistenceDiagnostics) — the old
//      persistence/reversion read, retained as a research diagnostic. It can
//      never determine whether a row exists, poison an entry, withhold a
//      label, or change cohort eligibility. Every record it emits carries
//      diagnosticOnly: true.
//
// Pure module: no network. The fetch script owns I/O.

const CORPACTIONS_VERSION = 'corpactions-v2';

// Detection thresholds by prior-close tier. Detection is deliberately wider
// than "impossible" — classification decides what survives.
const JUMP_THRESHOLDS = Object.freeze([
  { minPrev: 5, up: 0.60, down: -0.45 },
  { minPrev: 1, up: 1.00, down: -0.60 },
  { minPrev: 0, up: 2.00, down: -0.80 },
]);
const SPLIT_MATCH_TOLERANCE = 0.15;     // relative match of jump ratio to split factor
const PERSIST_BARS = 5;                 // diagnostics only: bars used to describe persistence
const PERSIST_TOLERANCE = 0.35;         // diagnostics only
const REVERT_TOLERANCE = 0.20;          // diagnostics only
const POISON_RADIUS_BARS = 1;           // poisoned bar ± this many bars is untrainable
const OHLC_TOLERANCE = 0.001;           // relative tolerance for close within [low, high]

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

// ── Layer A: DECISION-TIME VALIDATION ─────────────────────────────────────────
// Classifies every bar/extreme using ONLY decision-time evidence. Returns
// { version, events, poisonedMs: Set, extremeMs: Set } where
//   events[].class ∈ explained-split-error (poison), explained-dividend (keep),
//                    duplicate-bar (poison), ohlc-inconsistent (poison),
//                    non-positive-price (poison), unconfirmed-extreme (KEEP —
//                    observed market move, flagged for symmetric sensitivity)
// Bars may carry optional {open, high, low} for same-session consistency.
function decisionTimeQualityAudit(series, { splits = [], dividends = [] } = {}) {
  const events = [];
  const poisonedMs = new Set();
  const extremeMs = new Set();
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
  const isoOf = (b) => new Date(b.ms).toISOString().slice(0, 10);

  const seenMs = new Set();
  for (let i = 0; i < series.length; i++) {
    const cur = series[i];
    // Duplicate vendor record for the same session — structurally malformed.
    if (seenMs.has(cur.ms)) {
      events.push({ date: isoOf(cur), class: 'duplicate-bar', detail: 'multiple bars share one session timestamp' });
      poison(i);
    }
    seenMs.add(cur.ms);
    // Same-session OHLC consistency (when OHLC is present on the bar).
    if (Number.isFinite(cur.high) && Number.isFinite(cur.low)) {
      const lo = cur.low * (1 - OHLC_TOLERANCE), hi = cur.high * (1 + OHLC_TOLERANCE);
      const bad = cur.low > cur.high * (1 + OHLC_TOLERANCE)
        || (Number.isFinite(cur.close) && (cur.close < lo || cur.close > hi))
        || (Number.isFinite(cur.open) && (cur.open < lo || cur.open > hi));
      if (bad) {
        events.push({ date: isoOf(cur), class: 'ohlc-inconsistent', detail: `open/close outside [low, high]: o=${cur.open} h=${cur.high} l=${cur.low} c=${cur.close}` });
        poison(i);
      }
    }
    if (i === 0) continue;
    const prev = series[i - 1];
    if (!(prev.close > 0) || !(cur.close > 0)) {
      if (!(cur.close > 0)) { events.push({ date: isoOf(cur), class: 'non-positive-price', detail: `close=${cur.close}` }); poison(i); }
      continue;
    }
    const ret = cur.close / prev.close - 1;
    const th = thresholdFor(prev.close);
    if (ret <= th.up && ret >= th.down) continue;

    const ev = { date: isoOf(cur), ret: +ret.toFixed(4), prevClose: prev.close, close: cur.close };

    // 1) Matches a known split factor near this date → the vendor FAILED to
    //    adjust here (series is otherwise adjusted) → structural conflict.
    //    Decision-time evidence: the split record and the jump are contemporaneous.
    const ratio = ret > 0 ? cur.close / prev.close : prev.close / cur.close;
    const nearSplit = splitByApproxMs.find((s) => Math.abs(s.ms - cur.ms) <= 5 * 86400000
      && (Math.abs(ratio / s.factor - 1) <= SPLIT_MATCH_TOLERANCE || Math.abs(ratio * s.factor - 1) <= SPLIT_MATCH_TOLERANCE));
    if (nearSplit) {
      events.push({ ...ev, class: 'explained-split-error', detail: `unadjusted split factor ${nearSplit.factor} at ${new Date(nearSplit.ms).toISOString().slice(0, 10)}` });
      poison(i);
      continue;
    }
    // 2) Large special dividend on the ex-date explains a drop (decision-time
    //    corporate-action evidence; total-return layer handles the economics).
    const div = divByMs.get(cur.ms);
    if (ret < 0 && div && div / prev.close >= Math.abs(ret) * 0.6) {
      events.push({ ...ev, class: 'explained-dividend', detail: `dividend ${div} on ex-date` });
      continue;
    }
    // 3) No structural inconsistency: this is an OBSERVED MARKET MOVE. With a
    //    single provider it cannot be cross-confirmed, so it is flagged for the
    //    symmetric sensitivity views — but it is NEVER poisoned, and its future
    //    path plays no part in this decision.
    events.push({ ...ev, class: 'unconfirmed-extreme', detail: 'no corporate-action or structural explanation; retained as an observed market move (single-provider, unconfirmable)' });
    extremeMs.add(cur.ms);
  }
  return { version: CORPACTIONS_VERSION, events, poisonedMs, extremeMs };
}

// Classes that poison — ALL are decision-time structural evidence. Future-path
// classes (spike-revert/ambiguous/tail-truncated) may never appear here.
const POISONING_CLASSES = Object.freeze(['explained-split-error', 'duplicate-bar', 'ohlc-inconsistent', 'non-positive-price']);

// ── Layer B: POST-EVENT DIAGNOSTICS (research only, never data cleaning) ─────
// Describes how each unconfirmed extreme resolved. Output is diagnosticOnly:
// consumers MUST NOT use it to gate rows, labels, or cohorts (the audit gate
// enforces this: poisoning classes are restricted to POISONING_CLASSES).
function postEventPersistenceDiagnostics(series, auditEvents) {
  const byDate = new Map(series.map((b, i) => [new Date(b.ms).toISOString().slice(0, 10), i]));
  const out = [];
  for (const ev of auditEvents || []) {
    if (ev.class !== 'unconfirmed-extreme') continue;
    const i = byDate.get(ev.date);
    if (i == null) continue;
    const cur = series[i], prev = series[i - 1];
    const fwd = series.slice(i + 1, i + 1 + PERSIST_BARS).map((b) => b.close).filter((c) => c > 0);
    let persistence, detail;
    if (!fwd.length) { persistence = 'tail-truncated'; detail = 'no forward bars to describe persistence'; }
    else {
      const median = fwd.sort((a, b) => a - b)[Math.floor(fwd.length / 2)];
      if (Math.abs(median / cur.close - 1) <= PERSIST_TOLERANCE) { persistence = 'persistent'; detail = `median next-${fwd.length} close ${median} holds the move`; }
      else if (prev && Math.abs(median / prev.close - 1) <= REVERT_TOLERANCE) { persistence = 'reverted'; detail = `median next-${fwd.length} close ${median} returned to the prior level`; }
      else { persistence = 'ambiguous'; detail = `median next-${fwd.length} close ${median} neither holds nor reverts`; }
    }
    out.push({ ...ev, diagnosticOnly: true, persistence, persistenceDetail: detail });
  }
  return out;
}

// Does the window (entryMs, exitMs] touch any flagged bar?
function windowTouches(msSet, entryMs, exitMs) {
  for (const ms of msSet) if (ms > entryMs && ms <= exitMs) return true;
  return false;
}
const windowPoisoned = windowTouches;   // structural poison (labels withheld)
const windowExtreme = windowTouches;    // sensitivity flag (labels KEPT, row marked)

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
  PERSIST_TOLERANCE, REVERT_TOLERANCE, POISON_RADIUS_BARS, POISONING_CLASSES,
  OHLC_TOLERANCE,
  thresholdFor, splitFactor, verifySplitAdjustment, withTotalReturn,
  decisionTimeQualityAudit, postEventPersistenceDiagnostics,
  windowPoisoned, windowExtreme, adjustmentProvenance,
};
