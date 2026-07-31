'use strict';
// ⚡ GRIDLOCK — HTTP surface for the physical-constraint shadow vertical.
//   op=gridlock          public cached read — dashboard payload (region + events + ranked)
//   op=gridlockscenario  public — deterministic scenario arithmetic (cheap, pure)
//   op=gridlocktick      privileged (cron)  — sources → region state → events → classify → score → log
//   op=gridlockresolve   privileged (cron)  — resolve matured 1/5/10/21-session outcomes
//
// SHADOW ONLY (mirrors govdemand): isolated gridlock/* Blob prefix + its own
// immutable-ledger stream. Never touches production ranks, recommendations or
// allocation. Every candidate carries shadow:true / affectsLiveRank:false /
// deploymentWeight:0 / probability:null / portfolioEligible:false.
//
// Feature flag: GRIDLOCK_MODE = off | shadow (default shadow, fail-closed to
// shadow on unknown values). 'off' → every op no-ops cleanly and the rest of
// the app is untouched.

const S = require('./gridlock-schema');

const MODULE_VERSION = S.MODULE_VERSION;
const HORIZONS = Object.freeze([1, 5, 10, 21]);      // sessions
const REFRESH_MS = 6 * 3600 * 1000;                  // latest.json freshness window
const MAX_TAPE_FETCHES = 8;                          // candle fan-out per tick
const MAX_OMEGA_EVALS = 6;                           // OMEGA timing evals per tick
const MAX_LLM_EXTRACTS = 2;                          // bounded LLM refinement per tick
const CPS_HISTORY_CAP = 120;
const NEWS_PAGE_SIZE = 20;

// PJM installed capacity is a planning figure not exposed by the feeds we pull;
// this is a DISCLOSED assumption (labeled 'assumed' in the region state), not data.
const ASSUMED_INSTALLED_CAPACITY_MW = Object.freeze({ PJM: 180000 });

const KEYS = Object.freeze({
  state: 'gridlock/state.json',
  events: 'gridlock/events.json',
  latest: 'gridlock/latest.json',
  resolved: 'gridlock/resolved.json',
});

const SHADOW_FLAGS = S.SHADOW_FLAGS;

function resolveGridlockMode(raw) {
  const v = String(raw ?? process.env.GRIDLOCK_MODE ?? '').toLowerCase().trim();
  return v === 'off' ? 'off' : 'shadow';
}
function safeNowET() { try { return require('./stats').nowET(); } catch { return null; } }
const todayIso = () => { const et = safeNowET(); return (et && et.date) || new Date().toISOString().slice(0, 10); };

// ── Event-ledger derived region pipeline (deterministic) ────────────────────
function pipelineFromLedger(events, isoRegion) {
  const live = Object.values(events || {}).filter(e =>
    e.isoRegion === isoRegion && !['CANCELLED', 'INVALIDATED', 'COMPLETED'].includes(e.lifecycle) && e.certainty !== 'RUMORED');
  const sum = (f) => {
    const vals = live.map(e => e[f]).filter(v => Number.isFinite(v));
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0)) : null;
  };
  return {
    announcedLargeLoadMW: sum('demandDeltaMW'),
    generationPipelineMW: sum('generationDeltaMW'),
    retirementPipelineMW: (() => {
      const vals = live.filter(e => e.eventType === 'GENERATOR_RETIREMENT').map(e => e.generationDeltaMW).filter(Number.isFinite);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0)) : null;
    })(),
  };
}

// ── Bounded news ingestion (deterministic classify → optional grounded LLM) ─
async function ingestNews({ today }) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return { articles: [], candidates: [], reason: 'NEWS_API_KEY not configured' };
  const { fetchWithTimeout } = require('./http');
  const GE = require('./gridlock-events');
  const q = encodeURIComponent('(PJM OR "data center") AND (power OR grid OR megawatt OR nuclear OR transmission)');
  const url = `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=${NEWS_PAGE_SIZE}&apiKey=${key}`;
  const r = await fetchWithTimeout(url, { timeoutMs: 10000 }).catch(() => null);
  if (!r || !r.ok) return { articles: [], candidates: [], reason: `newsapi ${r ? r.status : 'unreachable'}` };
  let rows = [];
  try { const j = await r.json(); rows = Array.isArray(j.articles) ? j.articles : []; } catch { rows = []; }
  const articles = rows.map(a => ({
    title: a.title || '', text: a.description || a.content || '',
    url: a.url || null, publisher: (a.source && a.source.name) || 'unknown',
    publishedAt: a.publishedAt ? String(a.publishedAt).slice(0, 10) : null,
    retrievedAt: today,
  }));
  const candidates = [];
  let llmUsed = 0;
  for (const art of articles) {
    const type = GE.classifyEventType(`${art.title} ${art.text}`);
    if (!type) continue;
    let grounded = null;
    if (llmUsed < MAX_LLM_EXTRACTS && process.env.ANTHROPIC_API_KEY) {
      llmUsed++;
      const prop = await GE.llmExtract({ title: art.title, text: art.text });
      if (prop.ok) grounded = GE.groundExtraction(prop.proposal, `${art.title} ${art.text}`).grounded;
    }
    const ev = GE.buildEventFromArticle(art, { grounded, todayIso: today });
    if (ev) candidates.push(ev);
  }
  return { articles, candidates, reason: null, llmUsed };
}

// ── Candidate assembly (tape + NYR + OMEGA timing + score + gate) ───────────
async function assembleCandidates({ events, cps, regionState, regime, today }) {
  const { graphFor } = require('./gridlock-exposure');
  const causal = require('./gridlock-causal');
  const RT = require('./gridlock-readthrough');
  const scoreMod = require('./gridlock-score');
  const { fetchDailyHistory } = require('./screener');

  const graph = graphFor({ isoRegion: 'PJM', asOf: today });
  const all = [];
  for (const ev of Object.values(events)) {
    if (['CANCELLED', 'INVALIDATED'].includes(ev.lifecycle)) continue;
    for (const c of causal.classifyEvent({ event: ev, relationships: graph, asOf: today })) {
      all.push({ event: ev, cls: c });
    }
  }
  const beneficial = all.filter(x => ['DIRECT_BENEFICIARY', 'SECOND_ORDER_BENEFICIARY', 'EQUIPMENT_OR_CAPACITY_BENEFICIARY'].includes(x.cls.classification));
  // One row per ticker: keep the strongest (named > direct > horizon).
  const rank = c => (c.cls.named ? 4 : 0) + (c.cls.classification === 'DIRECT_BENEFICIARY' ? 3 : c.cls.classification === 'EQUIPMENT_OR_CAPACITY_BENEFICIARY' ? 2 : 1);
  const byTicker = new Map();
  for (const x of beneficial) {
    const prev = byTicker.get(x.cls.ticker);
    if (!prev || rank(x) > rank(prev)) byTicker.set(x.cls.ticker, x);
  }

  // Bounded tape + timing fan-out (freshest events first).
  const ordered = [...byTicker.values()].sort((a, b) => String(b.event.announcedAt).localeCompare(String(a.event.announcedAt)));
  const spyH = await fetchDailyHistory('SPY', '1y').catch(() => null);
  const spyCandles = (spyH && spyH.candles) || null;
  const benchCache = new Map([['SPY', spyCandles]]);
  const getBench = async (etf) => {
    if (benchCache.has(etf)) return benchCache.get(etf);
    const h = await fetchDailyHistory(etf, '1y').catch(() => null);
    const c = (h && h.candles) || null;
    benchCache.set(etf, c);
    return c;
  };

  const candidates = [];
  let tapeFetches = 0, omegaEvals = 0;
  for (const x of ordered) {
    const rel = graph.find(r => r.ticker === x.cls.ticker && r.exposureRole === x.cls.exposureRole) || null;
    let tape = null, timing = null, candles = null, bench = 'SPY';
    if (tapeFetches < MAX_TAPE_FETCHES) {
      tapeFetches++;
      const h = await fetchDailyHistory(x.cls.ticker, '1y').catch(() => null);
      candles = (h && h.candles) || null;
      bench = (rel && rel.sector && RT.benchForSector(rel.sector)) || 'SPY';
      const benchCandles = (await getBench(bench)) || spyCandles;
      if (candles) tape = RT.tapeRead({ candles, benchCandles, eventDate: x.event.announcedAt, asOf: today });
    }
    const nyr = RT.notYetRepricedScore({ classification: x.cls, relationship: rel || {}, event: x.event, tape, asOf: today });
    if (candles && candles.length >= 55 && omegaEvals < MAX_OMEGA_EVALS) {
      omegaEvals++;
      try {
        timing = require('./omega-swing').evaluateCandidate({
          ticker: x.cls.ticker, candles,
          bench: { spy: spyCandles, sector: benchCache.get(bench) || null },
          ctx: { regime: regime || { riskOn: false, bearish: false }, signalDate: today, maturity: 'shadow' },
        });
      } catch { timing = null; }
    }
    const score = scoreMod.opportunityScore({
      event: x.event, relationship: rel, classification: x.cls, cps, tape,
      notYetRepriced: nyr, dollarVol: tape ? tape.dollarVol : null, asOf: today,
    });
    const gate = scoreMod.actionGate({
      classification: x.cls, score, cps, timing, regime,
      dollarVol: tape ? tape.dollarVol : null,
    });
    candidates.push({
      ...SHADOW_FLAGS, version: MODULE_VERSION, scoreVersion: score.version,
      ticker: x.cls.ticker, company: x.cls.company,
      classification: x.cls.classification, exposureRole: x.cls.exposureRole,
      verifiedOrInferred: x.cls.verifiedOrInferred, named: x.cls.named,
      eventId: x.event.canonicalEventId, eventTitle: x.event.title, eventType: x.event.eventType,
      isoRegion: x.event.isoRegion, eventLifecycle: x.event.lifecycle,
      causalChain: x.cls.causalChain, direction: x.cls.direction, horizonDays: x.cls.horizonDays,
      score, notYetRepriced: nyr, tape, bench,
      timing: timing ? {
        tier: timing.tier, stage: timing.stage,
        entryClass: timing.entry && timing.entry.classification,
        entryReason: timing.entry && timing.entry.reason,
        entry: timing.risk ? { low: timing.risk.entryZoneLow, high: timing.risk.entryZoneHigh } : null,
        stop: timing.risk ? timing.risk.invalidation : null,
        target: timing.risk ? timing.risk.target1 : null,
        rr: timing.risk ? timing.risk.rr : null,
        source: 'omega-swing (reused — GRIDLOCK adds no timing features)',
      } : null,
      gate,
    });
  }
  candidates.sort((a, b) => (b.score.total || 0) - (a.score.total || 0));
  return {
    candidates,
    recorded: all.filter(x => !byTicker.has(x.cls.ticker) || byTicker.get(x.cls.ticker) !== x)
      .map(x => ({ ticker: x.cls.ticker, classification: x.cls.classification, reason: x.cls.reason, eventId: x.event.canonicalEventId })),
    tapeFetches, omegaEvals,
  };
}

// Research-only relative-value comparisons (never auto-shorts).
function buildRelativeValue(candidates) {
  const ROLE_BENCH = { MERCHANT_GENERATOR: 'XLU', INDEPENDENT_POWER_PRODUCER: 'XLU', REGULATED_UTILITY: 'XLU', NATURAL_GAS_PRODUCER: 'XLE', MIDSTREAM_OR_PIPELINE: 'XLE' };
  return candidates
    .filter(c => c.gate.status === 'ACTIONABLE_RESEARCH' || (c.score.total || 0) >= 50)
    .slice(0, 5)
    .map(c => ({
      long: c.ticker,
      comparison: ROLE_BENCH[c.exposureRole] || 'XLI',
      rationale: `Isolates the ${c.exposureRole} constraint exposure from broad ${ROLE_BENCH[c.exposureRole] || 'industrial'} beta; the thesis is the SPREAD, not the sector.`,
      exposureDifference: `${c.ticker} carries verified ${c.isoRegion} ${c.exposureRole} exposure; the benchmark is diversified across regions/roles.`,
      eventRelativeReturnPct: c.tape ? c.tape.excessMovePct : null,
      liquidityNote: c.tape && c.tape.dollarVol != null ? `$${Math.round(c.tape.dollarVol / 1e6)}M ADV` : 'ADV unavailable',
      shortSideNote: 'Research comparison only — no short position is recommended or sized.',
      invalidation: c.causalChain ? c.causalChain.invalidatingEvidence : null,
      correlation: null,   // honest: not computed in this slice (needs a candle-budget pass)
    }));
}

// ── op=gridlocktick ─────────────────────────────────────────────────────────
async function runGridlockTick(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (resolveGridlockMode() === 'off') return res.json({ ok: true, disabled: true, mode: 'off' });
  const store = require('./store');
  if (!store.hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });

  const { fetchRegionInputs } = require('./gridlock-sources');
  const { buildRegionState, constraintPressureScore } = require('./gridlock-region');
  const { autoAdvance } = require('./gridlock-lifecycle');
  const { foldIntoLedger } = require('./gridlock-events');
  const { SEED_EVENTS } = require('./gridlock-seed');
  const { scenarioTriplet } = require('./gridlock-scenario');
  const { fetchMacro } = require('./macro');

  const today = todayIso();
  const state0 = (await store.readJSON(KEYS.state, null)) || {};
  const ledger0 = (await store.readJSON(KEYS.events, null)) || {};

  // 1) Events: idempotent seed fold + bounded news ingestion.
  const seeded = foldIntoLedger(ledger0, SEED_EVENTS.map(e => ({ ...e })));
  const news = await ingestNews({ today }).catch(e => ({ articles: [], candidates: [], reason: String((e && e.message) || e) }));
  const folded = foldIntoLedger(seeded.ledger, news.candidates);
  let events = folded.ledger;

  // 2) Lifecycle auto-advance (deterministic evidence only).
  let lifecycleChanges = 0;
  events = Object.fromEntries(Object.entries(events).map(([k, ev]) => {
    const r = autoAdvance(ev, { todayIso: today });
    if (r.changed) lifecycleChanges++;
    return [k, r.event];
  }));

  // 3) Region inputs → PowerRegionState → constraint-pressure score.
  const inputs = await fetchRegionInputs({ isoRegion: 'PJM' });
  const pjmIn = inputs.pjm ? {
    ...inputs.pjm,
    installedCapacityMW: inputs.pjm.installedCapacityMW != null
      ? inputs.pjm.installedCapacityMW : ASSUMED_INSTALLED_CAPACITY_MW.PJM,
  } : null;
  const regionState = buildRegionState({
    isoRegion: 'PJM', asOf: today,
    inputs: { pjm: pjmIn, eia: inputs.eia, nws: inputs.nws, gas: null, pipeline: pipelineFromLedger(events, 'PJM') },
    sourceManifest: inputs.sourceManifest,
  });
  if (pjmIn && inputs.pjm.installedCapacityMW == null && regionState.availableCapacityMW.value != null) {
    regionState.availableCapacityMW.basis = 'assumed';
    regionState.availableCapacityMW.note = `installed capacity assumed ${ASSUMED_INSTALLED_CAPACITY_MW.PJM} MW (planning figure, not observed)`;
  }
  const history = Array.isArray(state0.cpsHistory) ? state0.cpsHistory : [];
  const cps = constraintPressureScore(regionState, history);
  const nextHistory = [...history.filter(h => h.asOf !== today), { asOf: today, total: cps.total }].slice(-CPS_HISTORY_CAP);

  // 4) Regime (canonical macro read; null-safe).
  const macro = await fetchMacro().catch(() => null);
  const regime = macro ? { riskOn: macro.regime === 'risk-on', bearish: macro.regime === 'risk-off', riskOff: macro.regime === 'risk-off', label: macro.regime } : null;

  // 5) Classify → tape → NYR → OMEGA timing → score → gate (bounded).
  const asm = await assembleCandidates({ events, cps, regionState, regime, today });

  // 6) Persist: latest payload, PIT day ledger (Scoreboard), events, state.
  const latest = {
    ok: true, version: MODULE_VERSION, ...SHADOW_FLAGS, mode: 'shadow',
    generatedAt: new Date().toISOString(), asOf: today,
    note: 'Shadow research vertical — weight-0, no live-portfolio inclusion, no win probability claimed. Prospective evidence decides everything.',
    region: { state: regionState, cps },
    regime,
    events: Object.values(events).sort((a, b) => String(b.announcedAt).localeCompare(String(a.announcedAt))).slice(0, 60),
    eventCount: Object.keys(events).length,
    candidates: asm.candidates,
    recordedRejections: asm.recorded.slice(0, 80),
    relativeValue: buildRelativeValue(asm.candidates),
    scenarioDefault: scenarioTriplet({
      addedLoadMW: regionState.announcedLargeLoadMW.value || 0,
      generationAddMW: regionState.generationPipelineMW.value || 0,
      retirementsMW: regionState.retirementPipelineMW.value || 0,
    }),
    coverage: {
      sources: inputs.sourceManifest, sourceFailures: inputs.failures,
      news: { fetched: news.articles.length, classified: news.candidates.length, reason: news.reason || null, llmUsed: news.llmUsed || 0 },
      tapeFetches: asm.tapeFetches, omegaEvals: asm.omegaEvals, lifecycleChanges,
      seeded: seeded.added, mergedFromNews: folded.merged, addedFromNews: folded.added,
    },
  };

  // Scoreboard/prospective ledger: EVERY beneficial candidate (gate pass or
  // fail) with its inclusion/exclusion reason; tier encodes the gate outcome.
  const picks = asm.candidates.map(c => ({
    ...SHADOW_FLAGS,
    ticker: c.ticker, date: today, entry: null, short: false,
    tier: c.gate.status === 'ACTIONABLE_RESEARCH' ? 'Actionable' : 'Tracked',
    gateStatus: c.gate.status, gateReason: c.gate.reason,
    classification: c.classification, exposureRole: c.exposureRole,
    eventId: c.eventId, eventType: c.eventType, isoRegion: c.isoRegion,
    bench: c.bench || null, scoreVersion: c.score.version, scoreTotal: c.score.total,
    cpsTotal: cps.total, cpsVersion: cps.version,
    lifecycleAtEntry: c.eventLifecycle, regime: regime ? regime.label : null,
    nyr: c.notYetRepriced ? c.notYetRepriced.score : null,
    featureSnapshot: { components: c.score.components, penalties: c.score.penalties, tape: c.tape },
  }));

  let err = null;
  try {
    await store.writeJSON(KEYS.events, events, 0);
    await store.writeJSON(KEYS.latest, latest, 0);
    await store.writeJSON(KEYS.state, { version: MODULE_VERSION, cpsHistory: nextHistory, lastRunAt: today }, 0);
    if (picks.length) await store.writeGridlockDay(today, { version: MODULE_VERSION, picks, ...SHADOW_FLAGS });
  } catch (e) { err = String((e && e.message) || e); }
  try {
    await require('./immutable-ledger').append('gridlock', {
      kind: 'tick', date: today, events: Object.keys(events).length,
      candidates: asm.candidates.length,
      actionable: picks.filter(p => p.tier === 'Actionable').map(p => p.ticker),
      cps: cps.total,
    });
  } catch { /* best-effort; the day-doc is the durable copy */ }

  return res.status(err ? 502 : 200).json({
    ok: !err, error: err, date: today, ...SHADOW_FLAGS,
    events: Object.keys(events).length, candidates: asm.candidates.length,
    actionable: picks.filter(p => p.tier === 'Actionable').length,
    cps: cps.total, cpsMissing: cps.missing, sourceFailures: inputs.failures,
    news: latest.coverage.news,
  });
}

// ── op=gridlockresolve ──────────────────────────────────────────────────────
// Entry = next session OPEN after the pick date; per-horizon close-to-entry
// return, SPY-excess, sector-bench excess, MFE/MAE + time-to-MFE from the
// intraday-free daily path. Net of estimated round-trip costs.
async function runGridlockResolve(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (resolveGridlockMode() === 'off') return res.json({ ok: true, disabled: true, mode: 'off' });
  const store = require('./store');
  if (!store.hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const { fetchDailyHistory } = require('./screener');
  const { roundTripCostPct, tierForPick } = require('./costs');

  const days = await store.readAllGridlockDays();
  const resolved = (await store.readJSON(KEYS.resolved, null)) || {};
  const pending = [];
  for (const d of days) for (const p of (d.picks || [])) {
    const key = `${p.date}|${p.ticker}`;
    const done = resolved[key];
    if (!done || HORIZONS.some(h => !done.horizons || !done.horizons[h])) pending.push({ ...p, key });
  }
  if (!pending.length) return res.json({ ok: true, resolved: 0, note: 'nothing to resolve', ...SHADOW_FLAGS });

  const histCache = new Map();
  const getCandles = async (t) => {
    if (histCache.has(t)) return histCache.get(t);
    const h = await fetchDailyHistory(t, '1y').catch(() => null);
    const c = (h && h.candles) || null;
    histCache.set(t, c);
    return c;
  };
  const spyCandles = await getCandles('SPY');
  if (!spyCandles) return res.json({ ok: false, error: 'SPY history unavailable', ...SHADOW_FLAGS });

  let resolvedCount = 0, stillOpen = 0;
  const next = { ...resolved };
  for (const p of pending.slice(0, 40)) {          // bounded per run; the rest next tick
    const candles = await getCandles(p.ticker);
    if (!candles) { stillOpen++; continue; }
    const entryIdx = candles.findIndex(c => c.date > p.date);
    if (entryIdx < 0) { stillOpen++; continue; }
    const entryC = candles[entryIdx];
    const entry = Number.isFinite(entryC.open) && entryC.open > 0 ? entryC.open : entryC.close;
    if (!entry) { stillOpen++; continue; }
    const benchCandles = p.bench && p.bench !== 'SPY' ? (await getCandles(p.bench)) || spyCandles : spyCandles;
    const refEntry = (cs) => { const i = cs.findIndex(c => c.date >= entryC.date); return i >= 0 ? (cs[i].open > 0 ? cs[i].open : cs[i].close) : null; };
    const spyEntry = refEntry(spyCandles), benchEntry = refEntry(benchCandles);

    const prior = next[p.key] || {
      key: p.key, date: p.date, ticker: p.ticker, tier: p.tier, gateStatus: p.gateStatus,
      classification: p.classification, exposureRole: p.exposureRole, eventType: p.eventType,
      scoreTotal: p.scoreTotal, cpsTotal: p.cpsTotal, regime: p.regime, bench: p.bench || 'SPY',
      entryDate: entryC.date, entryBasis: 'next-session-open',
      entrySlippageNote: 'entry = next-session OPEN; signal-day close is not tradeable',
      horizons: {}, ...SHADOW_FLAGS,
    };
    const horizons = { ...prior.horizons };
    let touched = false;
    for (const H of HORIZONS) {
      if (horizons[H]) continue;
      const exitIdx = entryIdx + H - 1;
      if (exitIdx >= candles.length) continue;      // not matured
      const path = candles.slice(entryIdx, exitIdx + 1);
      const exitC = path[path.length - 1];
      const retPct = ((exitC.close - entry) / entry) * 100;
      const refRet = (cs, e0) => {
        if (!e0) return null;
        const i = cs.findIndex(c => c.date >= exitC.date);
        const c1 = i >= 0 ? cs[i] : null;
        return c1 ? ((c1.close - e0) / e0) * 100 : null;
      };
      const spyRet = refRet(spyCandles, spyEntry), benchRet = refRet(benchCandles, benchEntry);
      const highs = path.map(c => c.high).filter(Number.isFinite);
      const lows = path.map(c => c.low).filter(Number.isFinite);
      const mfePct = highs.length ? +((Math.max(...highs) - entry) / entry * 100).toFixed(2) : null;
      const maePct = lows.length ? +((Math.min(...lows) - entry) / entry * 100).toFixed(2) : null;
      const mfeIdx = highs.length ? path.findIndex(c => c.high === Math.max(...highs)) : null;
      horizons[H] = {
        exitDate: exitC.date,
        grossPct: +retPct.toFixed(3),
        netPct: +(retPct - roundTripCostPct(tierForPick({}))).toFixed(3),
        excessSpyPct: spyRet == null ? null : +(retPct - spyRet).toFixed(3),
        excessBenchPct: benchRet == null ? null : +(retPct - benchRet).toFixed(3),
        mfePct, maePct, sessionsToMfe: mfeIdx,
      };
      touched = true;
    }
    if (!touched && !next[p.key]) { stillOpen++; continue; }
    next[p.key] = { ...prior, horizons };
    if (touched) resolvedCount++;
  }

  let err = null;
  try { await store.writeJSON(KEYS.resolved, next, 0); } catch (e) { err = String((e && e.message) || e); }
  return res.status(err ? 502 : 200).json({
    ok: !err, error: err, resolved: resolvedCount, open: stillOpen,
    totalKeys: Object.keys(next).length, ...SHADOW_FLAGS,
  });
}

// ── op=gridlock : public cached read ────────────────────────────────────────
async function runGridlock(req, res) {
  try {
    if (resolveGridlockMode() === 'off') {
      res.setHeader('Cache-Control', 's-maxage=600');
      return res.json({ ok: true, disabled: true, mode: 'off', note: 'GRIDLOCK is disabled (GRIDLOCK_MODE=off). Nothing else in the app is affected.' });
    }
    const store = require('./store');
    const [latest, resolved] = await Promise.all([
      store.readJSON(KEYS.latest, null), store.readJSON(KEYS.resolved, null),
    ]);
    const resolution = summarizeResolution(resolved);
    if (!latest) {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: false, warming: true, ...SHADOW_FLAGS, note: 'GRIDLOCK has not run yet — the nightly cron builds the first snapshot.', resolution });
    }
    const ageMs = Date.now() - Date.parse(latest.generatedAt || 0);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    return res.json({ ...latest, stale: !(ageMs < REFRESH_MS * 4), ageHours: Number.isFinite(ageMs) ? +(ageMs / 3600000).toFixed(1) : null, resolution });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, error: String((e && e.message) || e), ...SHADOW_FLAGS });
  }
}

function summarizeResolution(resolved) {
  const recs = Object.values(resolved || {});
  const byHorizon = {};
  for (const H of HORIZONS) {
    const outs = recs.map(r => r.horizons && r.horizons[H]).filter(Boolean);
    if (!outs.length) { byHorizon[H] = { n: 0 }; continue; }
    const nets = outs.map(o => o.excessSpyPct).filter(v => v != null);
    byHorizon[H] = {
      n: outs.length,
      meanExcessSpyPct: nets.length ? +(nets.reduce((a, b) => a + b, 0) / nets.length).toFixed(3) : null,
      hitRate: nets.length ? Math.round((nets.filter(x => x > 0).length / nets.length) * 100) : null,
    };
  }
  return { predictions: recs.length, byHorizon, note: recs.length < 30 ? 'Sample far below promotion bar — no verdict claimed.' : null };
}

// ── op=gridlockscenario : public deterministic arithmetic ───────────────────
async function runGridlockScenario(req, res) {
  const { scenarioTriplet } = require('./gridlock-scenario');
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  const q = req.query || {};
  const result = scenarioTriplet({
    addedLoadMW: num(q.addedLoadMW), generationAddMW: num(q.generationAddMW),
    retirementsMW: num(q.retirementsMW), outagesMW: num(q.outagesMW),
    gasPriceUSD: num(q.gasPriceUSD), weatherSeverity: num(q.weatherSeverity),
    completionProb: num(q.completionProb), contractYears: num(q.contractYears),
    transmissionAvailable: q.transmissionAvailable == null ? undefined : q.transmissionAvailable !== 'false',
    baselinePeakLoadMW: num(q.baselinePeakLoadMW), baselineCapacityMW: num(q.baselineCapacityMW),
  });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ...result, ...SHADOW_FLAGS });
}

module.exports = {
  MODULE_VERSION, HORIZONS, KEYS, SHADOW_FLAGS, resolveGridlockMode,
  pipelineFromLedger, buildRelativeValue, summarizeResolution, assembleCandidates,
  runGridlock, runGridlockTick, runGridlockResolve, runGridlockScenario,
};
