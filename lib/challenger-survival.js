'use strict';
// challenger-survival.js — competing-risk target/stop/timeout timing layer
// (`challenger-survival-v1`). SHADOW ONLY.
//
// Estimates, for a candidate entered now, the competing-risk probabilities:
//   P(target before stop), P(stop before target), P(neither before the time limit),
// plus expected sessions to resolution and an entry-state classification.
//
// Built over the existing triple-barrier labels (evolve-labels.tripleBarrier), with
// HIERARCHICAL shrinkage across horizon -> family -> regime -> cap -> stage -> event so a
// tiny subgroup can never produce an extreme probability (it shrinks toward broader priors).
// On EOD data these are next-session positioning decisions, not intraday-precise claims.

const { MAX_AGE_BARS } = require('./decision');
let capBucketFn = null;
function capBucket(dollarVol) {
  if (!capBucketFn) { try { capBucketFn = require('./evolve').capBucket; } catch { capBucketFn = () => 'unknown'; } }
  return capBucketFn(dollarVol);
}

const SURVIVAL_VERSION = 'challenger-survival-v1';

// Honest, slightly-pessimistic cold-start prior used when no history supports a cell.
const DEFAULT_PRIOR = { pTarget: 0.35, pStop: 0.40, pNeither: 0.25 };
const PRIOR_STRENGTH = 12; // pseudo-count mass pulling each level toward its parent estimate

const ENTRY_STATES = ['ENTER_NOW', 'WAIT_FOR_PULLBACK', 'WAIT_FOR_BREAKOUT', 'WAIT_FOR_CONFIRMATION', 'STALE', 'INVALID'];

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// --- subgroup keying ---------------------------------------------------------
function stageOf(sig) {
  const st = sig && sig.state;
  if (st === 'detected' || st === 'early') return 'forming';
  if (st === 'ready') return 'ready';
  if (st === 'triggered') return 'triggered';
  if (st === 'extended') return 'extended';
  return 'unknown';
}
function eventTypeOf(sig) {
  if (sig && sig.eventSurprise && sig.eventSurprise.category) return sig.eventSurprise.category;
  if (sig && sig.event && sig.event.type) return sig.event.type;
  return 'none';
}
// Ordered most-general -> most-specific so prefixes form the shrinkage ladder.
function keyPartsFor(sig, ctx = {}) {
  const horizon = (sig && sig.horizon) || 'swing';
  const family = (sig && sig.strategyFamily) || 'trend';
  const regime = (ctx.regime && ctx.regime.label) || (sig && sig.regimeLabel) || 'neutral';
  const cap = capBucket(sig && sig.liquidity && sig.liquidity.dollarVol);
  return [horizon, family, regime, cap, stageOf(sig), eventTypeOf(sig)];
}

// --- table construction ------------------------------------------------------
// Accumulate competing-risk counts at EVERY prefix granularity, so estimateSurvival can
// walk coarse->fine. `events`: resolved labeled events with { barrier|outcome, keyParts,
// barsToBarrier, windowUsed }. `barrier` in {upper->target, lower->stop, time->neither}.
function outcomeOf(ev) {
  const b = ev.barrier || ev.outcome;
  if (b === 'upper' || b === 'target') return 'target';
  if (b === 'lower' || b === 'stop') return 'stop';
  if (b === 'time' || b === 'neither' || b === 'timeout') return 'neither';
  return null;
}
function buildSurvivalTable(events) {
  const table = new Map();
  const bump = (key, oc, bars) => {
    let c = table.get(key);
    if (!c) { c = { target: 0, stop: 0, neither: 0, n: 0, barsSum: 0, barsN: 0 }; table.set(key, c); }
    c[oc] += 1; c.n += 1;
    if (isNum(bars)) { c.barsSum += bars; c.barsN += 1; }
  };
  for (const ev of (events || [])) {
    const oc = outcomeOf(ev);
    if (!oc) continue;
    const parts = ev.keyParts || keyPartsFor(ev, { regime: { label: ev.regimeLabel } });
    const bars = isNum(ev.barsToBarrier) ? ev.barsToBarrier : (isNum(ev.windowUsed) ? ev.windowUsed : null);
    bump('GLOBAL', oc, bars);
    for (let level = 1; level <= parts.length; level++) bump(parts.slice(0, level).join('|'), oc, bars);
  }
  return table;
}

// Empirical-Bayes update of a running estimate toward a cell's observed rates.
function ebUpdate(cell, prior, strength) {
  const denom = cell.n + strength;
  return {
    pTarget: (cell.target + strength * prior.pTarget) / denom,
    pStop: (cell.stop + strength * prior.pStop) / denom,
    pNeither: (cell.neither + strength * prior.pNeither) / denom,
  };
}

// Walk coarse->fine, shrinking each present level toward the running estimate.
function shrunkProbs(parts, table) {
  const global = table.get('GLOBAL');
  let est = { ...DEFAULT_PRIOR };
  if (global && global.n > 0) est = ebUpdate(global, DEFAULT_PRIOR, PRIOR_STRENGTH);
  let effN = 0;
  let levelsUsed = 0;
  let finestBars = null;
  for (let level = 1; level <= parts.length; level++) {
    const cell = table.get(parts.slice(0, level).join('|'));
    if (!cell || cell.n === 0) continue;
    est = ebUpdate(cell, est, PRIOR_STRENGTH);
    effN = cell.n;
    levelsUsed = level;
    if (cell.barsN > 0) finestBars = cell.barsSum / cell.barsN;
  }
  const s = est.pTarget + est.pStop + est.pNeither || 1;
  return {
    pTarget: est.pTarget / s,
    pStop: est.pStop / s,
    pNeither: est.pNeither / s,
    effN,
    levelsUsed,
    finestBars,
    shrunkToPrior: levelsUsed === 0,
  };
}

// --- entry-state classifier --------------------------------------------------
// Deterministic rules over lifecycle state, remaining-edge freshness, and price-vs-entry.
function classifyEntryState(sig) {
  const st = sig && sig.state;
  const re = sig && sig.remainingEdge;
  const fresh = re && re.freshness;
  const side = (sig && sig.side) === 'short' ? 'short' : 'long';
  const price = num(sig && sig.price);
  const entry = num(sig && sig.entry);
  const stop = num(sig && sig.stop);

  if (st === 'failed' || fresh === 'invalidated' || entry == null || stop == null) return 'INVALID';
  if (st === 'expired' || fresh === 'expired' || fresh === 'late' || st === 'extended') return 'STALE';

  // Price relative to the entry trigger tells pullback vs breakout.
  if (price != null && entry != null && entry !== 0) {
    const ext = (price - entry) / entry; // +ve = above entry
    const beyond = side === 'long' ? ext : -ext; // how far in the trade's favor past entry
    if (st === 'ready' || st === 'triggered') {
      if (beyond > 0.04) return 'WAIT_FOR_PULLBACK'; // extended past trigger -> better to wait
      if (beyond < -0.03) return 'WAIT_FOR_BREAKOUT'; // not yet at trigger
      return 'ENTER_NOW';
    }
    if (st === 'detected' || st === 'early') {
      return beyond < -0.005 ? 'WAIT_FOR_BREAKOUT' : 'WAIT_FOR_CONFIRMATION';
    }
  }
  if (st === 'ready' || st === 'triggered') return 'ENTER_NOW';
  return 'WAIT_FOR_CONFIRMATION';
}

function preferredEntryFor(state) {
  switch (state) {
    case 'WAIT_FOR_PULLBACK': return 'pullback';
    case 'WAIT_FOR_BREAKOUT': return 'breakout';
    case 'WAIT_FOR_CONFIRMATION': return 'vwap-reclaim-or-confirmation';
    case 'ENTER_NOW': return 'next-open';
    default: return null;
  }
}

function num(v) { return isNum(v) ? v : null; }
function round(v, d) { if (!isNum(v)) return null; const m = Math.pow(10, d); return Math.round(v * m) / m; }

// Main entry. `sig` enriched signal; ctx: { table (buildSurvivalTable output), regime }.
function assessSurvival(sig, ctx = {}) {
  const table = ctx.table instanceof Map ? ctx.table : new Map();
  const parts = keyPartsFor(sig, ctx);
  const probs = shrunkProbs(parts, table);

  const horizon = (sig && sig.horizon) || 'swing';
  const maxHoldBars = MAX_AGE_BARS[horizon] != null ? MAX_AGE_BARS[horizon] : 10;
  const ageBars = isNum(sig && sig.ageBars) ? sig.ageBars : 0;
  const sessionsRemaining = Math.max(0, maxHoldBars - ageBars);

  const entryState = classifyEntryState(sig);
  const preferredEntry = preferredEntryFor(entryState);

  // Edge now vs after waiting one session. Entering now captures the net edge but eats one
  // more session of decay; while WAITING (not yet entered) the setup edge persists to expiry.
  const re = sig && sig.remainingEdge;
  const edgeNowPct = re && re.rated && isNum(re.netRemainingPct) ? re.netRemainingPct : null;
  let edgeAfterWaitPct = edgeNowPct;
  let preferEntering = entryState === 'ENTER_NOW';
  if (edgeNowPct != null) {
    if (entryState === 'ENTER_NOW') edgeAfterWaitPct = round(edgeNowPct * 0.97, 2); // one bar of decay if you delay
    else edgeAfterWaitPct = edgeNowPct; // waiting preserves the setup edge until expiry
    preferEntering = entryState === 'ENTER_NOW' && probs.pTarget > probs.pStop;
  }

  const expectedSessionsToResolution = probs.finestBars != null
    ? round(probs.finestBars, 1)
    : round(maxHoldBars * (probs.pNeither + 0.5 * (probs.pTarget + probs.pStop)), 1);

  return {
    version: SURVIVAL_VERSION,
    isPrediction: true, // model estimate, NOT a validated probability
    pTargetBeforeStop: round(probs.pTarget, 3),
    pStopBeforeTarget: round(probs.pStop, 3),
    pNeither: round(probs.pNeither, 3),
    effN: probs.effN,
    levelsUsed: probs.levelsUsed,
    shrunkToPrior: probs.shrunkToPrior,
    expectedSessionsToResolution,
    entryState,
    preferredEntry,
    basis: 'eod-next-session', // EOD data => next-session positioning, not intraday precision
    edgeNowPct,
    edgeAfterWaitPct,
    preferEntering,
    setupExpiry: { maxHoldBars, ageBars, sessionsRemaining },
  };
}

module.exports = {
  SURVIVAL_VERSION,
  DEFAULT_PRIOR,
  PRIOR_STRENGTH,
  ENTRY_STATES,
  keyPartsFor,
  stageOf,
  eventTypeOf,
  outcomeOf,
  buildSurvivalTable,
  shrunkProbs,
  classifyEntryState,
  assessSurvival,
};
