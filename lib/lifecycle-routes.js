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
const { loadLifecycleDay, saveLifecycleDay, hasDurableStore, appendSnapshots, loadSnapshots, saveGrades, gradeKey } = require('./lifecycle-store');
const { buildSnapshot, firstEntryEpisodes, firstRetirementObservations } = require('./lifecycle-capture');
const { etDate } = require('./freshness');
// Stage-2 live 5-min revalidation is shared with the LIVE route (lib/daytrade-actionability)
// so the shadow board and the live board validate candidates identically (DRY).
const { stage2Evaluations } = require('./daytrade-actionability');

const STRATEGY = 'daytrade';
const STRATEGY_VERSION = 'lifecycle-v1';

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

// READ-ONLY since the writer-authority redesign. This op used to RE-COMPUTE and RE-SAVE the
// same lifecycle doc the live board owns — under the engine's DEFAULT config (none of the
// production anti-flap/thesis thresholds) and without the activePlan/earlyState stamps, so
// every write silently erased the frozen-plan contract and the early-alert diff basis for
// the next live cycle. There is now exactly ONE lifecycle writer (op=daytradeboardtick);
// this op serves the persisted records as a bucketed view.
async function runLifecycle(req, res) {
  const now = new Date();
  const nowIso = now.toISOString();
  const date = etDate(now);

  const priorDoc = await loadLifecycleDay(STRATEGY, date);
  const records = Object.values(priorDoc.records || {});
  const board = summarizeBoard(records);

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
  return res.json({
    ok: true,
    strategy: STRATEGY,
    strategyVersion: STRATEGY_VERSION,
    mode: 'read-only-view',
    authority: 'op=daytradeboardtick is the single lifecycle writer; this op never advances state',
    sessionDate: date,
    session: sessionOf(now),
    generatedAt: nowIso,
    durable: hasDurableStore(),
    tracked: records.length,
    lastAdvancedAt: records.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), '') || null,
    counts: board.counts,
    actionableNow: slim(board.actionableNow),
    reversalReclaim: slim(board.reversalReclaim),
    armed: slim(board.armed),
    buildingNearTrigger: slim(board.buildingNearTrigger),
    tooExtended: slim(board.tooExtended),
    retiredToday: slim(board.retiredToday),
    priorSessionWatch: slim(board.priorSessionWatch),
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
  const { forwardBarsAfter, gradeOutcome, gradeHorizons } = require('./outcome-grade');

  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : etDate(new Date());
  const snapshots = await loadSnapshots(STRATEGY, date);

  // FAIL-CLOSED persistence (review 2026-08-15): loadSnapshots now counts unreadable
  // shards (withReadStats). grades/<date>.json is an OVERWRITE — grading a truncated day
  // and persisting it would silently replace grades built from the complete evidence. If
  // the read was incomplete and a grades doc already exists, keep the prior doc and
  // refuse; if none exists (grade would otherwise never accrue), write but STAMP the doc
  // `readIncomplete:true` so partial-evidence grades stay distinguishable.
  const readIncomplete = snapshots.complete === false;
  if (readIncomplete) {
    let hasExistingGrades = true;                       // fail closed when the probe fails
    try { hasExistingGrades = await require('./store').blobExists(gradeKey(STRATEGY, date)); }
    catch { hasExistingGrades = true; }
    if (hasExistingGrades) {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        ok: false, graded: false, strategy: STRATEGY, date, mode: 'shadow',
        reason: 'incomplete-snapshot-read',
        unreadable: snapshots.unreadable ?? null, requestedShards: snapshots.requested ?? null,
        note: 'Snapshot shard read was incomplete — refusing to overwrite the existing grades doc with grades computed from a truncated day. Prior grades are preserved; retry when every shard is readable.',
      });
    }
  }

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
    const fwd = forwardBarsAfter(await sessionBars(e.ticker), e.decisionAt);
    const g = gradeOutcome({ decisionPrice: e.decisionPrice, decisionAt: e.decisionAt, atr: e.atr, forwardBars: fwd });
    if (g) {
      const horizons = gradeHorizons({ decisionPrice: e.decisionPrice, decisionAt: e.decisionAt, atr: e.atr, forwardBars: fwd });
      grades[e.episodeId] = { ...e, type: 'entry', outcome: g, horizons, becameDud: g.barrier === 'FAILURE', gradedAt };
    }
  }
  for (const r of retiredObs) {
    const g = gradeOutcome({ decisionPrice: r.decisionPrice, decisionAt: r.decisionAt, atr: r.atr, forwardBars: forwardBarsAfter(await sessionBars(r.ticker), r.decisionAt) });
    if (g) grades[r.episodeId] = { ...r, type: 'retired', outcome: g, becameRunner: g.barrier === 'SUCCESS', gradedAt };
  }
  const persist = await saveGrades(STRATEGY, date, grades,
    readIncomplete ? { readIncomplete: true, unreadableShards: snapshots.unreadable ?? null } : null);

  const entries = Object.values(grades).filter(g => g.type === 'entry');
  const n = entries.length;
  const by = b => entries.filter(g => g.outcome.barrier === b).length;
  const mean = sel => n ? +(entries.reduce((s, g) => s + sel(g), 0) / n).toFixed(5) : null;

  // Alert latency (earliest qualifying state → entry alert) from the day's durable alert log.
  let alertLatency = null;
  try {
    const { readJSON } = require('./store');
    const { alertsKey } = require('./daytrade-alerts');
    const adoc = await readJSON(alertsKey(date), null);
    const lat = (adoc && adoc.alerts ? adoc.alerts : []).filter(a => a.kind === 'entry' && a.alertLatencyMin != null).map(a => a.alertLatencyMin);
    if (lat.length) alertLatency = { n: lat.length, meanMin: +(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(1), maxMin: Math.max(...lat) };
  } catch { /* latency summary is best-effort */ }
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=1200');
  return res.json({
    ok: true, strategy: STRATEGY, date, mode: 'shadow',
    persisted: !!persist.persisted, persistNote: persist.reason || null,
    readIncomplete, unreadableShards: snapshots.unreadable ?? 0,
    snapshots: snapshots.length, episodes: episodes.length, retiredObservations: retiredObs.length,
    barriers: { kUp: 0.5, kDown: 0.35, scale: 'ATR', slippageBps: 10 },
    headline: {
      n, wins: by('SUCCESS'), fails: by('FAILURE'), timeouts: by('TIMEOUT'),
      winRate: n ? +(by('SUCCESS') / n).toFixed(3) : null,
      avgNetReturn: mean(g => g.outcome.netReturn), avgMfe: mean(g => g.outcome.mfe), avgMae: mean(g => g.outcome.mae),
      falseRetirements: Object.values(grades).filter(g => g.type === 'retired' && g.becameRunner).length,
      alertLatency,
    },
    note: 'SHADOW: leakage-safe triple-barrier grading uses ONLY post-decision 5-min bars. Headline counts one first-entry ACTIONABLE_NOW episode per ticker/day (not overlapping snapshots). Barrier thresholds are baseline policy, not validated alpha — this measures the deterministic system honestly; it is not itself an edge.',
  });
}

module.exports = { runLifecycle, runLifecycleGrade, advanceBoard, STRATEGY, STRATEGY_VERSION, slim };
