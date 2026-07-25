'use strict';
// DAY-TRADE LIVE ACTIONABILITY — the two-stage overlay that turns the daily-cache candidate
// POOL into a session-aware, lifecycle-classified board, and the single place the "is this an
// actionable buy RIGHT NOW?" question is answered.
//
// THE DEFECT THIS CLOSES. The Day Trade scan reads a once-daily candle cache (rebuilt by the
// post-close cron), so during regular hours EVERY candidate's newest daily bar is a PRIOR session — yesterday's
// +3.35% mover, not today. The browser overlays a live quote (down 10%) while membership,
// rank, pctChange, carry, stops and buy-language still describe yesterday's bullish bar. A
// daily bar can DISCOVER or RETAIN a watchlist name but can NEVER establish current
// actionability. So:
//   Stage 1 (elsewhere): the daily-cache scan produces a bounded candidate pool.
//   Stage 2 (here):      current 5-minute bars + a recent quote REVALIDATE that pool,
//                        overlaying live evidence on the shortlist (not re-fetching the whole
//                        universe). Only a name with FRESH current-session evidence (bar AND
//                        quote) that clears the intraday gate becomes ACTIONABLE_NOW.
//
// AUTHORITATIVE PERSISTENT LIFECYCLE. The live route passes the day's persisted records in
// (`priorRecords`) and persists the advanced map back, so hysteresis, cooldowns, post-entry
// locks, revival and retirement survive across refreshes — the durable state IS the live
// state, not a stateless one-shot reconstruction. Callers without prior state (tests, cold
// start, no Blob) degrade to the one-shot behavior explicitly.
//
// GLOBAL DEEP-VALIDATION SELECTION. The Stage-2 fetch budget is spent on the candidates with
// the highest CROSS-SECTIONAL priority over the MERGED pool (all scan families + expanded +
// discovery), with active lifecycle names revalidated first — never on a family-concatenation
// prefix, so one family can no longer consume the whole budget.
//
// Everything reuses the deterministic lib/opportunity-lifecycle engine — no competing state
// machine. Missing / stale / contradictory / future-dated evidence FAILS CLOSED.

const { advanceLifecycle, summarizeBoard, isActionable, STATES } = require('./opportunity-lifecycle');
const { buildEvaluation, absentEvaluation, intradayEv, sessionOf } = require('./lifecycle-eval');
const { isActionableFresh } = require('./freshness');
const CFG = require('./daytrade-config');

const INTRADAY_SESSIONS = new Set(['regular', 'afterhours']);   // when RTH 5-min bars exist
const STAGE2_MAX_NAMES = CFG.STAGE2.MAX_NAMES;                  // configurable via DAYTRADE_STAGE2_MAX
const LIFECYCLE_CFG = { failLossAtr: CFG.THESIS.FAIL_LOSS_ATR, vwapLossConfirm: CFG.THESIS.VWAP_LOSS_CONFIRM, reclaimMinRR: CFG.RECLAIM.MIN_REMAINING_RR };

// Prior lifecycle states that MUST be revalidated every cycle (failure detection on an armed
// or actionable name matters more than discovering one more watch candidate).
const REVALIDATE_BOOST = {
  [STATES.MANAGING]: 5,
  [STATES.ACTIONABLE_NOW]: 4,
  [STATES.REVERSAL_RECLAIM]: 4,
  [STATES.ARMED]: 3,
  [STATES.OPENING_RANGE_FORMING]: 2,
};

// ── Global deep-pool selection: ONE cross-sectional priority over the merged pool ──
// z-blend of relVol / pctChange / excessPct across ALL candidates (family-agnostic), plus a
// lifecycle boost so already-active names keep their live validation. Dedupes by ticker
// (first occurrence keeps its pick). Pure.
function selectDeepPool(picks, { priorRecords = {}, maxNames = STAGE2_MAX_NAMES } = {}) {
  const seen = new Set();
  const pool = [];
  for (const p of picks || []) {
    if (!p || !p.ticker || seen.has(p.ticker)) continue;
    seen.add(p.ticker);
    pool.push(p);
  }
  const stat = key => {
    const v = pool.map(p => p[key]).filter(x => x != null && isFinite(x));
    const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length || 1)) || 1;
    return { m, sd };
  };
  const rv = stat('relVol'), pc = stat('pctChange'), ex = stat('excessPct');
  const z = (x, s) => (x == null || !isFinite(x)) ? 0 : (x - s.m) / s.sd;
  const priority = p => {
    const prior = priorRecords[p.ticker];
    const boost = prior ? (REVALIDATE_BOOST[prior.state] || 0) : 0;
    return boost * 1000 + z(p.relVol, rv) + z(p.pctChange, pc) + z(p.excessPct, ex);
  };
  return [...pool].sort((a, b) => priority(b) - priority(a)).slice(0, Math.max(1, maxNames));
}

// ── Live trade-plan recomputation ───────────────────────────────────────────────
// An actionable card must NEVER present the prior-session (daily-cache) stop/target as its
// plan. Given current-session features, rebuild the plan from the ACTUAL live trigger:
// entry = the live price at confirmation, stop = the tighter of (opening-range low − pad)
// and (entry − k×ATR), target = entry + rr×risk, plus remaining R:R from the live price and
// an explicit expiry. Null (fail closed) when the live evidence can't support a plan.
function computeLivePlan(f, { now } = {}) {
  const P = CFG.LIVE_PLAN;
  const atr = f.dailyAtr;
  const last = f.last;
  if (!(atr > 0) || !(last > 0)) return null;
  const or = f.openingRange;
  const trigger = f.orComplete && or ? or.high : null;
  const entry = last;
  const atrStop = entry - P.STOP_ATR_MULT * atr;
  const orStop = or ? or.low - P.OR_LOW_PAD_ATR * atr : null;
  const stop = orStop != null ? Math.max(atrStop, orStop) : atrStop;   // tighter (higher) of the two
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  const target = entry + P.TARGET_RR * risk;
  const remainingRR = +( (target - last) / (last - stop) ).toFixed(2);
  const nowMs = Date.parse(now || new Date().toISOString());
  const minsToClose = Math.max(0, (16 * 60) - (f.nowSinceOpen + 9 * 60 + 30));
  const expiresAt = new Date(nowMs + Math.min(P.EXPIRES_MIN, minsToClose) * 60000).toISOString();
  return {
    basis: 'live-intraday',
    entry: +entry.toFixed(2), stop: +stop.toFixed(2), target: +target.toFixed(2),
    rr: P.TARGET_RR, riskPct: +((risk / entry) * 100).toFixed(1),
    trigger: trigger != null ? +trigger.toFixed(2) : null,
    atr: +atr.toFixed(3), remainingRR,
    computedAt: new Date(nowMs).toISOString(), expiresAt,
  };
}

// ── STAGE-2: live 5-minute revalidation of the globally-selected deep pool ─────
// For the selected candidates, fetch current-session 5-min bars + the live quote (chart
// meta) and compute the point-in-time feature set → a rich intraday `ev` with the STRICT
// freshness signal and a recomputed live plan. Bounded concurrency + deadline-guarded; SPY
// fetched once as the residual benchmark. Any name without fresh intraday bars simply isn't
// in the returned map → the caller uses the daily `ev` (which can never be actionable).
async function stage2Evaluations(picks, { now, sessionDate, t0, deadline = 38000, maxNames = STAGE2_MAX_NAMES, priorRecords = {} } = {}) {
  const session = sessionOf(new Date(now));
  if (!INTRADAY_SESSIONS.has(session)) return { evByTicker: {}, stage2: 0, skipped: `session:${session}` };
  const { fetchFiveMin } = require('./intraday-capture');
  const { sessionsFromResult, buildIntradayFeatures } = require('./intraday-features');

  let spyToday = [];
  try { const spyRes = await fetchFiveMin('SPY'); if (spyRes) spyToday = sessionsFromResult(spyRes)[sessionDate] || []; } catch { /* residual just unavailable */ }

  const pool = selectDeepPool(picks, { priorRecords, maxNames });
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
        // Live quote from the chart meta — the second half of the strict freshness pair.
        const meta = res.meta || {};
        const quote = (meta.regularMarketPrice != null && meta.regularMarketTime != null)
          ? { price: +meta.regularMarketPrice, asOf: new Date(meta.regularMarketTime * 1000).toISOString() }
          : null;
        let f = buildIntradayFeatures({
          todayBars, priorSessions, spyTodayBars: spyToday, now,
          dailyAtr: pick.orb ? pick.orb.atr : (pick.atr ?? null),
          plan: { entry: pick.entry, stop: pick.stop, target: pick.target },
        });
        if (f.hasIntraday) {
          // Recompute the plan from the live trigger; the live remaining R:R (from the live
          // plan, not the stale daily one) is what the actionable gate evaluates.
          const livePlan = computeLivePlan(f, { now });
          if (livePlan) f = { ...f, livePlan, remainingRR: livePlan.remainingRR };
          evByTicker[pick.ticker] = intradayEv(pick, f, { now, quote });
        }
      } catch { /* daily fallback for this name */ }
    }
  };
  await Promise.all(Array.from({ length: CFG.STAGE2.CONCURRENCY }, worker));
  return { evByTicker, stage2: Object.keys(evByTicker).length, skipped: null, deepPool: pool.map(p => p.ticker) };
}

// ── Classification: pool + evidence + PRIOR STATE → per-ticker lifecycle record ──
// Advances each candidate FROM its persisted record (hysteresis, cooldowns, post-entry lock,
// retirement and revival all work across refreshes). Prior-day tickers absent from the
// current pool are carried forward via absentEvaluation — de-escalated, never erased. With
// no priorRecords this degrades to the stateless one-shot (tests / cold start / no Blob).
function classifyPool(picks, { now, evByTicker = {}, priorRecords = {} } = {}) {
  const nowIso = now || new Date().toISOString();
  const byTicker = {};
  const seen = new Set();
  for (const pick of picks || []) {
    if (!pick || !pick.ticker || seen.has(pick.ticker)) continue;
    seen.add(pick.ticker);
    const ev = evByTicker[pick.ticker] || buildEvaluation(pick, { now: nowIso });
    const record = advanceLifecycle(priorRecords[pick.ticker] || null, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG);
    byTicker[pick.ticker] = { pick, ev, record, card: buildCanonicalCard(pick, ev, record, { now: nowIso }) };
  }
  // Carry forward tracked names that dropped out of the scan — they stall/retire visibly.
  for (const [ticker, rec] of Object.entries(priorRecords)) {
    if (seen.has(ticker) || !rec) continue;
    const ev = evByTicker[ticker] || absentEvaluation(ticker, { now: nowIso });
    const record = advanceLifecycle(rec, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG);
    const pick = { ticker };
    byTicker[ticker] = { pick, ev, record, card: buildCanonicalCard(pick, ev, record, { now: nowIso }) };
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
  const actionable = isActionable(lc);
  const livePlan = ev.livePlan || null;

  // The plan IN FORCE. An actionable state may ONLY present a live-recomputed plan — the
  // stale daily plan is never re-labeled as the current one. No live plan → planValid=false
  // (fail closed: the card cannot carry buy levels it can't currently justify).
  const planInForce = actionable ? livePlan : originalPlan;
  let planValid;
  if (actionable) planValid = !!(livePlan && planConsistent(livePlan.entry, livePlan.stop, livePlan.target));
  else planValid = thesisValid !== false && planConsistent(originalPlan.entry, originalPlan.stop, originalPlan.target);

  const originalPrice = pick.entry ?? pick.last ?? null;
  const currentPrice = (m.quotePrice != null) ? m.quotePrice : (m.last != null ? m.last : (pick.last ?? null));   // quote > intraday bar > detection bar
  const lossFromDetectionPct = (originalPrice != null && currentPrice != null)
    ? +(((currentPrice / originalPrice) - 1) * 100).toFixed(2) : null;

  const last = record.history && record.history.at ? record.history.at(-1) : null;
  const quoteAsOf = (fresh && fresh.quoteAsOf) || null;
  return {
    ...pick,
    // Canonical lifecycle / actionability envelope.
    lifecycleState: lc,
    actionable,
    setupId: record.setupId || null,
    falseRetirement: record.falseRetirement || null,
    thesisValid,
    planValid,
    currentSessionFresh,
    reasonCodes: last ? [last.reasonCode].filter(Boolean) : [],
    explanation: last ? last.explanation : null,
    // Freshness timestamps (immutable origin + live validation).
    candidateAsOf: (fresh && (fresh.candidateDate || fresh.dailyBarAsOf)) || pick.candidateDate || pick.date || null,
    intradayBarAsOf: (fresh && fresh.intradayBarAsOf) || null,
    quoteAsOf,
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
    // Plan surfaces. For an actionable card entry/stop/target/rr are the LIVE plan (the
    // stale daily levels are preserved separately as originalPlan for provenance).
    entry: planInForce ? planInForce.entry : null,
    stop: planInForce ? planInForce.stop : null,
    target: planInForce ? planInForce.target : null,
    rr: planInForce ? planInForce.rr : null,
    livePlan,
    planBasis: actionable ? (livePlan ? 'live-intraday' : 'missing') : 'daily-detection',
    planAsOf: actionable ? (livePlan ? livePlan.computedAt : null) : (pick.date || pick.candidateDate || null),
    planExpiresAt: actionable && livePlan ? livePlan.expiresAt : null,
    originalPlan,
    // Execution context — unknown is exposed as unknown, never treated as favorable.
    execution: {
      quoteAgeSeconds: quoteAsOf ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(quoteAsOf)) / 1000)) : null,
      spreadPct: null, spreadStatus: 'unknown',
      haltStatus: 'unknown',
    },
    // Runner/dud RESEARCH scores (deterministic, uncalibrated — labeled as such; null when
    // there is no intraday evidence to score).
    ...require('./runner-dud').scoreCard({
      currentVwap: m.vwap ?? null, mom15: m.mom15 ?? null, residualVsSpy: m.residualVsSpy ?? null,
      timeOfDayRelVol: m.timeOfDayRelVol ?? null, remainingRR: m.remainingRR ?? null,
      extensionAtr: m.extensionAtr ?? null,
      triggerConfirmed: ev.triggerConfirmed ?? null, aboveVwap: ev.aboveVwap ?? null,
      stopBreached: ev.stopBreached ?? null, breakoutFailed: ev.breakoutFailed ?? null,
      closesBelowVwap: ev.closesBelowVwap ?? null, lowerHighs: ev.lowerHighs ?? null,
      volumeFading: ev.volumeFading ?? null, barsSinceHigh: ev.noNewHighBars ?? null,
      currentSessionFresh,
    }),
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

// State transitions between the prior persisted map and the freshly advanced map — the
// input to the alert feed. Only reason-coded changes count (a no-op re-evaluation is not a
// transition), so refreshes can never re-emit the same alert.
function collectTransitions(priorRecords, byTicker) {
  const out = [];
  for (const [ticker, x] of Object.entries(byTicker)) {
    const prev = priorRecords[ticker] ? priorRecords[ticker].state : null;
    const rec = x.record;
    if (rec.state === prev) continue;
    const last = rec.history.at(-1);
    if (!last || !last.reasonCode) continue;
    out.push({
      ticker, from: prev, to: rec.state, at: last.at, reasonCode: last.reasonCode,
      explanation: last.explanation || null, setupId: rec.setupId || null,
      firstSeenAt: rec.createdAt || null,   // for alert-latency grading
      card: x.card,
    });
  }
  return out;
}

// ── Orchestration: pool → (optional Stage-2) → classified lanes + transitions ──
// `doStage2` controls whether the live 5-min revalidation runs (true during RTH from the
// route; false in tests / off-hours). `priorRecords` makes the persistent lifecycle
// authoritative. Fails closed on any Stage-2 error — the daily fallback yields
// PRIOR_SESSION_WATCH/BUILDING, never ACTIONABLE_NOW.
async function runActionability(picks, { now, sessionDate, t0, deadline = 38000, doStage2 = true, maxNames = STAGE2_MAX_NAMES, priorRecords = {} } = {}) {
  const nowIso = now || new Date().toISOString();
  const session = sessionOf(new Date(nowIso));
  let stage2 = { evByTicker: {}, stage2: 0, skipped: 'disabled', deepPool: [] };
  if (doStage2) {
    try { stage2 = await stage2Evaluations(picks, { now: nowIso, sessionDate, t0, deadline, maxNames, priorRecords }); }
    catch (e) { stage2 = { evByTicker: {}, stage2: 0, skipped: `error:${String((e && e.message) || e)}`, deepPool: [] }; }
  }
  const byTicker = classifyPool(picks, { now: nowIso, evByTicker: stage2.evByTicker, priorRecords });
  const { lanes, counts } = bucketLanes(byTicker);
  const records = Object.fromEntries(Object.entries(byTicker).map(([t, x]) => [t, x.record]));
  const transitions = collectTransitions(priorRecords, byTicker);
  return {
    session,
    liveValidated: stage2.stage2 || 0,
    liveValidationSkipped: stage2.skipped || null,
    deepPool: stage2.deepPool || [],
    degraded: doStage2 && INTRADAY_SESSIONS.has(session) && (stage2.stage2 || 0) === 0,
    lanes, counts, byTicker, records, transitions,
    generatedAt: nowIso,
  };
}

module.exports = {
  stage2Evaluations, classifyPool, buildCanonicalCard, bucketLanes, runActionability,
  selectDeepPool, computeLivePlan, collectTransitions,
  planConsistent, INTRADAY_SESSIONS, STAGE2_MAX_NAMES, LIFECYCLE_CFG, REVALIDATE_BOOST,
};
