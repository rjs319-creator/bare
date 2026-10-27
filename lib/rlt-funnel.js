'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// RLT false-early-rate / lead-time study (pre-registered 2026-07-27; see
// docs/relative-leadership-transition.md §20.2 and §13's two prior walk-forward
// negatives). This is a DIFFERENT measurement from the ranking backtests: no
// model, no residual, no IC. It reads the immutable daily cross-sections
// (rlt/cross-section/<date>.json, write-once) and asks the plain question the
// system exists to answer — of names that ENTERED a given pre-trigger state,
// what fraction later reached a more-advanced state (PRIMED/ARMED/TRIGGERED...)
// before explicitly weakening/dropping, and what was the lead time in accrued
// sessions? Censored episodes (no resolving transition before the data cutoff)
// are counted and reported SEPARATELY — they are never treated as failures.
//
// Pure module: no I/O. lib/rlt-routes.js loads the cross-section documents and
// calls buildFunnelStudy; this file only reasons about the transition log.
// ═══════════════════════════════════════════════════════════════════════════

const { wilson } = require('./stats');

// Funnel ladder order (doc §7). A transition's RANK determines whether it is a
// forward "progression" relative to a given base state.
const LADDER = Object.freeze(['DISCOVERED', 'EMERGING_LEADER', 'PRIMED', 'ARMED', 'TRIGGERED', 'ACCEPTED', 'COMPLETED']);
const RANK = Object.freeze(Object.fromEntries(LADDER.map((s, i) => [s, i])));

// Explicit failure/exit states (doc §7: "a name that stops qualifying emits an
// explicit DROPPED transition — published candidates never silently disappear").
const FAILURE_STATES = Object.freeze(['WEAKENING', 'INVALIDATED', 'EXPIRED', 'DROPPED']);

// Bases the pre-registered study asked for (doc §20.2: EMERGING_LEADER, plus
// DISCOVERED and PRIMED "if sample allows").
const STUDY_BASES = Object.freeze(['DISCOVERED', 'EMERGING_LEADER', 'PRIMED']);

const DEFAULT_MIN_DATES_FOR_VERDICT = 40;   // hard rule: say so plainly below this, never extrapolate
const DEFAULT_MIN_ENTRIES_PER_SPLIT = 20;   // never emit a per-sector rate from a thin sample

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// Distinct accrual dates (the session calendar) + a static ticker->sector
// lookup, built from whichever loaded cross-section carries the ticker first.
// Write-once: when the same date is passed twice (e.g. a duplicate probe hit),
// the first copy wins and the second is ignored rather than double-indexed.
function indexCrossSections(docs) {
  const byDate = new Map();
  for (const d of docs) {
    if (!d || !d.date || byDate.has(d.date)) continue;
    byDate.set(d.date, d);
  }
  const dates = [...byDate.keys()].sort();
  const sessionOf = new Map(dates.map((d, i) => [d, i]));
  const sectorOf = new Map();
  for (const d of dates) {
    for (const r of (byDate.get(d).rows || [])) {
      if (r && r.ticker && r.sector && !sectorOf.has(r.ticker)) sectorOf.set(r.ticker, r.sector);
    }
  }
  // Deduped doc list (one per date, first-wins) — the only thing safe to feed
  // to timelineByTicker; the raw input may carry the same date twice.
  const dedupedDocs = dates.map(d => byDate.get(d));
  return { dates, sessionOf, sectorOf, dedupedDocs };
}

// Every ticker's transitions, flattened across all loaded dates and sorted
// chronologically by accrual session. A transition whose `session` does not
// match a loaded date (should not happen, but the log is append-only data, not
// a guarantee) cannot be placed on the calendar and is dropped rather than
// mis-ordered.
function timelineByTicker(docs, sessionOf) {
  const byTicker = new Map();
  for (const d of docs) {
    for (const t of (d.transitions || [])) {
      if (!t || !t.ticker || !t.newState || !sessionOf.has(t.session)) continue;
      if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
      byTicker.get(t.ticker).push({ session: sessionOf.get(t.session), newState: t.newState });
    }
  }
  for (const list of byTicker.values()) list.sort((a, b) => a.session - b.session);
  return byTicker;
}

// Resolve ONE entry into `base` at timeline index `entryIndex` by scanning the
// SAME ticker's later transitions in order:
//   - the first later transition that reaches a rung strictly past `base` ⇒ progressed
//   - the first later transition into an explicit failure state ⇒ failed
//   - a demotion to an earlier-or-equal non-failure rung resolves nothing —
//     keep scanning (e.g. EMERGING_LEADER -> DISCOVERED is a setback, not a verdict)
//   - running out of transitions before the data cutoff ⇒ censored (NEVER a failure)
function resolveEntry(base, entryIndex, timeline) {
  const minProgressRank = RANK[base] + 1;
  for (let i = entryIndex + 1; i < timeline.length; i++) {
    const t = timeline[i];
    const r = RANK[t.newState];
    if (r != null && r >= minProgressRank) {
      return { outcome: 'progressed', toState: t.newState, leadTimeSessions: t.session - timeline[entryIndex].session };
    }
    if (FAILURE_STATES.includes(t.newState)) {
      return { outcome: 'failed', toState: t.newState, sessionsToFailure: t.session - timeline[entryIndex].session };
    }
  }
  return { outcome: 'censored' };
}

// Core stats for one set of entries (no sector split). Progression rate is
// reported two ways, deliberately: AMONG RESOLVED excludes censored episodes
// (the conventional point estimate); OF ALL ENTRIES treats censored as neither
// a win nor a loss (a conservative lower bound). Neither counts a censored
// episode as a failure.
function summarize(entries) {
  const n = entries.length;
  const progressed = entries.filter(e => e.outcome === 'progressed');
  const failed = entries.filter(e => e.outcome === 'failed');
  const censored = entries.filter(e => e.outcome === 'censored');
  const resolved = progressed.length + failed.length;
  const ci = resolved ? wilson(progressed.length, resolved) : null;
  const leadTimes = progressed.map(e => e.leadTimeSessions);
  return {
    entries: n,
    progressed: progressed.length,
    failed: failed.length,
    censored: censored.length,
    resolvedForRate: resolved,
    progressionRateAmongResolved: resolved ? +(progressed.length / resolved).toFixed(4) : null,
    progressionRateAmongResolvedCI90: ci ? { lo: +ci.lo.toFixed(4), hi: +ci.hi.toFixed(4) } : null,
    progressionRateOfAllEntries: n ? +(progressed.length / n).toFixed(4) : null,
    leadTimeSessions: leadTimes.length ? {
      n: leadTimes.length,
      median: median(leadTimes),
      p25: quantile(leadTimes, 0.25),
      p75: quantile(leadTimes, 0.75),
      min: Math.min(...leadTimes),
      max: Math.max(...leadTimes),
    } : null,
  };
}

function summarizeWithSectorSplit(entries, minEntriesPerSplit) {
  const base = summarize(entries);
  const sectors = [...new Set(entries.map(e => e.sector).filter(Boolean))].sort();
  const bySector = {};
  for (const sector of sectors) {
    const sub = entries.filter(e => e.sector === sector);
    if (sub.length < minEntriesPerSplit) continue;   // never emit a per-sector rate from a thin sample
    bySector[sector] = summarize(sub);
  }
  const withheld = sectors.filter(s => !bySector[s]);
  return {
    ...base,
    bySector: Object.keys(bySector).length ? bySector : null,
    sectorSplitNote: Object.keys(bySector).length
      ? (withheld.length ? `${withheld.length} sector(s) withheld below the ${minEntriesPerSplit}-entry split floor: ${withheld.join(', ')}` : null)
      : (sectors.length ? `no sector reached the ${minEntriesPerSplit}-entry split floor — per-sector split withheld, not fabricated from a thin sample` : null),
  };
}

/**
 * Build the full study from loaded RltCrossSection documents (any order,
 * duplicate dates tolerated).
 *
 * @param docs  array of { date, rows, transitions } cross-section documents
 * @param bases which pre-trigger states to measure entries into
 * @param minDatesForVerdict  below this many distinct accrual dates, flag the
 *        whole result as too thin for a verdict (report what exists anyway)
 * @param minEntriesPerSplit  minimum entries before a per-sector rate is shown
 */
function buildFunnelStudy(docs, {
  bases = STUDY_BASES,
  minDatesForVerdict = DEFAULT_MIN_DATES_FOR_VERDICT,
  minEntriesPerSplit = DEFAULT_MIN_ENTRIES_PER_SPLIT,
} = {}) {
  const clean = (Array.isArray(docs) ? docs : []).filter(d => d && d.date && Array.isArray(d.rows));
  const { dates, sessionOf, sectorOf, dedupedDocs } = indexCrossSections(clean);
  const timelines = timelineByTicker(dedupedDocs, sessionOf);

  const perBase = {};
  for (const base of bases) {
    const entries = [];
    for (const [ticker, timeline] of timelines) {
      timeline.forEach((t, idx) => {
        if (t.newState !== base) return;
        const resolution = resolveEntry(base, idx, timeline);
        entries.push({
          ticker, sector: sectorOf.get(ticker) || null,
          entrySession: t.session, entryDate: dates[t.session],
          ...resolution,
        });
      });
    }
    perBase[base] = summarizeWithSectorSplit(entries, minEntriesPerSplit);
  }

  const sampleTooThin = dates.length < minDatesForVerdict;
  return {
    schema: 'RltFunnelStudy',
    version: 'rlt-funnel-v1',
    registeredAt: '2026-07-27',
    purpose: 'Direct empirical measurement of the system’s stated purpose (earliness): of names entering a pre-trigger state, what fraction later progressed vs. explicitly weakened/dropped, and the lead time to progression. No model, no ranking claim.',
    dateCoverage: {
      distinctDates: dates.length,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
    },
    sampleTooThin,
    minDatesForVerdict,
    perBase,
    verdict: sampleTooThin
      ? `INCONCLUSIVE — only ${dates.length} distinct accrual date(s), below the ${minDatesForVerdict}-date reporting floor. Reporting what exists; not extrapolating.`
      : 'Reportable — see perBase for the measured rates and lead times. This is a descriptive measurement, not a promotion signal.',
    caveats: Object.freeze([
      'No model: these are direct empirical rates/lead-times read off the immutable daily cross-sections, not a forecast. Censored episodes are reported separately and are NEVER counted as failures.',
      'leadTimeSessions / sessionsToFailure count ACCRUED cross-section sessions (the dates this app actually persisted a snapshot for), not raw calendar trading days — a missed accrual day undercounts lead time for any episode spanning it.',
      'Sector metadata is present-day, not point-in-time (doc limitation #1) — per-sector splits are present-day labels, not reclassification-safe.',
      'A ticker that re-enters the same base state after a demotion is counted as a second, independent episode — entry count can exceed distinct-ticker count.',
      'This measures earliness (did the system flag the name before the move?), not ranking edge — it is a different question from the two real-data walk-forwards already recorded as negative in doc §13, and a positive result here does not reopen or override them.',
    ]),
  };
}

module.exports = {
  buildFunnelStudy, STUDY_BASES, LADDER, RANK, FAILURE_STATES,
  DEFAULT_MIN_DATES_FOR_VERDICT, DEFAULT_MIN_ENTRIES_PER_SPLIT,
  median, quantile,
};
