'use strict';
// op=lifecycle — SHADOW opportunity-lifecycle board for Day Trade candidates.
//
// Each cycle: load today's persisted lifecycle records → advance every candidate currently
// in the live scan against its fresh evidence → carry forward names that dropped out of the
// scan (so nothing is silently erased) → persist the updated map → return the bucketed board.
//
// READ-ONLY w.r.t. the live screener and its ledgers: it consumes computeDaytradeLive's
// output and never mutates rankings, picks, or the tracked pick log. This is the wiring of
// the deterministic lib/opportunity-lifecycle engine to durable storage + a route; it is NOT
// a validated edge and produces no trade signal.
const { advanceLifecycle, summarizeBoard } = require('./opportunity-lifecycle');
const { buildEvaluation, absentEvaluation, intradayEv, sessionOf } = require('./lifecycle-eval');
const { loadLifecycleDay, saveLifecycleDay, hasDurableStore, appendSnapshots, loadSnapshots, saveGrades } = require('./lifecycle-store');
const { buildSnapshot, firstEntryEpisodes, firstRetirementObservations } = require('./lifecycle-capture');
const { etDate } = require('./freshness');

const STRATEGY = 'daytrade';
const STRATEGY_VERSION = 'lifecycle-v1';
const INTRADAY_SESSIONS = new Set(['regular', 'afterhours']);   // when RTH 5-min bars exist
const STAGE2_MAX_NAMES = 30;                                     // cap fetches to fit the deadline

// STAGE-2 live validation: for the top candidates, fetch 5-min session bars and compute the
// current-session feature set → a rich `ev`. Bounded concurrency + deadline-guarded; SPY is
// fetched once as the residual benchmark. Any name without fresh intraday bars (or on any
// failure, or outside RTH) simply isn't in the returned map → the caller falls back to the
// daily `ev`. Read-only network reads; no storage here.
async function stage2Evaluations(picks, { now, sessionDate, t0, deadline = 38000, maxNames = STAGE2_MAX_NAMES } = {}) {
  const session = sessionOf(new Date(now));
  if (!INTRADAY_SESSIONS.has(session)) return { evByTicker: {}, stage2: 0, skipped: `session:${session}` };
  const { fetchFiveMin } = require('./intraday-capture');
  const { sessionsFromResult, buildIntradayFeatures } = require('./intraday-features');

  let spyToday = [];
  try { const spyRes = await fetchFiveMin('SPY'); if (spyRes) spyToday = sessionsFromResult(spyRes)[sessionDate] || []; } catch { /* residual just unavailable */ }

  const pool = picks.slice(0, maxNames);
  const evByTicker = {};
  let i = 0;
  const worker = async () => {
    while (i < pool.length) {
      const pick = pool[i++];
      if (t0 && Date.now() - t0 > deadline) return;
      try {
        const res = await fetchFiveMin(pick.ticker);
        if (!res) continue;
        const byDate = sessionsFromResult(res);
        const todayBars = byDate[sessionDate] || [];
        if (!todayBars.length) continue;   // no current-session bars → daily fallback
        const priorSessions = Object.keys(byDate).filter(d => d < sessionDate).sort().map(d => byDate[d]);
        const f = buildIntradayFeatures({
          todayBars, priorSessions, spyTodayBars: spyToday, now,
          dailyAtr: pick.orb ? pick.orb.atr : null,
          plan: { entry: pick.entry, stop: pick.stop, target: pick.target },
        });
        if (f.hasIntraday) evByTicker[pick.ticker] = intradayEv(pick, f, { now });
      } catch { /* daily fallback for this name */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { evByTicker, stage2: Object.keys(evByTicker).length, skipped: null };
}

// Compact a full record down to what a UI card needs (drop the heavy transition history,
// keep the last transition + a count so the audit trail is discoverable, not dumped).
function slim(records) {
  return records.map(r => ({
    ticker: r.ticker,
    state: r.state,
    updatedAt: r.updatedAt,
    reason: r.history.at(-1)?.reasonCode || null,
    explanation: r.history.at(-1)?.explanation || null,
    metrics: r.lastMetrics || null,
    freshness: r.lastFreshness || null,
    entryAlertAt: r.entryAlertAt || null,
    falseRetirement: r.falseRetirement || null,
    transitions: r.history.length,
  }));
}

// PURE orchestration (no network / no storage): advance every scanned candidate against its
// fresh evidence, then carry forward prior candidates absent from this scan so they can
// stall/retire rather than vanish. Returns the next { ticker: record } map. Unit-testable.
// `evByTicker` (optional) supplies Stage-2 intraday evaluations; any ticker without one falls
// back to the daily-evidence `ev`. Backward compatible (omit it → pure daily path).
function advanceBoard(prior, picks, nowIso, evByTicker = {}) {
  const next = {};
  const seen = new Set();
  for (const pick of picks || []) {
    if (!pick || !pick.ticker || seen.has(pick.ticker)) continue;
    seen.add(pick.ticker);
    const ev = evByTicker[pick.ticker] || buildEvaluation(pick, { now: nowIso });
    next[pick.ticker] = advanceLifecycle(prior[pick.ticker] || null, { strategy: STRATEGY, ...ev }, { strategyVersion: STRATEGY_VERSION });
  }
  for (const [ticker, rec] of Object.entries(prior || {})) {
    if (seen.has(ticker)) continue;   // absent from this scan → de-escalate, never erase
    next[ticker] = advanceLifecycle(rec, { strategy: STRATEGY, ...absentEvaluation(ticker, { now: nowIso }) }, { strategyVersion: STRATEGY_VERSION });
  }
  return next;
}

async function runLifecycle(req, res) {
  const { computeDaytradeLive } = require('./screener-routes');
  const t0 = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const date = etDate(now);

  let live;
  try { live = await computeDaytradeLive(t0, 40000, { pace: true, expanded: false }); }
  catch { live = null; }
  if (!live) return res.status(502).json({ ok: false, error: 'No market data' });

  // Candidate pool = the validated cap-band lanes + multi-day runs (scan4/expanded is
  // display-only and deliberately excluded, matching runDaytrade's tracked cohort).
  const picks = [...(live.scan1 || []), ...(live.scan2 || []), ...(live.scan3 || [])];

  const priorDoc = await loadLifecycleDay(STRATEGY, date);
  // Stage-2 live validation for the top candidates (5-min bars → current-session ev); the
  // rest fall back to daily evidence. Deadline-guarded so the response stays bounded.
  const { evByTicker, stage2, skipped } = await stage2Evaluations(picks, { now: nowIso, sessionDate: date, t0, deadline: 38000 });
  const next = advanceBoard(priorDoc.records || {}, picks, nowIso, evByTicker);

  const persist = await saveLifecycleDay(STRATEGY, date, next);
  const board = summarizeBoard(Object.values(next));

  // IMMUTABLE CAPTURE — append one snapshot per tracked candidate for this interval. Display
  // position is the candidate's index in the prominently-shown sections. Append-only; outcomes
  // are graded separately (op=lifecyclegrade) and never rewrite these snapshots.
  const picksByTicker = {};
  for (const p of picks) if (p && p.ticker && !(p.ticker in picksByTicker)) picksByTicker[p.ticker] = p;
  const shownOrder = new Map();
  [...board.actionableNow, ...board.buildingNearTrigger, ...board.tooExtended, ...board.managing].forEach((r, i) => shownOrder.set(r.ticker, i));
  const sess = sessionOf(now);
  const snapshots = Object.values(next)
    .filter(r => r.state !== 'CLOSED')   // terminal records were already captured; don't re-log
    .map(r => buildSnapshot({
      record: r, ev: { session: sess }, pick: picksByTicker[r.ticker] || {},
      displayed: shownOrder.has(r.ticker), displayPosition: shownOrder.has(r.ticker) ? shownOrder.get(r.ticker) : null,
      at: nowIso,
    }));
  const capture = await appendSnapshots(STRATEGY, date, snapshots);

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
  return res.json({
    ok: true,
    strategy: STRATEGY,
    strategyVersion: STRATEGY_VERSION,
    mode: 'shadow',
    sessionDate: date,
    session: sessionOf(now),
    generatedAt: nowIso,
    durable: hasDurableStore(),
    persisted: !!persist.persisted,
    persistNote: persist.reason || null,
    liveValidation: { stage2Enriched: stage2, candidates: picks.length, skipped: skipped || null },
    capture: { snapshotsAppended: capture.appended ?? 0, totalToday: capture.total ?? 0, persisted: !!capture.persisted },
    counts: board.counts,
    actionableNow: slim(board.actionableNow),
    buildingNearTrigger: slim(board.buildingNearTrigger),
    tooExtended: slim(board.tooExtended),
    retiredToday: slim(board.retiredToday),
    managing: slim(board.managing),
    closed: slim(board.closed),
    note: 'SHADOW: during RTH the top candidates are live-validated from 5-min bars (VWAP / opening-range trigger + failure / same-time-of-day relVol from the trailing-5d fetch / residual vs SPY), which drives ARMED/ACTIONABLE_NOW and the intraday failure paths. Names without fresh intraday bars — outside RTH, on a fetch failure, or below the fetch cap — fall back to daily evidence and top out at BUILDING. Shadow only: nothing here changes live rankings or picks, and the gate thresholds are baseline policy, not validated alpha.',
  });
}

// op=lifecyclegrade — leakage-safe forward-outcome grading of a day's captured snapshots.
// Headline = ONE first-entry (ACTIONABLE_NOW) episode per ticker/day, graded on triple
// barriers from POST-DECISION 5-min bars only. Also grades first-retirement observations to
// measure false retirements (did a retired name later run?). Grades persist to a SEPARATE doc
// — the immutable snapshots are never rewritten.
async function runLifecycleGrade(req, res) {
  const { fetchFiveMin } = require('./intraday-capture');
  const { sessionsFromResult } = require('./intraday-features');
  const { forwardBarsAfter, gradeOutcome } = require('./outcome-grade');

  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : etDate(new Date());
  const snapshots = await loadSnapshots(STRATEGY, date);
  const episodes = firstEntryEpisodes(snapshots);
  const retiredObs = firstRetirementObservations(snapshots);

  const barsCache = new Map();
  async function sessionBars(ticker) {
    if (barsCache.has(ticker)) return barsCache.get(ticker);
    let bars = [];
    try { const r = await fetchFiveMin(ticker); if (r) bars = sessionsFromResult(r)[date] || []; } catch { /* ungradeable */ }
    barsCache.set(ticker, bars);
    return bars;
  }
  const gradedAt = new Date().toISOString();
  const grades = {};
  for (const e of episodes) {
    const g = gradeOutcome({ decisionPrice: e.decisionPrice, decisionAt: e.decisionAt, atr: e.atr, forwardBars: forwardBarsAfter(await sessionBars(e.ticker), e.decisionAt) });
    if (g) grades[e.episodeId] = { ...e, type: 'entry', outcome: g, becameDud: g.barrier === 'FAILURE', gradedAt };
  }
  for (const r of retiredObs) {
    const g = gradeOutcome({ decisionPrice: r.decisionPrice, decisionAt: r.decisionAt, atr: r.atr, forwardBars: forwardBarsAfter(await sessionBars(r.ticker), r.decisionAt) });
    if (g) grades[r.episodeId] = { ...r, type: 'retired', outcome: g, becameRunner: g.barrier === 'SUCCESS', gradedAt };
  }
  const persist = await saveGrades(STRATEGY, date, grades);

  const entries = Object.values(grades).filter(g => g.type === 'entry');
  const n = entries.length;
  const by = b => entries.filter(g => g.outcome.barrier === b).length;
  const mean = sel => n ? +(entries.reduce((s, g) => s + sel(g), 0) / n).toFixed(5) : null;
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=1200');
  return res.json({
    ok: true, strategy: STRATEGY, date, mode: 'shadow',
    persisted: !!persist.persisted, persistNote: persist.reason || null,
    snapshots: snapshots.length, episodes: episodes.length, retiredObservations: retiredObs.length,
    barriers: { kUp: 0.5, kDown: 0.35, scale: 'ATR', slippageBps: 10 },
    headline: {
      n, wins: by('SUCCESS'), fails: by('FAILURE'), timeouts: by('TIMEOUT'),
      winRate: n ? +(by('SUCCESS') / n).toFixed(3) : null,
      avgNetReturn: mean(g => g.outcome.netReturn), avgMfe: mean(g => g.outcome.mfe), avgMae: mean(g => g.outcome.mae),
      falseRetirements: Object.values(grades).filter(g => g.type === 'retired' && g.becameRunner).length,
    },
    note: 'SHADOW: leakage-safe triple-barrier grading uses ONLY post-decision 5-min bars. Headline counts one first-entry ACTIONABLE_NOW episode per ticker/day (not overlapping snapshots). Barrier thresholds are baseline policy, not validated alpha — this measures the deterministic system honestly; it is not itself an edge.',
  });
}

module.exports = { runLifecycle, runLifecycleGrade, advanceBoard, STRATEGY, STRATEGY_VERSION, slim };
