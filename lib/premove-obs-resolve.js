'use strict';
// GHOST FULL-OBSERVATION OUTCOME RESOLVER (premove-ghost-obs-resolve-v1).
//
// lib/premove-capture.js records the complete standalone-accumulation cross-
// section — selected, near-threshold AND rejected candidates — every day, each
// row stamped `outcome: { state: 'unresolved' }`. Until now nothing ever flipped
// that state: the rejected cohorts were captured but never graded, so the
// false-negative question ("do the names Ghost rejects go on to win?") could
// never be answered. This module is the grading half.
//
// Honesty rules:
//   - OUTCOMES LIVE APART FROM PREDICTIONS. The ghostobs/<date>.json observation
//     records are never rewritten; resolved outcomes append to a separate
//     grader-owned doc (ghostobs/resolved.json). A grader bug can corrupt
//     outcomes but can never rewrite the observation being judged.
//   - CENSOR-AWARE. A row resolves only when its full window has elapsed or a
//     terminal event occurred inside it; otherwise it stays null (never a
//     partial grade). Same pattern as lib/coil.resolveBreak.
//   - SAME-BAR AMBIGUITY RESOLVES CONSERVATIVELY: stop before target.
//   - GROSS RETURNS, and labeled as such — no cost model is applied here, so
//     nothing downstream may present these as net edge.
//
// Pure & dependency-free: rows + candles in, frozen outcomes out.

const OBS_RESOLVE_VERSION = 'premove-ghost-obs-resolve-v1';

// Matches the premove trade contract's 10-session time exit.
const OBS_HORIZON_SESSIONS = 10;

const num = (v) => (Number.isFinite(v) ? v : null);

// Resolve one observation row against forward daily candles.
// Returns a frozen outcome object, or null while the row is still censored.
function resolveObsRow(row, candles, { horizon = OBS_HORIZON_SESSIONS } = {}) {
  if (!row || !row.ticker || !row.date || !Array.isArray(candles) || !candles.length) return null;
  const base = num(row.decisionPrice);
  if (base == null || base <= 0) return null;

  // Entry-eligible index: the first session AFTER the decision date (the capture
  // happens end-of-day, so the decision-date bar itself is not tradeable).
  let ei = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date > row.date) { ei = k; break; } }
  if (ei < 0) return null;
  const lastIdx = Math.min(ei + horizon - 1, candles.length - 1);
  const windowComplete = ei + horizon - 1 < candles.length;

  const trigger = num(row.triggerLevel);
  const invalidation = num(row.invalidation);
  const target = num(row.target);

  // Path stats vs the decision price — computed over however much window exists;
  // only reported once the row actually resolves.
  let hi = -Infinity, lo = Infinity;
  for (let k = ei; k <= lastIdx; k++) {
    if (Number.isFinite(candles[k].high)) hi = Math.max(hi, candles[k].high);
    if (Number.isFinite(candles[k].low)) lo = Math.min(lo, candles[k].low);
  }
  const mfePct = hi > -Infinity ? +(((hi / base) - 1) * 100).toFixed(2) : null;
  const maePct = lo < Infinity ? +(((lo / base) - 1) * 100).toFixed(2) : null;

  const finish = (state, extra) => Object.freeze({
    version: OBS_RESOLVE_VERSION,
    key: `${row.date}|${row.ticker}`,
    date: row.date, ticker: row.ticker,
    tier: row.tier ?? null, score: row.score ?? null,
    state,
    horizonSessions: horizon,
    mfePct, maePct,
    returnsBasis: 'gross',   // no cost model here — never present as net edge
    resolvedAt: null,        // stamped by the route at write time
    ...extra,
  });

  // ── With a trigger plan: trigger → (stop | target | timeout), else NO_TRIGGER ──
  if (trigger != null) {
    let ti = -1;
    for (let k = ei; k <= lastIdx; k++) { if (Number.isFinite(candles[k].high) && candles[k].high >= trigger) { ti = k; break; } }

    if (ti === -1) {
      // Never triggered: resolvable only once the whole window has elapsed.
      if (!windowComplete) return null;
      const endClose = num(candles[lastIdx].close);
      return finish('NO_TRIGGER', {
        triggered: false, triggerDate: null, fillPrice: null,
        fwdPct: endClose != null ? +(((endClose / base) - 1) * 100).toFixed(2) : null,
        exitDate: candles[lastIdx].date,
      });
    }

    // Gap-through fills at the worse open (exec-v1 convention).
    const open = num(candles[ti].open);
    const fill = open != null ? Math.max(open, trigger) : trigger;

    // A gap-open at/through the target consumes the plan's edge at fill — there is
    // no remaining trade to grade, only the fact that entry came too late.
    if (target != null && fill >= target) {
      return finish('CONSUMED_AT_FILL', {
        triggered: true, triggerDate: candles[ti].date, fillPrice: +fill.toFixed(4),
        fwdPct: 0, exitDate: candles[ti].date,
      });
    }

    // Scan from the trigger bar forward. Same-bar ambiguity: stop checked FIRST.
    for (let k = ti; k <= lastIdx; k++) {
      const bLow = num(candles[k].low), bHigh = num(candles[k].high);
      if (invalidation != null && bLow != null && bLow <= invalidation) {
        return finish('TRIGGERED_STOP', {
          triggered: true, triggerDate: candles[ti].date, fillPrice: +fill.toFixed(4),
          fwdPct: +(((invalidation / fill) - 1) * 100).toFixed(2),
          exitDate: candles[k].date,
        });
      }
      if (target != null && bHigh != null && bHigh >= target && !(k === ti && fill >= target)) {
        return finish('TRIGGERED_TARGET', {
          triggered: true, triggerDate: candles[ti].date, fillPrice: +fill.toFixed(4),
          fwdPct: +(((target / fill) - 1) * 100).toFixed(2),
          exitDate: candles[k].date,
        });
      }
    }
    // Triggered, no terminal barrier: needs the full window to grade the timeout.
    if (!windowComplete) return null;
    const endClose = num(candles[lastIdx].close);
    return finish('TRIGGERED_TIMEOUT', {
      triggered: true, triggerDate: candles[ti].date, fillPrice: +fill.toFixed(4),
      fwdPct: endClose != null ? +(((endClose / fill) - 1) * 100).toFixed(2) : null,
      exitDate: candles[lastIdx].date,
    });
  }

  // ── No trigger plan (most rejected rows): plain forward window ──
  if (!windowComplete) return null;
  const endClose = num(candles[lastIdx].close);
  if (endClose == null) return null;
  return finish('FORWARD_WINDOW', {
    triggered: null, triggerDate: null, fillPrice: null,
    fwdPct: +(((endClose / base) - 1) * 100).toFixed(2),
    exitDate: candles[lastIdx].date,
  });
}

// Resolve every not-yet-resolved row across the observation days.
//   days:        [{ date, selected, alsoInBreakout, nearThreshold, rejected }]
//   candleFor:   (ticker) => candles[] | null
//   existingKeys: Set of already-resolved `${date}|${ticker}` keys
// Returns { outcomes, censored, missingCandles } — outcomes carry `cohort`.
const COHORTS = Object.freeze(['selected', 'alsoInBreakout', 'nearThreshold', 'rejected']);

function resolveObservationDays(days, candleFor, { horizon = OBS_HORIZON_SESSIONS, existingKeys = new Set() } = {}) {
  const outcomes = [];
  let censored = 0, missingCandles = 0;
  for (const day of Array.isArray(days) ? days : []) {
    if (!day || !day.date) continue;
    for (const cohort of COHORTS) {
      for (const row of day[cohort] || []) {
        if (!row || !row.ticker) continue;
        const key = `${day.date}|${row.ticker}`;
        if (existingKeys.has(key)) continue;
        const candles = candleFor(row.ticker);
        if (!candles) { missingCandles++; continue; }
        const out = resolveObsRow({ ...row, date: day.date }, candles, { horizon });
        if (out) outcomes.push({ ...out, cohort });
        else censored++;
      }
    }
  }
  return { outcomes, censored, missingCandles };
}

module.exports = {
  OBS_RESOLVE_VERSION, OBS_HORIZON_SESSIONS, COHORTS,
  resolveObsRow, resolveObservationDays,
};
