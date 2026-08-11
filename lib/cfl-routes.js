'use strict';
// CFL ROUTES — Counterfactual Opportunity & Forecastability Lab ops.
//
//   op=cfl          public read  — summary (funnel, duds digest, integrity, state)
//   op=cflmissed    public read  — recent attributed missed winners
//   op=cflduds      public read  — graded picks (successes / duds / categories)
//   op=cfltrace     public read  — one opportunity's episode + trace + attribution
//   op=cflforecast  public read  — forecastability dispositions for the latest decision snapshot
//   op=cfltick      PRIVILEGED   — daily job: reconstruct matured checkpoints, grade duds, refresh summary
//   op=cflbackfill  PRIVILEGED   — caller-cursor resumable historical sweep (fundbuild pattern)
//
// SHADOW / weight-0: nothing here can move a live pick. Every retrospective
// artifact carries survivorshipSafe:false (candles are an as-of-today fetch).

const { fetchDailyHistory } = require('./screener');
const { loadCandleCache, cacheGet } = require('./candle-cache');
const UNIVERSE = require('./universe');
const STORE = require('./store');
const CFLSTORE = require('./cfl/store');
const CFG = require('./cfl/config');
const RECON = require('./cfl/reconstruct');
const FUNNEL = require('./cfl/funnel');
const DUDS = require('./cfl/duds');
const FORECAST = require('./cfl/forecastability');
const { logWarn } = require('./log');

const DEADLINE_MS = 45_000;
const SCOPE_LIST = Object.freeze({
  large: () => UNIVERSE.LARGE,
  small: () => UNIVERSE.SMALL_CAPS,
  micro: () => UNIVERSE.MICRO_CAPS,
  biotech: () => UNIVERSE.BIOTECH,
});

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 120) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);

// Build the replay dataset for a scope from its candle cache: Map ticker→{candles, meta}.
async function loadDataset(scope) {
  const doc = await loadCandleCache(scope);
  if (!doc) return { dataset: null, reason: 'no-candle-cache', builtDate: null };
  const listFn = SCOPE_LIST[scope];
  const tickers = listFn ? listFn() : Object.keys(doc.data || {});
  const dataset = new Map();
  for (const t of tickers) {
    const e = cacheGet(doc, t);
    if (e && e.candles && e.candles.length >= 60) dataset.set(t, { candles: e.candles, meta: e.meta });
  }
  return { dataset, reason: null, builtDate: doc.builtDate || null, universeSize: tickers.length };
}

// Replays memoized per decision date within one invocation (shared across horizons).
function replayMemo(dataset, spyCandles, scope) {
  const memo = new Map();
  const REPLAY = require('./swing-replay-v3');
  return (date) => {
    if (!memo.has(date)) memo.set(date, REPLAY.replayDate({ dataset, spyCandles, decisionDate: date, scope }));
    return memo.get(date);
  };
}

function priorCheckpointDates(spyCandles, decisionDate, n = 3, step = CFG.SWEEP.checkpointStepSessions) {
  const i = spyCandles.findIndex(b => b.date === decisionDate);
  const out = [];
  for (let k = 1; k <= n; k++) {
    const j = i - k * step;
    if (j >= 0) out.unshift(spyCandles[j].date);
  }
  return out;
}

async function reconstructOne({ dataset, spyCandles, scope, horizonKey, decisionDate, replayOf }) {
  const priors = priorCheckpointDates(spyCandles, decisionDate)
    .map(d => replayOf(d)).filter(r => r && r.ok);
  const day = RECON.reconstructCheckpoint({
    dataset, spyCandles, decisionDate, scope, horizonKey,
    priorReplays: priors, replay: replayOf(decisionDate),
  });
  if (day.ok) await CFLSTORE.writeDay(scope, horizonKey, decisionDate, day);
  return day;
}

// ── op=cfltick ────────────────────────────────────────────────────────────────
async function runCflTick(req, res) {
  noStore(res);
  const t0 = Date.now();
  if (!CFLSTORE.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store' });
  const scope = String(req.query.scope || 'large');
  if (!SCOPE_LIST[scope]) return res.status(400).json({ ok: false, error: `unknown scope ${scope}` });
  const force = req.query.force === '1';

  const spy = await fetchDailyHistory('SPY', '2y');
  if (!spy || !spy.candles || spy.candles.length < 200) {
    return res.status(503).json({ ok: false, error: 'benchmark candles unavailable', elapsedMs: Date.now() - t0 });
  }
  const spyCandles = spy.candles;
  const { dataset, reason, builtDate } = await loadDataset(scope);
  if (!dataset || !dataset.size) {
    return res.status(200).json({ ok: false, reason: reason || 'empty-dataset', elapsedMs: Date.now() - t0 });
  }

  const replayOf = replayMemo(dataset, spyCandles, scope);
  const processed = [], skipped = [];
  for (const horizonKey of CFG.SUPPORTED_HORIZONS) {
    if (Date.now() - t0 > DEADLINE_MS) { skipped.push({ horizon: horizonKey, reason: 'budget' }); continue; }
    const h = CFG.HORIZONS[horizonKey];
    const idx = spyCandles.length - 1 - h.sessions - 1;   // latest checkpoint whose label matured
    if (idx < 60) { skipped.push({ horizon: horizonKey, reason: 'axis-too-short' }); continue; }
    const decisionDate = spyCandles[idx].date;
    if (!force && await CFLSTORE.readDay(scope, horizonKey, decisionDate)) {
      skipped.push({ horizon: horizonKey, decisionDate, reason: 'already-built' });
      continue;
    }
    try {
      const day = await reconstructOne({ dataset, spyCandles, scope, horizonKey, decisionDate, replayOf });
      processed.push({ horizon: horizonKey, decisionDate, ok: day.ok, episodes: day.episodes ? day.episodes.length : 0, opportunities: day.opportunities || 0, missed: day.missed ? day.missed.length : 0, truncated: !!day.truncated });
    } catch (e) {
      logWarn('cfl.tick', 'reconstruction failed', { scope, horizonKey, decisionDate, error: e.message });
      processed.push({ horizon: horizonKey, decisionDate, ok: false, error: e.message });
    }
  }

  // Dud grading over the picks ledger (first-appearance dedup; bounded).
  let dudDigest = null;
  if (Date.now() - t0 < DEADLINE_MS) {
    try {
      const all = await STORE.readAllPicks();
      const picks = all.flatMap(d => (d.picks || []))
        .filter(p => p.section === 'screener' || p.section === 'EmergingLeader')
        .filter(p => p.entry > 0);
      const graded = DUDS.gradeDuds({
        picks, spyCandles,
        histOf: (t) => { const e = dataset.get(t); return e ? e.candles : null; },
        deadline: t0 + DEADLINE_MS, now: Date.now,
      });
      await CFLSTORE.writeDuds({ version: CFG.CFL_VERSION, scope, ...graded });
      dudDigest = { graded: graded.graded, counts: graded.counts, truncated: graded.truncated };
    } catch (e) {
      logWarn('cfl.tick', 'dud grading failed', { error: e.message });
      dudDigest = { error: e.message };
    }
  } else skipped.push({ step: 'duds', reason: 'budget' });

  // Funnel + summary refresh from the accumulated day docs.
  const funnels = {};
  for (const horizonKey of CFG.SUPPORTED_HORIZONS) {
    const { days, unreadable } = await CFLSTORE.readRecentDays(scope, horizonKey, 40);
    funnels[horizonKey] = { ...FUNNEL.computeFunnel(days), unreadableShards: unreadable };
  }
  const summary = {
    version: CFG.CFL_VERSION, scope, generatedAt: new Date().toISOString(),
    funnels, duds: dudDigest,
    integrity: {
      survivorshipSafe: false, adjustmentBasis: 'as-of-fetch', macroPIT: false,
      candleCacheBuiltDate: builtDate, datasetSize: dataset.size,
      alertLayer: 'absent-for-swing-lane',
      intradayHorizon: CFG.HORIZONS.intraday.delegatedTo,
    },
  };
  await CFLSTORE.writeSummary(summary);
  const prevState = (await CFLSTORE.readState()) || {};
  await CFLSTORE.writeState({ ...prevState, lastTick: { at: new Date().toISOString(), scope, processed, skipped } });
  return res.status(200).json({ ok: true, scope, processed, skipped, duds: dudDigest, elapsedMs: Date.now() - t0 });
}

// ── op=cflbackfill (caller-cursor, fundbuild pattern) ─────────────────────────
async function runCflBackfill(req, res) {
  noStore(res);
  const t0 = Date.now();
  if (!CFLSTORE.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store' });
  const scope = String(req.query.scope || 'large');
  if (!SCOPE_LIST[scope]) return res.status(400).json({ ok: false, error: `unknown scope ${scope}` });
  const horizonKey = String(req.query.horizon || 'h21');
  if (!CFG.SUPPORTED_HORIZONS.includes(horizonKey)) {
    return res.status(400).json({ ok: false, error: `unsupported horizon ${horizonKey} (intraday is delegated to large-mover-audit)` });
  }
  const start = Math.max(0, parseInt(req.query.start, 10) || 0);
  const limit = Math.min(12, Math.max(1, parseInt(req.query.limit, 10) || 6));
  const force = req.query.force === '1';

  const spy = await fetchDailyHistory('SPY', '2y');
  if (!spy || !spy.candles || spy.candles.length < 200) {
    return res.status(503).json({ ok: false, error: 'benchmark candles unavailable', elapsedMs: Date.now() - t0 });
  }
  const spyCandles = spy.candles;
  const { dataset, reason } = await loadDataset(scope);
  if (!dataset || !dataset.size) return res.status(200).json({ ok: false, reason: reason || 'empty-dataset' });

  const checkpoints = RECON.buildCheckpoints({
    spyCandles, horizonSessions: CFG.HORIZONS[horizonKey].sessions, maxCheckpoints: 80,
  });
  if (start >= checkpoints.length) {
    return res.status(200).json({ ok: true, scope, horizon: horizonKey, processed: 0, nextStart: null, done: true, totalCheckpoints: checkpoints.length });
  }
  const replayOf = replayMemo(dataset, spyCandles, scope);
  const processed = [];
  let i = start, truncated = false;
  for (; i < Math.min(checkpoints.length, start + limit); i++) {
    if (Date.now() - t0 > DEADLINE_MS) { truncated = true; break; }
    const decisionDate = checkpoints[i];
    if (!force && await CFLSTORE.readDay(scope, horizonKey, decisionDate)) {
      processed.push({ decisionDate, skipped: 'already-built' });
      continue;
    }
    const day = await reconstructOne({ dataset, spyCandles, scope, horizonKey, decisionDate, replayOf });
    processed.push({ decisionDate, ok: day.ok, episodes: day.episodes ? day.episodes.length : 0, missed: day.missed ? day.missed.length : 0 });
  }
  const done = i >= checkpoints.length && !truncated;
  const prevState = (await CFLSTORE.readState()) || {};
  await CFLSTORE.writeState({
    ...prevState,
    backfill: { ...(prevState.backfill || {}), [`${scope}-${horizonKey}`]: { nextStart: done ? null : i, totalCheckpoints: checkpoints.length, at: new Date().toISOString() } },
  });
  return res.status(200).json({
    ok: true, scope, horizon: horizonKey,
    processed: processed.length, detail: processed,
    nextStart: done ? null : i, done, truncated,
    totalCheckpoints: checkpoints.length, elapsedMs: Date.now() - t0,
  });
}

// ── public reads ──────────────────────────────────────────────────────────────
async function runCflSummary(req, res) {
  cached(res, 120);
  const [summary, state] = await Promise.all([CFLSTORE.readSummary(), CFLSTORE.readState()]);
  if (!summary) return res.status(200).json({ ok: false, reason: 'not-built-yet', hint: 'run op=cfltick (privileged) or wait for the nightly chain' });
  return res.status(200).json({ ok: true, ...summary, state: state || null });
}

async function runCflMissed(req, res) {
  cached(res, 120);
  const scope = String(req.query.scope || 'large');
  const horizonKey = String(req.query.horizon || 'h21');
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const { days, unreadable } = await CFLSTORE.readRecentDays(scope, horizonKey, 30);
  const rows = days.flatMap(d => (d.missed || []).map(m => ({
    symbol: m.episode.symbol, checkpointDate: m.episode.checkpointDate, horizon: horizonKey,
    excessReturn: m.episode.excessReturn, mfe: m.episode.mfe, outcome: m.episode.outcome,
    gapClass: m.episode.gap ? m.episode.gap.class : null,
    executable: m.episode.crossSection ? m.episode.crossSection.executable : null,
    primaryFailure: m.attribution.primaryFailure,
    secondaryFailures: m.attribution.secondaryFailures,
    preventable: m.attribution.preventable,
    confidence: m.attribution.confidence,
    warningSessions: m.trace ? m.trace.warningSessions : null,
    firstDetectionDate: m.trace ? m.trace.firstDetectionDate : null,
    highestRankBeforeMove: m.trace ? m.trace.highestRankBeforeMove : null,
    opportunityId: m.episode.opportunityId,
  })));
  rows.sort((a, b) => (b.excessReturn || 0) - (a.excessReturn || 0));
  return res.status(200).json({
    ok: true, scope, horizon: horizonKey, n: rows.length, rows: rows.slice(0, limit),
    unreadableShards: unreadable, daysCovered: days.length,
    dataQuality: { survivorshipSafe: false, macroPIT: false },
  });
}

async function runCflDuds(req, res) {
  cached(res, 120);
  const doc = await CFLSTORE.readDuds();
  if (!doc) return res.status(200).json({ ok: false, reason: 'not-built-yet' });
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 40));
  const duds = (doc.rows || []).filter(r => r.status === 'dud').slice(0, limit);
  return res.status(200).json({
    ok: true, graded: doc.graded, counts: doc.counts, byCategory: doc.byCategory,
    rows: duds, truncated: doc.truncated, savedAt: doc.savedAt,
  });
}

async function runCflTrace(req, res) {
  cached(res, 300);
  const scope = String(req.query.scope || 'large');
  const horizonKey = String(req.query.horizon || 'h21');
  const symbol = String(req.query.symbol || '').toUpperCase();
  const date = String(req.query.date || '');
  if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: 'symbol and date (YYYY-MM-DD checkpoint) required' });
  }
  const day = await CFLSTORE.readDay(scope, horizonKey, date);
  if (!day) return res.status(200).json({ ok: false, reason: 'no-day-doc', scope, horizon: horizonKey, date });
  const miss = (day.missed || []).find(m => m.episode.symbol === symbol) || null;
  const episode = miss ? miss.episode : (day.episodes || []).find(e => e.symbol === symbol) || null;
  if (!episode) return res.status(200).json({ ok: false, reason: 'symbol-not-in-day', scope, horizon: horizonKey, date });
  return res.status(200).json({
    ok: true, episode, trace: miss ? miss.trace : null, attribution: miss ? miss.attribution : null,
    replaySummary: day.replaySummary || null,
  });
}

async function runCflForecast(req, res) {
  cached(res, 120);
  const scope = String(req.query.scope || 'large');
  let date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  let snapshot = null;
  if (date) snapshot = await CFLSTORE.readDecision(scope, date);
  else {
    for (let back = 0; back < 6 && !snapshot; back++) {
      const d = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
      snapshot = await CFLSTORE.readDecision(scope, d);
      if (snapshot) date = d;
    }
  }
  if (!snapshot) return res.status(200).json({ ok: false, reason: 'no-decision-snapshot', hint: 'snapshots are captured by the warm screener run' });
  const summary = await CFLSTORE.readSummary();
  const maturedByH = {};
  for (const h of CFG.SUPPORTED_HORIZONS) {
    maturedByH[h] = summary && summary.funnels && summary.funnels[h] ? (summary.funnels[h].matured || 0) : 0;
  }
  const cohort = (snapshot.names || []).filter(n => n.factors);
  const cohortStats = {};
  for (const key of ['mom63', 'vol']) {
    const xs = cohort.map(n => n.factors[key]).filter(Number.isFinite);
    if (xs.length >= 10) {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
      if (sd > 0) cohortStats[key] = { mean, sd };
    }
  }
  const rows = (snapshot.names || [])
    .filter(n => n.status === 'selected')
    .map(n => {
      const f = FORECAST.assessForecastability({
        analogueCount: maturedByH.h21,
        calibrationBinN: null,
        features: n.factors || {},
        cohortStats,
        missing: n.missing || [],
        freshnessClass: 'current',
        liquidityOk: !n.factors || !Number.isFinite(n.factors.dollarVol) ? true : n.factors.dollarVol >= CFG.CROSS_SECTION.minDollarVol,
        providerHealthy: true,
      });
      return { symbol: n.symbol, rank: n.rank, score: n.score, ...f };
    });
  const byDisposition = rows.reduce((m, r) => { m[r.disposition] = (m[r.disposition] || 0) + 1; return m; }, {});
  return res.status(200).json({
    ok: true, scope, date, n: rows.length, byDisposition, rows,
    note: 'evidence-based dispositions; probabilities are withheld until a calibrator has support (NO_CALIBRATOR is expected while the episode ledger matures)',
  });
}

module.exports = { runCflTick, runCflBackfill, runCflSummary, runCflMissed, runCflDuds, runCflTrace, runCflForecast };
