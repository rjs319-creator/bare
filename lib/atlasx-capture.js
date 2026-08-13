'use strict';
// ATLAS-X — decision capture with matched controls (learn from the whole tape).
//
// A grader that only sees the names it displayed learns nothing about the ones it
// passed on. This module snapshots the FULL decision context at decision time:
// selected, rejected, near-threshold, prosecutor-vetoed, wait-recommended, removed,
// and the live-algo names ATLAS-X did NOT select — plus a matched same-sector
// CONTROL for each pick. That control set is what later powers selection-lift,
// waiting-value, prosecutor-veto-value and false-removal-rate measurement.
//
// Each item keeps only features available AT decision time (no leakage of outcome).
// Pure, deeply frozen record.

const { VERSIONS } = require('./atlasx-config');

// Liquidity tiers as an ordinal scale for the control-distance metric.
const LIQ_TIER_ORDER = Object.freeze(['thin', 'light', 'mid', 'deep', 'ultra']);
const CAP_GROUP_MISMATCH_COST = 1; // distance added when cap groups differ
const NUMERIC_KEYS = Object.freeze(['beta', 'vol', 'momentum', 'price']);

const round = (x) => Math.round(x * 1e4) / 1e4;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => (isNum(v) ? v : null);

// Normalize an item to the decision-time feature set. Anything not an object → null.
function featureItem(x) {
  if (!x || typeof x !== 'object') return null;
  return Object.freeze({
    ticker: x.ticker ?? null,
    sector: x.sector ?? null,
    beta: numOrNull(x.beta),
    vol: numOrNull(x.vol),
    liqTier: x.liqTier ?? null,
    momentum: numOrNull(x.momentum),
    price: numOrNull(x.price),
    capGroup: x.capGroup ?? null,
    reasonCode: x.reasonCode ?? null,
  });
}

const mapItems = (arr) => (Array.isArray(arr) ? arr : []).map(featureItem).filter(Boolean);
const freezeArr = (arr) => Object.freeze(arr);

function sameSector(a, b) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function liqOrd(tier) {
  if (tier == null) return null;
  const i = LIQ_TIER_ORDER.indexOf(String(tier).trim().toLowerCase());
  return i >= 0 ? i : null;
}

// Per-feature spread across the candidate pool → so a dollar of price and a unit of
// beta contribute comparably. Zero spread → 1 (no division blow-up, no dominance).
function featureRanges(items) {
  const ranges = {};
  for (const k of NUMERIC_KEYS) {
    const vals = items.map((it) => it[k]).filter(isNum);
    if (!vals.length) { ranges[k] = 1; continue; }
    const span = Math.max(...vals) - Math.min(...vals);
    ranges[k] = span > 0 ? span : 1;
  }
  return ranges;
}

function distance(a, b, ranges) {
  let d = 0;
  for (const k of NUMERIC_KEYS) {
    if (a[k] == null || b[k] == null) continue;
    d += Math.abs(a[k] - b[k]) / (ranges[k] || 1);
  }
  const la = liqOrd(a.liqTier);
  const lb = liqOrd(b.liqTier);
  if (la != null && lb != null) d += Math.abs(la - lb) / (LIQ_TIER_ORDER.length - 1);
  if (a.capGroup != null && b.capGroup != null && a.capGroup !== b.capGroup) {
    d += CAP_GROUP_MISMATCH_COST;
  }
  return d;
}

/**
 * Nearest SAME-SECTOR control for a candidate by (beta,vol,liq,momentum,price,
 * capGroup) distance. Honest: no same-sector control in the pool → null (we do not
 * fabricate a cross-sector match).
 * @returns frozen control item {…features, distance, matchedTo} | null
 */
function matchControls(candidate, pool) {
  const cand = featureItem(candidate);
  if (!cand) return null;
  const items = mapItems(pool).filter((p) => p.ticker !== cand.ticker);
  const same = items.filter((p) => sameSector(p.sector, cand.sector));
  if (!same.length) return null;

  const ranges = featureRanges(same.concat(cand));
  let best = null;
  let bestD = Infinity;
  for (const p of same) {
    const d = distance(cand, p, ranges);
    if (d < bestD) { bestD = d; best = p; }
  }
  return Object.freeze({ ...best, distance: round(bestD), matchedTo: cand.ticker });
}

// Prosecutor-vetoed items: explicit ctx list wins, else infer from a reasonCode.
function pickProsecutor(rejectedItems, ctx) {
  if (ctx && Array.isArray(ctx.prosecutorRejected)) return mapItems(ctx.prosecutorRejected);
  return rejectedItems.filter((r) => r.reasonCode && /prosecutor/i.test(String(r.reasonCode)));
}

/**
 * Build the immutable ATLAS-X capture record for a decision date.
 * @returns frozen record
 */
// SELECTION BASIS (alpha-research pass 3). `selected` is the cohort whose forward
// outcomes are compared against matched controls to measure SELECTION LIFT, so what it
// means is load-bearing for every number derived from this capture.
//
// It used to be `candidates.filter(c => c.actionable)` — the UTILITY gate alone. That
// admitted names which cleared expected value, prosecutor, R:R, liquidity and regime but
// had NO valid entry (`entry.action: 'NO_TRADE'`), i.e. names the system displayed under
// Avoid and could not have traded. Selection lift measured over that cohort answers "did
// names that passed the utility gate outperform?", which is not the question the metric
// is used to answer.
//
// `selected` now means WOULD HAVE BEEN ACTED ON — consistent with the portfolio gate.
// Names that cleared the utility gate without an entry are NOT pushed into `rejected`
// (which means "failed the utility gate" and feeds prosecutorRejected); they get their
// own bucket, so no name silently changes category and the distinction stays measurable.
const SELECTION_BASIS = 'actionable AND enterable entry action (utility gate + valid entry)';

function buildCapture({ date, selected, rejected, nearMiss, controls, todayCandidates, ctx, qualifiedNoEntry } = {}) {
  const sel = mapItems(selected);
  const rej = mapItems(rejected);
  const near = mapItems(nearMiss);
  const qne = mapItems(qualifiedNoEntry);

  const matchedControls = sel
    .map((s) => matchControls(s, controls))
    .filter(Boolean);

  const selectedTickers = new Set(sel.map((s) => s.ticker));
  const currentAlgoNotSelected = mapItems(todayCandidates)
    .filter((c) => !selectedTickers.has(c.ticker));

  return Object.freeze({
    date: date ?? null,
    version: VERSIONS.strategy,
    // Stamped so a reader can tell which definition a stored capture was built under —
    // this changed, and silently redefining a research cohort would corrupt any
    // comparison across the boundary.
    selectionBasis: SELECTION_BASIS,
    selected: freezeArr(sel),
    // Cleared the utility gate but had no valid entry. Distinct from `rejected` (failed
    // the gate) and from `selected` (would have been acted on).
    qualifiedNoEntry: freezeArr(qne),
    rejected: freezeArr(rej),
    nearThreshold: freezeArr(near),
    matchedControls: freezeArr(matchedControls),
    prosecutorRejected: freezeArr(pickProsecutor(rej, ctx)),
    waitRecommended: freezeArr(mapItems(ctx && ctx.waitRecommended)),
    removed: freezeArr(mapItems(ctx && ctx.removed)),
    currentAlgoNotSelected: freezeArr(currentAlgoNotSelected),
  });
}

module.exports = { featureItem, matchControls, buildCapture, LIQ_TIER_ORDER };
