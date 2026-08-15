'use strict';
// Tech Operational Evidence — forward alpha ledger.
//
// Entry contract: a signal observed at cutoff C (always derived from data public by C)
// may first execute at the OPEN of the next regular session after C — a signal observed
// after the close never enters at that same close. Geometry mirrors
// research/lib/experiment-kit.forwardFromNextOpen: with decision bar index i,
//   H-session return = candles[i+H].close / candles[i+1].open − 1.
// Benchmark residual uses the identical geometry on the mapping's subsector ETF.
// A resolution day is postponed WHOLE if any event is not yet mature — partial
// resolution would introduce selection bias (same rule as the dilution ledger).

const SCHEMA = require('./schema');
const { roundTripCostPct } = require('../costs');

const FORWARD_VERSION = 'techev-forward-v1';
const HORIZONS = SCHEMA.HORIZONS;                 // [1, 5, 10]
const MATURITY_CALENDAR_DAYS = 16;                // ≥10 sessions + weekends/holidays buffer
const OVERLAP_BLOCK_SESSIONS_DAYS = 9;            // no new event for (arm,ticker) within ~5 sessions
const LIQUID_ADV_USD = 2e7;                       // mirrors experiment-kit costFractions threshold
const MAX_EVENT_AGE_DAYS = 650;                   // beyond ~2y of candles we cannot resolve honestly

// ── event creation (pure) ────────────────────────────────────────────────────
// priorEvents: [{ d, t, arm }] from the forward index — the overlap/dedup authority.
function eventsFromSignals(signals, { cutoffDate, priorEvents = [], benchmarkFor, createdAt }) {
  const dayMs = 86400000;
  const tooClose = (p) => (new Date(cutoffDate + 'T00:00:00Z') - new Date(p.d + 'T00:00:00Z')) / dayMs < OVERLAP_BLOCK_SESSIONS_DAYS;
  const events = [];
  const skipped = [];
  for (const s of signals) {
    if (!s.eligible) continue;
    if (priorEvents.some((p) => p.t === s.ticker && p.arm === s.arm && tooClose(p))) {
      skipped.push({ ticker: s.ticker, arm: s.arm, reason: 'overlapping-open-event' });
      continue;
    }
    const benchmark = benchmarkFor(s.ticker);
    if (!benchmark) { skipped.push({ ticker: s.ticker, arm: s.arm, reason: 'no-benchmark' }); continue; }
    events.push(Object.freeze({
      v: FORWARD_VERSION, id: SCHEMA.forwardEventId({ arm: s.arm, ticker: s.ticker, cutoffDate }),
      arm: s.arm, ticker: s.ticker, cutoffDate,
      signalId: s.id, mappingId: s.mappingId, benchmark,
      direction: s.direction, z: s.z, surprise: s.surprise, adjustedSurprise: s.adjustedSurprise,
      basis: s.basis || 'live',
      entryPolicy: 'next-regular-session-open-after-cutoff',
      createdAt,
    }));
  }
  return { events, skipped };
}

// ── resolution math (pure) ───────────────────────────────────────────────────
function advUsd(candles, lookback = 60) {
  const tail = candles.slice(-lookback);
  if (!tail.length) return null;
  const vals = tail.map((c) => (Number(c.close) || 0) * (Number(c.volume) || 0)).filter((v) => v > 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function horizonReturns(candles, cutoffDate) {
  if (!Array.isArray(candles) || !candles.length) return { status: 'no-history' };
  let decIdx = -1;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    if (candles[i].date <= cutoffDate) { decIdx = i; break; }
  }
  if (decIdx < 0) return { status: 'no-decision-bar' };
  const maxH = HORIZONS[HORIZONS.length - 1];
  if (decIdx + maxH >= candles.length) return { status: 'not-mature' };
  const entryBar = candles[decIdx + 1];
  const entry = Number(entryBar && entryBar.open);
  if (!Number.isFinite(entry) || entry <= 0) return { status: 'bad-prices' };
  const returns = {};
  for (const H of HORIZONS) {
    const exit = Number(candles[decIdx + H] && candles[decIdx + H].close);
    if (!Number.isFinite(exit) || exit <= 0) return { status: 'bad-prices' };
    returns[H] = exit / entry - 1; // FRACTION
  }
  return { status: 'ok', returns, entryDate: entryBar.date, entryPrice: entry, exitDates: Object.fromEntries(HORIZONS.map((H) => [H, candles[decIdx + H].date])) };
}

// Resolve one event given its candles + benchmark candles. Fractions throughout.
function resolveEvent(event, candles, benchCandles) {
  const stock = horizonReturns(candles, event.cutoffDate);
  if (stock.status !== 'ok') return { id: event.id, status: stock.status };
  const bench = horizonReturns(benchCandles, event.cutoffDate);
  if (bench.status === 'not-mature') return { id: event.id, status: 'not-mature' };
  if (bench.status !== 'ok') return { id: event.id, status: 'no-benchmark-data' };
  const adv = advUsd(candles);
  const tier = adv != null && adv >= LIQUID_ADV_USD ? 'liquid' : 'small';
  const costFraction = roundTripCostPct(tier) / 100; // lib/costs is PERCENT — convert once, here
  const gross = {};
  const benchmark = {};
  const netResidual = {};
  for (const H of HORIZONS) {
    gross[H] = stock.returns[H];
    benchmark[H] = bench.returns[H];
    netResidual[H] = stock.returns[H] - bench.returns[H] - costFraction;
  }
  return {
    id: event.id, status: 'resolved',
    entryDate: stock.entryDate, entryPrice: stock.entryPrice, exitDates: stock.exitDates,
    gross, benchmark, netResidual, costFraction, tier,
    priceBasis: 'split-adjusted daily bars, entry next open, exit close',
  };
}

// Compact scorecard row (fractions; NEVER pre-round — stats need full precision).
function toRow(event, resolution) {
  return {
    d: event.cutoffDate, t: event.ticker, arm: event.arm,
    dir: event.direction, z: event.z, basis: event.basis,
    e: resolution.entryDate,
    g: HORIZONS.map((H) => resolution.gross[H]),
    b: HORIZONS.map((H) => resolution.benchmark[H]),
    n: HORIZONS.map((H) => resolution.netResidual[H]),
    cost: resolution.costFraction, tier: resolution.tier, bench: event.benchmark,
  };
}

function maturityCutoffDate(now = new Date()) {
  return new Date(now.getTime() - MATURITY_CALENDAR_DAYS * 86400000).toISOString().slice(0, 10);
}

function historyRangeFor(cutoffDate, now = new Date()) {
  const ageDays = Math.round((now - new Date(cutoffDate + 'T00:00:00Z')) / 86400000);
  if (ageDays > MAX_EVENT_AGE_DAYS) return null;
  return ageDays > 200 ? '2y' : '1y';
}

module.exports = {
  FORWARD_VERSION, HORIZONS, MATURITY_CALENDAR_DAYS, MAX_EVENT_AGE_DAYS, LIQUID_ADV_USD,
  eventsFromSignals, horizonReturns, resolveEvent, toRow, advUsd,
  maturityCutoffDate, historyRangeFor,
};
