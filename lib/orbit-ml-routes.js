// ORBIT-ML HTTP surface (shadow-only). Routed through api/tracker.js (Hobby cap).
// ORBIT-ML never 500s and never touches live rank. Ops:
//   op=orbitml            public cached read of the latest ranked cross-section
//   op=orbitmltick        (privileged) compute + log today's ranking (bounded)
//   op=orbitmlresolve     (privileged) resolve logged predictions via orbit-labels
//   op=orbitmlwalkforward (expensive) backfill → train ranker → walk-forward + marginal
//   op=orbitmlhealth      public read of monitor + grade + incremental value
//
// The genuine ORBIT-ML deltas over ORBIT: a date-grouped RANK objective, EVOLVE
// specialist framing (idiosyncraticPersistence), and marginal-ensemble measurement.
// Everything else reuses the proven orbit-* engines.

const store = require('./store');
const MLFeat = require('./orbit-ml-features');
const MLModel = require('./orbit-ml-model');
const MLEnsemble = require('./orbit-ml-ensemble');
const Adapter = require('./orbit-ml-evolve');
const MLMonitor = require('./orbit-ml-monitor');
const Backfill = require('./orbit-backfill');
const Labels = require('./orbit-labels');
const FM = require('./orbit-factor-model');
const { alignByDate } = require('./orbit-features');
const { SECTOR_OF, LARGE } = require('./universe');

const HORIZONS = ['days5', 'days21', 'days63'];
function safeNowET() { try { return require('./stats').nowET(); } catch { return null; } }
function codeVersion() { try { return require('./run-manifest').codeVersion(); } catch { return { sha: null }; } }
function versions() {
  return { featureVersion: MLFeat.ML_FEATURES_VERSION, modelVersion: MLModel.ML_MODEL_VERSION, adapterVersion: Adapter.ADAPTER_VERSION, ensembleVersion: MLEnsemble.ENSEMBLE_VERSION };
}

async function loadFactorBundle(fetchHistory, range, sectorEtfs) {
  const [spy, iwm, vix] = await Promise.all([fetchHistory('SPY', range), fetchHistory('IWM', range), fetchHistory('^VIX', range)]);
  const sectors = {};
  for (const etf of sectorEtfs) { try { sectors[etf] = (await fetchHistory(etf, range))?.candles || null; } catch { sectors[etf] = null; } }
  return { market: spy?.candles || null, small: iwm?.candles || null, vol: vix?.candles || null, sectors };
}

// Build a bounded ranked cross-section as-of the latest bar. Honest cold-start: if no
// trained ranker artifact exists, names are ordered by residual momentum as a fallback
// and everything is classified ABSTAIN (uncalibrated) — logged only for IC measurement.
async function buildBoard({ fetchHistory, universe, limit, range, artifact }) {
  const names = universe.slice(0, limit);
  const sectorEtfs = [...new Set(names.map(t => FM.sectorEtfFor(SECTOR_OF[t])).filter(Boolean))];
  const bundle = await loadFactorBundle(fetchHistory, range, sectorEtfs);
  const trained = !!(artifact && artifact.model && artifact.model.trained);

  const cands = [];
  for (const ticker of names) {
    let hist; try { hist = await fetchHistory(ticker, range); } catch { hist = null; }
    if (!hist || !hist.candles || hist.candles.length < 160) continue;
    const dates = hist.candles.map(c => c.date);
    const sectorEtf = FM.sectorEtfFor(SECTOR_OF[ticker]);
    const factorCloses = {
      marketCloses: alignByDate(dates, bundle.market), sectorCloses: alignByDate(dates, sectorEtf ? bundle.sectors[sectorEtf] : null),
      smallCloses: alignByDate(dates, bundle.small), volCloses: alignByDate(dates, bundle.vol),
    };
    const snap = MLFeat.orbitMlFeatures(hist.candles, factorCloses);
    if (!snap || !snap.sufficient) continue;
    const rankScore = trained ? MLModel.scoreRankModel(artifact.model, snap.features) : (snap.features.residMom63 || 0);
    cands.push({ ticker, decisionTs: dates[dates.length - 1], features: snap.features, rankScore, drift: snap.features.drift, expectedResidual: snap.features.residMom21 });
  }
  // Cross-sectional percentile within the day's group.
  cands.sort((a, b) => b.rankScore - a.rankScore);
  const n = cands.length;
  cands.forEach((c, i) => { c.rankPct = n > 1 ? +(1 - i / (n - 1)).toFixed(4) : 1; c.classification = 'ABSTAIN'; });
  return { asOf: (safeNowET() && safeNowET().date) || null, shadow: true, affectsLiveRank: false, trained, count: n, ranked: cands };
}

// ── op=orbitml — public read ────────────────────────────────────────────────
async function runOrbitMl(req, res) {
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  try {
    const days = await store.readAllOrbitMlDays();
    const latest = days.length ? days[days.length - 1] : null;
    return res.status(200).json({ ok: true, ...Adapter.shadowStatus(), version: versions(), latest: latest || { note: 'ORBIT-ML is a shadow EVOLVE specialist and has not logged a ranking yet.', ranked: [] } });
  } catch (e) { return res.status(200).json({ ok: false, shadow: true, affectsLiveRank: false, error: String(e && e.message || e), ranked: [] }); }
}

// ── op=orbitmltick — compute + log the ranked cross-section (bounded) ───────
async function runOrbitMlTick(req, res) {
  if (!store.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store', shadow: true });
  const fetchHistory = require('./screener').fetchDailyHistory;
  const limit = Math.min(+(req.query.limit || 60), 120);
  const artifact = await store.readOrbitMlModel();
  const date = (safeNowET() && safeNowET().date) || req.query.date || null;
  try {
    const board = await buildBoard({ fetchHistory, universe: LARGE, limit, range: '2y', artifact });
    const logged = board.ranked.map(c => ({ ticker: c.ticker, decisionTs: c.decisionTs, rankScore: c.rankScore, rankPct: c.rankPct, classification: c.classification, expectedResidual: c.expectedResidual }));
    if (date) await store.writeOrbitMlDay(date, { trained: board.trained, count: board.count, predictions: logged, versions: versions(), code: codeVersion(), shadow: Adapter.shadowStatus() });
    try { await require('./immutable-ledger').append('orbit-ml', { kind: 'ranking-batch', at: date, n: logged.length, trained: board.trained, specialist: Adapter.SPECIALIST_ID }); } catch { /* best-effort */ }
    return res.status(200).json({ ok: true, shadow: true, date, logged: logged.length, trained: board.trained });
  } catch (e) { return res.status(200).json({ ok: false, shadow: true, error: String(e && e.message || e) }); }
}

// ── op=orbitmlresolve — resolve logged predictions via orbit-labels ─────────
async function runOrbitMlResolve(req, res) {
  if (!store.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store', shadow: true });
  const fetchHistory = require('./screener').fetchDailyHistory;
  try {
    const days = await store.readAllOrbitMlDays();
    const resolved = await store.readOrbitMlResolved();
    const bundle = await loadFactorBundle(fetchHistory, '2y', []);
    let newly = 0;
    for (const day of days) {
      for (const p of (day.predictions || [])) {
        const key = `${p.ticker}:${p.decisionTs}`;
        if (resolved[key] && resolved[key].done) continue;
        let hist; try { hist = await fetchHistory(p.ticker, '2y'); } catch { hist = null; }
        if (!hist || !hist.candles) continue;
        const labels = Labels.orbitLabels(hist.candles, p.decisionTs, { tier: 'liquid', marketCandles: bundle.market });
        if (!labels.resolvable) continue;
        if (!HORIZONS.some(h => labels.horizons[h] && labels.horizons[h].resolved)) continue;
        resolved[key] = { ticker: p.ticker, decisionTs: p.decisionTs, rankScore: p.rankScore, rankPct: p.rankPct, horizons: labels.horizons, done: HORIZONS.every(h => labels.horizons[h] && labels.horizons[h].resolved), at: (safeNowET() && safeNowET().date) || null };
        newly++;
      }
    }
    await store.writeOrbitMlResolved(resolved);
    try { await require('./immutable-ledger').append('orbit-ml', { kind: 'resolution-batch', at: (safeNowET() && safeNowET().date) || null, resolved: newly }); } catch { /* best-effort */ }
    return res.status(200).json({ ok: true, shadow: true, newlyResolved: newly, total: Object.keys(resolved).length });
  } catch (e) { return res.status(200).json({ ok: false, shadow: true, error: String(e && e.message || e) }); }
}

// ── op=orbitmlwalkforward — backfill → train ranker → walk-forward + marginal ─
async function runOrbitMlWalkForward(req, res) {
  const fetchHistory = require('./screener').fetchDailyHistory;
  const limit = Math.min(+(req.query.limit || 40), 120);
  try {
    const bf = await Backfill.runBackfill({ universe: LARGE, scope: 'large', fetchHistory, range: req.query.range || '3y', limit, step: +(req.query.step || 10), featureFn: MLFeat.orbitMlFeatures });
    const features = [...require('./orbit-model').FEATURE_SET, ...MLFeat.ML_FEATURE_NAMES];
    const walkforward = {};
    for (const h of HORIZONS) walkforward[h] = MLModel.rankWalkForward(bf.samples, { horizon: h, targetField: 'residualReturn', outerBlocks: +(req.query.outer || 6), features, researchValidity: bf.researchValidity });
    // Train + freeze the serving ranker (21d target as the primary).
    const rows21 = trainRows(bf.samples, 'days21');
    const model = MLModel.fitRankModel(rows21, { features });
    if (store.hasStore()) {
      await store.writeOrbitMlModel({ version: 'orbit-ml-artifact-v1', trainedAt: (safeNowET() && safeNowET().date) || null, model, features, researchValidity: bf.researchValidity });
      await store.writeOrbitMlEval({ walkforward, backfill: { nSamples: bf.nSamples, built: bf.built }, gbm: MLModel.gbmStatus(null), at: (safeNowET() && safeNowET().date) || null, researchValidity: bf.researchValidity });
    }
    return res.status(200).json({ ok: true, shadow: true, walkforward: summarize(walkforward), backfill: { nSamples: bf.nSamples, built: bf.built }, gbm: MLModel.gbmStatus(null), trained: model.trained, researchValidity: bf.researchValidity });
  } catch (e) { return res.status(200).json({ ok: false, shadow: true, error: String(e && e.message || e) }); }
}

function trainRows(samples, horizon) {
  const rows = [];
  for (const s of samples) { const h = s.horizons && s.horizons[horizon]; if (!h || !h.resolved) continue; const t = h.residualReturn != null ? h.residualReturn : h.netReturn; if (t == null) continue; rows.push({ decisionDate: s.decisionDate, features: s.features, target: t }); }
  return rows;
}
function summarize(wf) {
  const out = {};
  for (const h of HORIZONS) { const w = wf[h]; out[h] = w && w.ok ? { purgedIC: w.purged.overall && w.purged.overall.ic, leakyIC: w.leaky.overall && w.leaky.overall.ic, leakageInflation: w.leakageInflation, nOuter: w.purged.nOuter } : { ok: false, reason: w && w.reason }; }
  return out;
}

// ── op=orbitmlhealth — monitor + grade + incremental value ──────────────────
async function runOrbitMlHealth(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  try {
    const resolved = store.hasStore() ? await store.readOrbitMlResolved() : {};
    const evalDoc = store.hasStore() ? await store.readOrbitMlEval() : null;
    // Peer rows for redundancy: the existing challenger/omega ledgers would feed here;
    // in cold-start we measure only against ORBIT's own resolved excess if present.
    const monitor = MLMonitor.monitorOrbitMl(resolved, { evalDoc, now: (safeNowET() && safeNowET().date) || null, horizon: 'days21' });
    return res.status(200).json({ ok: true, ...Adapter.shadowStatus(), version: MLMonitor.ML_MONITOR_VERSION, monitor, researchValidity: evalDoc ? evalDoc.researchValidity : { productionGrade: false, survivorshipSafe: false, pointInTimeSafe: false } });
  } catch (e) { return res.status(200).json({ ok: false, shadow: true, error: String(e && e.message || e) }); }
}

module.exports = { runOrbitMl, runOrbitMlTick, runOrbitMlResolve, runOrbitMlWalkForward, runOrbitMlHealth, buildBoard };
