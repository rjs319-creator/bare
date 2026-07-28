'use strict';
// RLT routes — folded into api/tracker.js (no new Serverless Function). Ops:
//
//   op=rlt          build + return the shadow leadership board (READ-ONLY)
//   op=rltlog       (cron/privileged) build + persist: latest, episodes,
//                   write-once cross-section, capture, predictions, sector-state
//                   history, transition alerts, hash-chained ledger
//   op=rltresolve   (cron/privileged) append graded terminal episodes → resolved
//
// Universe, residuals, leadership, sector state, states, stages, utility and
// episodes all live in pure modules; this layer only fetches candles (cached
// full-universe first, SPY + sector ETFs cache-first with bounded live
// fallback — they are NOT in the candle cache), calls the scan, and persists.
// RLT is SHADOW/weight-0 — it cannot originate, boost, suppress or reorder a
// live trade, and op=today never reads any rlt/* artifact.

const { mapLimit } = require('./map-limit');
const { nowET, isMarketHoliday } = require('./stats');
const { fetchDailyHistory } = require('./screener');
const { loadCandleCache, cacheGet } = require('./candle-cache');
const { SECTOR_OF, SECTOR_LIST } = require('./universe');
const { benchFor } = require('./readthrough');
const STORE = require('./rlt-store');
const { VERSIONS, resolveRltMode } = require('./rlt-config');
const { runRltScan, compactLeadershipSnapshot } = require('./rlt-scan');
const { buildRltEpisodes } = require('./rlt-episodes');
const { emitRltAlerts } = require('./rlt-alerts');
const { assertShadow, modelHealth, REGISTRATION } = require('./rlt-governance');
const { NOVICE_ACTION } = require('./rlt-states');

const SCOPES = ['large', 'small', 'micro', 'expanded'];
const SCAN_CAP = 600;            // bound per-invocation compute; disclosed in coverage
const FETCH_CONCURRENCY = 4;
const MEDIAN_DV_BARS = 20;

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function capGroupFor(dollarVol) {
  if (!Number.isFinite(dollarVol)) return 'unknown';
  if (dollarVol >= 100e6) return 'large';
  if (dollarVol >= 20e6) return 'mid';
  if (dollarVol >= 2e6) return 'small';
  return 'micro';
}

// Pool row from cached candles — price, median dollar volume, cap band.
function poolRow(ticker, scope, candles) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const last = candles[candles.length - 1];
  const price = last && Number.isFinite(last.close) ? last.close : null;
  const dvs = candles.slice(-MEDIAN_DV_BARS)
    .map(c => (Number.isFinite(c.close) && Number.isFinite(c.volume) ? c.close * c.volume : null))
    .filter(Number.isFinite);
  const dollarVol = dvs.length >= 5 ? median(dvs) : null;
  const sector = SECTOR_OF[ticker] || null;
  return {
    ticker, scope, sector,
    sectorSource: sector ? 'universe-static' : null,
    sectorEtf: sector ? benchFor(sector) : null,
    price, dollarVol,
    capGroup: capGroupFor(dollarVol),
    bars: candles,
  };
}

async function loadUniverseRows() {
  const docs = {};
  await Promise.all(SCOPES.map(async s => {
    const d = await loadCandleCache(s).catch(() => null);
    if (d) docs[s] = d;
  }));
  const rows = [];
  const seen = new Set();
  for (const scope of SCOPES) {
    const doc = docs[scope];
    if (!doc || !doc.data) continue;
    for (const t of Object.keys(doc.data)) {
      if (seen.has(t)) continue;
      const g = cacheGet(doc, t);
      const row = g && Array.isArray(g.candles) ? poolRow(t, scope, g.candles) : null;
      if (row) { rows.push(row); seen.add(t); }
    }
  }
  // Deterministic cap: keep the most liquid names (ties broken by ticker).
  rows.sort((a, b) => (b.dollarVol || 0) - (a.dollarVol || 0) || (a.ticker < b.ticker ? -1 : 1));
  const capped = rows.length > SCAN_CAP;
  return { rows: rows.slice(0, SCAN_CAP), totalPool: rows.length, capped, scopes: Object.keys(docs) };
}

// SPY + the 11 sector ETFs: cache-first, live fetch fallback (they are NOT in
// the candle cache — see docs/relative-leadership-transition.md).
async function loadBenchmarks() {
  const etfs = [...new Set(['SPY', ...SECTOR_LIST.map(s => benchFor(s)).filter(Boolean)])];
  const bench = {};
  await mapLimit(etfs, FETCH_CONCURRENCY, async e => {
    const r = await fetchDailyHistory(e, '1y').catch(() => null);
    if (r && Array.isArray(r.candles) && r.candles.length) bench[e] = r.candles;
  });
  return bench;
}

function inventoryCard(e) {
  const setup = e.features && e.features.setup ? e.features.setup : {};
  return {
    ticker: e.ticker,
    company: e.company,
    sector: e.sector,
    sectorState: e.sectorState,
    state: e.state,
    stateSource: e.stateSource,
    novice: {
      action: e.novice,
      reason: e.reasonCodes.join(', ').toLowerCase().replace(/_/g, ' '),
      timeframe: 'swing (5–21 sessions)',
      trigger: setup.pivot != null ? `acceptance above ${(+setup.pivot).toFixed(2)}` : 'no trigger yet — watch',
      invalidation: setup.pivot != null && setup.atr != null
        ? `weakens below ${(setup.pivot - setup.atr).toFixed(2)}` : 'no structured invalidation yet',
      majorRisk: e.cautions.length ? e.cautions.join(', ').toLowerCase().replace(/_/g, ' ') : 'irreducible market noise',
      dataStatus: `calibration ${e.calibrationStatus}; ${e.missing.length ? `missing: ${e.missing.join(', ')}` : 'inputs complete'}`,
    },
    expert: {
      residualRank: e.residualRank,
      residualRankBand: e.residualRankBand,
      rankVel5: e.rankVel5,
      rankAccel: e.rankAccel,
      transitionRank: e.transitionRank,
      evidenceBand: e.evidenceBand,
      calibrationStatus: e.calibrationStatus,
      peerGroup: { id: e.peerGroupId, size: e.peerGroupSize, level: e.groupingLevel, fallback: e.groupingFallback },
      triggerFamily: e.triggerFamily,
      leadership: e.leadership,
      path: e.features ? e.features.path : null,
      turnover: e.features ? e.features.turnover : null,
      absorption: e.features ? e.features.absorption : null,
      setup,
      decision: e.decision,
      staleSessions: e.staleSessions,
    },
  };
}

function sectorLeadershipSummary(sectorStates) {
  if (!sectorStates || !sectorStates.states) return null;
  const entries = Object.values(sectorStates.states);
  const by = (s) => entries.filter(e => e.state === s).map(e => e.sector);
  const improving = by('IMPROVING');
  const leading = by('LEADING');
  const weakening = [...by('WEAKENING'), ...by('RISK_OFF')];
  const accel = entries.map(e => e.vector.breadthAcceleration).filter(Number.isFinite);
  const conc = entries.map(e => e.vector.leadershipConcentration).filter(Number.isFinite);
  const emerging = entries.reduce((s, e) => s + (e.vector.improvingLeaders || 0), 0);
  return {
    version: sectorStates.version,
    asOf: sectorStates.asOf,
    leading, improving, weakening,
    breadthAcceleration: accel.length ? +(accel.reduce((s, x) => s + x, 0) / accel.length).toFixed(3) : null,
    leadershipBreadth: conc.length
      ? (conc.reduce((s, x) => s + x, 0) / conc.length < 0.25 ? 'broadening' : 'narrowing') : null,
    emergingLeaderCount: emerging,
    dataFreshness: sectorStates.asOf,
    note: 'measured sector state — context, never a buy signal',
  };
}

async function buildRltBoard({ persist = false } = {}) {
  assertShadow();
  const { date, isMarketClosed } = nowET();
  const generatedAt = new Date().toISOString();
  const mode = resolveRltMode();

  const [{ rows, totalPool, capped, scopes }, bench, prevLatest, prevEpisodes, resolved] = await Promise.all([
    loadUniverseRows(),
    loadBenchmarks(),
    STORE.loadLatest().catch(() => null),
    STORE.loadEpisodes().catch(() => []),
    STORE.loadResolved().catch(() => []),
  ]);
  const spyBars = bench.SPY || [];
  const sectorBarsFor = (sector) => bench[benchFor(sector)] || [];

  const episodesByTicker = {};
  for (const ep of prevEpisodes) {
    if (ep && !ep.terminal && ep.origin && ep.origin.ticker) episodesByTicker[ep.origin.ticker] = ep;
  }

  const scan = runRltScan({
    rows, spyBars, sectorBarsFor,
    asOf: date, decisionTs: generatedAt,
    episodesByTicker,
    prevStates: (prevLatest && prevLatest.states) || {},
    mode,
    artifact: await STORE.loadCalibration().catch(() => null),
    resolvedCount: resolved.length,
  });

  // Episodes via the reused supervisor engine (rlt/* namespace).
  const priceBundle = {
    map: Object.fromEntries(rows.map(r => [r.ticker, r.bars])),
    bench,
  };
  const ctx = { date, generatedAt, isHoliday: isMarketHoliday, cooldownSessions: 3 };
  const episodeResult = buildRltEpisodes({ prevEpisodes, inventory: scan.inventory, priceBundle, ctx });

  const health = modelHealth({ resolvedEpisodes: resolved.length });
  const leadershipSnapshot = compactLeadershipSnapshot(scan);
  const cards = scan.inventory.map(inventoryCard);
  const sectorLeadership = sectorLeadershipSummary(scan.sectorStates);

  let persisted = false;
  let ledger = null;
  if (persist && !isMarketClosed && STORE.hasStore()) {
    await STORE.saveEpisodes(episodeResult.episodes);
    // Immutable prediction records: EVERY inventory entry (selected view) —
    // decision provenance, features hash inputs, model versions. Dedup by id.
    const preds = scan.inventory.map(e => ({
      predictionId: `rlt:${e.ticker}:${date}`,
      decisionTs: generatedAt,
      eligibleEntryTs: null,            // next session; stamped by the grader
      date, ticker: e.ticker, state: e.state,
      universeSnapshotId: e.universeSnapshotId,
      peerGroupId: e.peerGroupId,
      transitionRank: e.transitionRank,
      residualRank: e.residualRank,
      modelVersion: VERSIONS.stageA,
      featureVersion: VERSIONS.features,
      executionVersion: 'exec-v1',
      calibrationStatus: e.calibrationStatus,
      sectorState: e.sectorState,
      abstainReasons: e.decision.abstainReasons,
    }));
    await STORE.appendPredictions(preds).catch(() => {});
    await STORE.appendCapture({ date, observations: scan.observations, counts: scan.counts }).catch(() => {});
    await STORE.saveCrossSection(date, {
      schema: 'RltCrossSection', date, versions: VERSIONS, mode: scan.mode,
      universeSnapshotId: scan.universeSnapshotId,
      rows: scan.observations,
      transitions: scan.transitions,
    }).catch(() => {});
    await STORE.appendSectorState({
      asOf: date,
      states: Object.fromEntries(Object.entries(scan.sectorStates.states)
        .map(([k, v]) => [k, { state: v.state, vector: v.vector }])),
    }).catch(() => {});
    await emitRltAlerts(scan.transitions, Object.fromEntries(scan.inventory.map(e => [e.ticker, e])), {
      date,
      prevSectorStates: prevLatest && prevLatest.sectorStates ? prevLatest.sectorStates.states : null,
      nextSectorStates: scan.sectorStates.states,
    }).catch(() => {});
    const led = await STORE.appendLedger({
      kind: 'rlt-monitor', date, transitions: scan.transitions.length,
      inventory: scan.inventory.length, episodes: episodeResult.episodes.length,
      version: VERSIONS.scoring,
    }).catch(() => null);
    await STORE.saveHealth(health).catch(() => {});
    ledger = led ? { appended: true, seq: led.seq } : { appended: false };
    persisted = true;
  }

  const board = {
    ok: true,
    version: VERSIONS.scoring,
    generatedAt, date,
    mode: scan.mode,
    gate: scan.gate,
    governanceStatus: 'shadow',
    weight: 0,
    registration: { hypothesis: REGISTRATION.hypothesis, knownLimitations: REGISTRATION.knownLimitations },
    coverage: {
      ...scan.coverage,
      totalPool, scanCap: SCAN_CAP, capped, cacheScopes: scopes,
      benchmarks: Object.keys(bench).length,
      note: capped ? `pool of ${totalPool} capped to the ${SCAN_CAP} most liquid names (disclosed, not silent)` : null,
    },
    universeSnapshotId: scan.universeSnapshotId,
    counts: scan.counts,
    byState: scan.byState,
    inventory: cards,
    states: scan.states,
    sectorStates: scan.sectorStates,
    sectorLeadership,
    transitions: scan.transitions,
    episodes: {
      counts: episodeResult.counts,
      sections: episodeResult.sections,
      open: episodeResult.episodes.filter(e => !e.terminal).length,
    },
    graded: episodeResult.graded || [],
    leadershipSnapshot,
    health,
    honesty: 'SHADOW / weight-0. Relative strength alone is never a buy signal. No probabilities without a validated calibration artifact — transition rank + evidence band only. The system may produce no picks; abstention reasons are listed per name.',
    persisted,
    ledger,
  };
  if (persist && !isMarketClosed && STORE.hasStore()) {
    await STORE.saveLatest(board).catch(() => {});
  }
  return board;
}

function json(res, code, obj, sMaxAge) {
  if (sMaxAge) res.setHeader('Cache-Control', `s-maxage=${sMaxAge}, stale-while-revalidate=60`);
  return res.status(code).json(obj);
}

async function runRlt(req, res) {
  try {
    const board = await buildRltBoard({ persist: req.query.log === '1' });
    return json(res, 200, board, 300);
  } catch (e) {
    const cached = await STORE.loadLatest().catch(() => null);
    if (cached) return json(res, 200, { ...cached, stale: true, buildError: String((e && e.message) || e) }, 60);
    return json(res, 200, {
      ok: false, error: String((e && e.message) || e), version: VERSIONS.scoring,
      inventory: [], honesty: 'RLT build failed; no cached board available.',
    }, 30);
  }
}

async function runRltLog(req, res) {
  try {
    const board = await buildRltBoard({ persist: true });
    return json(res, 200, {
      ok: true, date: board.date, persisted: board.persisted,
      inventory: board.counts.inventory, transitions: board.transitions.length, ledger: board.ledger,
    }, 60);
  } catch (e) {
    return json(res, 200, { ok: false, error: String((e && e.message) || e) }, 30);
  }
}

// Append graded terminal episodes → resolved (grader-owned; dedup by episodeId).
async function runRltResolve(req, res) {
  try {
    const latest = await STORE.loadLatest().catch(() => null);
    const graded = (latest && latest.graded) || [];
    const rows = graded.map(g => ({
      episodeId: g.episodeId || (g.origin && g.origin.episodeId) || null,
      predictionId: g.predictionId || null,
      ...g,
    })).filter(r => r.episodeId || r.predictionId);
    const appended = rows.length ? await STORE.appendResolved(rows) : false;
    const verify = await STORE.verifyLedger().catch(() => null);
    return json(res, 200, { ok: true, graded: rows.length, appended, ledgerOk: verify ? verify.ok !== false : null }, 300);
  } catch (e) {
    return json(res, 200, { ok: false, error: String((e && e.message) || e) }, 30);
  }
}

// Purged walk-forward comparison vs the mandatory baseline ladder (EXPENSIVE).
// Runs over cached candles — survivorship-unsafe by construction, stamped so.
const WF_UNIVERSE_CAP = 150;
const WF_LABEL_WINDOW = 25;      // swing label window + holiday buffer
const WF_DATE_STEP = 5;          // weekly decision dates → less overlap
const WF_MAX_DATES = 30;

async function runRltWalkForward(req, res) {
  try {
    const { buildRltEvents, runRltComparison } = require('./rlt-research');
    const RESmod = require('./atlasx-residual');
    const [{ rows }, bench] = await Promise.all([loadUniverseRows(), loadBenchmarks()]);
    const spyBars = bench.SPY || [];
    if (!spyBars.length || !rows.length) {
      return json(res, 200, { ok: false, error: 'no cached candles or SPY history available' }, 60);
    }
    const wfRows = rows.slice(0, WF_UNIVERSE_CAP);
    const sectorBarsFor = (sector) => bench[benchFor(sector)] || [];
    const spyDates = RESmod.toBars(spyBars).map(b => b.date);
    const usable = spyDates.slice(60, Math.max(60, spyDates.length - WF_LABEL_WINDOW));
    const decisionDates = [];
    for (let i = usable.length - 1; i >= 0 && decisionDates.length < WF_MAX_DATES; i -= WF_DATE_STEP) {
      decisionDates.unshift(usable[i]);
    }
    const events = buildRltEvents({ rowsFor: () => wfRows, spyCandles: spyBars, sectorBarsFor, decisionDates });
    const comparison = runRltComparison(events, { experimentId: `rlt-wf-${decisionDates[0]}-${decisionDates[decisionDates.length - 1]}` });
    return json(res, 200, { ok: true, universe: wfRows.length, decisionDates: decisionDates.length, comparison }, 300);
  } catch (e) {
    return json(res, 200, { ok: false, error: String((e && e.message) || e) }, 30);
  }
}

module.exports = { runRlt, runRltLog, runRltResolve, runRltWalkForward, buildRltBoard, sectorLeadershipSummary, NOVICE_ACTION };
