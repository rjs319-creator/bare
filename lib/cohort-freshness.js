'use strict';
// CROSS-SECTIONAL COHORT FRESHNESS GATE (swing defect #3 — mixed-vintage universe).
//
// THE DEFECT THIS CLOSES. The expanded universe is refreshed in shards (~300
// names/day); compilation merges OLD and NEW shards and stamps the compiled doc
// with a CURRENT document-level timestamp (lib/universe-routes runUniverseCompile).
// Every downstream freshness check keyed off `doc.updatedAt`, so a ticker whose
// candles were fetched two weeks ago read as "built today" — and its two-week-old
// features entered the SAME cross-sectional percentile cohort as names with a
// current bar. Percentile ranks over a mixed-vintage cohort are not a cross-
// section; they are a comparison across different dates.
//
// THE CONTRACT. Every cross-sectional scan resolves ONE authoritative decision
// session from the benchmark calendar (SPY's own bar axis + the exchange-session
// clock), then requires each candidate's latest usable bar to reach that session:
//   current       — bar >= decision session (includes an in-progress partial bar
//                   during market hours; the whole cohort shares the same floor)
//   prior-session — exactly one benchmark session behind (reported separately —
//                   this is a freshly-lagging name, not a rotted shard)
//   stale         — older than the prior session
//   future-dated  — dated beyond the benchmark's own newest bar (ambiguous/bogus)
//   missing       — no usable bar date at all
// Only `current` rows may enter cross-sectional percentiles/selection. Excluded
// rows are RETAINED for diagnostics with reason codes — never silently dropped,
// never silently admitted. Compilation can never upgrade an entry's freshness:
// classification reads the per-entry `lastBarDate`, not any document stamp.
//
// Pure (no network, no store); `now` injectable for tests.

const { sessionInfoAt } = require('./market-session');

const FRESHNESS_CLASS = Object.freeze({
  CURRENT: 'current',
  PRIOR_SESSION: 'prior-session',
  STALE: 'stale',
  FUTURE_DATED: 'future-dated',
  MISSING: 'missing',
});

// Resolve the authoritative decision session for a cross-sectional scan.
//   benchmarkDates — ascending 'YYYY-MM-DD' axis from the benchmark's (SPY) candles.
// If the benchmark's newest bar is the in-progress ET session (market not yet
// closed), the completed decision session is the PRIOR benchmark bar; bars at or
// beyond it stay admissible, so a partial-bar live fetch never splits the cohort.
function resolveDecisionSession({ benchmarkDates = [], now = new Date() } = {}) {
  const axis = (benchmarkDates || []).filter(Boolean);
  if (!axis.length) return { session: null, prior: null, latest: null, source: 'unavailable' };
  const latest = axis[axis.length - 1];
  const info = sessionInfoAt(now);
  const marketOpen = info.marketSession === 'premarket' || info.marketSession === 'regular';
  let session = latest;
  let source = 'benchmark-latest';
  if (marketOpen && latest === info.etDate && axis.length >= 2) {
    session = axis[axis.length - 2];
    source = 'benchmark-completed';
  }
  const si = axis.lastIndexOf(session);
  const prior = si > 0 ? axis[si - 1] : null;
  return { session, prior, latest, source };
}

// Classify one candidate's latest usable bar against the resolved session.
function classifyBarDate(lastBarDate, ctx) {
  if (!ctx || !ctx.session) return FRESHNESS_CLASS.MISSING;
  if (!lastBarDate) return FRESHNESS_CLASS.MISSING;
  if (ctx.latest && lastBarDate > ctx.latest) return FRESHNESS_CLASS.FUTURE_DATED;
  if (lastBarDate >= ctx.session) return FRESHNESS_CLASS.CURRENT;
  if (ctx.prior && lastBarDate === ctx.prior) return FRESHNESS_CLASS.PRIOR_SESSION;
  return FRESHNESS_CLASS.STALE;
}

// Gate a whole cohort. rows: [{ ticker, lastBarDate, ... }] (any extra fields pass
// through untouched). Returns admitted rows (current only), excluded rows with
// reason codes, and the counts every scan response must expose. When the
// benchmark axis is unavailable the gate FAILS OPEN WITH A FLAG: nothing is
// excluded (we cannot adjudicate freshness without a calendar), but
// `sessionSource:'unavailable'` travels on the response so the scan is marked
// un-adjudicated rather than silently trusted.
function gateCohort(rows, { benchmarkDates, now = new Date() } = {}) {
  const ctx = resolveDecisionSession({ benchmarkDates, now });
  const counts = { current: 0, 'prior-session': 0, stale: 0, 'future-dated': 0, missing: 0 };
  if (!ctx.session) {
    return {
      decisionSession: null, sessionSource: ctx.source, admitted: rows.slice(),
      excluded: [], counts, adjudicated: false,
    };
  }
  const admitted = [];
  const excluded = [];
  for (const r of rows) {
    const cls = classifyBarDate(r && r.lastBarDate, ctx);
    counts[cls]++;
    if (cls === FRESHNESS_CLASS.CURRENT) admitted.push(r);
    else excluded.push({ ticker: r && r.ticker, lastBarDate: (r && r.lastBarDate) || null, reason: cls });
  }
  return {
    decisionSession: ctx.session, sessionSource: ctx.source, benchmarkLatest: ctx.latest,
    admitted, excluded, counts, adjudicated: true,
  };
}

module.exports = { FRESHNESS_CLASS, resolveDecisionSession, classifyBarDate, gateCohort };
