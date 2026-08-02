'use strict';
// op=researchgrade — grade stored decision snapshots into outcome batches.
//
// Walks back over recent decision dates, grades every prediction whose holding period
// has fully elapsed, and writes an OutcomeBatch alongside (never over) the decisions.
//
// Deliberately CONSERVATIVE about work per invocation: it grades the oldest ungraded
// day first and stops at a bounded number of days, because this runs inside a 60s
// serverless budget behind a warm cron that already does a great deal. A partial pass
// is fine — the next run continues, and nothing is lost.
//
// Idempotent: re-grading a day recomputes from immutable inputs and produces the same
// outcomes, so a retry is always safe.

const { fetchDailyHistory } = require('./screener');
const { nowET } = require('./stats');
const { hasStore } = require('./store');
const { loadCandleCache, cacheGet } = require('./candle-cache');
const RS = require('./research/store');
const G = require('./research/grade');
const MH = require('./research/multi-horizon');
const { SECTOR_OF } = require('./universe');           // ticker → GICS sector
const { benchFor } = require('./readthrough');         // GICS sector → SPDR sector ETF

const MAX_DAYS_PER_RUN = 3;      // bounded work per invocation (60s function budget)
// COVERAGE FIX: the old MAX_TICKERS=120 cap dropped a DETERMINISTIC tail of every
// ~200-280-name decision day — the same ~half of predictions graded `no-candles` on
// every re-grade forever ("the rest grade on the next pass" never happened, because
// the slice was stable). Candles are now CACHE-FIRST (one Blob read covers the whole
// pooled universe at zero Yahoo fan-out), so the per-day cap can be generous; only
// cache MISSES spend the live-fetch budget, and that budget ROTATES by grading day so
// a stubborn miss still gets its turn. Previously-graded vectors are merge-protected
// (see mergeOutcomeBatches/mergeHorizonBatches) so a lean pass can never downgrade
// a filled vector back to `no-candles`.
const MAX_TICKERS = 400;
const LIVE_FETCH_CAP = 40;       // per-day Yahoo fetches for cache misses
const CACHE_SCOPES = ['large', 'small', 'micro', 'biotech', 'expanded'];
const BENCH = 'SPY';
const HISTORY_RANGE = '1y';

// A prediction's ticker → its SPDR sector ETF (or null when the sector is unknown), reusing
// the canonical maps the rest of the app grades against (apex/CERN/evolve). This is what
// upgrades the residual from market-relative (SPY only) to sector-relative.
const sectorEtfFor = ticker => benchFor(SECTOR_OF[ticker]) || null;
// Soft deadline, under the 60s function wall. Up to 3 days x 120 candle fetches is
// genuinely slow against a rate-limited feed, and a hard kill is a 504 that writes NO
// outcomes at all — losing even the days already graded in this pass. Stopping early
// and NAMING the skip keeps partial progress and makes chronic starvation visible,
// which is the same principle lib/warm-chains.js was rebuilt around.
const RUN_DEADLINE_MS = 40000;

// fetchDailyHistory returns { candles, meta, ... } — the grader wants the bare candle ARRAY.
// Passing the wrapper object straight through makes Array.isArray(candles) false, so EVERY
// prediction pends as `no-candles` and nothing ever grades. Unwrap here, once.
const candlesOf = r => (r && Array.isArray(r.candles) ? r.candles : (Array.isArray(r) ? r : null));

// Fetch candles for a set of tickers with bounded concurrency.
async function fetchAll(tickers, concurrency = 6) {
  const out = new Map();
  const queue = [...tickers];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      try { out.set(t, candlesOf(await fetchDailyHistory(t, HISTORY_RANGE))); }
      catch { out.set(t, null); }     // a dead ticker grades as unfilled, not as a crash
    }
  });
  await Promise.all(workers);
  return out;
}

// One Blob read per scope per RUN; per-ticker candle resolution against the pool.
async function loadCandlePool() {
  const docs = [];
  await Promise.all(CACHE_SCOPES.map(async s => {
    const d = await loadCandleCache(s).catch(() => null);
    if (d) docs.push(d);
  }));
  return t => {
    for (const doc of docs) {
      const g = cacheGet(doc, t);
      if (g && Array.isArray(g.candles) && g.candles.length) return g.candles;
    }
    return null;
  };
}

// Deterministic per-grading-day rotation of the live-fetch budget over cache misses,
// so with more misses than budget every name still gets a turn across passes.
function rotateMisses(misses, asOf, cap) {
  if (misses.length <= cap) return misses;
  const sorted = misses.slice().sort();
  const offset = Math.floor(new Date(asOf + 'T00:00:00Z').getTime() / 86400000) % sorted.length;
  return sorted.slice(offset).concat(sorted.slice(0, offset)).slice(0, cap);
}

// ── Merge protection: a re-grade may IMPROVE a prediction's record, never lose it ──
// A pass without candles for a ticker produces pending:'no-candles' (single-horizon)
// or an unfilled vector (term structure). If a PRIOR pass graded that prediction from
// real candles, the prior result is kept — grading is monotone per prediction.
function mergeOutcomeBatches(prev, next) {
  if (!prev || !Array.isArray(prev.outcomes) || !prev.outcomes.length) return { batch: next, keptFromPrior: 0 };
  const nextGraded = new Set(next.outcomes.map(o => o.predictionId));
  const rescued = prev.outcomes.filter(o => !nextGraded.has(o.predictionId)
    && next.pending.some(p => p.predictionId === o.predictionId && p.reason === 'no-candles'));
  if (!rescued.length) return { batch: next, keptFromPrior: 0 };
  const rescuedIds = new Set(rescued.map(o => o.predictionId));
  const outcomes = [...next.outcomes, ...rescued];
  const pending = next.pending.filter(p => !rescuedIds.has(p.predictionId));
  const filled = outcomes.filter(o => o.fillStatus === 'filled');
  return {
    keptFromPrior: rescued.length,
    batch: Object.freeze({
      ...next,
      nGraded: outcomes.length, nFilled: filled.length,
      nUnfilled: outcomes.length - filled.length, nPending: pending.length,
      outcomes: Object.freeze(outcomes), pending: Object.freeze(pending),
    }),
  };
}

function mergeHorizonBatches(prev, next) {
  if (!prev || !Array.isArray(prev.vectors) || !prev.vectors.length) return { batch: next, keptFromPrior: 0 };
  const prevById = new Map(prev.vectors.map(v => [v.predictionId, v]));
  let kept = 0;
  const vectors = next.vectors.map(v => {
    const noCandles = v.fillStatus === 'unfilled' && (v.horizons || []).some(h => h && h.reason === 'no-candles');
    const old = prevById.get(v.predictionId);
    if (noCandles && old && old.fillStatus === 'filled') { kept++; return old; }
    return v;
  });
  if (!kept) return { batch: next, keptFromPrior: 0 };
  const filled = vectors.filter(v => v.fillStatus === 'filled');
  const resolvedByBar = {};
  for (const bars of next.ladder || []) {
    resolvedByBar[bars] = filled.reduce((n, v) => n + (v.horizons.some(h => h.bars === bars && h.status === 'resolved') ? 1 : 0), 0);
  }
  return {
    keptFromPrior: kept,
    batch: Object.freeze({
      ...next,
      nFilled: filled.length, nUnfilled: vectors.length - filled.length,
      resolvedByBar: Object.freeze(resolvedByBar),
      vectors: Object.freeze(vectors),
    }),
  };
}

// Any horizon rung still pending on a filled vector? The 63-session rung stays open long
// after the single-horizon swing grade is complete, so this keeps a day in scope until the
// FULL term structure has come due.
function horizonBatchHasPending(batch) {
  if (!batch || !Array.isArray(batch.vectors)) return false;
  return batch.vectors.some(v => v.fillStatus === 'filled' && (v.horizons || []).some(h => h.status === 'pending'));
}

// Which recent dates have a decision snapshot but no complete grading yet?
async function findUngradedDates(asOf, lookbackDays) {
  const dates = RS.recentDates(asOf, lookbackDays);
  const todo = [];
  for (const d of dates) {
    if (d === asOf) continue;                       // today's horizon cannot have elapsed
    const snap = await RS.loadDecisionSnapshot(d);
    if (!snap) continue;
    const graded = await RS.loadOutcomes(d);
    const horizonGraded = await RS.loadHorizonOutcomes(d);
    // Re-grade when EITHER the single-horizon grade or any term-structure rung is still
    // pending — their labels may have since elapsed.
    const stale = !graded || (graded.nPending || 0) > 0 || !horizonGraded || horizonBatchHasPending(horizonGraded);
    if (stale) todo.push({ date: d, snap, graded, horizonGraded });
    if (todo.length >= MAX_DAYS_PER_RUN) break;
  }
  return todo.reverse();                            // oldest first: they resolve first
}

async function runResearchGrade(req, res) {
  if (!hasStore()) {
    return res.status(200).json({ ok: false, configured: false, note: 'Blob storage not configured — nothing to grade.' });
  }
  const asOf = nowET().date;
  const lookback = Math.min(Number(req.query.days) || 90, 365);

  let todo;
  try { todo = await findUngradedDates(asOf, lookback); }
  catch (e) { return res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }

  if (!todo.length) {
    return res.status(200).json({
      ok: true, asOf, graded: [], note: 'No decision snapshots with elapsed horizons awaiting grading.',
    });
  }

  const results = [];
  const startedAt = Date.now();
  const skippedDays = [];
  const poolLookup = await loadCandlePool();       // one Blob read per scope, whole run
  for (const { date, snap, graded: priorBatch, horizonGraded: priorHorizonBatch } of todo) {
    // Do not START another candle-heavy day past the budget — record it and let the
    // next run take it. Days already graded in this pass are still written.
    if (Date.now() - startedAt > RUN_DEADLINE_MS) { skippedDays.push({ date, reason: 'skipped:budget' }); continue; }
    const tickers = [...new Set((snap.predictions || []).map(p => p.ticker).filter(Boolean))].slice(0, MAX_TICKERS);
    // Cache-first: the pooled candle caches cover the vast majority at zero fetch cost;
    // only misses spend the bounded, day-rotated live budget.
    const priced = new Map();
    const misses = [];
    for (const t of tickers) {
      const cached = poolLookup(t);
      if (cached) priced.set(t, cached);
      else misses.push(t);
    }
    const toFetch = rotateMisses(misses, asOf, LIVE_FETCH_CAP);
    const fetched = await fetchAll(toFetch);
    for (const [t, c] of fetched) if (c) priced.set(t, c);
    let bench = null;
    try { bench = candlesOf(await fetchDailyHistory(BENCH, HISTORY_RANGE)); } catch { bench = null; }

    // Fetch each distinct sector ETF ONCE (≤11), then resolve per ticker. A missing sector
    // ETF just leaves that name market-relative (grade.js falls back to the benchmark) — the
    // upgrade is best-effort and never blocks grading.
    const etfs = [...new Set(tickers.map(sectorEtfFor).filter(Boolean))];
    const sectorCandles = await fetchAll(etfs);
    const sectorLookup = t => { const e = sectorEtfFor(t); return e ? (sectorCandles.get(e) || null) : null; };

    const lookup = t => priced.get(t) || null;
    const gradedNew = G.gradeSnapshot(snap, lookup, { asOf, benchCandles: bench, sectorLookup });
    // Merge protection: never lose a previously-graded outcome to a missing candle.
    const merged = mergeOutcomeBatches(priorBatch, gradedNew);
    const batch = merged.batch;
    let written = { written: false, reason: 'not-attempted' };
    try { written = await RS.saveOutcomes(date, batch); }
    catch (e) { written = { written: false, reason: String((e && e.message) || e) }; }

    // Multi-horizon term structure from the SAME candles/bench — a strict superset that
    // extracts far more evidence per stored decision. Written to its own artifact; its
    // failure must never lose the single-horizon grade already written above.
    let mhWritten = { written: false, reason: 'not-attempted' };
    let mhBatch = null;
    let mhKept = 0;
    try {
      const mhNew = MH.gradeSnapshotHorizons(snap, lookup, { asOf, benchCandles: bench, sectorLookup });
      const mhMerged = mergeHorizonBatches(priorHorizonBatch, mhNew);
      mhBatch = mhMerged.batch;
      mhKept = mhMerged.keptFromPrior;
      mhWritten = await RS.saveHorizonOutcomes(date, mhBatch);
    } catch (e) { mhWritten = { written: false, reason: String((e && e.message) || e) }; }

    results.push({
      date, written,
      nPredictions: batch.nPredictions, nGraded: batch.nGraded,
      nFilled: batch.nFilled, nUnfilled: batch.nUnfilled, nPending: batch.nPending,
      nInvalid: batch.invalid.length,
      horizon: { written: mhWritten, resolvedByBar: mhBatch ? mhBatch.resolvedByBar : null, keptFromPrior: mhKept },
      tickersPriced: priced.size,
      candles: { cacheHits: tickers.length - misses.length, cacheMisses: misses.length, liveFetched: toFetch.length, unpriced: tickers.length - priced.size },
      keptFromPrior: merged.keptFromPrior,
      sectorEtfs: etfs.length,     // residuals are sector-relative for names with a mapped sector
      sectorCoverage: tickers.length ? +(tickers.filter(sectorEtfFor).length / tickers.length).toFixed(2) : 0,
      truncated: (snap.predictions || []).length > MAX_TICKERS,
    });
  }

  return res.status(200).json({
    ok: true, asOf, outcomeVersion: G.OUTCOME_VERSION,
    horizonBars: G.HORIZON_BARS,
    horizonLadder: MH.HORIZON_LADDER, horizonOutcomeVersion: MH.MULTI_HORIZON_VERSION,
    graded: results,
    skippedDays,                 // named, not silent — chronic starvation must be visible
    elapsedMs: Date.now() - startedAt,
    affectsLiveRank: false,
    note: 'Outcomes are written to research/outcomes/<date>.json. Decisions are never modified.',
  });
}

module.exports = {
  runResearchGrade, findUngradedDates, horizonBatchHasPending, sectorEtfFor, candlesOf, fetchAll,
  mergeOutcomeBatches, mergeHorizonBatches, rotateMisses,
  MAX_DAYS_PER_RUN, MAX_TICKERS, LIVE_FETCH_CAP, RUN_DEADLINE_MS,
};
