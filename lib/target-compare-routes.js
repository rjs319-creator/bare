'use strict';
// 🎯 op=targetcompare — validate the target factory's declared preference on REAL
// graded outcomes (folded into api/tracker.js; EXPENSIVE, rate-limited).
//
// Data path: the research OS already records immutable decision snapshots
// (research/decisions/<date>) and re-grades them into multi-horizon outcome
// vectors (research/horizon-outcomes/<date>). This route joins those REAL graded
// vectors with PIT features recomputed from the candle pool, builds every target
// variant per decision date via the target factory, and runs the pure comparison
// (lib/research/target-compare): each variant trains its own ridge, all are
// scored on the one pre-declared economic metric on identical purged folds.
//
// `cached=1` serves the last persisted report without recomputing (UI-safe).
// Fail-closed: too few graded dates/rows → INSUFFICIENT_DATA verdict, no winner.

const { nowET } = require('./stats');
const S = require('./store');
const RS = require('./research/store');
const { mapLimit } = require('./map-limit');
const { fetchDailyHistory } = require('./screener');
const { loadUniverseRows } = require('./rlt-routes');
const { computeFeatureVector } = require('./research/features');
const { buildTargetRows, TARGET_VARIANTS } = require('./research/target-factory');
const { compareTargets, TARGET_COMPARE_VERSION } = require('./research/target-compare');

const REPORT_PATH = 'research/target-compare.json';
const BARS = 21;                                   // the horizon rung under comparison
const MAX_DATES = 60;
// target-before-stop excluded: no path-dependent barrier outcomes are stored for
// these vectors, and the factory correctly refuses to derive one from MFE/MAE.
const VARIANTS = TARGET_VARIANTS.filter(v => v !== 'target-before-stop');

function json(res, code, obj, sMaxAge) {
  if (sMaxAge) res.setHeader('Cache-Control', `s-maxage=${sMaxAge}, stale-while-revalidate=60`);
  return res.status(code).json(obj);
}

async function runTargetCompare(req, res) {
  try {
    if (req.query.cached === '1') {
      const cached = await S.readJSON(REPORT_PATH, null).catch(() => null);
      return json(res, 200, cached || { ok: false, reason: 'no-cached-report — run op=targetcompare explicitly' }, 300);
    }
    const t0 = Date.now();
    const { date: today } = nowET();
    const lookback = Math.min(180, Number(req.query.lookback) || 120);

    // 1. Real graded multi-horizon batches, newest first, bounded.
    const probeDates = RS.recentDates(today, lookback);
    const loaded = await mapLimit(probeDates, 8, async d => {
      const batch = await RS.loadHorizonOutcomes(d).catch(() => null);
      return batch && Array.isArray(batch.vectors) && batch.vectors.length ? { date: d, batch } : null;
    });
    const days = loaded.filter(Boolean).slice(0, MAX_DATES);
    if (!days.length) {
      return json(res, 200, { ok: false, version: TARGET_COMPARE_VERSION, reason: 'no-graded-horizon-outcomes-found', lookback }, 60);
    }

    // 2. Production-composite scores from the immutable decision snapshots.
    const snapshots = await mapLimit(days, 8, async d => ({ date: d.date, snap: await RS.loadDecisionSnapshot(d.date).catch(() => null) }));
    const scoreByDateTicker = new Map();
    for (const { date, snap } of snapshots) {
      for (const p of (snap && snap.predictions) || []) {
        const sc = p.rawOutputs && Number.isFinite(p.rawOutputs.compositeScore) ? p.rawOutputs.compositeScore : null;
        if (sc != null) scoreByDateTicker.set(`${date}:${p.ticker}`, sc);
      }
    }

    // 3. PIT features from the candle pool + SPY.
    const [{ rows: pool }, spyHist] = await Promise.all([
      loadUniverseRows(),
      fetchDailyHistory('SPY', '1y').catch(() => null),
    ]);
    const benchCloses = {};
    for (const c of (spyHist && spyHist.candles) || []) benchCloses[c.date] = c.close;
    const barsOf = new Map(pool.map(r => [r.ticker, r.bars]));

    // 4. Rows: per date, every variant's label + features + champion score.
    const rows = [];
    let missingFeatures = 0;
    for (const { date, batch } of days) {
      const vectors = batch.vectors.filter(v => v && v.fillStatus === 'filled');
      const byVariant = {};
      for (const v of VARIANTS) {
        byVariant[v] = new Map(buildTargetRows(vectors, { bars: BARS, variant: v, decisionTs: date }).map(r => [r.ticker, r]));
      }
      const base = byVariant['cost-adjusted-residual'];
      for (const [ticker, r] of base) {
        const candles = barsOf.get(ticker);
        let features = {};
        if (Array.isArray(candles) && candles.length) {
          let idx = -1;
          for (let i = candles.length - 1; i >= 0; i--) if (candles[i].date <= date) { idx = i; break; }
          if (idx >= 20) {
            const f = computeFeatureVector(candles, idx, { benchCloses });
            features = f && f.values ? f.values : {};
          }
        }
        if (!Object.keys(features).length) missingFeatures++;
        const outcomes = {};
        for (const v of VARIANTS) {
          const row = byVariant[v].get(ticker);
          outcomes[v] = row ? row.outcome : null;
        }
        rows.push({
          securityId: ticker, ticker,
          decisionTs: date, labelEndDate: r.labelEndDate, horizon: BARS,
          features, outcomes,
          score: scoreByDateTicker.get(`${date}:${ticker}`) ?? null,
        });
      }
    }

    // 5. Compare on identical purged folds.
    const result = compareTargets(rows, { folds: 4, embargo: 5 });
    const payload = {
      ok: true, ...result,
      coverage: {
        gradedDates: days.length, lookbackDays: lookback, rowsBuilt: rows.length,
        rowsMissingFeatures: missingFeatures,
        withChampionScore: rows.filter(r => r.score != null).length,
      },
      generatedAt: new Date().toISOString(), tookMs: Date.now() - t0,
    };
    try { await S.writeJSON(REPORT_PATH, payload, 0); } catch { /* cache is best-effort */ }
    return json(res, 200, payload, 600);
  } catch (e) {
    return json(res, 200, { ok: false, error: String((e && e.message) || e) }, 30);
  }
}

module.exports = { runTargetCompare, REPORT_PATH, VARIANTS, BARS };
