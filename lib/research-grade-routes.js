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
const RS = require('./research/store');
const G = require('./research/grade');

const MAX_DAYS_PER_RUN = 3;      // bounded work per invocation (60s function budget)
const MAX_TICKERS = 120;         // cap the fan-out; the rest grade on the next pass
const BENCH = 'SPY';
const HISTORY_RANGE = '1y';

// Fetch candles for a set of tickers with bounded concurrency.
async function fetchAll(tickers, concurrency = 6) {
  const out = new Map();
  const queue = [...tickers];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      try { out.set(t, await fetchDailyHistory(t, HISTORY_RANGE)); }
      catch { out.set(t, null); }     // a dead ticker grades as unfilled, not as a crash
    }
  });
  await Promise.all(workers);
  return out;
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
    // Re-grade when predictions remain pending — their horizons may have since elapsed.
    if (!graded || (graded.nPending || 0) > 0) todo.push({ date: d, snap, graded });
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
  for (const { date, snap } of todo) {
    const tickers = [...new Set((snap.predictions || []).map(p => p.ticker).filter(Boolean))].slice(0, MAX_TICKERS);
    const priced = await fetchAll(tickers);
    let bench = null;
    try { bench = await fetchDailyHistory(BENCH, HISTORY_RANGE); } catch { bench = null; }

    const batch = G.gradeSnapshot(snap, t => priced.get(t) || null, { asOf, benchCandles: bench });
    let written = { written: false, reason: 'not-attempted' };
    try { written = await RS.saveOutcomes(date, batch); }
    catch (e) { written = { written: false, reason: String((e && e.message) || e) }; }

    results.push({
      date, written,
      nPredictions: batch.nPredictions, nGraded: batch.nGraded,
      nFilled: batch.nFilled, nUnfilled: batch.nUnfilled, nPending: batch.nPending,
      nInvalid: batch.invalid.length,
      tickersPriced: tickers.length,
      truncated: (snap.predictions || []).length > MAX_TICKERS,
    });
  }

  return res.status(200).json({
    ok: true, asOf, outcomeVersion: G.OUTCOME_VERSION,
    horizonBars: G.HORIZON_BARS,
    graded: results,
    affectsLiveRank: false,
    note: 'Outcomes are written to research/outcomes/<date>.json. Decisions are never modified.',
  });
}

module.exports = { runResearchGrade, findUngradedDates, fetchAll, MAX_DAYS_PER_RUN, MAX_TICKERS };
