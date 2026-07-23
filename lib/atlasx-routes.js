'use strict';
// ATLAS-X routes — folded into api/tracker.js (no new Serverless Function). Ops:
//
//   op=atlasx              build + return the 10-section research board (READ-ONLY)
//   op=atlasxlog           (cron/privileged) build + persist episodes, ledger, predictions, capture
//   op=atlasxresolve       (cron/privileged) grade terminal episodes + refresh model health
//   op=atlasxwalkforward   (expensive) run the research comparison vs baselines
//
// Universe, residualization, experts, ranking, survival, prosecutor, entry, utility,
// portfolio and episode lifecycle all live in pure modules; this layer only fetches
// candles (cached full-universe first), calls the engine, and persists. ATLAS-X is
// SHADOW/weight-0 — it cannot originate, boost, suppress or reorder a live trade.

const { internalHeaders } = require('./auth');
const { nowET, isMarketHoliday } = require('./stats');
const { fetchDailyHistory } = require('./screener');
const { SECTOR_ETF } = require('./omega-backfill');
const { loadCandleCache, cacheGet, cacheState } = require('./candle-cache');
const STORE = require('./atlasx-store');
const { buildUniverse, DEFAULT_SCOPES } = require('./atlasx-universe');
const { runEngine } = require('./atlasx-engine');
const { buildAtlasEpisodes } = require('./atlasx-episodes');
const { buildAtlasPortfolio } = require('./atlasx-portfolio');
const { buildCapture, matchControls } = require('./atlasx-capture');
const { modelHealth, promotionView } = require('./atlasx-governance');
const { toCard } = require('./swing-supervisor-routes');
const { displayNumber } = require('./atlasx-contracts');
const { VERSIONS, STORE: STORE_KEYS } = require('./atlasx-config');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const FETCH_CONCURRENCY = 6;
const FETCH_FALLBACK_CAP = 60;   // bound live Yahoo fan-out for names missing from cache
const etfForSector = name => (name ? SECTOR_ETF[String(name).trim().toLowerCase()] || null : null);

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

async function pull(path) {
  try {
    const r = await fetch('https://' + HOST + path, { headers: internalHeaders(), signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { ok: false, status: r.status, data: null };
    return { ok: true, data: await r.json() };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), data: null }; }
}

// ── candle sourcing: cached full-universe first, bounded Yahoo fallback ────────
async function loadCandleDocs(scopes = DEFAULT_SCOPES) {
  const docs = {};
  await Promise.all(scopes.map(async s => { const d = await loadCandleCache(s).catch(() => null); if (d) docs[s] = d; }));
  return docs;
}

// Build a ticker→candles map for the eval set: cache hits first, then a bounded
// live fetch for the misses. Benchmarks (SPY + referenced sector ETFs) always resolved.
async function buildPriceMap(evalTickers, sectorEtfs, candleDocs) {
  const map = {};
  const docs = Object.values(candleDocs);
  const misses = [];
  for (const t of evalTickers) {
    let hit = null;
    for (const d of docs) { const g = cacheGet(d, t); if (g && g.candles && g.candles.length) { hit = g.candles; break; } }
    if (hit) map[t] = hit; else misses.push(t);
  }
  const toFetch = misses.slice(0, FETCH_FALLBACK_CAP);
  await mapLimit(toFetch, FETCH_CONCURRENCY, async t => {
    const d = await fetchDailyHistory(t, '1y').catch(() => null);
    if (d && d.candles) map[t] = d.candles;
  });

  const bench = {};
  const etfs = [...new Set(['SPY', ...sectorEtfs.filter(Boolean)])];
  await mapLimit(etfs, FETCH_CONCURRENCY, async e => {
    for (const d of docs) { const g = cacheGet(d, e); if (g && g.candles && g.candles.length) { bench[e] = g.candles; return; } }
    const r = await fetchDailyHistory(e, '1y').catch(() => null);
    if (r && r.candles) bench[e] = r.candles;
  });
  return { map, bench, fetched: toFetch.length, missesUnresolved: Math.max(0, misses.length - toFetch.length) };
}

// ── the 10-section research board ─────────────────────────────────────────────
const SECTION_ORDER = ['enterNextSession', 'waitBreakout', 'waitPullback', 'waitConfirmation', 'doNotChase', 'avoid', 'openEpisodes', 'noLongerActionable', 'completed', 'evidenceValidation'];
const SECTION_LABELS = {
  enterNextSession: 'Enter Next Session', waitBreakout: 'Wait for Breakout', waitPullback: 'Wait for Pullback',
  waitConfirmation: 'Wait for First-Hour Confirmation', doNotChase: 'Do Not Chase', avoid: 'Avoid / Prosecutor Flags',
  openEpisodes: 'Open Episodes', noLongerActionable: 'No Longer Actionable', completed: 'Completed', evidenceValidation: 'Evidence & Validation',
};

function candidateCard(c) {
  const surv = c.survival || {};
  return {
    ticker: c.ticker, company: c.company, side: c.side, price: round(c.price),
    expert: c.expert, expertStage: c.expertAssessment ? c.expertAssessment.stage : null,
    transition: c.transition ? c.transition.dominantTransition : null,
    action: c.entry ? c.entry.action : 'NO_TRADE', actionable: c.actionable, abstentionReason: c.abstentionReason,
    trigger: c.entry ? c.entry.trigger : null, invalidation: c.invalidation, targets: c.targets,
    remainingRR: round(c.remainingRR), holdingWindow: c.holdingWindow,
    residual10: c.residual && c.residual.byHorizon[10] ? round(c.residual.byHorizon[10].residual) : null,
    residualAccel: c.residual ? c.residual.residualAccel : null,
    pathArchetype: c.path ? c.path.archetype : null,
    champion: c.champion ? c.champion.reasons : [],
    prosecutor: c.prosecutor ? { failureScore: displayNumber(c.prosecutor.failureScore, 'uncalibrated', 'probability').display, modes: (c.prosecutor.failureModes || []).map(f => f.mode), binding: c.prosecutor.binding } : null,
    // survival + distribution are EXPERIMENTAL scores — never a percentage
    targetBeforeStop: displayNumber(surv.pTargetBeforeStop, surv.calibrationStatus || 'uncalibrated', 'probability').display,
    expectedSessions: surv.expectedSessions != null ? Math.round(surv.expectedSessions) : null,
    distribution: c.distribution ? { p10: round(c.distribution.p10), median: round(c.distribution.median), p90: round(c.distribution.p90), score: round(c.distribution.score) } : null,
    utilityWaterfall: c.utility ? c.utility.waterfall : [],
    expectedValueBps: c.utility ? c.utility.expectedValue : null, lowerBps: c.utility ? c.utility.lower : null,
    uncertaintySource: c.utility && c.utility.interval ? c.utility.interval.uncertaintySource : (c.utility ? c.utility.uncertaintySource : null),
    dataFreshnessSessions: c.staleSessions, provenance: c.provenance,
    governanceStatus: 'shadow', calibrationStatus: 'uncalibrated',
  };
}

function sectionForCandidate(c) {
  const a = c.entry ? c.entry.action : 'NO_TRADE';
  if (a === 'ENTER_NEXT_OPEN') return c.actionable ? 'enterNextSession' : 'avoid';
  if (a === 'WAIT_BREAKOUT') return 'waitBreakout';
  if (a === 'WAIT_PULLBACK') return 'waitPullback';
  if (a === 'WAIT_FIRST_HOUR' || a === 'WAIT_CONFIRMATION') return 'waitConfirmation';
  if (a === 'DO_NOT_CHASE') return 'doNotChase';
  return 'avoid'; // AVOID / NO_TRADE / abstained
}

function assembleBoard({ candidates, episodeResult, portfolio, capture, health, promotion, coverage, universe, ctx, ledger, extras = {} }) {
  const sections = {}; for (const k of SECTION_ORDER) sections[k] = [];
  const today = ctx.date;

  for (const c of candidates) sections[sectionForCandidate(c)].push(candidateCard(c));

  // episode lanes from the reused supervisor (carried-forward monitoring + terminals)
  const es = episodeResult && episodeResult.sections ? episodeResult.sections : {};
  const openLanes = [...(es.stillValid || []), ...(es.waitingForTrigger || []), ...(es.needsAttention || [])]
    .filter(ep => ep.origin.firstDecisionDate !== today); // today's new ones already shown in entry lanes
  sections.openEpisodes = openLanes.map(toCard);
  sections.noLongerActionable = (es.noLongerActionable || []).map(toCard);
  sections.completed = (es.completed || []).map(toCard);

  sections.evidenceValidation = [{
    coverage, universe: universeSummary(universe),
    health, promotion,
    portfolio: { positions: portfolio.positions.length, excluded: portfolio.excluded.length, weightPolicy: 'weight-0 (shadow)' },
    capture: capture ? { selected: capture.selected.length, rejected: capture.rejected.length, nearThreshold: capture.nearThreshold.length, matchedControls: capture.matchedControls.length } : null,
    ledger: ledger || null,
    calibration: { status: 'uncalibrated', note: 'Survival, prosecutor and distributional outputs are EXPERIMENTAL SCORES shown as qualitative bands — never percentages — until an out-of-fold calibration artifact passes.' },
    honesty: 'ATLAS-X is a SHADOW/weight-0 challenger. It cannot originate, boost, suppress or reorder any live trade. Sophistication is not evidence: it stays shadow until it clears strategy-gate PROMOTION_GATE on purged, survivorship-safe, cost-aware, prospective, incremental evidence.',
  }];

  const counts = {}; for (const k of SECTION_ORDER) counts[k] = sections[k].length;
  return {
    generatedAt: ctx.generatedAt, date: today, version: VERSIONS.strategy,
    sectionOrder: SECTION_ORDER, sectionLabels: SECTION_LABELS, sections, counts,
    coverage, governanceStatus: 'shadow', weight: 0,
    emptyActionableNote: sections.enterNextSession.length === 0
      ? 'No candidate clears the evidence and uncertainty hurdle right now — ATLAS-X is abstaining rather than showing a weak pick.' : null,
    ...extras,
  };
}

function universeSummary(u) {
  if (!u) return null;
  return { evaluable: u.evalTickers.length, current: u.sources.current.length, episodes: u.sources.episodes.length, nearMiss: u.sources.nearMiss.length };
}

// ── shared build ──────────────────────────────────────────────────────────────
async function buildAtlasBoard({ persist }) {
  const { date, isMarketClosed } = nowET();
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();

  const prevEpisodes = await STORE.loadEpisodes().catch(() => []);
  const today = await pull('/api/tracker?op=today');
  const regime = today.data && today.data.regime ? today.data.regime.label : 'neutral';
  const regimeRiskOff = !!(today.data && today.data.regime && today.data.regime.bearish);

  const candleDocs = await loadCandleDocs();
  const universe = buildUniverse({ todayData: today.data, prevEpisodes, candleDocs, opts: { nowMs } });

  const sectorEtfs = [...new Set(universe.current.map(c => etfForSector(c.sector)).filter(Boolean))];
  // include sector ETFs on the current descriptors so the engine can residualize
  for (const c of universe.current) c.sectorEtf = c.sectorEtf || etfForSector(c.sector);
  const { map, bench, fetched, missesUnresolved } = await buildPriceMap(universe.evalTickers, sectorEtfs, candleDocs);

  const calibration = await STORE.loadCalibration().catch(() => null);
  const ctx = {
    date, generatedAt, regime, regimeRiskOff, isHoliday: isMarketHoliday, cooldownSessions: 3,
    residualsOOF: calibration && Array.isArray(calibration.residualsBps) ? calibration.residualsBps : null,
    universeSnapshotId: `${date}:${universe.evalTickers.length}`,
  };

  const priceLookup = t => map[t] || null;
  const benchLookup = t => bench[t] || (map[t] || []);
  const { candidates, skipped } = runEngine({ universe, priceLookup, benchLookup, ctx });

  // episodes via the reused supervisor engine (own namespace)
  const priceBundle = { map, bench };
  const episodeResult = buildAtlasEpisodes({ prevEpisodes, candidates, priceBundle, ctx });

  // portfolio + capture + governance
  const actionable = candidates.filter(c => c.actionable);
  const portfolio = buildAtlasPortfolio(actionable.map(rankRow), { });
  const rejected = candidates.filter(c => !c.actionable);
  const controls = actionable.map(c => ({ ...c, control: matchControls(controlKey(c), Object.values(universe.pool || {})) }));
  const capture = buildCapture({
    date, ctx,
    selected: actionable.map(controlKey),
    rejected: rejected.map(controlKey),
    nearMiss: universe.sources.nearMiss.map(t => ({ ticker: t })),
    controls: controls.map(c => c.control).filter(Boolean),
    todayCandidates: universe.current,
  });

  const resolved = await STORE.loadResolved().catch(() => []);
  const health = modelHealth({ nEpisodes: resolved.length, rankIC: null, precision: null, netUtility: null, dudRate: null, calibrationError: null, dataFreshness: 1 });
  const promotion = promotionView({ resolvedEpisodes: resolved.length, independentDates: new Set(resolved.map(r => r.firstDecisionDate || r.decisionTs)).size, incrementalExcessReturn: false, calibrationBeatsBaseRate: false, costAware: false, regimeRobust: false, confidenceInterval: false });

  const coverage = { ...universe.coverage, priceFetched: fetched, priceMissesUnresolved: missesUnresolved, cacheScopes: Object.keys(candleDocs), sourceAvailable: !!(today.ok && today.data), skipped: skipped.length };

  let ledger = null;
  if (persist && !isMarketClosed && STORE.hasStore()) {
    await STORE.saveEpisodes(episodeResult.episodes);
    const led = await STORE.appendLedger({ kind: 'atlasx-monitor', date, transitions: episodeResult.transitions.length, episodes: episodeResult.episodes.length, version: VERSIONS.strategy }).catch(() => null);
    await STORE.appendResolved((episodeResult.graded || []).map(gradedRow));
    await STORE.appendPredictions(actionable.map(c => predictionRow(c, ctx)));
    await STORE.appendCapture(capture);
    await STORE.saveHealth(health);
    ledger = led ? { appended: true, seq: led.seq, hash: (led.hash || '').slice(0, 12) } : { appended: false };
  }

  const board = assembleBoard({ candidates, episodeResult, portfolio, capture, health, promotion, coverage, universe, ctx, ledger, extras: { persisted: !!(persist && !isMarketClosed) } });
  if (persist && !isMarketClosed && STORE.hasStore()) { await STORE.saveLatest(board).catch(() => {}); await STORE.saveBoard(board).catch(() => {}); }
  return board;
}

// ── op handlers ───────────────────────────────────────────────────────────────
async function runAtlasX(req, res) {
  try {
    // Serve a fresh build; fall back to the cached board only if the live build throws.
    const board = await buildAtlasBoard({ persist: req.query.log === '1' });
    return json(res, 200, board, 120);
  } catch (e) {
    const cached = await STORE.loadLatest().catch(() => null);
    if (cached) return json(res, 200, { ...cached, stale: true, buildError: String(e && e.message || e) }, 60);
    return json(res, 200, { ok: false, error: String(e && e.message || e), version: VERSIONS.strategy, sections: {}, sectionOrder: SECTION_ORDER, sectionLabels: SECTION_LABELS, honesty: 'ATLAS-X build failed; no cached board available.' }, 30);
  }
}

async function runAtlasXLog(req, res) {
  const board = await buildAtlasBoard({ persist: true });
  return json(res, 200, { ...board, logged: true }, 60);
}

async function runAtlasXResolve(req, res) {
  const { date } = nowET();
  const episodes = await STORE.loadEpisodes().catch(() => []);
  const graded = episodes.filter(e => e.terminal);
  await STORE.appendResolved(graded.map(gradedRow));
  const resolved = await STORE.loadResolved().catch(() => []);
  const health = modelHealth({ nEpisodes: resolved.length, rankIC: null, precision: null, netUtility: null, dudRate: null });
  await STORE.saveHealth(health).catch(() => {});
  const ledger = await STORE.verifyLedger().catch(() => null);
  return json(res, 200, {
    date, version: VERSIONS.strategy, resolvedTotal: resolved.length, gradedThisPass: graded.length,
    health, ledger,
    honesty: 'Resolved competing-risk outcomes are experimental scores feeding calibration — never live probabilities. ATLAS-X remains shadow/weight-0.',
  }, 300);
}

async function runAtlasXWalkForward(req, res) {
  let research;
  try { research = require('./atlasx-research'); } catch (e) { research = null; }
  if (!research || !research.runComparison || !research.buildEvents) {
    return json(res, 200, { version: VERSIONS.strategy, status: 'research-harness-unavailable', note: 'The ATLAS-X research comparison module is not present in this build.' }, 300);
  }
  try {
    const candleDocs = await loadCandleDocs();
    const docs = Object.values(candleDocs);
    if (!docs.length) return json(res, 200, { version: VERSIONS.strategy, status: 'data-gated', note: 'No cached full-universe candles — run `node scripts/atlasx-research.js` locally or wait for the warm cron to populate the cache.' }, 120);

    // Bounded, deterministic: first N cache tickers + SPY, a spread of decision dates.
    const RESEARCH_CAP = 40;
    const candleMap = {};
    for (const d of docs) { for (const t of Object.keys(d.data)) { if (Object.keys(candleMap).length >= RESEARCH_CAP) break; const g = cacheGet(d, t); if (g && g.candles && g.candles.length > 90) candleMap[t] = g.candles; } }
    let spyCandles = null;
    for (const d of docs) { const g = cacheGet(d, 'SPY'); if (g && g.candles) { spyCandles = g.candles; break; } }
    if (!spyCandles) { const r = await fetchDailyHistory('SPY', '1y').catch(() => null); spyCandles = r && r.candles ? r.candles : null; }
    if (!spyCandles) return json(res, 200, { version: VERSIONS.strategy, status: 'data-gated', note: 'SPY benchmark unavailable.' }, 120);

    const dates = spyCandles.map(b => b.date).filter((_, i) => i % 15 === 0).slice(30, -12); // spaced PIT decision dates with forward room
    const events = research.buildEvents({ candleMap, spyCandles, sectorMap: {}, decisionDates: dates, horizon: 'swing' });
    const comparison = research.runComparison(events, {});
    const promotion = research.promotionReadout(comparison);
    return json(res, 200, {
      version: VERSIONS.strategy, status: 'ok', events: events.length,
      champion: comparison.champion, perRankerIC: comparison.perRankerIC, verdict: comparison.verdict, promotion,
      honesty: 'Cache-derived research is SURVIVORSHIP-BIASED (present-day universe membership) and fail-closed: it can never pass a production gate no matter the IC. The canonical walk-forward is `node scripts/atlasx-research.js`.',
    }, 300);
  } catch (e) {
    return json(res, 200, { version: VERSIONS.strategy, status: 'data-gated', error: String(e && e.message || e) }, 120);
  }
}

// ── row adapters ──────────────────────────────────────────────────────────────
function rankRow(c) {
  return { ticker: c.ticker, expert: c.expert, strategyFamily: c.expert, sector: c.sector, sectorEtf: c.sectorEtf,
    score: c.distribution ? c.distribution.score : 0, rank: c.rank, dollarVol: c.dollarVol,
    utility: c.utility ? c.utility.expectedValue : null, capGroup: null };
}
function controlKey(c) {
  const t = c.transition && c.transition.features ? c.transition.features : {};
  return { ticker: c.ticker, sector: c.sector, beta: c.residual ? c.residual.beta : null, vol: c.residual ? c.residual.vol : null,
    liqTier: c.sourceMeta ? c.sourceMeta.liqTier : null, momentum: t.ret20 != null ? t.ret20 : null, price: c.price,
    capGroup: null, reasonCode: c.abstentionReason || (c.entry ? c.entry.action : null) };
}
function gradedRow(ep) {
  const a = ep.assessment || {};
  return { predictionId: ep.origin.predictionId, episodeId: ep.origin.episodeId, ticker: ep.origin.ticker,
    strategyFamily: ep.origin.strategyFamily, sourceStrategy: ep.origin.sourceStrategy,
    firstDecisionDate: ep.origin.firstDecisionDate, outcomeState: a.outcomeState, lifecycleState: a.lifecycleState,
    returnSinceFill: a.returnSinceFill, excessVsSpy: a.excessVsSpy };
}
function predictionRow(c, ctx) {
  return { predictionId: `atlasx:${c.ticker}:${c.side}:${ctx.date}`, ticker: c.ticker, side: c.side,
    decisionTs: ctx.date, eligibleEntryTs: c.provenance ? c.provenance.eligibleEntryTs : null,
    expert: c.expert, action: c.entry ? c.entry.action : null,
    distribution: c.distribution ? { p10: c.distribution.p10, median: c.distribution.median, p90: c.distribution.p90 } : null,
    survival: c.survival ? { pTargetBeforeStop: c.survival.pTargetBeforeStop, calibrationStatus: c.survival.calibrationStatus } : null,
    provenance: c.provenance, calibrationStatus: 'uncalibrated' };
}

const round = x => (x == null || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
function json(res, code, obj, sMaxAge) {
  res.setHeader('Cache-Control', `s-maxage=${sMaxAge}, stale-while-revalidate=86400`);
  return res.status(code).json(obj);
}

module.exports = { runAtlasX, runAtlasXLog, runAtlasXResolve, runAtlasXWalkForward, buildAtlasBoard, assembleBoard, SECTION_ORDER, SECTION_LABELS };
