'use strict';
// STAGE 5 — LARGE-MOVER MISS AUDIT. After the close, find the day's actual biggest movers and
// answer, for each one, the only question that improves a discovery system: *where in our own
// pipeline did this fall out?*
//
// This is deliberately the most uncomfortable report in the app. It is not a performance
// scoreboard — it is a list of the stocks that made the moves this system exists to find, with
// the specific stage and reason each was lost. Without it, "improving recall" is guesswork:
// you cannot tell whether you are missing names because they were never in the universe,
// because a filter deleted them, because they were found and ranked 180th, or because they
// were found and then suppressed by a model answering a different question.
//
// EVERY MISS GETS A CATEGORY. "UNKNOWN" is available but is itself a finding — a high UNKNOWN
// share means the audit's own evidence trail is inadequate, and that is reported.

const { AUDIT_VERSION, SCHEMA_VERSION } = require('./lowfloat-config');

// The pipeline stages a candidate can reach, in order. `pipelineStageReached` is the furthest
// stage the audit can prove the name got to.
const STAGES = Object.freeze([
  'NOT_IN_UNIVERSE', 'UNIVERSE', 'BULK_QUOTE', 'DISCOVERY', 'FLOAT_ENRICHMENT',
  'INTRADAY_ENRICHMENT', 'STRUCTURE', 'ACTIONABILITY', 'DISPLAYED', 'PAPER_ENTRY',
]);

const MISS_CATEGORIES = Object.freeze({
  NOT_IN_UNIVERSE: 'NOT_IN_UNIVERSE',
  SECURITY_TYPE_EXCLUDED: 'SECURITY_TYPE_EXCLUDED',
  FLOAT_UNAVAILABLE: 'FLOAT_UNAVAILABLE',
  FLOAT_STALE: 'FLOAT_STALE',
  BATCH_QUOTE_MISSING: 'BATCH_QUOTE_MISSING',
  HISTORICAL_VOLUME_FILTER: 'HISTORICAL_VOLUME_FILTER',
  PRICE_FILTER: 'PRICE_FILTER',
  CURRENT_LIQUIDITY_FILTER: 'CURRENT_LIQUIDITY_FILTER',
  NOT_ENOUGH_PERCENT_GAIN: 'NOT_ENOUGH_PERCENT_GAIN',
  NOT_ENOUGH_RVOL: 'NOT_ENOUGH_RVOL',
  NOT_SELECTED_FOR_INTRADAY_ENRICHMENT: 'NOT_SELECTED_FOR_INTRADAY_ENRICHMENT',
  RANKED_TOO_LOW: 'RANKED_TOO_LOW',
  PCARRY_SUPPRESSED: 'PCARRY_SUPPRESSED',
  CATALYST_NOT_FOUND: 'CATALYST_NOT_FOUND',
  DATA_STALE: 'DATA_STALE',
  REFRESH_INTERVAL_MISS: 'REFRESH_INTERVAL_MISS',
  MOVE_OCCURRED_DURING_HALT: 'MOVE_OCCURRED_DURING_HALT',
  MOVE_ALREADY_COMPLETE_AT_DETECTION: 'MOVE_ALREADY_COMPLETE_AT_DETECTION',
  STRUCTURE_FILTER_REJECTED: 'STRUCTURE_FILTER_REJECTED',
  EXECUTION_BLOCKED: 'EXECUTION_BLOCKED',
  UNKNOWN: 'UNKNOWN',
});

const CATEGORY_LABEL = Object.freeze({
  NOT_IN_UNIVERSE: 'Never in the eligible universe',
  SECURITY_TYPE_EXCLUDED: 'Excluded by security type (ETF, warrant, unit, preferred…)',
  FLOAT_UNAVAILABLE: 'No float data, so the low-float lane could not see it',
  FLOAT_STALE: 'Float data too old to credit',
  BATCH_QUOTE_MISSING: 'The bulk-quote provider never returned it',
  HISTORICAL_VOLUME_FILTER: 'Removed by a historical average-volume gate',
  PRICE_FILTER: 'Outside the price band',
  CURRENT_LIQUIDITY_FILTER: 'Below the current-session dollar-volume floor',
  NOT_ENOUGH_PERCENT_GAIN: 'Did not reach the percent-move threshold while we were looking',
  NOT_ENOUGH_RVOL: 'Relative volume never cleared the threshold',
  NOT_SELECTED_FOR_INTRADAY_ENRICHMENT: 'Discovered, but the enrichment budget did not reach it',
  RANKED_TOO_LOW: 'Discovered and enriched, but ranked below the display cut',
  PCARRY_SUPPRESSED: 'Suppressed by the multi-session carry model',
  CATALYST_NOT_FOUND: 'Catalyst lane found nothing for it',
  DATA_STALE: 'Its data was stale when it mattered',
  REFRESH_INTERVAL_MISS: 'The move happened between two scans',
  MOVE_OCCURRED_DURING_HALT: 'The move occurred across a halt',
  MOVE_ALREADY_COMPLETE_AT_DETECTION: 'Detected, but the move was already over',
  STRUCTURE_FILTER_REJECTED: 'The intraday structure model rejected it',
  EXECUTION_BLOCKED: 'Execution checks blocked it',
  UNKNOWN: 'Cause could not be determined from the evidence trail',
});

const finite = v => Number.isFinite(v);
const pctChange = (a, b) => (finite(a) && finite(b) && b > 0 ? +(((a / b) - 1) * 100).toFixed(2) : null);

// ── Mover ranking from end-of-day quotes ─────────────────────────────────────
// `quotes` are the post-close bulk-quote rows (open / dayHigh / dayLow / price / prevClose).
// Five leaderboards, because "biggest mover" means different things to different setups.
function rankMovers(quotes, { topN = 20 } = {}) {
  const rows = (quotes || [])
    .filter(q => q && finite(q.price) && finite(q.open) && finite(q.dayHigh) && finite(q.dayLow) && q.open > 0 && q.dayLow > 0)
    .map(q => ({
      ticker: q.ticker,
      sessionOpen: q.open,
      sessionHigh: q.dayHigh,
      sessionLow: q.dayLow,
      sessionClose: q.price,
      prevClose: finite(q.prevClose) ? q.prevClose : null,
      sessionVolume: finite(q.dayVolume) ? q.dayVolume : null,
      sessionDollarVolume: finite(q.dayVolume) ? Math.round(q.dayVolume * q.price) : null,
      openToHighPct: pctChange(q.dayHigh, q.open),
      lowToHighPct: pctChange(q.dayHigh, q.dayLow),
      closeToHighPct: pctChange(q.dayHigh, q.price),
      dayChangePct: finite(q.prevClose) ? pctChange(q.price, q.prevClose) : null,
    }));

  const top = (key) => [...rows]
    .filter(r => finite(r[key]))
    .sort((a, b) => b[key] - a[key])
    .slice(0, topN);

  return {
    byOpenToHigh: top('openToHighPct'),
    byLowToHigh: top('lowToHighPct'),
    byDayChange: top('dayChangePct'),
    byCloseStrength: [...rows]
      .filter(r => finite(r.closeToHighPct))
      .sort((a, b) => a.closeToHighPct - b.closeToHighPct)   // closed nearest its high
      .slice(0, topN),
    universeScanned: rows.length,
  };
}

// Maximum N-minute return inside a session, from five-minute bars. Used only for the top
// movers (bounded), because it needs a per-symbol chart fetch.
function maxWindowReturn(bars, windowMin) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  let best = null;
  for (let i = 0; i < bars.length; i++) {
    const startMs = Date.parse(bars[i].t);
    const ref = bars[i].o;
    if (!(ref > 0)) continue;
    for (let j = i; j < bars.length; j++) {
      if (Date.parse(bars[j].t) - startMs > windowMin * 60_000) break;
      const r = ((bars[j].h / ref) - 1) * 100;
      if (best == null || r > best) best = r;
    }
  }
  return best == null ? null : +best.toFixed(2);
}

// ── Evidence trail lookup ────────────────────────────────────────────────────
// Builds, for one ticker, everything the pipeline recorded about it during the session.
// `trail` = { universe:Set|Map, universeExclusions:Map, quoted:Set, discovery:[snapshots],
//             ignition:[snapshots], continuation:[snapshots], events:[], rejections:[] }
function traceTicker(ticker, trail = {}) {
  const t = String(ticker || '').toUpperCase();
  const inUniverse = trail.universe instanceof Set ? trail.universe.has(t)
    : (trail.universe && typeof trail.universe.get === 'function' ? !!trail.universe.get(t) : false);
  const universeExclusion = trail.universeExclusions && typeof trail.universeExclusions.get === 'function'
    ? trail.universeExclusions.get(t) : null;
  const quoted = trail.quoted instanceof Set ? trail.quoted.has(t) : false;

  // First discovery observation across all of the day's snapshots.
  let firstDiscovery = null, bestRank = null, discoveryCount = 0, laneSet = new Set();
  for (const snap of trail.discovery || []) {
    for (const c of snap.candidates || []) {
      if (c.ticker !== t) continue;
      discoveryCount++;
      (c.discoverySources || []).forEach(l => laneSet.add(l));
      if (!firstDiscovery || Date.parse(c.firstDetectedAt || snap.generatedAt) < Date.parse(firstDiscovery.at)) {
        firstDiscovery = {
          at: c.firstDetectedAt || snap.generatedAt,
          price: c.priceAtFirstDetection ?? c.price ?? null,
          dayChangePct: c.dayChangeAtFirstDetection ?? c.dayChangePct ?? null,
          rank: c.discoveryRank ?? null,
        };
      }
      if (finite(c.discoveryRank) && (bestRank == null || c.discoveryRank < bestRank)) bestRank = c.discoveryRank;
    }
  }

  // Ignition (Stage 1) and continuation (Stage 2) records.
  const ignition = [];
  for (const snap of trail.ignition || []) {
    for (const r of snap.records || []) if (r.ticker === t) ignition.push(r);
  }
  const continuation = [];
  for (const snap of trail.continuation || []) {
    for (const r of snap.records || []) if (r.ticker === t) continuation.push(r);
  }
  const events = (trail.events || []).filter(e => e.ticker === t);
  const rejections = (trail.rejections || []).filter(r => r.ticker === t);

  let stage = 'NOT_IN_UNIVERSE';
  if (inUniverse) stage = 'UNIVERSE';
  if (quoted) stage = 'BULK_QUOTE';
  if (discoveryCount) stage = 'DISCOVERY';
  if (ignition.some(r => r.floatShares != null)) stage = 'FLOAT_ENRICHMENT';
  if (continuation.length) stage = 'INTRADAY_ENRICHMENT';
  if (continuation.some(r => r.structureState && r.structureState !== 'STALE_DATA')) stage = 'STRUCTURE';
  if (ignition.some(r => r.actionState)) stage = 'ACTIONABILITY';
  if (ignition.some(r => r.displayed === true)) stage = 'DISPLAYED';
  if (events.length) stage = 'PAPER_ENTRY';

  return {
    ticker: t, inUniverse, universeExclusion, quoted,
    discoveryCount, discoverySources: [...laneSet], firstDiscovery, bestRank,
    ignition, continuation, events, rejections,
    pipelineStageReached: stage,
  };
}

// ── Miss categorization ──────────────────────────────────────────────────────
// Assigns the FIRST category that explains the loss, walking the pipeline in order. That
// ordering matters: a name that was never in the universe cannot also be "ranked too low",
// and reporting the earliest true cause is what makes the histogram actionable.
function categorizeMiss(mover, trace, { displayCut = 12, cfg = {} } = {}) {
  const reasons = [];

  if (!trace.inUniverse) {
    if (trace.universeExclusion) {
      const ex = String(trace.universeExclusion);
      const typeLike = ['ETF', 'FUND', 'WARRANT', 'RIGHT', 'UNIT', 'PREFERRED', 'NOTE', 'ETN', 'SPAC', 'TEST_SECURITY', 'NONSTANDARD_SYMBOL'];
      const cat = typeLike.some(x => ex.includes(x)) ? MISS_CATEGORIES.SECURITY_TYPE_EXCLUDED : MISS_CATEGORIES.NOT_IN_UNIVERSE;
      return { category: cat, reasons: [ex] };
    }
    return { category: MISS_CATEGORIES.NOT_IN_UNIVERSE, reasons: ['absent from the eligible universe build'] };
  }
  if (!trace.quoted) {
    return { category: MISS_CATEGORIES.BATCH_QUOTE_MISSING, reasons: ['the bulk-quote provider never returned this symbol'] };
  }
  if (!trace.discoveryCount) {
    // In the universe and quoted, but no lane ever tripped. Work out which threshold it was.
    if (finite(mover.sessionDollarVolume) && finite(cfg.MIN_SESSION_DOLLAR_VOLUME)
        && mover.sessionDollarVolume < cfg.MIN_SESSION_DOLLAR_VOLUME) {
      return { category: MISS_CATEGORIES.CURRENT_LIQUIDITY_FILTER, reasons: [`session dollar volume $${Math.round(mover.sessionDollarVolume / 1e6)}M below the floor`] };
    }
    if (finite(mover.sessionClose) && finite(cfg.MIN_PRICE) && mover.sessionClose < cfg.MIN_PRICE) {
      return { category: MISS_CATEGORIES.PRICE_FILTER, reasons: [`price $${mover.sessionClose} below the floor`] };
    }
    if (finite(mover.dayChangePct) && finite(cfg.PCT_MOVER_MIN) && mover.dayChangePct < cfg.PCT_MOVER_MIN) {
      // The classic shape: it opened high and faded, so its CLOSE change never cleared the bar
      // even though open-to-high was enormous.
      return { category: MISS_CATEGORIES.NOT_ENOUGH_PERCENT_GAIN, reasons: [`closed +${mover.dayChangePct}% though it ran +${mover.openToHighPct}% off the open`] };
    }
    return { category: MISS_CATEGORIES.NOT_ENOUGH_RVOL, reasons: ['no discovery lane threshold was tripped during the session'] };
  }

  // It WAS discovered. From here the question changes from recall to prioritization.
  const firstGain = trace.firstDiscovery ? trace.firstDiscovery.dayChangePct : null;
  const eventualHigh = mover.openToHighPct;
  if (finite(firstGain) && finite(mover.dayChangePct) && finite(eventualHigh)
      && trace.firstDiscovery && finite(trace.firstDiscovery.price) && finite(mover.sessionHigh)
      && mover.sessionHigh <= trace.firstDiscovery.price * 1.02) {
    reasons.push('the move was essentially complete by the time it was first detected');
    return { category: MISS_CATEGORIES.MOVE_ALREADY_COMPLETE_AT_DETECTION, reasons };
  }

  if (!trace.continuation.length) {
    if (finite(trace.bestRank) && trace.bestRank > (cfg.INTRADAY_ENRICHMENT_CAP || 60)) {
      return { category: MISS_CATEGORIES.NOT_SELECTED_FOR_INTRADAY_ENRICHMENT, reasons: [`best discovery rank ${trace.bestRank}, beyond the enrichment budget`] };
    }
    return { category: MISS_CATEGORIES.NOT_SELECTED_FOR_INTRADAY_ENRICHMENT, reasons: ['never selected for intraday enrichment'] };
  }

  if (trace.continuation.some(r => r.structureState === 'STALE_DATA')) {
    return { category: MISS_CATEGORIES.DATA_STALE, reasons: ['intraday data was stale during the relevant window'] };
  }
  // A structure rejection is a legitimate decision, but it must still be COUNTED — a filter
  // that rejects the day's biggest movers is a filter to re-examine.
  const rejectedStates = trace.continuation.filter(r => ['FAILED_BREAKOUT', 'DISTRIBUTION', 'EXHAUSTED'].includes(r.structureState));
  if (rejectedStates.length && !trace.events.length) {
    return { category: MISS_CATEGORIES.STRUCTURE_FILTER_REJECTED, reasons: [`structure model classified it ${[...new Set(rejectedStates.map(r => r.structureState))].join('/')}`] };
  }

  // Explicit suppression records (the pcarry / execution audit trail).
  const pcarry = trace.rejections.find(r => /pcarry|carry/i.test(r.reason || ''));
  if (pcarry) return { category: MISS_CATEGORIES.PCARRY_SUPPRESSED, reasons: [pcarry.reason] };
  const exec = trace.rejections.find(r => /execution|spread|halt|cost/i.test(r.reason || ''));
  if (exec) return { category: MISS_CATEGORIES.EXECUTION_BLOCKED, reasons: [exec.reason] };

  if (finite(trace.bestRank) && trace.bestRank > displayCut) {
    return { category: MISS_CATEGORIES.RANKED_TOO_LOW, reasons: [`best rank ${trace.bestRank}, display cut ${displayCut}`] };
  }
  if (!trace.events.length) {
    const blocked = trace.ignition.flatMap(r => r.blockingReasons || []);
    if (blocked.length) return { category: MISS_CATEGORIES.EXECUTION_BLOCKED, reasons: [...new Set(blocked)].slice(0, 3) };
  }

  return { category: MISS_CATEGORIES.UNKNOWN, reasons: ['discovered and analyzed, but the evidence trail does not explain the loss'] };
}

// ── Full audit ───────────────────────────────────────────────────────────────
// Pure given its inputs, so the whole categorization policy is testable against fixtures.
function buildAudit({
  sessionDate, movers, trail = {}, barsByTicker = {}, displayCut = 12, cfg = {}, universeCoverage = null,
} = {}) {
  const boards = movers || {};
  const union = new Map();
  for (const [board, rows] of Object.entries(boards)) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const prev = union.get(r.ticker) || { ...r, boards: [] };
      prev.boards = [...new Set([...prev.boards, board])];
      union.set(r.ticker, prev);
    }
  }

  const records = [];
  for (const mover of union.values()) {
    const trace = traceTicker(mover.ticker, trail);
    const bars = barsByTicker[mover.ticker] || null;
    const max30 = bars ? maxWindowReturn(bars, 30) : null;
    const max60 = bars ? maxWindowReturn(bars, 60) : null;
    const discovered = trace.discoveryCount > 0;

    const fd = trace.firstDiscovery;
    const gainAtFirst = fd ? fd.dayChangePct : null;
    const eventualAfterDiscovery = fd && finite(fd.price) && finite(mover.sessionHigh) && fd.price > 0
      ? +(((mover.sessionHigh / fd.price) - 1) * 100).toFixed(2) : null;
    const finalMove = mover.openToHighPct;

    const { category, reasons } = discovered && trace.events.length
      ? { category: null, reasons: [] }                      // not a miss — it produced an entry event
      : categorizeMiss(mover, trace, { displayCut, cfg });

    const ign = trace.ignition[0] || {};
    records.push({
      ticker: mover.ticker,
      boards: mover.boards,
      floatShares: ign.floatShares ?? null,
      floatTier: ign.floatTier ?? 'UNKNOWN',
      marketCap: ign.marketCap ?? null,
      price: mover.sessionClose,
      sessionOpen: mover.sessionOpen,
      sessionHigh: mover.sessionHigh,
      sessionLow: mover.sessionLow,
      sessionClose: mover.sessionClose,
      openToHighPct: mover.openToHighPct,
      lowToHighPct: mover.lowToHighPct,
      dayChangePct: mover.dayChangePct,
      max30mReturn: max30,
      max60mReturn: max60,
      firstDiscoveryTimestamp: fd ? fd.at : null,
      priceAtFirstDiscovery: fd ? fd.price : null,
      gainAtFirstDiscovery: gainAtFirst,
      eventualGainAfterDiscovery: eventualAfterDiscovery,
      discovered,
      discoveredBefore10Pct: discovered && finite(gainAtFirst) ? gainAtFirst < 10 : false,
      discoveredBefore20Pct: discovered && finite(gainAtFirst) ? gainAtFirst < 20 : false,
      discoveredBefore50PctOfFinalMove: discovered && finite(gainAtFirst) && finite(finalMove) && finalMove > 0
        ? gainAtFirst < finalMove * 0.5 : false,
      discoveryRank: trace.bestRank,
      discoverySources: trace.discoverySources,
      pipelineStageReached: trace.pipelineStageReached,
      rejectionStage: category ? stageForCategory(category) : null,
      rejectionReasons: reasons,
      missCategory: category,
      pcarrySuppressed: category === MISS_CATEGORIES.PCARRY_SUPPRESSED,
      dataFailures: trace.continuation.filter(r => r.structureState === 'STALE_DATA').length,
      catalyst: ign.catalyst ?? null,
      sessionVolume: mover.sessionVolume,
      sessionDollarVolume: mover.sessionDollarVolume,
      floatTurnover: ign.floatTurnover ?? null,
      producedEntryEvent: trace.events.length > 0,
    });
  }

  return {
    schema: AUDIT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    sessionDate,
    generatedAt: new Date().toISOString(),
    records: records.sort((a, b) => (b.openToHighPct ?? 0) - (a.openToHighPct ?? 0)),
    // `movers` also carries scalar diagnostics (universeScanned); only the leaderboard arrays
    // are projected here.
    boards: Object.fromEntries(Object.entries(boards)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => [k, v.map(r => r.ticker)])),
    recall: calculateRecallMetrics(records, boards),
    missHistogram: histogram(records.filter(r => r.missCategory).map(r => r.missCategory)),
    universeCoverage,
  };
}

function stageForCategory(cat) {
  const map = {
    NOT_IN_UNIVERSE: 'UNIVERSE', SECURITY_TYPE_EXCLUDED: 'UNIVERSE',
    BATCH_QUOTE_MISSING: 'BULK_QUOTE',
    PRICE_FILTER: 'DISCOVERY', CURRENT_LIQUIDITY_FILTER: 'DISCOVERY',
    HISTORICAL_VOLUME_FILTER: 'DISCOVERY', NOT_ENOUGH_PERCENT_GAIN: 'DISCOVERY',
    NOT_ENOUGH_RVOL: 'DISCOVERY', CATALYST_NOT_FOUND: 'DISCOVERY',
    FLOAT_UNAVAILABLE: 'FLOAT_ENRICHMENT', FLOAT_STALE: 'FLOAT_ENRICHMENT',
    NOT_SELECTED_FOR_INTRADAY_ENRICHMENT: 'INTRADAY_ENRICHMENT',
    DATA_STALE: 'INTRADAY_ENRICHMENT', REFRESH_INTERVAL_MISS: 'DISCOVERY',
    MOVE_OCCURRED_DURING_HALT: 'DISCOVERY', MOVE_ALREADY_COMPLETE_AT_DETECTION: 'DISCOVERY',
    STRUCTURE_FILTER_REJECTED: 'STRUCTURE', PCARRY_SUPPRESSED: 'ACTIONABILITY',
    EXECUTION_BLOCKED: 'ACTIONABILITY', RANKED_TOO_LOW: 'DISPLAYED', UNKNOWN: null,
  };
  return map[cat] ?? null;
}

function histogram(values) {
  const h = {};
  for (const v of values) h[v] = (h[v] || 0) + 1;
  return Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1]));
}

// ── RECALL METRICS ───────────────────────────────────────────────────────────
// Discovery is measured SEPARATELY from trade outcomes. A system can have excellent entry
// quality and terrible recall (it only ever sees five stocks), and that must be visible.
function calculateRecallMetrics(records, boards = {}) {
  const byTicker = new Map(records.map(r => [r.ticker, r]));
  const recallOf = (list, n) => {
    const set = (list || []).slice(0, n);
    if (!set.length) return null;
    const found = set.filter(m => { const r = byTicker.get(m.ticker); return r && r.discovered; }).length;
    return +((found / set.length) * 100).toFixed(1);
  };

  const discovered = records.filter(r => r.discovered);
  const withFirst = discovered.filter(r => finite(r.gainAtFirstDiscovery));

  const bucket = (keyFn) => {
    const out = {};
    for (const r of records) {
      const k = keyFn(r) ?? 'UNKNOWN';
      out[k] ||= { total: 0, discovered: 0 };
      out[k].total++;
      if (r.discovered) out[k].discovered++;
    }
    for (const k of Object.keys(out)) {
      out[k].recallPct = out[k].total ? +((out[k].discovered / out[k].total) * 100).toFixed(1) : null;
    }
    return out;
  };

  const medianOf = arr => {
    const a = arr.filter(finite).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return +(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2).toFixed(2);
  };

  return {
    recallOfTop10OpenToHighMovers: recallOf(boards.byOpenToHigh, 10),
    recallOfTop20OpenToHighMovers: recallOf(boards.byOpenToHigh, 20),
    recallOfTop20LowToHighMovers: recallOf(boards.byLowToHigh, 20),
    recallOfTop20ThirtyMinuteMovers: recallOf(
      [...records].filter(r => finite(r.max30mReturn)).sort((a, b) => b.max30mReturn - a.max30mReturn), 20),
    recallOfTop20SixtyMinuteMovers: recallOf(
      [...records].filter(r => finite(r.max60mReturn)).sort((a, b) => b.max60mReturn - a.max60mReturn), 20),
    recallBefore10PctMove: records.length ? +((records.filter(r => r.discoveredBefore10Pct).length / records.length) * 100).toFixed(1) : null,
    recallBefore20PctMove: records.length ? +((records.filter(r => r.discoveredBefore20Pct).length / records.length) * 100).toFixed(1) : null,
    recallBeforeHalfOfFinalMove: records.length ? +((records.filter(r => r.discoveredBefore50PctOfFinalMove).length / records.length) * 100).toFixed(1) : null,
    medianGainRemainingAfterFirstDetection: medianOf(discovered.map(r => r.eventualGainAfterDiscovery)),
    medianGainAtFirstDetection: medianOf(withFirst.map(r => r.gainAtFirstDiscovery)),
    medianDiscoveryRankOfActualTopMovers: medianOf(discovered.map(r => r.discoveryRank)),
    coverageByFloatTier: bucket(r => r.floatTier),
    coverageByPriceBand: bucket(r => priceBand(r.price)),
    coverageByCatalystTier: bucket(r => (r.catalyst ? `TIER_${r.catalyst}` : 'NONE')),
    totalMoversAudited: records.length,
    totalDiscovered: discovered.length,
    overallRecallPct: records.length ? +((discovered.length / records.length) * 100).toFixed(1) : null,
    producedEntryEvents: records.filter(r => r.producedEntryEvent).length,
  };
}

function priceBand(p) {
  if (!finite(p)) return 'UNKNOWN';
  if (p < 1) return 'UNDER_1';
  if (p < 5) return '1_TO_5';
  if (p < 20) return '5_TO_20';
  if (p < 100) return '20_TO_100';
  return 'OVER_100';
}

module.exports = {
  STAGES, MISS_CATEGORIES, CATEGORY_LABEL, AUDIT_VERSION,
  rankMovers, maxWindowReturn, traceTicker, categorizeMiss, buildAudit,
  calculateRecallMetrics, histogram, priceBand, stageForCategory,
};
