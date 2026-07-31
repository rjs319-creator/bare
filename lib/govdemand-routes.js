'use strict';
// 🏛️ GOV-DEMAND — HTTP surface for the shadow government-demand vertical
// (AI-Alpha-OS slice 1; prereg: research/ai-alpha-os/GOVERNMENT-DEMAND-PREREG.md).
//   op=govdemand         public cached read — event board + ledger summary
//   op=govdemandtick     privileged (cron)  — collect → assemble → log PIT predictions
//   op=govdemandresolve  privileged (cron)  — resolve matured 5/21/63-session outcomes
//
// SHADOW ONLY: reads/writes its own govdemand/* Blob prefix + the `govdemand`
// immutable-ledger stream. Never touches production ranks, recommendations or
// allocation. Every prediction carries shadow:true / affectsLiveRank:false /
// deploymentWeight:0 / governanceStatus:'paper'.
//
// PROSPECTIVE-ONLY: USAspending has no publication timestamp, so availableAt
// is the collector's own observation time and no historical backtest is
// claimed. The dataset earns a verdict by accruing forward.

const MODULE_VERSION = 'govdemand-v1';
const HORIZONS = Object.freeze([5, 21, 63]);      // sessions, mirrors ORBIT
const PRED_COOLDOWN_DAYS = 30;                    // one prediction per ticker per window (event-cluster dedup)
const REVENUE_CACHE_DAYS = 7;                     // trailing-revenue TTL (slow-moving input)
const CADENCE_REFRESH_DAYS = 30;                  // authoritative quarterly-flow refresh cadence
const MAX_REVENUE_FETCHES_PER_TICK = 10;          // bounded provider fan-out per tick
const MAX_CADENCE_FETCHES_PER_TICK = 6;
const MAX_PRICE_FETCHES_PER_TICK = 8;
const COLLECT_DEADLINE_MS = 25000;                // leaves budget for gates + persistence
const DESC_TRIM = 240;                            // stored description length cap
const EVENT_ROWS_CAP_PER_MONTH = 400;             // full event rows kept per monthly archive

const SHADOW_FLAGS = Object.freeze({
  shadow: true, affectsLiveRank: false, deploymentWeight: 0, governanceStatus: 'paper',
});

function safeNowET() { try { return require('./stats').nowET(); } catch { return null; } }
const addDays = (iso, d) => new Date(new Date(iso + 'T00:00:00Z').getTime() + d * 864e5).toISOString().slice(0, 10);

// ── op=govdemandtick ─────────────────────────────────────────────────────────
async function runGovDemandTick(req, res) {
  const store = require('./store');
  res.setHeader('Cache-Control', 'no-store');
  if (!store.hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });

  const { scanRoster, mapRecipient } = require('./govdemand-map');
  const collect = require('./govdemand-collect');
  const { ACTIONS, classifyAction, fetchTrailingRevenueUSD, computeMateriality } = require('./govdemand-materiality');
  const { expectationSurprise } = require('./govdemand-expect');
  const { assembleEvent, priceConsumedGate, STATUS, MIN_MATERIALITY } = require('./govdemand-events');

  const et = safeNowET();
  const today = (et && et.date) || new Date().toISOString().slice(0, 10);
  const roster = scanRoster();
  const state0 = (await store.readGovDemandState()) || {};

  // 1) Collect the next cursor batch of the roster (revision-preserving).
  const collected = await collect.collectBatch({
    roster, state: state0, todayIso: today, deadlineMs: COLLECT_DEADLINE_MS,
  });
  let state = collected.state;

  // 2) Refresh stale cadence baselines (authoritative quarterly flow, bounded).
  const cadence = { ...(state.cadence || {}) };
  const staleTickers = roster
    .filter(r => {
      const c = cadence[r.ticker];
      return !c || !c.refreshedAt || c.refreshedAt <= addDays(today, -CADENCE_REFRESH_DAYS);
    })
    .slice(0, MAX_CADENCE_FETCHES_PER_TICK);
  for (const r of staleTickers) {
    const q = await collect.fetchQuarterlyObligations({ query: r.query, todayIso: today });
    if (q.ok) cadence[r.ticker] = { quarters: q.quarters, refreshedAt: today, source: 'usaspending:spending_over_time' };
  }
  state = { ...state, cadence };

  // 3) Classify + map every fresh observation; find candidates needing revenue.
  const prepared = collected.fresh.map(obs => {
    const mapped = mapRecipient(obs.recipientName, today);
    return { obs, mapped, action: classifyAction(obs) };
  });
  const needsRevenue = [...new Set(prepared
    .filter(p => p.mapped && p.obs.amountUSD > 0 &&
      (p.action === ACTIONS.NEW_AWARD || p.action === ACTIONS.OPTION_EXERCISE || p.action === ACTIONS.MODIFICATION))
    .map(p => p.mapped.ticker))];

  // 4) Trailing revenue (cached, TTL'd, bounded per tick). Missing stays null.
  const revenueCache = { ...(state.revenueCache || {}) };
  const staleRevenue = needsRevenue
    .filter(t => {
      const c = revenueCache[t];
      return !c || !c.fetchedAt || c.fetchedAt <= addDays(today, -REVENUE_CACHE_DAYS);
    })
    .slice(0, MAX_REVENUE_FETCHES_PER_TICK);
  for (const t of staleRevenue) {
    const r = await fetchTrailingRevenueUSD(t);
    revenueCache[t] = { ...r, fetchedAt: today };
  }
  state = { ...state, revenueCache };

  // 5) Assemble events. The price gate is fetched LAZILY — only for events that
  //    survive the cheaper gates — so provider fan-out stays bounded.
  const { fetchDailyHistory } = require('./screener');
  const priceCache = new Map(); let spyCandles = null; let priceFetches = 0;
  const getCandles = async (ticker) => {
    if (priceCache.has(ticker)) return priceCache.get(ticker);
    if (priceFetches >= MAX_PRICE_FETCHES_PER_TICK) return null;
    priceFetches++;
    const h = await fetchDailyHistory(ticker, '1y').catch(() => null);
    const candles = (h && h.candles) || null;
    priceCache.set(ticker, candles);
    return candles;
  };

  const events = [];
  for (const p of prepared) {
    const rev = p.mapped ? revenueCache[p.mapped.ticker] : null;
    const materiality = computeMateriality({
      obligatedUSD: p.obs.amountUSD,
      trailingRevenueUSD: rev ? rev.revenueUSD : null,
      revenueInputs: rev ? rev.inputs || null : null,
      revenueFailures: rev ? rev.failureReasons || [] : ['revenue not fetched this tick'],
    });
    const cad = p.mapped ? cadence[p.mapped.ticker] : null;
    const expectation = p.mapped ? expectationSurprise({
      amountUSD: p.obs.amountUSD, ticker: p.mapped.ticker, asOf: today,
      quarters: (cad && cad.quarters) || {},
    }) : null;

    // Lazy price gate: only when every prior gate could still pass.
    let priceGate = null;
    const maybeActionable = p.mapped && materiality.value != null &&
      materiality.value >= MIN_MATERIALITY &&
      expectation && expectation.isUnexpected === true;
    if (maybeActionable) {
      if (!spyCandles) { const s = await fetchDailyHistory('SPY', '1y').catch(() => null); spyCandles = (s && s.candles) || null; }
      const candles = await getCandles(p.mapped.ticker);
      priceGate = priceConsumedGate({ candles, spyCandles, eventTime: p.obs.eventTime, asOf: today });
    }

    events.push(assembleEvent({
      obs: { ...p.obs, description: p.obs.description ? String(p.obs.description).slice(0, DESC_TRIM) : null },
      action: p.action, mapped: p.mapped, materiality, expectation, priceGate,
    }));
  }

  // 6) Predictions: qualifying events, deduped per ticker + cooldown window.
  const lastPredicted = { ...(state.lastPredicted || {}) };
  const byTicker = new Map();
  for (const ev of events.filter(e => e.qualifies)) {
    const prior = lastPredicted[ev.ticker];
    if (prior && prior > addDays(today, -PRED_COOLDOWN_DAYS)) continue;   // event-cluster dedup
    if (!byTicker.has(ev.ticker)) byTicker.set(ev.ticker, []);
    byTicker.get(ev.ticker).push(ev);
  }
  const predictions = [...byTicker.entries()].map(([ticker, evs]) => {
    lastPredicted[ticker] = today;
    const lead = evs[0];
    return {
      ...SHADOW_FLAGS,
      version: MODULE_VERSION, predDate: today, ticker,
      eventIds: evs.map(e => e.eventId),
      amountUSD: evs.reduce((s, e) => s + (e.amountUSD || 0), 0),
      materiality: lead.materiality && lead.materiality.value,
      surpriseRatio: lead.expectation && lead.expectation.surpriseRatio,
      excessMoveAtPredPct: lead.priceGate && lead.priceGate.excessMovePct,
      horizons: [...HORIZONS],
      execution: 'next-session-open',
      causalSteps: lead.causalSteps, confirmingMeasurements: lead.confirmingMeasurements,
      invalidatingMeasurements: lead.invalidatingMeasurements,
    };
  });
  state = { ...state, lastPredicted, seen: collect.pruneSeen(state.seen, today) };

  // 7) Persist: monthly event archive (full rows capped, counts always exact),
  //    PIT prediction day-doc, immutable ledger, collector state.
  const month = today.slice(0, 7);
  const monthDoc = (await store.readGovDemandEventsMonth(month)) || { month, events: [], statusCounts: {}, observed: 0 };
  const statusCounts = { ...monthDoc.statusCounts };
  for (const ev of events) statusCounts[ev.status] = (statusCounts[ev.status] || 0) + 1;
  const keepFull = (ev) => ev.qualifies || ev.status === STATUS.EXPECTATION_SURPRISE ||
    ev.status === STATUS.MOVE_CONSUMED || ev.status === STATUS.NO_INCREMENTAL_EDGE;
  const compact = (ev) => ({
    eventId: ev.eventId, ticker: ev.ticker, recipientName: ev.recipientName, status: ev.status,
    rejectReason: ev.rejectReason, eventSubtype: ev.eventSubtype, eventTime: ev.eventTime,
    observedAt: ev.observedAt, amountUSD: ev.amountUSD,
  });
  const newRows = events.map(ev => (keepFull(ev) ? ev : compact(ev)));
  const mergedRows = [...monthDoc.events, ...newRows].slice(-EVENT_ROWS_CAP_PER_MONTH);
  let err = null;
  try {
    await store.writeGovDemandEventsMonth(month, {
      month, events: mergedRows, statusCounts,
      observed: (monthDoc.observed || 0) + events.length,
      rowsCapped: mergedRows.length >= EVENT_ROWS_CAP_PER_MONTH,   // no silent truncation
      ...SHADOW_FLAGS,
    });
    if (predictions.length) {
      await store.writeGovDemandPredDay(today, { version: MODULE_VERSION, predictions, ...SHADOW_FLAGS });
    }
    await store.writeGovDemandState({ ...state, version: MODULE_VERSION });
  } catch (e) { err = String((e && e.message) || e); }

  try {
    await require('./immutable-ledger').append('govdemand', {
      kind: 'tick', date: today, scanned: collected.scanned, fresh: collected.fresh.length,
      revised: collected.revised.length, qualifying: predictions.length,
      predictions: predictions.map(p => ({ ticker: p.ticker, materiality: p.materiality, surpriseRatio: p.surpriseRatio, amountUSD: p.amountUSD })),
    });
  } catch { /* best-effort; the day-doc is the durable copy */ }

  return res.status(err ? 502 : 200).json({
    ok: !err, error: err, date: today, ...SHADOW_FLAGS,
    scanned: collected.scanned, cursor: state.cursor, rosterSize: roster.length,
    fresh: collected.fresh.length, revised: collected.revised.length,
    collectErrors: collected.errors, cadenceRefreshed: staleTickers.map(r => r.ticker),
    statusCounts: events.reduce((m, e) => ({ ...m, [e.status]: (m[e.status] || 0) + 1 }), {}),
    predictions: predictions.map(p => ({ ticker: p.ticker, materiality: p.materiality, surpriseRatio: p.surpriseRatio })),
  });
}

// ── op=govdemandresolve ──────────────────────────────────────────────────────
// Resolve matured horizons: entry = next session OPEN after predDate (the
// prereg's execution rule), exit = close H sessions later, outcome = SPY-excess
// net of estimated round-trip costs. Thesis outcome stays UNRESOLVED here —
// revenue confirmation needs the next quarterly report and is graded
// separately, so a lucky unrelated rally can't reinforce the mechanism.
async function runGovDemandResolve(req, res) {
  const store = require('./store');
  res.setHeader('Cache-Control', 'no-store');
  if (!store.hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const { fetchDailyHistory } = require('./screener');
  const { roundTripCostPct, tierForPick } = require('./costs');

  const days = await store.readAllGovDemandPredDays();
  const resolved = (await store.readGovDemandResolved()) || {};
  const pending = [];
  for (const d of days) for (const p of (d.predictions || [])) {
    const key = `${p.predDate}|${p.ticker}`;
    const done = resolved[key];
    if (!done || HORIZONS.some(h => !done.horizons || !done.horizons[h])) pending.push({ ...p, key });
  }
  if (!pending.length) return res.json({ ok: true, resolved: 0, note: 'nothing to resolve', ...SHADOW_FLAGS });

  const spy = await fetchDailyHistory('SPY', '1y').catch(() => null);
  const spyCandles = (spy && spy.candles) || null;
  if (!spyCandles) return res.json({ ok: false, error: 'SPY history unavailable', ...SHADOW_FLAGS });
  const spyByDate = new Map(spyCandles.map(c => [c.date, c]));

  let resolvedCount = 0, stillOpen = 0;
  const next = { ...resolved };
  for (const p of pending) {
    const h = await fetchDailyHistory(p.ticker, '1y').catch(() => null);
    const candles = (h && h.candles) || null;
    if (!candles) { stillOpen++; continue; }
    const entryIdx = candles.findIndex(c => c.date > p.predDate);
    if (entryIdx < 0) { stillOpen++; continue; }
    const entryC = candles[entryIdx];
    const entry = Number.isFinite(entryC.open) && entryC.open > 0 ? entryC.open : entryC.close;
    const spyEntryC = spyByDate.get(entryC.date);
    if (!entry || !spyEntryC) { stillOpen++; continue; }
    const spyEntry = Number.isFinite(spyEntryC.open) && spyEntryC.open > 0 ? spyEntryC.open : spyEntryC.close;

    const prior = next[p.key] || {
      key: p.key, predDate: p.predDate, ticker: p.ticker, eventIds: p.eventIds,
      materiality: p.materiality, surpriseRatio: p.surpriseRatio,
      entryDate: entryC.date, entryBasis: 'next-session-open',
      thesisOutcome: 'UNRESOLVED', thesisCriteria: p.confirmingMeasurements || null,
      horizons: {}, ...SHADOW_FLAGS,
    };
    const horizons = { ...prior.horizons };
    let touched = false;
    for (const H of HORIZONS) {
      if (horizons[H]) continue;
      const exitIdx = entryIdx + H - 1;
      if (exitIdx >= candles.length) continue;              // not matured yet
      const exitC = candles[exitIdx];
      const spyExitC = spyByDate.get(exitC.date);
      if (!spyExitC) continue;
      const tickRet = (exitC.close - entry) / entry;
      const spyRet = (spyExitC.close - spyEntry) / spyEntry;
      const grossExcessPct = (tickRet - spyRet) * 100;
      const netExcessPct = +(grossExcessPct - roundTripCostPct(tierForPick({}))).toFixed(3);
      horizons[H] = {
        exitDate: exitC.date, grossExcessPct: +grossExcessPct.toFixed(3), netExcessPct,
        marketOutcome: netExcessPct > 0 ? 'positive' : 'negative',
      };
      touched = true;
    }
    if (!touched && !next[p.key]) { stillOpen++; continue; }
    next[p.key] = { ...prior, horizons };
    if (touched) resolvedCount++;
  }

  let err = null;
  try { await store.writeGovDemandResolved(next); } catch (e) { err = String((e && e.message) || e); }
  try {
    if (resolvedCount) await require('./immutable-ledger').append('govdemand', {
      kind: 'resolution-batch', at: (safeNowET() && safeNowET().date) || null, resolutions: resolvedCount,
    });
  } catch { /* best-effort */ }
  return res.status(err ? 502 : 200).json({
    ok: !err, error: err, resolved: resolvedCount, open: stillOpen,
    totalKeys: Object.keys(next).length, ...SHADOW_FLAGS,
  });
}

// ── op=govdemand : public cached read ────────────────────────────────────────
async function runGovDemand(req, res) {
  const store = require('./store');
  try {
    const et = safeNowET();
    const today = (et && et.date) || new Date().toISOString().slice(0, 10);
    const thisMonth = today.slice(0, 7);
    const prevMonth = addDays(`${thisMonth}-01`, -2).slice(0, 7);
    const [state, cur, prev, resolved] = await Promise.all([
      store.readGovDemandState(), store.readGovDemandEventsMonth(thisMonth),
      store.readGovDemandEventsMonth(prevMonth), store.readGovDemandResolved(),
    ]);

    const rows = [...((prev && prev.events) || []), ...((cur && cur.events) || [])];
    const recent = rows.slice(-60).reverse().map(ev => ({
      eventId: ev.eventId, ticker: ev.ticker, recipientName: ev.recipientName,
      status: ev.status, rejectReason: ev.rejectReason || null,
      eventSubtype: ev.eventSubtype, eventTime: ev.eventTime, observedAt: ev.observedAt,
      amountUSD: ev.amountUSD,
      materiality: ev.materiality && ev.materiality.value != null ? +ev.materiality.value.toFixed(4) : null,
      surpriseRatio: (ev.expectation && ev.expectation.surpriseRatio) || null,
    }));

    const resolvedRecs = Object.values(resolved || {});
    const byHorizon = {};
    for (const H of HORIZONS) {
      const outs = resolvedRecs.map(r => r.horizons && r.horizons[H]).filter(Boolean);
      if (!outs.length) { byHorizon[H] = { n: 0 }; continue; }
      const nets = outs.map(o => o.netExcessPct);
      byHorizon[H] = {
        n: nets.length,
        meanNetExcessPct: +(nets.reduce((a, b) => a + b, 0) / nets.length).toFixed(3),
        hitRate: Math.round((nets.filter(x => x > 0).length / nets.length) * 100),
      };
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    return res.json({
      ok: true, version: MODULE_VERSION, ...SHADOW_FLAGS,
      survivorshipSafe: false, productionGrade: false,
      note: 'Prospective-only shadow research dataset. USAspending exposes no publication timestamp, so availability = our collection time; no historical backtest is claimed. Nothing here is a recommendation.',
      coverage: {
        lastRunAt: (state && state.lastRunAt) || null, cursor: (state && state.cursor) || 0,
        seenTransactions: state && state.seen ? Object.keys(state.seen).length : 0,
        cadenceTickers: state && state.cadence ? Object.keys(state.cadence).length : 0,
        statusCountsThisMonth: (cur && cur.statusCounts) || {},
        observedThisMonth: (cur && cur.observed) || 0,
      },
      recentEvents: recent,
      resolution: { predictions: resolvedRecs.length, byHorizon },
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, error: String((e && e.message) || e), ...SHADOW_FLAGS });
  }
}

module.exports = { runGovDemand, runGovDemandTick, runGovDemandResolve, HORIZONS, PRED_COOLDOWN_DAYS, MODULE_VERSION };
