'use strict';
// ALERTS EPISODE GRADING — realistic, leakage-resistant outcome measurement.
//
// An episode is DECIDED on day T from that day's close/EOD data. Grading enters at the NEXT
// session OPEN (T+1) — never the same close that generated the decision — over 1/3/5/10/21
// sessions, SPY- and (when wired) sector-relative, cost- and (for shorts) borrow-adjusted,
// with MFE/MAE, R-multiple against stated levels, and an honest "move already consumed before
// ingestion" (chase) measure so a late alert can't be scored as a fresh entry.
//
// FOLLOW and FADE are graded separately: a fade of a long is a SHORT and must carry borrow
// assumptions before it is called tradeable. Reuses the proven primitives in options-grade.

const { nextOpenEntry, horizonReturns, mfeMae, benchReturn } = require('./options-grade');

const DEFAULT_HORIZONS = [1, 3, 5, 10, 21];
const DEFAULT_COST_BPS = 10;                 // per side (slippage + fee proxy); round trip = 2×
const SHORT_BORROW_BPS_PER_DAY = 3;          // ~11%/yr hard-to-borrow proxy, per calendar day held
const HORIZON_SESSIONS = { '1': 1, '3': 3, '5': 5, '10': 10, '21': 21 };

const r2 = v => (v == null ? null : +v.toFixed(2));
const r3 = v => (v == null ? null : +v.toFixed(3));

// Map an intended horizon label to the nearest graded session count (default 5 = standard swing).
function horizonSessions(horizon) {
  if (horizon === 'day') return 1;
  if (horizon === 'swing') return 5;
  if (horizon === 'position') return 21;
  const n = parseInt(horizon, 10);
  return Number.isFinite(n) && HORIZON_SESSIONS[String(n)] ? n : 5;
}

// R-multiple from stated levels (entry→exit signed by side, risk = |entry − stop|).
function rMultipleFrom(entryPx, exitPx, side, statedLevels) {
  if (!statedLevels || statedLevels.stop == null) return null;
  const risk = Math.abs(entryPx - statedLevels.stop);
  if (!(risk > 0)) return null;
  const dir = side === 'long' ? 1 : -1;
  return +(dir * (exitPx - entryPx) / risk).toFixed(2);
}

/**
 * Grade one directional episode. `series` = { candles, spy?, sector? } (ascending by date).
 * Returns a graded record, or { graded:false, reason } when it can't be graded.
 */
function gradeEpisode(episode, series = {}, opts = {}) {
  const horizons = opts.horizons || DEFAULT_HORIZONS;
  const costBps = opts.costBps != null ? opts.costBps : DEFAULT_COST_BPS;
  const dir = episode && episode.side === 'long' ? 1 : episode && episode.side === 'short' ? -1 : 0;
  if (dir === 0) return { graded: false, reason: 'non-directional' };

  const candles = series.candles || [];
  const entry = nextOpenEntry(candles, episode.firstSeenDate);
  if (!entry) return { graded: false, reason: 'no-next-open-entry' };
  const maxH = Math.max(...horizons);
  if (entry.entryIdx + 1 >= candles.length) return { graded: false, reason: 'no-forward-data' };

  const rawH = horizonReturns(candles, entry.entryIdx, entry.entryPx, horizons);
  const roundTripCost = (2 * costBps) / 10_000;
  const isShort = dir === -1;

  const horizonGrades = {};
  for (const h of horizons) {
    const raw = rawH[h];
    if (raw == null) { horizonGrades[h] = null; continue; }
    const exitCandle = candles[entry.entryIdx + h];
    const exitDate = exitCandle ? exitCandle.date : null;
    const spyR = benchReturn(series.spy, entry.entryDate, exitDate);
    const secR = benchReturn(series.sector, entry.entryDate, exitDate);
    const borrow = isShort ? (SHORT_BORROW_BPS_PER_DAY * h) / 10_000 : 0;   // ~calendar-day proxy
    const directional = dir * raw - roundTripCost - borrow;
    const vsSpy = spyR == null ? null : dir * (raw - spyR) - roundTripCost - borrow;
    const vsSector = secR == null ? null : dir * (raw - secR) - roundTripCost - borrow;
    horizonGrades[h] = {
      rawReturn: r2(raw * 100),
      directional: r2(directional * 100),
      excessVsSpy: vsSpy == null ? null : r2(vsSpy * 100),
      excessVsSector: vsSector == null ? null : r2(vsSector * 100),
      borrowCostPct: isShort ? r3(borrow * 100) : 0,
    };
  }

  const exc = mfeMae(candles, entry.entryIdx, entry.entryPx, maxH);
  const mfe = r2((dir === 1 ? exc.up : -exc.down) * 100);
  const mae = r2((dir === 1 ? exc.down : -exc.up) * 100);

  // Trigger / stop / target first-touch (stated levels only — deterministic).
  const levels = episode.statedLevels || {};
  const touch = firstTouch(candles, entry.entryIdx, maxH, episode.side, levels);

  // Chase: how much of the move already happened between the first ALERT price (execRef at
  // decision) and the realistic entry (next open). A large adverse-to-entry pre-move ⇒ late.
  const preMove = episode.execRef != null && entry.entryPx
    ? r2(dir * ((entry.entryPx - episode.execRef) / episode.execRef) * 100)
    : null;

  // Primary outcome for the skill model: cost-adjusted SPY-relative at the intended horizon.
  const primH = horizonSessions(episode.intendedHorizon);
  const prim = horizonGrades[primH] || horizonGrades[5] || null;
  const primExcess = prim ? (prim.excessVsSpy != null ? prim.excessVsSpy : prim.directional) : null;
  const exitPx = candles[entry.entryIdx + primH] ? candles[entry.entryIdx + primH].close : null;

  return {
    graded: true,
    episodeId: episode.id,
    ticker: episode.ticker,
    side: episode.side,
    accountKey: episode.firstSourceKey || null,
    identityKnown: !!episode.firstSourceKey,
    decisionDate: episode.firstSeenDate,
    entryDate: entry.entryDate,
    entryPx: r2(entry.entryPx),
    costBps,
    horizons: horizonGrades,
    mfe, mae,
    trigger: touch,
    rMultiple: exitPx != null ? rMultipleFrom(entry.entryPx, exitPx, episode.side, levels) : null,
    preMovePct: preMove,
    moveConsumed: preMove != null && preMove > 0 && primExcess != null && preMove > Math.abs(primExcess) * 1.5,
    setupClass: episode.setupClass || null,
    intendedHorizon: episode.intendedHorizon || null,
    coordinated: !!episode.coordinatedSeen,
    // the skill-model row:
    primaryHorizon: primH,
    excess: primExcess,
  };
}

// First-touch of stated trigger/stop/target over the window (which came first).
function firstTouch(candles, entryIdx, maxH, side, levels) {
  const out = { triggerFilled: null, stopFirst: null, targetFirst: null };
  if (!levels) return out;
  for (let i = entryIdx + 1; i <= entryIdx + maxH && i < candles.length; i++) {
    const c = candles[i]; if (!c) continue;
    const hi = c.high ?? c.close, lo = c.low ?? c.close;
    if (levels.entry != null && out.triggerFilled == null && lo <= levels.entry && hi >= levels.entry) out.triggerFilled = c.date;
    const hitStop = levels.stop != null && (side === 'long' ? lo <= levels.stop : hi >= levels.stop);
    const hitTarget = levels.target != null && (side === 'long' ? hi >= levels.target : lo <= levels.target);
    if (hitStop && out.stopFirst == null && out.targetFirst == null) { out.stopFirst = c.date; break; }
    if (hitTarget && out.targetFirst == null && out.stopFirst == null) { out.targetFirst = c.date; break; }
  }
  return out;
}

// Aggregate summary at one horizon over independent episodes/dates (economic usefulness).
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function summarizeEpisodes(graded, { horizon = 5, metric = 'excessVsSpy', follow = true } = {}) {
  const rows = (graded || []).filter(g => g && g.graded && (follow ? true : true) && g.horizons[horizon] && g.horizons[horizon][metric] != null);
  const vals = rows.map(g => (follow ? 1 : -1) * g.horizons[horizon][metric]);
  if (!vals.length) return { n: 0, independentDates: 0, note: 'insufficient graded episodes' };
  const m = mean(vals);
  const wins = vals.filter(v => v > 0);
  const variance = vals.length > 1 ? mean(vals.map(v => (v - m) ** 2)) * (vals.length / (vals.length - 1)) : 0;
  const se = Math.sqrt(variance / vals.length);
  return {
    n: vals.length,
    independentDates: new Set(rows.map(g => g.decisionDate)).size,
    hitRate: +((wins.length / vals.length) * 100).toFixed(1),
    meanExcess: +m.toFixed(3),
    ci95: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)],
    horizon, metric, mode: follow ? 'follow' : 'fade',
  };
}

module.exports = {
  DEFAULT_HORIZONS, DEFAULT_COST_BPS, SHORT_BORROW_BPS_PER_DAY,
  horizonSessions, rMultipleFrom, gradeEpisode, firstTouch, summarizeEpisodes,
};
