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
const LIFECYCLE_CFG = {
  failLossAtr: CFG.THESIS.FAIL_LOSS_ATR, vwapLossConfirm: CFG.THESIS.VWAP_LOSS_CONFIRM, reclaimMinRR: CFG.RECLAIM.MIN_REMAINING_RR,
  // Anti-flapping policy (central config → engine): soft-retirement cooldown, revival
  // confirmation streak, hysteresis re-entry bands, material-new-setup thresholds.
  retireCooldownMs: CFG.ANTIFLAP.RETIRE_COOLDOWN_MS,
  reviveConfirmEvals: CFG.ANTIFLAP.REVIVE_CONFIRM_EVALS,
  reenterMinRR: CFG.ANTIFLAP.REENTER_MIN_RR,
  reenterMaxExtensionAtr: CFG.ANTIFLAP.REENTER_MAX_EXTENSION_ATR,
  materialTriggerAtr: CFG.ANTIFLAP.MATERIAL_TRIGGER_ATR,
  materialPriceAtr: CFG.ANTIFLAP.MATERIAL_PRICE_ATR,
  materialMinElapsedMs: CFG.ANTIFLAP.MATERIAL_MIN_ELAPSED_MS,
};

// Prior lifecycle states that MUST be revalidated every cycle (failure detection on an armed
// or actionable name matters more than discovering one more watch candidate).
const REVALIDATE_BOOST = {
  [STATES.MANAGING]: 5,
  [STATES.ACTIONABLE_NOW]: 4,
  [STATES.REVERSAL_RECLAIM]: 4,
  [STATES.ARMED]: 3,
  [STATES.OPENING_RANGE_FORMING]: 2,
};

// ── Discovery evidence extraction ───────────────────────────────────────────────
// A pick can carry Stage-A discovery evidence two ways: it IS a discovery anomaly (fields at
// top level) or a scan pick that discovery ALSO flagged (merged under `p.discovery` by the
// route — the observation is merged, never discarded).
function discoveryEvidenceOf(p) {
  if (p && p.discovery && (p.discovery.cusum != null || p.discovery.z != null)) return p.discovery;
  if (p && (p.source === 'discovery' || p.scan === 'discovery') && (p.cusum != null || p.z != null)) {
    return {
      cusum: p.cusum ?? null, z: p.z ?? null, intervalRet: p.intervalRet ?? null,
      quoteAsOf: p.quoteAsOf ?? null, discoveredAt: p.discoveredAt ?? null,
    };
  }
  return null;
}

// Priority contribution of genuine early-discovery evidence: CUSUM magnitude/persistence,
// standardized return shock, and signal freshness (a 2-minute-old alarm has lead-time
// potential a 10-minute-old one does not). Bounded so one component can't dominate.
function discoveryPriority(d, nowMs = null) {
  if (!d) return 0;
  const H = CFG.DISCOVERY.CUSUM_H;
  let s = 0;
  if (d.cusum != null && isFinite(d.cusum)) s += Math.min(d.cusum / H, 2.5) * 1.5;
  if (d.z != null && isFinite(d.z) && d.z > 0) s += Math.min(d.z, 4) * 0.4;
  const asOf = d.quoteAsOf ? Date.parse(d.quoteAsOf) : NaN;
  if (Number.isFinite(asOf) && nowMs != null) {
    const ageMin = (nowMs - asOf) / 60000;
    s += ageMin <= 2 ? 1 : ageMin <= 5 ? 0.5 : ageMin <= 10 ? 0.2 : 0;
  }
  return s;
}

// ── Lane-based deep-pool selection with diagnostics ─────────────────────────────
// The old selection gave any tracked lifecycle name a ×1000 boost — active names could
// consume the ENTIRE Stage-2 budget and a fresh discovery would never get validated. Lanes
// replace that: management and revalidation keep protected reservations (failure detection
// on an armed/actionable name still matters more than one more watch candidate), but new
// discovery candidates are GUARANTEED a minimum allocation, with a small extra reserve for
// exceptional anomalies. Unused reservation flows back to the global ranking. Pure.
const MGMT_STATES = new Set([STATES.MANAGING, STATES.ACTIONABLE_NOW, STATES.REVERSAL_RECLAIM]);
const REVAL_STATES = new Set([STATES.ARMED, STATES.OPENING_RANGE_FORMING]);

function selectDeepPoolDetailed(picks, { priorRecords = {}, maxNames = STAGE2_MAX_NAMES, now = null } = {}) {
  const nowMs = now ? Date.parse(now) : null;
  const seen = new Set();
  const pool = [];
  for (const p of picks || []) {
    if (!p || !p.ticker || seen.has(p.ticker)) continue;
    seen.add(p.ticker);
    pool.push(p);
  }
  // STALENESS DECAY. During a live session the scan picks' pctChange/relVol/excessPct come
  // from the once-daily candle cache (the PRIOR session) while discovery picks carry live
  // values — z-scoring both raw in one pool let yesterday's +12% mover outrank today's
  // fresh +4% one. The stale daily INPUTS are decayed BEFORE the cross-sectional stats are
  // computed, so the pool mean/sd themselves stop being inflated by prior-session numbers
  // (decaying only the final z would still leave the fresh pick below a contaminated mean).
  const liveSession = now ? ['regular', 'premarket'].includes(require('./lifecycle-eval').sessionOf(new Date(now))) : false;
  const staleW = CFG.STAGE2.STALE_DAILY_WEIGHT;
  const freshnessWeight = p => (liveSession && p.barIsToday === false) ? staleW : 1;
  const effVal = (p, key) => (p[key] == null || !isFinite(p[key])) ? null : p[key] * freshnessWeight(p);

  const stat = key => {
    const v = pool.map(p => effVal(p, key)).filter(x => x != null && isFinite(x));
    const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length || 1)) || 1;
    return { m, sd };
  };
  const rv = stat('relVol'), pc = stat('pctChange'), ex = stat('excessPct');
  const z = (x, s) => (x == null || !isFinite(x)) ? 0 : (x - s.m) / s.sd;

  const L = CFG.STAGE2.LANES;
  const entries = pool.map(p => {
    const prior = priorRecords[p.ticker];
    const disc = discoveryEvidenceOf(p);
    const lane = prior && MGMT_STATES.has(prior.state) ? 'management'
      : prior && REVAL_STATES.has(prior.state) ? 'revalidation'
        : disc ? 'discovery' : 'general';
    const boost = prior ? (REVALIDATE_BOOST[prior.state] || 0) : 0;
    const priority = z(effVal(p, 'relVol'), rv) + z(effVal(p, 'pctChange'), pc) + z(effVal(p, 'excessPct'), ex) + discoveryPriority(disc, nowMs);
    return { p, lane, boost, disc, priority, staleDecayed: freshnessWeight(p) !== 1 };
  });

  const byLane = lane => entries.filter(e => e.lane === lane)
    .sort((a, b) => (b.boost - a.boost) || (b.priority - a.priority));
  const cap = Math.max(1, maxNames);
  const chosen = new Map();   // ticker → { entry, via }
  const take = (list, n, via) => {
    for (const e of list) {
      if (chosen.size >= cap || n <= 0) return;
      if (chosen.has(e.p.ticker)) continue;
      chosen.set(e.p.ticker, { e, via });
      n--;
    }
  };
  // 1. Protected reservations, in precedence order.
  take(byLane('management'), L.MANAGEMENT_RESERVE, 'management-reserve');
  take(byLane('revalidation'), L.REVALIDATION_RESERVE, 'revalidation-reserve');
  take(byLane('discovery'), L.DISCOVERY_RESERVE, 'discovery-reserve');
  // Exceptional anomalies (CUSUM ≥ 2× alarm) get a small extra reserve beyond the lane.
  const exceptional = entries.filter(e => e.disc && e.disc.cusum != null && e.disc.cusum >= 2 * CFG.DISCOVERY.CUSUM_H)
    .sort((a, b) => b.priority - a.priority);
  take(exceptional, L.ANOMALY_RESERVE, 'anomaly-reserve');
  // 2. Global fill: remaining capacity flows to the best of ANY lane. Management/revalidation
  // overflow keeps a moderate (bounded — not ×1000) precedence so failure detection on extra
  // tracked names still outranks marginal watch candidates without starving discovery.
  const fillRank = e => e.boost * 10 + e.priority;
  take([...entries].sort((a, b) => fillRank(b) - fillRank(a)), cap, 'rank');

  // Output order: management first (failure detection), then by priority.
  const selected = [...chosen.values()].sort((a, b) =>
    (b.e.boost - a.e.boost) || (b.e.priority - a.e.priority));
  // The marginal accepted candidate (lowest-ranked 'rank'-fill winner) — recorded with every
  // rejection so a budget miss can be audited against exactly who occupied the final slot.
  const rankWinners = [...chosen.values()].filter(x => x.via === 'rank');
  const marginal = rankWinners.length ? rankWinners[rankWinners.length - 1] : [...chosen.values()].at(-1) || null;
  const diagnostics = {
    budget: cap,
    laneCounts: ['management', 'revalidation', 'discovery', 'general'].reduce((o, l) => ({ ...o, [l]: entries.filter(e => e.lane === l).length }), {}),
    reserves: { ...L },
    staleDecayWeight: staleW,
    staleDecayed: entries.filter(e => e.staleDecayed).length,
    selected: selected.map(({ e, via }) => ({ ticker: e.p.ticker, lane: e.lane, via, priority: +e.priority.toFixed(3) })),
    rejected: entries.filter(e => !chosen.has(e.p.ticker))
      .sort((a, b) => b.priority - a.priority)
      .map(e => ({
        ticker: e.p.ticker, lane: e.lane, priority: +e.priority.toFixed(3), reason: 'stage2-budget',
        occupiedBy: marginal ? { ticker: marginal.e.p.ticker, lane: marginal.e.lane, priority: +marginal.e.priority.toFixed(3) } : null,
      })),
  };
  return { pool: selected.map(x => x.e.p), diagnostics };
}

// Back-compatible façade: returns just the selected picks.
function selectDeepPool(picks, opts = {}) {
  return selectDeepPoolDetailed(picks, opts).pool;
}

// ── Live trade-plan computation with a FROZEN-plan contract ─────────────────────
// An actionable card must NEVER present the prior-session (daily-cache) stop/target as its
// plan. Given current-session features, build the plan from the ACTUAL live trigger:
// entry = the live price at confirmation, stop = the tighter of (opening-range low − pad)
// and (entry − k×ATR), target = entry + rr×risk, plus an explicit expiry.
//
// THE DEFECT THE FREEZE CLOSES: recomputing entry/target around EVERY new quote made
// remaining R:R ≡ TARGET_RR by construction ((target−last)/(last−stop) with entry=last is
// mechanically 2) — a constant that discriminated nothing while the score rewarded it. The
// plan is now FROZEN at confirmation (`priorPlan`): while the same setup remains active and
// unexpired, later cycles keep the SAME stop/target and recompute ONLY remaining R:R from
// the current price against those frozen levels — so it genuinely falls as price approaches
// the target. Null (fail closed) when live evidence can't support a plan.
function planFrozenValid(plan, nowMs) {
  return !!(plan && plan.basis === 'live-intraday'
    && planConsistent(plan.entry, plan.stop, plan.target)
    && plan.expiresAt && Date.parse(plan.expiresAt) > nowMs);
}

function computeLivePlan(f, { now, priorPlan = null } = {}) {
  const P = CFG.LIVE_PLAN;
  const atr = f.dailyAtr;
  const last = f.last;
  if (!(atr > 0) || !(last > 0)) return null;
  const nowMs = Date.parse(now || new Date().toISOString());

  // FROZEN PATH — an existing plan for this setup stays in force; only remaining R:R moves.
  if (planFrozenValid(priorPlan, nowMs) && last > priorPlan.stop) {
    const remainingRR = +(((priorPlan.target - last) / (last - priorPlan.stop))).toFixed(2);
    return { ...priorPlan, remainingRR, frozen: true, revalidatedAt: new Date(nowMs).toISOString() };
  }

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
  const minsToClose = Math.max(0, (16 * 60) - (f.nowSinceOpen + 9 * 60 + 30));
  const expiresAt = new Date(nowMs + Math.min(P.EXPIRES_MIN, minsToClose) * 60000).toISOString();
  return {
    basis: 'live-intraday',
    entry: +entry.toFixed(2), stop: +stop.toFixed(2), target: +target.toFixed(2),
    rr: P.TARGET_RR, riskPct: +((risk / entry) * 100).toFixed(1),
    trigger: trigger != null ? +trigger.toFixed(2) : null,
    atr: +atr.toFixed(3), remainingRR, frozen: false,
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

  const { pool, diagnostics: selection } = selectDeepPoolDetailed(picks, { priorRecords, maxNames, now });

  // SECTOR BARS — the residualSector15 feature existed but NEVER received bars (the call
  // site omitted sectorTodayBars, so it was permanently null). Resolve each selected pick's
  // sector to its SPDR ETF (SECTOR_OF → benchFor, the same mapping every other module uses),
  // fetch each DISTINCT ETF once (bounded), and hand each pick its sector's bars. A pick
  // whose sector can't be resolved simply gets none — the feature stays null and
  // dataQuality.sectorMatched stays false (explicit missingness, never a fabricated zero).
  const sectorBarsByEtf = {};
  const etfOfTicker = {};
  try {
    const { SECTOR_OF } = require('./universe');
    const { benchFor } = require('./readthrough');
    const wanted = new Map();   // etf → first-seen order
    for (const pick of pool) {
      const sector = pick.sector || SECTOR_OF[pick.ticker] || null;
      const etf = sector ? benchFor(sector) : null;
      if (!etf || etf === 'SPY') continue;
      etfOfTicker[pick.ticker] = etf;
      if (!wanted.has(etf)) wanted.set(etf, wanted.size);
    }
    const etfs = [...wanted.keys()].slice(0, CFG.STAGE2.SECTOR_ETF_MAX);
    await Promise.all(etfs.map(async etf => {
      try {
        const r = await fetchFiveMin(etf);
        if (r) sectorBarsByEtf[etf] = sessionsFromResult(r)[sessionDate] || [];
      } catch { /* that sector's residual just unavailable this cycle */ }
    }));
  } catch { /* sector mapping unavailable — features stay explicitly missing */ }
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
          todayBars, priorSessions, spyTodayBars: spyToday,
          sectorTodayBars: sectorBarsByEtf[etfOfTicker[pick.ticker]] || [],
          now,
          dailyAtr: pick.orb ? pick.orb.atr : (pick.atr ?? null),
          plan: { entry: pick.entry, stop: pick.stop, target: pick.target },
        });
        if (f.hasIntraday) {
          // Plan in force: FROZEN from the prior record when this setup already confirmed one
          // (remaining R:R then moves with price against fixed levels); otherwise computed
          // fresh from the live trigger. The stale daily plan is never re-labeled as live.
          const priorRec = priorRecords[pick.ticker];
          const priorPlan = priorRec && priorRec.activePlan ? priorRec.activePlan : null;
          const livePlan = computeLivePlan(f, { now, priorPlan });
          if (livePlan) f = { ...f, livePlan, remainingRR: livePlan.remainingRR };
          // Early-signal research annotation (watch language only — beside the lifecycle,
          // never a shortcut through its actionable gate).
          const early = require('./daytrade-early-state').computeEarlyState({ f, discovery: discoveryEvidenceOf(pick) });
          evByTicker[pick.ticker] = { ...intradayEv(pick, f, { now, quote }), earlyState: early.state, earlyWhy: early.why, earlyBasis: early.basis };
        }
      } catch { /* daily fallback for this name */ }
    }
  };
  await Promise.all(Array.from({ length: CFG.STAGE2.CONCURRENCY }, worker));
  const sectorCoverage = {
    etfsFetched: Object.keys(sectorBarsByEtf).filter(k => (sectorBarsByEtf[k] || []).length),
    ticksMapped: Object.keys(etfOfTicker).length,
  };
  return { evByTicker, stage2: Object.keys(evByTicker).length, skipped: null, deepPool: pool.map(p => p.ticker), selection, sectorCoverage };
}

// ── Classification: pool + evidence + PRIOR STATE → per-ticker lifecycle record ──
// Advances each candidate FROM its persisted record (hysteresis, cooldowns, post-entry lock,
// retirement and revival all work across refreshes). Prior-day tickers absent from the
// current pool are carried forward via absentEvaluation — de-escalated, never erased. With
// no priorRecords this degrades to the stateless one-shot (tests / cold start / no Blob).
// Persist the FROZEN-plan contract on the advanced record: the plan confirmed for a setup
// is stored under that setupId so later cycles revalidate against the SAME levels (no
// per-quote target resets). Cleared on retirement — a revival mints a new setup and must
// confirm a NEW plan. Immutable: returns a new record.
// Persist the early research state ON the record so upward progressions are diffable across
// cycles (the input to Early Watch alerts). `undefined` evidence = unknown → carry the prior
// value forward (evidence gaps must not fake a regression that would later re-alert).
function stampEarlyState(record, ev) {
  if (!record) return record;
  const curr = (ev && ev.earlyState !== undefined) ? (ev.earlyState ?? null) : (record.earlyState ?? null);
  if (curr === (record.earlyState ?? null) && record.earlyState !== undefined) return record;
  return { ...record, earlyState: curr, earlyStateAt: (ev && ev.now) || record.updatedAt || null };
}

function stampActivePlan(record, ev) {
  if (!record) return record;
  const active = MGMT_STATES.has(record.state);
  if (active && ev && ev.livePlan) return { ...record, activePlan: { ...ev.livePlan, setupId: record.setupId } };
  if (require('./opportunity-lifecycle').isRetired(record.state) && record.activePlan) {
    const { activePlan, ...rest } = record;
    return { ...rest, retiredPlan: activePlan };   // provenance, never reused as live
  }
  return record;
}

function classifyPool(picks, { now, evByTicker = {}, priorRecords = {} } = {}) {
  const nowIso = now || new Date().toISOString();
  const byTicker = {};
  const seen = new Set();
  for (const pick of picks || []) {
    if (!pick || !pick.ticker || seen.has(pick.ticker)) continue;
    seen.add(pick.ticker);
    let ev = evByTicker[pick.ticker] || buildEvaluation(pick, { now: nowIso });
    // A discovery-flagged name that did NOT get a Stage-2 slot still deserves its early-signal
    // annotation from the Stage-A evidence alone (no bars → coarse states only).
    if (ev.earlyState === undefined) {
      const d = discoveryEvidenceOf(pick);
      if (d) {
        const early = require('./daytrade-early-state').computeEarlyState({ f: null, discovery: d });
        ev = { ...ev, earlyState: early.state, earlyWhy: early.why, earlyBasis: early.basis };
      }
    }
    const record = stampEarlyState(stampActivePlan(advanceLifecycle(priorRecords[pick.ticker] || null, { strategy: 'daytrade', ...ev }, LIFECYCLE_CFG), ev), ev);
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
    momAccel: m.momAccel ?? null,
    residualVsSpy: m.residualVsSpy ?? null,
    residual15: m.residual15 ?? null,
    timeOfDayRelVol: m.timeOfDayRelVol ?? null,
    volAccel: m.volAccel ?? null,
    vwapSlope: m.vwapSlope ?? null,
    rangeExpansion: m.rangeExpansion ?? null,
    distFromHod: m.distFromHod ?? null,
    remainingRR: m.remainingRR ?? null,
    extensionAtr: m.extensionAtr ?? null,
    archetypes: ev.archetypes ?? null,
    earlyState: ev.earlyState ?? null,
    earlyWhy: ev.earlyWhy ?? null,
    earlyBasis: ev.earlyState != null ? (ev.earlyBasis ?? null) : null,
    discoveryEvidence: discoveryEvidenceOf(pick),
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
      currentVwap: m.vwap ?? null, mom15: m.mom15 ?? null, momAccel: m.momAccel ?? null,
      residualVsSpy: m.residualVsSpy ?? null,
      timeOfDayRelVol: m.timeOfDayRelVol ?? null, volAccel: m.volAccel ?? null,
      remainingRR: m.remainingRR ?? null,
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

// Upward early-state progressions between the prior persisted map and the freshly advanced
// map — the input to EARLY WATCH alerts. Only rungs at or above the notify floor fire
// (SCOUT is board-only), only UPWARD movement counts (decay is silent — regression noise
// must not alert), and the (setupId, state) dedup in the alert layer bounds each rung to
// once per setup per day.
function collectEarlyTransitions(priorRecords, byTicker, { now } = {}) {
  const { EARLY_LADDER, EARLY_MIN_NOTIFY_STATE } = CFG.ALERTS;
  const rank = Object.fromEntries(EARLY_LADDER.map((s, i) => [s, i]));
  const floor = rank[EARLY_MIN_NOTIFY_STATE] ?? 1;
  const out = [];
  for (const [ticker, x] of Object.entries(byTicker)) {
    const curr = x.record.earlyState ?? null;
    if (!curr || !(rank[curr] >= floor)) continue;
    const prior = priorRecords[ticker] ? (priorRecords[ticker].earlyState ?? null) : null;
    const prevRank = prior != null && rank[prior] != null ? rank[prior] : -1;
    if (rank[curr] <= prevRank) continue;
    const d = x.card ? x.card.discoveryEvidence : null;
    out.push({
      ticker, from: prior, to: curr, at: now || x.record.earlyStateAt || new Date().toISOString(),
      setupId: x.record.setupId || null,
      firstDetectedAt: (d && d.discoveredAt) || x.record.createdAt || null,
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
  let stage2 = { evByTicker: {}, stage2: 0, skipped: 'disabled', deepPool: [], selection: null };
  if (doStage2) {
    try { stage2 = await stage2Evaluations(picks, { now: nowIso, sessionDate, t0, deadline, maxNames, priorRecords }); }
    catch (e) { stage2 = { evByTicker: {}, stage2: 0, skipped: `error:${String((e && e.message) || e)}`, deepPool: [], selection: null }; }
  }
  const byTicker = classifyPool(picks, { now: nowIso, evByTicker: stage2.evByTicker, priorRecords });
  const { lanes, counts } = bucketLanes(byTicker);
  const records = Object.fromEntries(Object.entries(byTicker).map(([t, x]) => [t, x.record]));
  const transitions = collectTransitions(priorRecords, byTicker);
  const earlyTransitions = collectEarlyTransitions(priorRecords, byTicker, { now: nowIso });
  return {
    session,
    liveValidated: stage2.stage2 || 0,
    liveValidationSkipped: stage2.skipped || null,
    deepPool: stage2.deepPool || [],
    selection: stage2.selection || null,
    sectorCoverage: stage2.sectorCoverage || null,
    degraded: doStage2 && INTRADAY_SESSIONS.has(session) && (stage2.stage2 || 0) === 0,
    lanes, counts, byTicker, records, transitions, earlyTransitions,
    generatedAt: nowIso,
  };
}

module.exports = {
  stage2Evaluations, classifyPool, buildCanonicalCard, bucketLanes, runActionability,
  selectDeepPool, selectDeepPoolDetailed, discoveryEvidenceOf, discoveryPriority,
  computeLivePlan, stampActivePlan, stampEarlyState, collectTransitions, collectEarlyTransitions,
  planConsistent, INTRADAY_SESSIONS, STAGE2_MAX_NAMES, LIFECYCLE_CFG, REVALIDATE_BOOST,
};
