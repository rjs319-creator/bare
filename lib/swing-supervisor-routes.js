'use strict';
// SWING SUPERVISOR ROUTES — the server-authoritative board (folded into api/tracker.js; no new
// Serverless Function). Three ops, all idempotent per session:
//
//   op=swingmonitor         build + return the sectioned board (no persistence)
//   op=swingmonitor&log=1   also persist episodes, append transitions to the ledger, grade terminals
//   op=swinggrade           recompute the algorithm router + resolved-episode summary + verify ledger
//
// The union universe (current swing candidates ∪ all non-terminal published episodes) and every
// lifecycle decision live in the pure core (lib/swing-supervisor); this layer only fetches sources
// and candles and persists. The client renders the board — it never owns lifecycle truth.

const { internalHeaders } = require('./auth');
const { nowET, isMarketHoliday } = require('./stats');
const { fetchDailyHistory } = require('./screener');
const { SECTOR_ETF } = require('./omega-backfill');
const SUP = require('./swing-supervisor');
const STORE = require('./swing-store');
const { buildRouter } = require('./swing-router');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const FETCH_CONCURRENCY = 6;
const CANDLE_TICKER_CAP = 200;   // bound the fan-out; oldest-untraded picks beyond this age out on freshness
const etfForSector = (name) => (name ? SECTOR_ETF[String(name).trim().toLowerCase()] || null : null);

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

// One self-fetch of a cached endpoint. Never throws (a dead source contributes nothing + a warning).
async function pull(path) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://' + HOST + path, { headers: internalHeaders(), signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { ok: false, status: r.status, ms: Date.now() - t0, data: null };
    return { ok: true, ms: Date.now() - t0, data: await r.json() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - t0, data: null };
  }
}

// Extract today's swing candidates from the op=today payload → supervisor signal shape. op=today has
// already normalized, merged (one canonical ticker/side/horizon) and ranked every source, so this is
// the single clean current-candidate feed for the whole swing horizon.
function extractSwingSignals(today) {
  if (!today || !today.horizons) return [];
  const swing = today.horizons.swing || [];
  return swing.map((s) => ({
    ticker: s.ticker, company: s.company || null, side: s.side || 'long', horizon: 'swing',
    source: s.source || (s.sources && s.sources[0]) || 'unknown',
    sources: s.sources && s.sources.length ? s.sources : (s.source ? [s.source] : []),
    strategyFamily: s.strategyFamily || s.family || 'priceTrend', scoringVersion: s.scoringVersion || null,
    score: s.score, rank: s.rank, tier: s.tier || null, setup: s.setup || s.tier || null,
    price: s.price, entry: s.entry, stop: s.stop, target: s.target,
    maxEntry: s.maxEntry || null, maxGap: s.maxGap || null, holdingWindow: s.holdingWindow || 10,
    rr: s.rr, note: s.note || null, thesis: s.note || null,
    event: s.event || null, sector: s.sector || null, sectorEtf: etfForSector(s.sector),
    features: s.features || {},
  }));
}

// Fetch daily candles for the union of tickers + SPY + the sector ETFs referenced.
async function fetchPriceBundle(tickers, sectors) {
  const uniq = [...new Set(tickers.filter(Boolean))].slice(0, CANDLE_TICKER_CAP);
  const map = {};
  await mapLimit(uniq, FETCH_CONCURRENCY, async (t) => {
    const d = await fetchDailyHistory(t, '1y').catch(() => null);
    if (d && d.candles) map[t] = d.candles;
  });
  const etfs = [...new Set(['SPY', ...sectors.map(etfForSector).filter(Boolean)])];
  const bench = {};
  await mapLimit(etfs, FETCH_CONCURRENCY, async (e) => {
    const d = await fetchDailyHistory(e, '1y').catch(() => null);
    if (d && d.candles) bench[e] = d.candles;
  });
  return { map, bench };
}

// Trim an episode down to a card the client renders (no internal freeze machinery).
function toCard(ep) {
  const o = ep.origin, a = ep.assessment || {};
  return {
    episodeId: o.episodeId, ticker: o.ticker, company: o.company, side: o.side,
    sourceStrategy: o.sourceStrategy, sourceStrategies: o.sourceStrategies, strategyFamily: o.strategyFamily,
    strategyVersion: o.strategyVersion, setupGeneration: o.setupGeneration,
    firstDecisionDate: o.firstDecisionDate, firstSuggestedPrice: o.firstSuggestedPrice,
    originalEntry: o.originalEntry, originalStop: o.originalStop, originalTargets: o.originalTargets,
    originalScore: o.originalScore, originalRank: o.originalRank, originalTier: o.originalTier,
    originalSetup: o.originalSetup, originalThesis: o.originalThesis, originalRisks: o.originalRisks,
    // current assessment
    lifecycleState: a.lifecycleState, thesisState: a.thesisState, actionState: a.actionState,
    executionState: a.executionState, outcomeState: a.outcomeState,
    reasonCodes: a.reasonCodes, explanation: a.explanation,
    currentPrice: a.currentPrice, currentScore: a.currentScore, scoreDelta: a.scoreDelta,
    currentRank: a.currentRank, rankDelta: a.rankDelta, currentTier: a.currentTier,
    returnSinceSuggestion: a.returnSinceSuggestion, returnSinceFill: a.returnSinceFill,
    excessVsSpy: a.excessVsSpy, excessVsSector: a.excessVsSector,
    mfeSinceSuggestion: a.mfeSinceSuggestion, maeSinceSuggestion: a.maeSinceSuggestion,
    remainingToOriginalTarget: a.remainingToOriginalTarget, remainingRewardRisk: a.remainingRewardRisk, consumedPct: a.consumedPct,
    sessionsSinceSuggestion: a.sessionsSinceSuggestion, sessionsSinceEntry: a.sessionsSinceEntry, sessionsRemaining: a.sessionsRemaining,
    sourceStillSelects: a.sourceStillSelects, currentSources: a.currentSources,
    managementStop: a.managementStop, managementNote: a.managementNote,
    dataFreshness: a.dataFreshness, calibrationStatus: a.calibrationStatus,
    lastEvaluatedAt: a.lastEvaluatedAt, latestCompletedBarAsOf: a.latestCompletedBarAsOf,
    transitionCount: (ep.transitions || []).length,
    lastTransition: (ep.transitions || []).slice(-1)[0] || null,
    terminal: ep.terminal,
  };
}

function boardPayload(result, extras = {}) {
  const sections = {};
  for (const [k, v] of Object.entries(result.sections)) sections[k] = v.map(toCard);
  return {
    generatedAt: result.generatedAt, date: result.date, version: SUP.STRATEGY_VERSION,
    counts: result.counts, suppressedReentries: result.suppressedReentries,
    sections,
    sectionOrder: ['newCandidates', 'stillValid', 'waitingForTrigger', 'needsAttention', 'noLongerActionable', 'completed', 'archive'],
    sectionLabels: {
      newCandidates: 'New Swing Candidates', stillValid: 'Still Valid / Actionable', waitingForTrigger: 'Waiting for Trigger',
      needsAttention: 'Needs Attention', noLongerActionable: 'No Longer Actionable', completed: 'Completed', archive: 'Historical Archive',
    },
    honesty: 'Lifecycle accountability only. States and explanations describe what happened to each published pick — they are NOT a claim of predictive edge. Uncalibrated scores are shown as evidence, never as probabilities.',
    ...extras,
  };
}

async function runSwingMonitor(req, res) {
  const { date, isMarketClosed } = nowET();
  const generatedAt = new Date().toISOString();
  const doLog = req.query.log === '1';

  const prevEpisodes = await STORE.loadEpisodes().catch(() => []);
  const today = await pull('/api/tracker?op=today');
  const regimeRiskOff = !!(today.data && today.data.regime && today.data.regime.bearish);
  const regime = today.data && today.data.regime ? today.data.regime.label : 'neutral';
  const signals = extractSwingSignals(today.data);

  // Union of tickers we must price: every prior open/terminal episode + today's candidates.
  const tickers = [...new Set([...prevEpisodes.map(e => e.origin.ticker), ...signals.map(s => s.ticker)])];
  const sectors = [...new Set([...prevEpisodes.map(e => e.origin.originalSectorState), ...signals.map(s => s.sector)].filter(Boolean))];
  const priceBundle = await fetchPriceBundle(tickers, sectors);

  const resolved = await STORE.loadResolved().catch(() => []);
  const router = buildRouter(resolved.map(r => ({ origin: { strategyFamily: r.strategyFamily, sourceStrategy: r.sourceStrategy }, assessment: r })));

  const ctx = { date, generatedAt, regime, regimeRiskOff, isHoliday: isMarketHoliday, cooldownSessions: 3, router };
  const result = SUP.buildSupervisor({ prevEpisodes, signals, priceBundle, ctx });

  const extras = {
    router: { version: router.version, priorRate: router.priorRate, sources: router.sources, families: router.families, shadow: true, note: router.note },
    sourceAvailable: !!(today.ok && today.data),
    warnings: today.ok ? [] : ['op=today unavailable — evaluating persisted episodes only; new candidates may be missing'],
  };

  if (doLog && !isMarketClosed) {
    const saved = await STORE.saveEpisodes(result.episodes, date);
    const led = await STORE.appendTransitions(date, result.transitions, { version: SUP.STRATEGY_VERSION });
    const graded = await STORE.recordResolved(result.graded, date);
    extras.persistence = { episodes: saved, ledger: led, resolved: graded, transitions: result.transitions.length };
    const payload = boardPayload(result, extras);
    await STORE.saveBoard(payload).catch(() => {});
    return json(res, 200, payload, 60);
  }
  return json(res, 200, boardPayload(result, extras), 120);
}

// Grade terminals + recompute the algorithm router + verify the immutable ledger. Read-only over the
// stored episodes; safe to re-run.
async function runSwingGrade(req, res) {
  const { date } = nowET();
  const episodes = await STORE.loadEpisodes().catch(() => []);
  const graded = episodes.filter(e => e.terminal);
  const rec = await STORE.recordResolved(graded, date);
  const resolved = await STORE.loadResolved().catch(() => []);
  const router = buildRouter(resolved.map(r => ({ origin: { strategyFamily: r.strategyFamily, sourceStrategy: r.sourceStrategy }, assessment: r })));
  const ledger = await STORE.verifyLedger();
  // Resolved competing-risk summary — EXPERIMENTAL scores, never probabilities (feeds the shadow
  // survival model; see lib/challenger-survival.js which the swing episodes extend).
  const summary = summarizeResolved(resolved);
  return json(res, 200, {
    date, version: SUP.STRATEGY_VERSION,
    resolvedTotal: resolved.length, gradedThisPass: graded.length, recorded: rec,
    router: { version: router.version, priorRate: router.priorRate, sources: router.sources, families: router.families },
    survivalSummary: summary,
    ledger,
    honesty: 'Router tilts and survival counts are shadow, evidence-gated, and shown as experimental scores. They do not change any live ranking or originate a trade.',
  }, 300);
}

function summarizeResolved(rows) {
  const byFamily = {};
  for (const r of rows) {
    const k = r.strategyFamily || 'unknown';
    const b = byFamily[k] || (byFamily[k] = { episodes: 0, wins: 0, losses: 0, noFill: 0, expiredPos: 0 });
    b.episodes++;
    if (r.outcomeState === 'WIN') b.wins++;
    else if (r.outcomeState === 'LOSS') b.losses++;
    else if (r.outcomeState === 'NO_FILL') b.noFill++;
    else if (r.outcomeState === 'EXPIRED_POSITIVE') b.expiredPos++;
  }
  return byFamily;
}

function json(res, code, obj, sMaxAge = 60) {
  res.setHeader('Cache-Control', `s-maxage=${sMaxAge}, stale-while-revalidate=86400`);
  return res.status(code).json(obj);
}

module.exports = { runSwingMonitor, runSwingGrade, extractSwingSignals, toCard, boardPayload };
