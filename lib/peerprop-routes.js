'use strict';
// 🕸 PEER PROPAGATION routes — folded into api/tracker.js (no new Serverless Function).
//
//   op=peerprop     build + return the shadow propagation board (READ-ONLY; falls
//                   back to the cached latest on build failure)
//   op=peerproplog  (cron/privileged) build + persist latest + append today's
//                   EARLY/CONFIRMING candidates to the pick ledger (write-once/day)
//   op=peerpropwf   (expensive, rate-limited) purged walk-forward over the cached
//                   candle pool, comparing the propagation score against baselines
//                   AND its own falsifications (reversed edges, random peers)
//
// SHADOW/weight-0 everywhere: nothing here can originate, boost, suppress or
// reorder a live trade. op=today never reads any peerprop/* artifact.

const { nowET } = require('./stats');
const S = require('./store');
const { loadUniverseRows, loadBenchmarks } = require('./rlt-routes');
const { runPeerPropagation, buildResidualPanel } = require('./peerprop/engine');
const { buildDirectedGraph, reverseGraph } = require('./peerprop/graph');
const { stockPeerFeatures } = require('./peerprop/features');
const { VERSIONS, GRAPH_POLICY, STORE, SECTION } = require('./peerprop/config');
const { forecastNextSession } = require('./volume-forecast');
const { benchFor } = require('./readthrough');
const { costBreakdown } = require('./costs');
const { windowReturn } = require('./research/grade');
const { runExperiment, lcg } = require('./research/harness');
const { randomRanker, residualMomentumRanker } = require('./research/baseline-ranker');

const LIVE_SCAN_CAP = 400;      // most-liquid names scanned by the live board
const WF_UNIVERSE_CAP = 100;    // walk-forward cross-section width
const WF_DATE_STEP = 10;        // sessions between walk-forward decision dates
const WF_HORIZON_BARS = 21;     // forward window for the outcome label
const WF_GRAPH_POLICY = { ...GRAPH_POLICY, maxGroupSize: 30, window: 120 };
const LOG_STAGES = new Set(['EARLY', 'CONFIRMING']);
const LOG_MIN_QUALITY = 0.6;

function json(res, code, obj, sMaxAge) {
  if (sMaxAge) res.setHeader('Cache-Control', `s-maxage=${sMaxAge}, stale-while-revalidate=60`);
  return res.status(code).json(obj);
}

const bandToCostTier = band => (band === 'large' || band === 'mid') ? 'liquid' : band === 'small' ? 'small' : 'micro';

// ── Build the live board ─────────────────────────────────────────────────────
async function buildBoard() {
  const { date } = nowET();
  const decisionTs = new Date().toISOString();
  const { rows, totalPool, capped } = await loadUniverseRows();
  rows.sort((a, b) => (b.dollarVol || 0) - (a.dollarVol || 0) || (a.ticker < b.ticker ? -1 : 1));
  const pool = rows.slice(0, LIVE_SCAN_CAP);
  const bench = await loadBenchmarks();
  const spyBars = bench.SPY || [];
  if (!spyBars.length) throw new Error('SPY benchmark unavailable — residualization impossible');
  const sectorBarsFor = sector => { const etf = benchFor(sector); return etf && bench[etf] ? bench[etf] : null; };

  const snap = runPeerPropagation({ rows: pool, spyBars, sectorBarsFor, asOf: date, decisionTs });

  // Volume/capacity forecast annotation for the top of the board — execution
  // context only, never a rank input (see lib/volume-forecast.js header).
  const barsOf = new Map(pool.map(r => [r.ticker, r.bars]));
  const top = snap.candidates.slice(0, 40).map(c => ({
    ...c,
    volumeForecast: forecastNextSession(barsOf.get(c.ticker) || [], {}),
  }));

  return {
    ...snap,
    date,
    candidates: top,
    candidatesTotal: snap.candidates.length,
    pool: { totalPool, scanned: pool.length, capped: capped || pool.length < rows.length },
    shadow: true,
    honesty: 'Shadow research engine. Scores are heuristic ranks, not probabilities; probabilities unlock only after out-of-fold calibration on matured outcomes.',
  };
}

async function runPeerProp(req, res) {
  try {
    const board = await buildBoard();
    return json(res, 200, board, 300);
  } catch (e) {
    const cached = await S.readJSON(STORE.latest, null).catch(() => null);
    if (cached) return json(res, 200, { ...cached, stale: true, buildError: String((e && e.message) || e) }, 60);
    return json(res, 200, { ok: false, error: String((e && e.message) || e), version: VERSIONS.engine, candidates: [] }, 30);
  }
}

// Cron writer: persist latest + append today's candidates to the pick ledger.
// Write-once per day (immutable decision snapshots — re-runs never rewrite).
async function runPeerPropLog(req, res) {
  try {
    const { date, isMarketClosed } = nowET();
    if (isMarketClosed) return json(res, 200, { ok: true, skipped: 'market-closed', date });
    const board = await buildBoard();
    await S.writeJSON(STORE.latest, board, 0);

    const existing = await S.readJSON(`${STORE.ledgerPrefix}${date}.json`, null).catch(() => null);
    if (existing) return json(res, 200, { ok: true, date, persisted: false, reason: 'already-recorded', picks: (existing.picks || []).length });

    const picks = board.candidates
      .filter(c => LOG_STAGES.has(c.stage) && c.dataQuality >= LOG_MIN_QUALITY && Number.isFinite(c.price))
      .map(c => ({
        date, ts: new Date().toISOString(),
        ticker: c.ticker, section: SECTION, tier: c.stage,
        scope: c.band === 'large' || c.band === 'mid' ? 'large' : c.band,
        sector: c.sector, bench: c.sectorEtf || null,
        entry: c.price, score: c.score, signalVersion: VERSIONS.engine,
      }));
    await S.writePeerPropDay(date, { picks, snapshotId: board.snapshotId, version: VERSIONS.engine });
    return json(res, 200, { ok: true, date, persisted: true, picks: picks.length });
  } catch (e) {
    return json(res, 200, { ok: false, error: String((e && e.message) || e) }, 30);
  }
}

// ── Walk-forward + falsifications ────────────────────────────────────────────
// Deterministic group permutation for the random-peers control: same group SIZES,
// memberships shuffled by a seeded LCG — economically meaningless peers.
function permuteGroups(groups, seed = 777) {
  const rnd = lcg(seed);
  const tickers = Object.values(groups).flat();
  const shuffled = tickers.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const out = {}; let k = 0;
  for (const [gid, members] of Object.entries(groups)) { out[gid] = shuffled.slice(k, k + members.length); k += members.length; }
  return out;
}

function scoreVariant({ panel, groups, graph, featureKey, events }) {
  const membersOf = new Map();
  for (const [gid, members] of Object.entries(groups)) for (const t of members) membersOf.set(t, members);
  for (const ev of events) {
    const own = panel.seriesByTicker[ev.ticker];
    if (!own) continue;
    const groupTickers = (membersOf.get(ev.ticker) || []).filter(t => t !== ev.ticker);
    const groupSeries = groupTickers.map(t => panel.seriesByTicker[t]).filter(Boolean);
    const f = stockPeerFeatures({ ticker: ev.ticker, ownSeries: own, groupSeries, graph, seriesByTicker: panel.seriesByTicker });
    ev.features[featureKey] = f.score;
  }
}

async function runPeerPropWalkforward(req, res) {
  try {
    // cached=1: serve the last persisted report without recomputing — the Lab panel
    // uses this so merely opening the tab never triggers the heavy walk-forward.
    if (req.query.cached === '1') {
      const cached = await S.readJSON('peerprop/walkforward.json', null).catch(() => null);
      return json(res, 200, cached || { ok: false, reason: 'no-cached-walkforward — run op=peerpropwf explicitly' }, 300);
    }
    const t0 = Date.now();
    const { rows } = await loadUniverseRows();
    rows.sort((a, b) => (b.dollarVol || 0) - (a.dollarVol || 0) || (a.ticker < b.ticker ? -1 : 1));
    const pool = rows.slice(0, Math.min(WF_UNIVERSE_CAP, Number(req.query.limit) || WF_UNIVERSE_CAP));
    const bench = await loadBenchmarks();
    const spyBars = bench.SPY || [];
    if (!spyBars.length) return json(res, 200, { ok: false, error: 'SPY benchmark unavailable' }, 30);
    const sectorBarsFor = sector => { const etf = benchFor(sector); return etf && bench[etf] ? bench[etf] : null; };

    // Decision dates from the SPY calendar: leave room for warm-up history and
    // the forward label window (+1 entry bar).
    const RES = require('./atlasx-residual');
    const spy = RES.toBars(spyBars);
    const dates = spy.map(b => b.date);
    const firstIdx = 130, lastIdx = dates.length - (WF_HORIZON_BARS + 2);
    const decisionDates = [];
    for (let i = firstIdx; i <= lastIdx; i += WF_DATE_STEP) decisionDates.push(dates[i]);
    if (decisionDates.length < 6) return json(res, 200, { ok: false, error: `too few decision dates (${decisionDates.length}) in cached window` }, 30);

    const barsOf = new Map(pool.map(r => [r.ticker, RES.toBars(r.bars)]));
    const sectorEtfOf = new Map(pool.map(r => [r.ticker, r.sectorEtf]));
    const bandOf = new Map(pool.map(r => [r.ticker, r.capGroup]));

    const events = [];
    for (const asOf of decisionDates) {
      const panel = buildResidualPanel({ rows: pool, spyBars, sectorBarsFor, asOf, decisionTs: `${asOf}T21:00:00.000Z`, graphPolicy: WF_GRAPH_POLICY });
      const graph = buildDirectedGraph({ seriesByTicker: panel.seriesByTicker, groups: panel.universe.groups, rankOf: panel.rankOf, policy: WF_GRAPH_POLICY });

      // Outcome: next-open entry after asOf, close 21 bars later, minus tier
      // costs, minus the sector (fallback SPY) ETF's same-window return.
      const dateEvents = [];
      for (const ticker of Object.keys(panel.seriesByTicker)) {
        const bars = barsOf.get(ticker);
        if (!bars) continue;
        let sigIdx = -1;
        for (let i = bars.length - 1; i >= 0; i--) if (bars[i].date <= asOf) { sigIdx = i; break; }
        const entryBar = bars[sigIdx + 1], exitBar = bars[sigIdx + 1 + WF_HORIZON_BARS];
        if (!entryBar || !exitBar || !(entryBar.o > 0) || !(exitBar.c > 0)) continue;
        const grossPct = (exitBar.c - entryBar.o) / entryBar.o * 100;
        const costs = costBreakdown(bandToCostTier(bandOf.get(ticker)), { side: 'long', holdSessions: WF_HORIZON_BARS }).totalPct;
        const etf = sectorEtfOf.get(ticker);
        const benchCandles = (etf && bench[etf]) || spyBars;
        const benchRet = windowReturn(benchCandles, entryBar.date, exitBar.date);
        if (!Number.isFinite(benchRet)) continue;
        const outcome = +(grossPct - costs - benchRet).toFixed(3);
        dateEvents.push({
          securityId: ticker, ticker,
          decisionTs: asOf, labelEndDate: exitBar.date, horizon: WF_HORIZON_BARS,
          features: {}, score: null, outcome, won: outcome > 0,
        });
      }

      // Fill scores: real graph, reversed edges, random peers, residual momentum.
      scoreVariant({ panel, groups: panel.universe.groups, graph, featureKey: 'ppScore', events: dateEvents });
      scoreVariant({ panel, groups: panel.universe.groups, graph: reverseGraph(graph), featureKey: 'ppScoreReversed', events: dateEvents });
      const permGroups = permuteGroups(panel.universe.groups);
      const permGraph = buildDirectedGraph({ seriesByTicker: panel.seriesByTicker, groups: permGroups, rankOf: panel.rankOf, policy: WF_GRAPH_POLICY });
      scoreVariant({ panel, groups: permGroups, graph: permGraph, featureKey: 'ppScoreRandomPeers', events: dateEvents });
      for (const ev of dateEvents) {
        const s = panel.seriesByTicker[ev.ticker] || [];
        let mom = 0, ok = s.length >= 21;
        for (let i = s.length - 21; ok && i < s.length; i++) { if (!Number.isFinite(s[i].residual)) ok = false; else mom += s[i].residual; }
        ev.features.residMom21 = ok ? mom : null;
      }
      events.push(...dateEvents);
    }

    const passthrough = key => ({ name: key === 'ppScore' ? 'peer-propagation' : key === 'ppScoreReversed' ? 'peerprop-reversed-edges' : 'peerprop-random-peers',
      fit: () => null, score: (_m, row) => (Number.isFinite(row.features[key]) ? row.features[key] : 0) });
    const rankers = [randomRanker, residualMomentumRanker, passthrough('ppScore'), passthrough('ppScoreReversed'), passthrough('ppScoreRandomPeers')];

    const exp = runExperiment(events, rankers, { folds: 4, embargo: 5 }, {
      experimentId: 'peerprop-wf-v1',
      experimentFamilyId: 'peer-propagation',
      datasetHash: `${events.length}|${decisionDates[0]}..${decisionDates[decisionDates.length - 1]}`,
      primaryMetric: 'mean-daily-rank-IC (OOS, purged) vs residual-momentum + falsifications',
      survivorshipSafe: false,
      relatedExperimentsAttempted: rankers.length,
    });

    const ic = name => (exp.result.perRanker[name] && exp.result.perRanker[name].meanIC != null) ? exp.result.perRanker[name].meanIC : null;
    const pp = ic('peer-propagation'), rev = ic('peerprop-reversed-edges'), rand = ic('peerprop-random-peers'), rm = ic('residual-momentum'), ctl = ic('control-random');
    const falsification = {
      reversedEdgesWeaker: pp != null && rev != null ? pp > rev : null,
      randomPeersWeaker: pp != null && rand != null ? pp > rand : null,
      beatsResidualMomentum: pp != null && rm != null ? pp > rm : null,
      beatsRandomControl: pp != null && ctl != null ? pp > ctl : null,
    };
    const passes = Object.values(falsification).every(v => v === true);
    const payload = {
      ok: true, version: VERSIONS.engine, tookMs: Date.now() - t0,
      universe: pool.length, decisionDates: decisionDates.length, events: events.length,
      experiment: exp, falsification,
      verdict: passes
        ? 'PROVISIONAL PASS — directional structure present but survivorship-unsafe; shadow accrual continues'
        : 'NO VALIDATED INCREMENTAL EDGE — propagation score does not beat baselines/falsifications out-of-sample',
    };
    try { await S.writeJSON('peerprop/walkforward.json', payload, 0); } catch { /* cache is best-effort */ }
    return json(res, 200, payload, 600);
  } catch (e) {
    return json(res, 200, { ok: false, error: String((e && e.message) || e) }, 30);
  }
}

module.exports = { runPeerProp, runPeerPropLog, runPeerPropWalkforward, buildBoard, permuteGroups };
