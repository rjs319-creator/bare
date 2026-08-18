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
//   ahead-of-benchmark — newer than the benchmark but still a REAL completed
//                   session on the exchange calendar. This is the benchmark
//                   lagging, not the candidate being wrong (see below).
//   future-dated  — dated beyond any session the exchange calendar has actually
//                   completed (ambiguous/bogus)
//   missing       — no usable bar date at all
// Only `current` rows may enter cross-sectional percentiles/selection. Excluded
// rows are RETAINED for diagnostics with reason codes — never silently dropped,
// never silently admitted. Compilation can never upgrade an entry's freshness:
// classification reads the per-entry `lastBarDate`, not any document stamp.
//
// WHEN THE BENCHMARK ITSELF IS STALE (2026-08-18). The ceiling for "too new" used
// to be the benchmark's OWN newest bar, so a lagging SPY series silently redefined
// what "today" meant for the whole app: on 2026-08-18 the provider was missing the
// 2026-08-17 SPY bar, the gate adjudicated the entire 514-name cross-section to
// 2026-08-14, and the only two names that DID carry Monday's bar were thrown out as
// `future-dated` — i.e. the freshest data in the scan was discarded as bogus, and a
// four-day-old cross-section was published with no indication it was behind.
//
// The exchange CALENDAR, not the benchmark, is the authority on which sessions have
// actually completed. So the gate now resolves both and compares them:
//   • the ceiling for `future-dated` is the calendar's last completed session (plus
//     today, while a session is in progress) — never the benchmark's own axis;
//   • a benchmark lagging that calendar sets `benchmarkStale` + `sessionsBehind`, so
//     a stale scan is DECLARED instead of being indistinguishable from a healthy one;
//   • rows newer than a lagging benchmark are `ahead-of-benchmark` — still excluded
//     (admitting them would re-mix vintages, the very defect this file exists to
//     close) but no longer mislabelled as corrupt.
//
// Pure (no network, no store); `now` injectable for tests.

const { sessionInfoAt, lastCompletedRegularSession } = require('./market-session');

const FRESHNESS_CLASS = Object.freeze({
  CURRENT: 'current',
  PRIOR_SESSION: 'prior-session',
  STALE: 'stale',
  AHEAD_OF_BENCHMARK: 'ahead-of-benchmark',
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
  const info = sessionInfoAt(now);
  // The exchange calendar's own answer, independent of any provider payload.
  const calendarSession = lastCompletedRegularSession(now) || null;
  if (!axis.length) {
    return {
      session: null, prior: null, latest: null, source: 'unavailable',
      calendarSession, ceiling: null, benchmarkStale: false, sessionsBehind: 0,
    };
  }
  const latest = axis[axis.length - 1];
  const marketOpen = info.marketSession === 'premarket' || info.marketSession === 'regular';
  let session = latest;
  let source = 'benchmark-latest';
  if (marketOpen && latest === info.etDate && axis.length >= 2) {
    session = axis[axis.length - 2];
    source = 'benchmark-completed';
  }
  const si = axis.lastIndexOf(session);
  const prior = si > 0 ? axis[si - 1] : null;

  // Is the scan behind the sessions the exchange has actually completed?
  //
  // Compare the resolved DECISION SESSION, not the newest bar. A hole in the middle of
  // the series is exactly as stale as a short tail, and the newest bar hides it: on
  // 2026-08-18 the SPY axis ran ...08-13, 08-14, 08-18 — Monday simply absent — so the
  // newest bar was TODAY and looked perfectly healthy, while the session every ranking
  // was actually computed on was still Friday. Judging by `latest` called that fresh.
  const benchmarkStale = !!(calendarSession && session < calendarSession);
  if (benchmarkStale) source = 'benchmark-stale';
  const sessionsBehind = benchmarkStale ? countSessionsBetween(session, calendarSession, now) : 0;

  // A bar is only "future-dated" (bogus) past what the calendar can justify: the last
  // completed session, or today while a session is actually in progress. Deriving this
  // from the benchmark's own axis is what let a lagging provider condemn good data.
  let ceiling = latest;
  if (calendarSession && calendarSession > ceiling) ceiling = calendarSession;
  if (info.isTradingDay && info.etDate > ceiling) ceiling = info.etDate;

  return { session, prior, latest, source, calendarSession, ceiling, benchmarkStale, sessionsBehind };
}

// Trading sessions strictly after `fromDate` up to and including `toDate`, per the
// exchange calendar (weekends and holidays excluded). Bounded — a lag longer than the
// scan window is reported as the bound rather than walked indefinitely.
function countSessionsBetween(fromDate, toDate, now = new Date()) {
  if (!fromDate || !toDate || fromDate >= toDate) return 0;
  const DAY_MS = 86400000;
  let n = 0;
  let t = Date.parse(fromDate + 'T12:00:00Z') + DAY_MS;
  const end = Date.parse(toDate + 'T12:00:00Z');
  for (let i = 0; i < 60 && t <= end; i++, t += DAY_MS) {
    const probe = sessionInfoAt(new Date(t));
    if (probe.isTradingDay) n++;
  }
  return n;
}

// Classify one candidate's latest usable bar against the resolved session.
function classifyBarDate(lastBarDate, ctx) {
  if (!ctx || !ctx.session) return FRESHNESS_CLASS.MISSING;
  if (!lastBarDate) return FRESHNESS_CLASS.MISSING;
  // Bogus only past what the exchange calendar can account for. `ceiling` falls back to
  // the benchmark axis when no calendar answer is available, preserving the old behaviour.
  const ceiling = ctx.ceiling || ctx.latest;
  if (ceiling && lastBarDate > ceiling) return FRESHNESS_CLASS.FUTURE_DATED;
  // A row ahead of a LAGGING benchmark is real data we simply cannot adjudicate into
  // this cohort without re-mixing vintages. Excluded, but named for what it is.
  if (ctx.benchmarkStale && lastBarDate > ctx.session) return FRESHNESS_CLASS.AHEAD_OF_BENCHMARK;
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
  const counts = { current: 0, 'prior-session': 0, stale: 0, 'ahead-of-benchmark': 0, 'future-dated': 0, missing: 0 };
  if (!ctx.session) {
    return {
      decisionSession: null, sessionSource: ctx.source, admitted: rows.slice(),
      excluded: [], counts, adjudicated: false,
      calendarSession: ctx.calendarSession, benchmarkStale: false, sessionsBehind: 0,
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
  // FAIL OPEN RATHER THAN RETURN AN EMPTY SCAN. If a lagging benchmark would exclude the
  // ENTIRE cohort as ahead-of-benchmark, the benchmark is the outlier, not the universe —
  // that is the shape of a warm rebuild that picked up the new session for the
  // constituents but not for the index. Blanking the app is the worst available answer,
  // so admit them and carry the flag, exactly as this gate already does when the
  // benchmark axis is missing altogether.
  let failedOpen = false;
  if (!admitted.length && counts[FRESHNESS_CLASS.AHEAD_OF_BENCHMARK] > 0) {
    failedOpen = true;
    for (let i = excluded.length - 1; i >= 0; i--) {
      if (excluded[i].reason !== FRESHNESS_CLASS.AHEAD_OF_BENCHMARK) continue;
      admitted.push(rows.find(r => r && r.ticker === excluded[i].ticker));
      excluded.splice(i, 1);
    }
  }

  return {
    decisionSession: ctx.session, sessionSource: failedOpen ? 'cohort-ahead-of-benchmark' : ctx.source,
    benchmarkLatest: ctx.latest, cohortAheadOfBenchmark: failedOpen,
    // The calendar's verdict travels with every scan so a consumer (or the UI banner)
    // can say "one session behind" instead of presenting stale data as current.
    calendarSession: ctx.calendarSession,
    benchmarkStale: ctx.benchmarkStale, sessionsBehind: ctx.sessionsBehind,
    admitted, excluded, counts, adjudicated: true,
  };
}

module.exports = { FRESHNESS_CLASS, resolveDecisionSession, classifyBarDate, gateCohort, countSessionsBetween };
