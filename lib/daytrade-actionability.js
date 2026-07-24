'use strict';
// DAY-TRADE LIVE ACTIONABILITY — the two-stage overlay that turns the daily-cache candidate
// POOL into a session-aware, lifecycle-classified board, and the single place the "is this an
// actionable buy RIGHT NOW?" question is answered.
//
// THE DEFECT THIS CLOSES. The Day Trade scan reads a daily-candle cache built pre-open, so
// during regular hours EVERY candidate's newest daily bar is a PRIOR session — yesterday's
// +3.35% mover, not today. The browser overlays a live quote (down 10%) while membership,
// rank, pctChange, carry, stops and buy-language still describe yesterday's bullish bar. A
// daily bar can DISCOVER or RETAIN a watchlist name but can NEVER establish current
// actionability. So:
//   Stage 1 (elsewhere): the daily-cache scan produces a bounded candidate pool.
//   Stage 2 (here):      current 5-minute bars + a recent timestamp REVALIDATE that pool,
//                        overlaying live evidence on the shortlist (not re-fetching the whole
//                        universe). Only a name with FRESH current-session evidence that
//                        clears the intraday gate becomes ACTIONABLE_NOW.
//
// Everything reuses the deterministic lib/opportunity-lifecycle engine — no competing state
// machine. Missing / stale / contradictory evidence FAILS CLOSED (never ACTIONABLE_NOW).

const { advanceLifecycle, summarizeBoard, isActionable, STATES } = require('./opportunity-lifecycle');
const { buildEvaluation, intradayEv, sessionOf } = require('./lifecycle-eval');
const { isActionableFresh, isCurrentSessionFresh } = require('./freshness');
const CFG = require('./daytrade-config');

const INTRADAY_SESSIONS = new Set(['regular', 'afterhours']);   // when RTH 5-min bars exist
const STAGE2_MAX_NAMES = 30;                                     // cap fetches to fit the deadline
const LIFECYCLE_CFG = { failLossAtr: CFG.THESIS.FAIL_LOSS_ATR, vwapLossConfirm: CFG.THESIS.VWAP_LOSS_CONFIRM, reclaimMinRR: CFG.RECLAIM.MIN_REMAINING_RR };

// ── STAGE-2: live 5-minute revalidation of the candidate shortlist ─────────────
// For the top candidates, fetch current-session 5-min bars and compute the point-in-time
// feature set → a rich intraday `ev`. Bounded concurrency + deadline-guarded; SPY fetched
// once as the residual benchmark. Any name without fresh intraday bars (or any failure, or
// outside RTH) simply isn't in the returned map → the caller uses the daily `ev`. This is
// the SAME contract lib/lifecycle-routes previously defined locally; centralized here (DRY)
// so the shadow board and the live route validate identically.
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

// ── Pure classification: pool + evidence → per-ticker lifecycle record ──────────
// Runs the deterministic engine once per candidate (stateless one-shot — the persistent,
// hysteresis-carrying board is the shadow op=lifecycle; this drives the LIVE display). A
// Stage-2 intraday ev (when present) beats the daily-evidence fallback for that name.
function classifyPool(picks, { now, evByTicker = {} } = {}) {
  const nowIso = now || new Date().toISOString();
  const byTicker = {};
  const seen = new Set();
  for (const pick of picks || []) {
    if (!pick || !pick.ticker || seen.has(pick.ticker)) continue;
    seen.add(pick.ticker);
    const ev = evByTicker[pick.ticker] || buildEvaluation(pick, { now: nowIso });
    const record = advanceLifecycle(null, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG);
    byTicker[pick.ticker] = { pick, ev, record, card: buildCanonicalCard(pick, ev, record, { now: nowIso }) };
  }
  return byTicker;
}

// Internal-consistency of a trade plan: entry/stop/target present and correctly ordered.
function planConsistent(entry, stop, target) {
  return entry > 0 && stop > 0 && target > 0 && entry > stop && target > entry;
}

// ── The ONE canonical Day Trade candidate representation ────────────────────────
// Enriches the existing pick (so all legacy card fields survive) with the lifecycle/
// freshness/thesis fields every actionable decision path keys off. Immutable: returns a NEW
// object; the input pick is never mutated.
function buildCanonicalCard(pick, ev, record, { now } = {}) {
  const nowIso = now || new Date().toISOString();
  const lc = record.state;
  const fresh = record.lastFreshness || ev.freshness || pick.freshness || null;
  const currentSessionFresh = isActionableFresh(fresh, { now: new Date(nowIso) });
  const m = ev.metrics || {};

  // Thesis validity — the ORIGINAL long momentum thesis. false on any confirmed invalidation,
  // null for a prior-session-only name (historical discovery — cannot be confirmed live), true
  // otherwise. Never "true" for a name the engine retired.
  let thesisValid;
  if (lc === STATES.FAILED || lc === STATES.EXPIRED || lc === STATES.TOO_EXTENDED || lc === STATES.STALLING) thesisValid = false;
  else if (ev.stopBreached === true || ev.breakoutFailed === true || (ev.closesBelowVwap || 0) >= CFG.THESIS.VWAP_LOSS_CONFIRM || (ev.lossFromDetectionAtr ?? 0) >= CFG.THESIS.FAIL_LOSS_ATR) thesisValid = false;
  else if (lc === STATES.PRIOR_SESSION_WATCH) thesisValid = null;
  else thesisValid = true;

  const originalPlan = { entry: pick.entry ?? null, stop: pick.stop ?? null, target: pick.target ?? null, rr: pick.rr ?? null, orb: pick.orb || null };
  const planValid = thesisValid !== false && planConsistent(originalPlan.entry, originalPlan.stop, originalPlan.target);

  const originalPrice = pick.entry ?? pick.last ?? null;
  const currentPrice = (ev.metrics && ev.metrics.last != null) ? ev.metrics.last : (pick.last ?? null);   // intraday last when Stage-2 ran, else the detection bar
  const lossFromDetectionPct = (originalPrice != null && currentPrice != null && currentPrice < originalPrice)
    ? +(((currentPrice / originalPrice) - 1) * 100).toFixed(2) : (currentPrice != null && originalPrice != null ? +(((currentPrice / originalPrice) - 1) * 100).toFixed(2) : null);

  const last = record.history && record.history.at ? record.history.at(-1) : null;
  return {
    ...pick,
    // Canonical lifecycle / actionability envelope.
    lifecycleState: lc,
    actionable: isActionable(lc),
    thesisValid,
    planValid,
    currentSessionFresh,
    reasonCodes: last ? [last.reasonCode].filter(Boolean) : [],
    explanation: last ? last.explanation : null,
    // Freshness timestamps (immutable origin + live validation).
    candidateAsOf: (fresh && (fresh.candidateDate || fresh.dailyBarAsOf)) || pick.candidateDate || pick.date || null,
    intradayBarAsOf: (fresh && fresh.intradayBarAsOf) || null,
    quoteAsOf: (fresh && fresh.quoteAsOf) || null,
    validatedAt: ev.intraday || (fresh && fresh.intradayBarAsOf) ? nowIso : null,
    freshnessStatus: fresh ? fresh.freshnessStatus : null,
    // Detection origin (immutable — for later grading) + current-vs-detection.
    detection: { source: pick.scan || pick.source || null, tier: pick.tier || null, price: originalPrice, date: pick.candidateDate || pick.date || null },
    originalPrice, currentPrice,
    lossFromDetectionPct,
    lossFromDetectionAtr: ev.lossFromDetectionAtr ?? null,
    stopBreached: ev.stopBreached === true,
    breakoutFailed: ev.breakoutFailed === true,
    // Current intraday state (null when the daily fallback was used).
    currentVwap: m.vwap ?? null,
    aboveVwap: ev.aboveVwap ?? null,
    openingRangeForming: ev.openingRangeForming ?? null,
    triggerConfirmed: ev.triggerConfirmed ?? null,
    mom15: m.mom15 ?? null,
    residualVsSpy: m.residualVsSpy ?? null,
    timeOfDayRelVol: m.timeOfDayRelVol ?? null,
    remainingRR: m.remainingRR ?? null,
    extensionAtr: m.extensionAtr ?? null,
    planAsOf: pick.date || pick.candidateDate || null,
    originalPlan,
  };
}

// Bucket the classified pool into the UI lanes. Returns lane arrays of ENRICHED CARDS plus a
// count summary. Only ACTIONABLE_NOW / REVERSAL_RECLAIM feed the actionable lane.
function bucketLanes(byTicker) {
  const records = Object.values(byTicker).map(x => x.record);
  const board = summarizeBoard(records);
  const cardOf = r => byTicker[r.ticker] ? byTicker[r.ticker].card : null;
  const lanes = {
    actionableNow: board.actionableNow.map(cardOf).filter(Boolean),
    reversalReclaim: board.reversalReclaim.map(cardOf).filter(Boolean),
    armed: board.armed.map(cardOf).filter(Boolean),
    buildingWatch: board.buildingNearTrigger.map(cardOf).filter(Boolean),
    tooExtended: board.tooExtended.map(cardOf).filter(Boolean),
    retiredToday: board.retiredToday.map(cardOf).filter(Boolean),
    priorSessionWatch: board.priorSessionWatch.map(cardOf).filter(Boolean),
    managing: board.managing.map(cardOf).filter(Boolean),
    closed: board.closed.map(cardOf).filter(Boolean),
  };
  const counts = Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v.length]));
  return { lanes, counts };
}

// ── Orchestration: pool → (optional Stage-2) → classified lanes ─────────────────
// `doStage2` controls whether the live 5-min revalidation runs (true during RTH from the
// route; false in tests / off-hours). Fails closed on any Stage-2 error — the daily fallback
// yields PRIOR_SESSION_WATCH/BUILDING, never ACTIONABLE_NOW.
async function runActionability(picks, { now, sessionDate, t0, deadline = 38000, doStage2 = true } = {}) {
  const nowIso = now || new Date().toISOString();
  const session = sessionOf(new Date(nowIso));
  let stage2 = { evByTicker: {}, stage2: 0, skipped: 'disabled' };
  if (doStage2) {
    try { stage2 = await stage2Evaluations(picks, { now: nowIso, sessionDate, t0, deadline }); }
    catch (e) { stage2 = { evByTicker: {}, stage2: 0, skipped: `error:${String((e && e.message) || e)}` }; }
  }
  const byTicker = classifyPool(picks, { now: nowIso, evByTicker: stage2.evByTicker });
  const { lanes, counts } = bucketLanes(byTicker);
  return {
    session,
    liveValidated: stage2.stage2 || 0,
    liveValidationSkipped: stage2.skipped || null,
    degraded: doStage2 && INTRADAY_SESSIONS.has(session) && (stage2.stage2 || 0) === 0,
    lanes, counts, byTicker,
    generatedAt: nowIso,
  };
}

module.exports = {
  stage2Evaluations, classifyPool, buildCanonicalCard, bucketLanes, runActionability,
  planConsistent, INTRADAY_SESSIONS, STAGE2_MAX_NAMES, LIFECYCLE_CFG,
};
