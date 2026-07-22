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
const { buildEvaluation, absentEvaluation, sessionOf } = require('./lifecycle-eval');
const { loadLifecycleDay, saveLifecycleDay, hasDurableStore } = require('./lifecycle-store');
const { etDate } = require('./freshness');

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
function advanceBoard(prior, picks, nowIso) {
  const next = {};
  const seen = new Set();
  for (const pick of picks || []) {
    if (!pick || !pick.ticker || seen.has(pick.ticker)) continue;
    seen.add(pick.ticker);
    const ev = buildEvaluation(pick, { now: nowIso });
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
  const next = advanceBoard(priorDoc.records || {}, picks, nowIso);

  const persist = await saveLifecycleDay(STRATEGY, date, next);
  const board = summarizeBoard(Object.values(next));

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
    counts: board.counts,
    actionableNow: slim(board.actionableNow),
    buildingNearTrigger: slim(board.buildingNearTrigger),
    tooExtended: slim(board.tooExtended),
    retiredToday: slim(board.retiredToday),
    managing: slim(board.managing),
    closed: slim(board.closed),
    note: 'SHADOW: states are driven by daily-bar evidence + per-ticker freshness. ACTIONABLE_NOW/ARMED and the intraday failure paths require the Stage-2 intraday feature builder (VWAP / opening-range trigger / time-of-day relVol), which is not yet wired — so daily-only candidates top out at BUILDING. Nothing here changes live rankings or picks.',
  });
}

module.exports = { runLifecycle, advanceBoard, STRATEGY, STRATEGY_VERSION, slim };
