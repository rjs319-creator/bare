// ORBIT HTTP surface (shadow-only). All ops route through api/tracker.js (Hobby
// 12-function cap). ORBIT never 500s the board — errors degrade to a shadow
// payload. Nothing here touches the production rank.
//
//   op=orbit           public cached read of the latest shadow board
//   op=orbitlog        (privileged) compute + log today's predictions (bounded)
//   op=orbitresolve    (privileged) resolve logged predictions via orbit-labels
//   op=orbitwalkforward(expensive) backfill → train model+calibrators → eval cache
//   op=orbithealth     public read of monitor + grade + router weight
//   op=algorithmrouter public read of the conservative router weights (ORBIT ≈ 0)

const store = require('./store');
const FEAT = require('./orbit-features');
const FM = require('./orbit-factor-model');
const Mod = require('./orbit-model');
const Cal = require('./orbit-calibration');
const Sc = require('./orbit-scenarios');
const Dec = require('./orbit-decision');
const Labels = require('./orbit-labels');
const Backfill = require('./orbit-backfill');
const WF = require('./orbit-walkforward');
const Monitor = require('./orbit-monitor');
const Router = require('./algorithm-router');
const { SECTOR_OF, LARGE } = require('./universe');

const HORIZONS = ['days5', 'days21', 'days63'];

function hostFrom(req) { return (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'market-news-app-chi.vercel.app'; }
function safeNowET() { try { return require('./stats').nowET(); } catch { return null; } }
function codeVersion() { try { return require('./run-manifest').codeVersion(); } catch { return { sha: null }; } }

function moduleVersions() {
  return {
    featureVersion: FEAT.FEATURES_VERSION, factorModelVersion: FM.FACTOR_MODEL_VERSION,
    stateModelVersion: require('./orbit-state').STATE_VERSION, predictionModelVersion: Mod.MODEL_VERSION,
    calibrationVersion: Cal.CALIBRATION_VERSION, costModelVersion: require('./costs').COST_MODEL_VERSION,
    labelVersion: Labels.LABELS_VERSION, decisionVersion: Dec.DECISION_VERSION, scenarioVersion: Sc.SCENARIO_VERSION,
  };
}

// Align raw factor candle arrays to a stock's dates → close arrays for the feature engine.
function factorClosesFor(dates, factorBundle, sectorEtf) {
  return {
    marketCloses: FEAT.alignByDate(dates, factorBundle.market),
    sectorCloses: FEAT.alignByDate(dates, sectorEtf ? factorBundle.sectors[sectorEtf] : null),
    smallCloses: FEAT.alignByDate(dates, factorBundle.small),
    volCloses: FEAT.alignByDate(dates, factorBundle.vol),
  };
}

// Score ONE ticker as-of its latest bar into the ORBIT prediction contract.
function scoreTicker({ ticker, candles, factorCloses, tier, sector, artifact, scenarioVec }) {
  const snap = FEAT.orbitFeatures(candles, factorCloses);
  if (!snap) return null;
  const decisionTs = candles[candles.length - 1].date;
  const horizons = {};
  const models = artifact && artifact.models;
  for (const h of HORIZONS) {
    const model = models && models[h];
    if (!model || !model.trained || !snap.sufficient) { horizons[h] = { calibrated: false, rankScore: null }; continue; }
    const s = Mod.scoreOrbit(model, snap.features);
    const cal = artifact.calibrators && artifact.calibrators[h];
    const calibrated = !!(cal && cal.calibrated);
    const calResid = calibrated ? Cal.calibrate(cal, s.residualUp) : null;
    const calRaw = calibrated ? Cal.calibrate(cal, s.rawUp) : null;
    let robust = { robustUp: null, lowerBound: null, worstScenario: null };
    if (calibrated && calResid != null && scenarioVec) {
      const br = (artifact.scenarioBaseRates && artifact.scenarioBaseRates[h]) || {};
      const perS = Sc.perScenarioProb(calResid, br.rates || {}, br.overall != null ? br.overall : calResid);
      robust = Sc.robustUp(perS, scenarioVec);
    }
    horizons[h] = {
      calibrated, rawUp: calRaw, residualUp: calResid,
      robustUp: robust.robustUp, lowerBound: robust.lowerBound, upperBound: calResid,
      pUpper: s.pUpper, pLower: s.pLower, pTimeout: s.pTimeout,
      expectedNet: s.expectedNetReturn, expectedGross: null, expectedResidual: null,
      severe: s.severeLossProbability, rankScore: s.rankScore,
    };
  }
  const topDrivers = topDriversFrom(snap.features);
  return Dec.decideCandidate({
    ticker, securityId: sector ? `${ticker}` : ticker, decisionTs, dataCutoffTs: decisionTs, eligibleEntryTs: null,
    universeSnapshotId: artifact ? artifact.universeSnapshotId : null,
    versions: moduleVersions(), horizons,
    latentState: snap.state, scenario: scenarioVec, topDrivers, sufficient: snap.sufficient,
    gates: { dataQualityOk: snap.sufficient, liquidityOk: (snap.features.avgDollarVol || 0) > 2e6 },
    researchValidity: { productionGrade: false, survivorshipSafe: false, reason: 'shadow research output; survivorship-biased universe' },
  });
}

function topDriversFrom(f) {
  const drivers = [
    ['residual drift', f.drift], ['residual momentum 63d', f.residMom63], ['demand asymmetry', f.demandAsymmetry],
    ['drift P(+)', f.driftProbPositive], ['sector-relative 63d', f.secRelRet63], ['accumulation on down days', f.accumOnMktDown],
  ].filter(d => d[1] != null);
  return drivers.slice(0, 5).map(([name, value]) => ({ name, value }));
}

// ── Bounded factor-proxy bundle (fetched once per run) ──────────────────────
async function loadFactorBundle(fetchHistory, range, sectors) {
  const [spy, iwm, vix] = await Promise.all([fetchHistory('SPY', range), fetchHistory('IWM', range), fetchHistory('^VIX', range)]);
  const sectorSeries = {};
  for (const etf of sectors) { try { sectorSeries[etf] = (await fetchHistory(etf, range))?.candles || null; } catch { sectorSeries[etf] = null; } }
  return { market: spy?.candles || null, small: iwm?.candles || null, vol: vix?.candles || null, sectors: sectorSeries };
}

// Build a bounded shadow board (used by op=orbitlog). Honest: with no trained
// model artifact, every candidate ABSTAINs.
async function buildOrbitBoard({ fetchHistory, universe, limit, range, artifact }) {
  const names = universe.slice(0, limit);
  const sectorEtfs = [...new Set(names.map(t => FM.sectorEtfFor(SECTOR_OF[t])).filter(Boolean))];
  const factorBundle = await loadFactorBundle(fetchHistory, range, sectorEtfs);
  let scenarioVec = null;
  try {
    const macro = await require('./macro').fetchMacro();
    if (macro) scenarioVec = Sc.scenarioVector(macro, {});
  } catch { /* scenario optional */ }

  const board = [];
  for (const ticker of names) {
    let hist; try { hist = await fetchHistory(ticker, range); } catch { hist = null; }
    if (!hist || !hist.candles || hist.candles.length < 160) continue;
    const sector = SECTOR_OF[ticker] || null;
    const sectorEtf = FM.sectorEtfFor(sector);
    const factorCloses = factorClosesFor(hist.candles.map(c => c.date), factorBundle, sectorEtf);
    const tier = 'liquid';
    const pred = scoreTicker({ ticker, candles: hist.candles, factorCloses, tier, sector, artifact, scenarioVec });
    if (pred) board.push(pred);
  }
  const picks = board.filter(p => !['ABSTAIN', 'WATCH'].includes(p.classification));
  const counts = board.reduce((m, p) => { m[p.classification] = (m[p.classification] || 0) + 1; return m; }, {});
  return { asOf: (safeNowET() && safeNowET().date) || null, shadow: true, affectsLiveRank: false, trained: !!(artifact && artifact.models), board, picks, counts, scenario: scenarioVec };
}

// ── op=orbit — public read of the latest logged board ───────────────────────
async function runOrbit(req, res) {
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  try {
    const days = await store.readAllOrbitDays();
    const latest = days.length ? days[days.length - 1] : null;
    return res.status(200).json({ ok: true, shadow: true, affectsLiveRank: false, version: Dec.DECISION_VERSION, latest: latest || { note: 'ORBIT is shadow-only and has not logged a board yet.', board: [], picks: [] } });
  } catch (e) {
    return res.status(200).json({ ok: false, shadow: true, affectsLiveRank: false, error: String(e && e.message || e), board: [], picks: [] });
  }
}

// ── op=orbitlog — compute + log today's shadow predictions (bounded) ────────
async function runOrbitLog(req, res) {
  if (!store.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store', shadow: true });
  const fetchHistory = require('./screener').fetchDailyHistory;
  const limit = Math.min(+(req.query.limit || 60), 120);
  const artifact = await store.readOrbitModel();
  const et = safeNowET();
  const date = (et && et.date) || (req.query.date || null);
  try {
    const built = await buildOrbitBoard({ fetchHistory, universe: LARGE, limit, range: '2y', artifact });
    const logged = built.board.map(p => ({ ticker: p.ticker, decisionTs: p.decisionTs, classification: p.classification, confidence: p.confidence, horizonProbabilities: p.horizonProbabilities, expectedNetReturn: p.expectedNetReturn, severeLossProbability: p.severeLossProbability }));
    if (date) await store.writeOrbitDay(date, { picks: built.picks.map(p => p.ticker), counts: built.counts, trained: built.trained, predictions: logged, versions: moduleVersions(), code: codeVersion() });
    try { await require('./immutable-ledger').append('orbit', { kind: 'prediction-batch', at: date, n: logged.length, trained: built.trained, predictions: logged.map(p => ({ ticker: p.ticker, classification: p.classification, decisionTs: p.decisionTs })) }); } catch { /* best-effort */ }
    return res.status(200).json({ ok: true, shadow: true, date, logged: logged.length, counts: built.counts, trained: built.trained });
  } catch (e) {
    return res.status(200).json({ ok: false, shadow: true, error: String(e && e.message || e) });
  }
}

// ── op=orbitresolve — resolve logged predictions via the label engine ───────
async function runOrbitResolve(req, res) {
  if (!store.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store', shadow: true });
  const fetchHistory = require('./screener').fetchDailyHistory;
  try {
    const days = await store.readAllOrbitDays();
    const resolved = await store.readOrbitResolved();
    let newlyResolved = 0;
    const range = '2y';
    const factorBundle = await loadFactorBundle(fetchHistory, range, []);
    for (const day of days) {
      for (const p of (day.predictions || [])) {
        const key = `${p.ticker}:${p.decisionTs}`;
        if (resolved[key] && resolved[key].done) continue;
        let hist; try { hist = await fetchHistory(p.ticker, range); } catch { hist = null; }
        if (!hist || !hist.candles) continue;
        const sector = SECTOR_OF[p.ticker] || null;
        const labels = Labels.orbitLabels(hist.candles, p.decisionTs, { tier: 'liquid', atrPct: null, marketCandles: factorBundle.market, sectorCandles: null });
        if (!labels.resolvable) continue;
        const anyClosed = HORIZONS.some(h => labels.horizons[h] && labels.horizons[h].resolved);
        if (!anyClosed) continue;
        resolved[key] = { ticker: p.ticker, decisionTs: p.decisionTs, classification: p.classification, horizons: labels.horizons, done: HORIZONS.every(h => labels.horizons[h] && labels.horizons[h].resolved), at: (safeNowET() && safeNowET().date) || null };
        newlyResolved++;
      }
    }
    await store.writeOrbitResolved(resolved);
    try { await require('./immutable-ledger').append('orbit', { kind: 'resolution-batch', at: (safeNowET() && safeNowET().date) || null, resolved: newlyResolved }); } catch { /* best-effort */ }
    return res.status(200).json({ ok: true, shadow: true, newlyResolved, total: Object.keys(resolved).length });
  } catch (e) {
    return res.status(200).json({ ok: false, shadow: true, error: String(e && e.message || e) });
  }
}

// ── op=orbitwalkforward — backfill → train model+calibrators → eval cache ───
async function runOrbitWalkForward(req, res) {
  const fetchHistory = require('./screener').fetchDailyHistory;
  const limit = Math.min(+(req.query.limit || 40), 120);
  const horizon = req.query.horizon || 'days21';
  try {
    const bf = await Backfill.runBackfill({ universe: LARGE, scope: 'large', fetchHistory, range: req.query.range || '3y', limit, step: +(req.query.step || 10) });
    const wf = WF.walkForward(bf.samples, { horizon, labelField: 'positiveResidual', outerBlocks: +(req.query.outer || 6), researchValidity: bf.researchValidity });
    // Train + freeze a serving artifact (model per horizon + OOF calibrators + scenario base rates).
    const artifact = trainArtifact(bf.samples, bf.researchValidity);
    if (store.hasStore()) {
      await store.writeOrbitModel(artifact);
      await store.writeOrbitEval({ walkforward: wf, backfill: { nSamples: bf.nSamples, built: bf.built, skipped: bf.skipped }, at: (safeNowET() && safeNowET().date) || null, researchValidity: bf.researchValidity });
    }
    return res.status(200).json({ ok: true, shadow: true, horizon, walkforward: summarizeWF(wf), backfill: { nSamples: bf.nSamples, built: bf.built }, trained: !!artifact.models, researchValidity: bf.researchValidity });
  } catch (e) {
    return res.status(200).json({ ok: false, shadow: true, error: String(e && e.message || e) });
  }
}

// Train per-horizon models + OOF calibrators + scenario base rates from samples.
function trainArtifact(samples, researchValidity) {
  const models = {}, calibrators = {}, scenarioBaseRates = {};
  for (const h of HORIZONS) {
    const rows = WF.horizonRows(samples, h, 'positiveResidual');
    if (rows.length < 120) { models[h] = { trained: false }; calibrators[h] = { calibrated: false, reason: 'insufficient rows' }; continue; }
    const dates = [...new Set(rows.map(r => r.decisionDate))].sort();
    const cut = dates[Math.floor(dates.length * 0.8)];
    const innerTrain = rows.filter(r => r.decisionDate < cut), innerValid = rows.filter(r => r.decisionDate >= cut);
    models[h] = Mod.fitOrbitModel(rows, { horizon: h });
    const innerModel = Mod.fitOrbitModel(innerTrain, { horizon: h });
    let calibrator = { calibrated: false, reason: 'no inner support' };
    if (innerModel.trained && innerValid.length >= 40) {
      const pairs = innerValid.map(r => { const s = Mod.scoreOrbit(innerModel, r.features); return s ? { p: s.rawUp, won: r.label } : null; }).filter(Boolean);
      const half = Math.floor(pairs.length / 2);
      calibrator = Cal.selectCalibrator(pairs.slice(0, half), pairs.slice(half), { minN: 40 });
    }
    calibrators[h] = calibrator;
    scenarioBaseRates[h] = { rates: {}, overall: Mod.fitBaseRate(rows).p };  // scenario cells accrue live; base rate is the shrink target
  }
  return { version: 'orbit-artifact-v1', trainedAt: (safeNowET() && safeNowET().date) || null, universeSnapshotId: null, models, calibrators, scenarioBaseRates, researchValidity };
}

function summarizeWF(wf) {
  if (!wf || !wf.ok) return { ok: false, reason: wf && wf.reason };
  return { ok: true, horizon: wf.horizon, purgedIC: wf.purged.overall && wf.purged.overall.ic, leakyIC: wf.leaky.overall && wf.leaky.overall.ic, leakageInflation: wf.leakageInflation, nOuter: wf.purged.nOuter, purged: wf.purged.overall };
}

// ── op=orbithealth — monitor + grade + router weight ────────────────────────
async function runOrbitHealth(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  try {
    const resolvedMap = store.hasStore() ? await store.readOrbitResolved() : {};
    const evalDoc = store.hasStore() ? await store.readOrbitEval() : null;
    const resolvedRows = flattenResolved(resolvedMap);
    const monitor = Monitor.monitorAll(resolvedRows, { now: (safeNowET() && safeNowET().date) || null });
    const grades = {};
    for (const h of HORIZONS) {
      const wf = evalDoc && evalDoc.walkforward && evalDoc.walkforward.horizon === h ? evalDoc.walkforward : null;
      grades[h] = Monitor.gradeHorizon(wf, monitor.byHorizon[h], { survivorshipSafe: false });
    }
    const routerWeight = orbitRouterWeight(grades, monitor);
    return res.status(200).json({ ok: true, shadow: true, affectsLiveRank: false, version: Monitor.MONITOR_VERSION, monitor, grades, routerWeight, registryStatus: 'experimental (shadow)', researchValidity: evalDoc ? evalDoc.researchValidity : { productionGrade: false, survivorshipSafe: false } });
  } catch (e) {
    return res.status(200).json({ ok: false, shadow: true, error: String(e && e.message || e) });
  }
}

function flattenResolved(map) {
  const rows = [];
  for (const key in map) {
    const r = map[key]; if (!r || !r.horizons) continue;
    for (const h of HORIZONS) {
      const hz = r.horizons[h]; if (!hz || !hz.resolved) continue;
      rows.push({ date: r.decisionTs, ticker: r.ticker, horizon: h, score: null, calUp: null, label: hz.positiveResidual, net: hz.netReturn, severe: hz.severeLoss });
    }
  }
  return rows;
}

// ORBIT's own router weight — 0 in shadow (its validated skill is not established).
function orbitRouterWeight(grades, monitor) {
  const g = grades.days21 || {};
  const algos = [{
    id: 'orbit', family: 'residual-drift', longTermSkill: g.oos ? (g.oos.ic || 0) : 0, recentSkill: monitor.byHorizon.days21 ? (monitor.byHorizon.days21.expanding.ic || 0) : 0,
    scenarioCompat: 1, calibrationQuality: g.calibrated ? 1 : 0, independentValue: 0.5, executionQuality: 1, uncertainty: 0.3,
    health: monitor.byHorizon.days21 ? monitor.byHorizon.days21.status : 'INSUFFICIENT_DATA', effN: g.effectiveSampleSize || 0,
  }];
  const out = Router.routeWeights(algos, {});
  return { weight: out.weights.orbit, abstain: out.abstain, note: 'Shadow: ORBIT earns router focus only after validated OOS + prospective skill.' };
}

// ── op=algorithmrouter — conservative router demo (ORBIT + baselines) ───────
async function runAlgorithmRouter(req, res) {
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  try {
    const evalDoc = store.hasStore() ? await store.readOrbitEval() : null;
    const orbitIC = evalDoc && evalDoc.walkforward && evalDoc.walkforward.ok && evalDoc.walkforward.purged.overall ? evalDoc.walkforward.purged.overall.ic : 0;
    const algos = [
      { id: 'orbit', family: 'residual-drift', longTermSkill: orbitIC || 0, recentSkill: 0, calibrationQuality: 0, independentValue: 0.5, executionQuality: 1, uncertainty: 0.4, health: 'INSUFFICIENT_DATA', effN: 0 },
    ];
    const out = Router.routeWeights(algos, {});
    return res.status(200).json({ ok: true, shadow: true, version: Router.ROUTER_VERSION, router: out, note: 'Shadow router. Live production rank is unaffected. Add validated algorithms as they accrue OOS + prospective skill.' });
  } catch (e) {
    return res.status(200).json({ ok: false, shadow: true, error: String(e && e.message || e) });
  }
}

module.exports = { runOrbit, runOrbitLog, runOrbitResolve, runOrbitWalkForward, runOrbitHealth, runAlgorithmRouter, buildOrbitBoard, scoreTicker, trainArtifact };
