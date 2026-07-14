'use strict';
// EVOLVE — Adaptive Pre-Move Discovery Engine: HTTP ops (folded into api/tracker.js, no
// new Serverless Function). EVOLVE composes the app's existing engines as SPECIALISTS
// (via the unified decision engine's op=today, which already normalizes + merges + ranks
// every screener into one canonical table) and layers the calibrated triple-barrier
// ensemble on top. It never re-scans the universe itself — it self-fetches cached
// endpoints the warm cron keeps fresh, so it is cheap and degrades gracefully.
//
//   op=evolve            live ranked candidates (FAST/SWING/POSITION), calibrated + honest
//   op=evolvescore&log=1 persist today's feature snapshots + predictions (warm cron)
//   op=evolveresolve     resolve matured predictions → triple-barrier labels, update perf + calibrator
//   op=evolvehealth      drift, calibration, coverage, per-specialist track record
//   op=evolvewalkforward out-of-sample metrics over the accrued ledger vs baselines

const { internalHeaders } = require('./auth');
const { nowET, spearman, wilson } = require('./stats');
const S = require('./store');
const E = require('./evolve');
const L = require('./evolve-labels');
const RG = require('./evolve-regime');
const RQ = require('./rankquality');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const RECENT_WINDOW = 40;         // resolved predictions per specialist for the "recent OOS" read
const MAX_RESOLVE_TICKERS = 45;   // bound per resolve run (network); the rest resolve next run
const RESOLVE_DEADLINE_MS = 45000;

// GICS sector name (as the screeners emit) → sector SPDR ETF, for sector-relative labels.
const SECTOR_ETF = {
  'technology': 'XLK', 'information technology': 'XLK',
  'financials': 'XLF', 'financial services': 'XLF', 'financial': 'XLF',
  'health care': 'XLV', 'healthcare': 'XLV',
  'energy': 'XLE', 'industrials': 'XLI',
  'consumer discretionary': 'XLY', 'cons discret': 'XLY', 'consumer cyclical': 'XLY',
  'consumer staples': 'XLP', 'cons staples': 'XLP', 'consumer defensive': 'XLP',
  'materials': 'XLB', 'basic materials': 'XLB',
  'real estate': 'XLRE', 'utilities': 'XLU',
  'communication services': 'XLC', 'comm services': 'XLC', 'communication': 'XLC',
};
const etfForSector = (name) => name ? SECTOR_ETF[String(name).trim().toLowerCase()] || null : null;

// One self-fetch of a cached endpoint (never throws — a dead source contributes nothing).
async function pull(path, timeout = 12000) {
  try {
    const r = await fetch('https://' + HOST + path, { headers: internalHeaders(), signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return { ok: false, status: r.status, data: null };
    return { ok: true, data: await r.json() };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), data: null }; }
}

// ── Regime context (best-effort; never fabricates a dimension) ───────────────────────
async function buildRegimeContext(sectorsData) {
  let macro = null, indices = {};
  try {
    const { fetchMacro } = require('./macro');
    const { fetchDailyHistory } = require('./screener');
    const [m, spy, qqq, iwm] = await Promise.all([
      fetchMacro().catch(() => null),
      fetchDailyHistory('SPY', '1y').catch(() => null),
      fetchDailyHistory('QQQ', '1y').catch(() => null),
      fetchDailyHistory('IWM', '1y').catch(() => null),
    ]);
    macro = m;
    if (spy) indices.SPY = RG.indexFeatures(spy.candles);
    if (qqq) indices.QQQ = RG.indexFeatures(qqq.candles);
    if (iwm) indices.IWM = RG.indexFeatures(iwm.candles);
  } catch { /* degrade to sectors-only vector */ }
  // Sector daily % changes from /api/sectors (default shape = {sectors:[{name,changePct}]};
  // the {rotation} shape only appears with ?mode=rotation). breadth = fraction of sectors up.
  const rows = (sectorsData && sectorsData.sectors) || [];
  const sectors = rows.filter(r => r.symbol !== 'SPY' && r.symbol !== 'QQQ').map(r => ({ name: r.name, changePct: +r.changePct }));
  const { date } = nowET();
  return RG.buildRegimeVector({ macro, indices, sectors, asOf: (macro && macro.asOf) || date });
}

// ── Flatten op=today horizons into EVOLVE input signals ──────────────────────────────
function collectSignals(todayPayload) {
  const horizons = (todayPayload && todayPayload.horizons) || {};
  const out = [];
  for (const arr of Object.values(horizons)) {
    for (const sig of arr || []) {
      const dollarVol = sig.liquidity && sig.liquidity.dollarVol;
      const slippageEst = L.estimateSlippagePct({ dollarVol, price: sig.price });
      out.push({ ...sig, evolveHorizon: L.toEvolveHorizon(sig.horizon),
        liquidity: { ...(sig.liquidity || {}), slippageEst } });
    }
  }
  return out;
}

// Regime-support scalar: how much resolved history the ledger holds in THIS regime
// (cold-start → low → keeps the system honest about what it hasn't seen yet).
function regimeSupportFor(perf, regimeLabel) {
  let n = 0;
  for (const sp of Object.values((perf && perf.bySpecialist) || {})) {
    for (const [k, v] of Object.entries(sp.byContext || {})) if (k.startsWith(regimeLabel + '|')) n += v.n || 0;
  }
  return { value: +Math.min(1, n / 40).toFixed(2), samples: n };
}

// The fixed, canonical barriers per horizon for the LIVE decision layer (stable breakeven).
const BARRIERS = { fast: L.barriersFor('fast'), swing: L.barriersFor('swing'), position: L.barriersFor('position') };

// ── PURE payload assembly (unit-testable without network) ────────────────────────────
// signals: enriched decision-engine signals; ledgers: { perf, model }; regimeVector + label.
function buildEvolvePayload(signals, { regimeVector = null, regime = {}, perf = null, model = null } = {}) {
  const regimeLabel = regimeVector ? regimeVector.label : (regime.bearish ? 'risk-off' : regime.riskOn ? 'risk-on' : 'neutral');
  const support = regimeSupportFor(perf, regimeLabel);
  const ctx = {
    regime: { ...regime, label: regimeLabel },
    regimeVector,
    perfBySpecialist: (perf && perf.bySpecialist) || {},
    driftBySpecialist: (perf && perf.driftBySpecialist) || {},
    calibrator: (model && model.calibrator) || null,
    barriersByHorizon: BARRIERS,
    regimeSupport: support.value,
    priorP: 0.4,
  };
  const built = E.buildEvolve(signals, ctx);
  // Index the original signals so cards can show display fields (levels, evidence, track record).
  const byKey = new Map(signals.map(s => [s.ticker + '|' + s.evolveHorizon, s]));
  const decorate = (c) => {
    const sig = byKey.get(c.ticker + '|' + c.horizon) || {};
    return { ...c,
      company: sig.company || c.company || null,
      entry: c.entry ?? sig.entry ?? null, stop: c.stop ?? sig.stop ?? null, target: c.target ?? sig.target ?? null,
      sector: sig.sector || null, sectorStrength: sig.sectorStrength ?? null,
      evidenceFamilies: sig.evidenceFamilies || [], evidence: sig.evidence || null,
      expectancy: sig.expectancy || null, regimeFitLabel: sig.regimeFit != null ? sig.regimeFit : null,
      event: sig.event || null, catalyst: sig.catalyst || null, sourcesLabel: (c.sources || []).join(', '),
      reasons: topReasons(c, sig), primaryRisk: primaryRisk(c, sig), whyNow: whyNow(c, sig, regimeLabel),
      sampleSupport: { effN: c.effSample, byContext: c.contribs.map(x => ({ specialist: x.specialist, n: x.ctxN, globalN: x.globalN, cold: x.cold })) },
    };
  };
  const byHorizon = {};
  for (const h of L.EVOLVE_HORIZONS) byHorizon[h] = (built.byHorizon[h] || []).map(decorate);
  return {
    version: E.EVOLVE_VERSION,
    regime: { label: regimeLabel, vector: regimeVector, support },
    byHorizon, counts: built.counts, abstainedSample: built.abstainedSample,
    horizonMeta: L.HORIZON_META, specialistLegend: built.specialistLegend, decisionLegend: built.decisionLegend,
    modelHealth: { calibrated: !!ctx.calibrator, calibrationError: ctx.calibrator ? ctx.calibrator.error : null,
      resolvedSamples: (perf && perf.n) || 0, activeModel: (model && model.activeId) || null,
      regimeSupportSamples: support.samples },
  };
}

// Up to three INDEPENDENT reasons (distinct evidence families + supportive specialists).
function topReasons(c, sig) {
  const reasons = [];
  const D = require('./decision');
  const fams = (sig.evidenceFamilies || []).slice(0, 3);
  for (const f of fams) reasons.push({ kind: 'evidence', text: D.FAMILY_LABEL[f] || f });
  for (const sp of (c.specialists || []).slice(0, 3 - reasons.length)) {
    const m = E.SPECIALIST_META[sp]; if (m) reasons.push({ kind: 'specialist', text: `${m.icon} ${m.label}` });
  }
  if (c.expectedPayoff != null && c.expectedPayoff > 0)
    reasons.push({ kind: 'payoff', text: `+${(c.expectedPayoff * 100).toFixed(1)}% expected net payoff` });
  return reasons.slice(0, 3);
}
// The single most important contradicting evidence / risk.
function primaryRisk(c, sig) {
  if (c.regimeVeto) return 'Regime veto — longs stand down in risk-off (the app’s one validated lever).';
  if (c.liquidityWarn) return `Execution friction: ${(c.liquidityWarn || []).join(', ')}.`;
  if (c.effSample < E.GUARDRAILS.minEffSample) return `Thin track record in this context (n≈${Math.round(c.effSample)}) — probabilities are uncertain.`;
  if (sig && sig.event && sig.event.kind === 'binary') return `Earnings/binary event inside the hold window — gap risk.`;
  if (c.extensionPenalty > 0) return 'Already extended — limited room, poorer reward:risk left.';
  if (c.uncertainty && c.uncertainty.width != null && c.uncertainty.width > 0.3) return 'Wide probability band — low confidence.';
  return 'Standard market risk; size accordingly.';
}
function whyNow(c, sig, regimeLabel) {
  const p = c.probability != null ? `${Math.round(c.probability * 100)}%` : 'n/a';
  const be = `${Math.round(c.breakeven * 100)}%`;
  const specs = (c.specialists || []).map(s => (E.SPECIALIST_META[s] || {}).label).filter(Boolean).join(' + ');
  return `${specs || 'Signals'} firing in a ${regimeLabel} tape. Calibrated ${p} chance of the +${Math.round(c.barriers.up * 100)}% barrier before −${Math.round(c.barriers.down * 100)}% (breakeven ${be}). Expected net payoff ${c.expectedPayoff != null ? (c.expectedPayoff >= 0 ? '+' : '') + (c.expectedPayoff * 100).toFixed(1) + '%' : 'n/a'}.`;
}

// ── op=evolve (live candidates) ──────────────────────────────────────────────────────
async function runEvolve(req, res) {
  const [today, sectors] = await Promise.all([pull('/api/tracker?op=today'), pull('/api/sectors')]);
  if (!today.ok || !today.data) {
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.json({ ok: true, version: E.EVOLVE_VERSION, degraded: true, note: 'decision engine (op=today) unavailable', byHorizon: { fast: [], swing: [], position: [] }, counts: {} });
  }
  const regimeVector = await buildRegimeContext(sectors.data);
  const [perf, model] = await Promise.all([S.readEvolvePerf(), S.readEvolveModel()]);
  const signals = collectSignals(today.data);
  const payload = buildEvolvePayload(signals, { regimeVector, regime: today.data.regime || {}, perf, model });
  payload.freshness = { today: today.ok, sectors: sectors.ok, generatedAt: new Date().toISOString() };
  payload.configured = S.hasStore();
  // Live for 10 min, serve stale up to 24h while revalidating (matches op=today cadence).
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  return res.json({ ok: true, ...payload });
}

// ── op=evolvescore&log=1 (persist today's predictions for later resolution) ──────────
async function runEvolveScore(req, res) {
  const { date, isMarketClosed } = nowET();
  const log = req.query.log === '1';
  const [today, sectors] = await Promise.all([pull('/api/tracker?op=today'), pull('/api/sectors')]);
  if (!today.ok || !today.data) return res.json({ ok: false, note: 'op=today unavailable' });
  const regimeVector = await buildRegimeContext(sectors.data);
  const [perf, model] = await Promise.all([S.readEvolvePerf(), S.readEvolveModel()]);
  const signals = collectSignals(today.data);
  const payload = buildEvolvePayload(signals, { regimeVector, regime: today.data.regime || {}, perf, model });

  // Persist the surfaced predictions (trade/probe/watch) with everything resolution needs.
  const preds = [];
  for (const h of L.EVOLVE_HORIZONS) for (const c of payload.byHorizon[h]) {
    const entry = c.entry ?? c.price;
    if (!Number.isFinite(entry)) continue;
    preds.push({
      id: `${date}|${c.ticker}|${h}`, ticker: c.ticker, predDate: date, evolveHorizon: h,
      entry: +entry, barriers: c.barriers, specialists: c.specialists,
      contribs: c.contribs.map(x => ({ specialist: x.specialist, p: x.p })),
      probability: c.probability, decision: c.decision, contextKey: c.contextKey,
      sector: c.sector || null, cap: c.cap || null,
    });
  }
  let logged = 0;
  if (log && S.hasStore() && !isMarketClosed && preds.length) {
    try { await S.writeEvolveDay(date, { regimeVector, predictions: preds, counts: payload.counts }); logged = preds.length; }
    catch (e) { payload.logError = String((e && e.message) || e); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, date, logged, predictions: preds.length, closed: isMarketClosed, counts: payload.counts });
}

// ── op=evolveresolve (triple-barrier resolution + perf/calibrator update) ────────────
async function runEvolveResolve(req, res) {
  if (!S.hasStore()) return res.json({ ok: false, note: 'Blob storage not configured' });
  const t0 = Date.now();
  const { fetchDailyHistory } = require('./screener');
  const [days, resolved] = await Promise.all([S.readAllEvolveDays(), S.readEvolveResolved()]);
  const { date: today } = nowET();

  // Which predictions are matured (window elapsed) and unresolved? Group by ticker so
  // each ticker's candles are fetched once for all its horizons.
  const pending = [];
  for (const d of days) for (const p of (d.predictions || [])) {
    if (resolved[p.id]) continue;
    const calDaysNeeded = Math.ceil((p.barriers.window || 21) * 1.5) + 2;   // trading→calendar buffer
    if (daysBetween(p.predDate, today) < calDaysNeeded) continue;           // not yet mature
    pending.push(p);
  }
  const byTicker = new Map();
  for (const p of pending) (byTicker.get(p.ticker) || byTicker.set(p.ticker, []).get(p.ticker)).push(p);
  const tickers = [...byTicker.keys()].slice(0, MAX_RESOLVE_TICKERS);

  const benchCache = new Map();
  const getBench = async (sym) => {
    if (!sym) return null;
    if (benchCache.has(sym)) return benchCache.get(sym);
    const r = await fetchDailyHistory(sym, '1y').catch(() => null);
    const c = r ? r.candles : null; benchCache.set(sym, c); return c;
  };
  const spy = await getBench('SPY');

  let newlyResolved = 0, stillPending = 0;
  for (const t of tickers) {
    if (Date.now() - t0 > RESOLVE_DEADLINE_MS) break;
    const hist = await fetchDailyHistory(t, '1y').catch(() => null);
    if (!hist) continue;
    for (const p of byTicker.get(t)) {
      const fwd = L.sliceForward(hist.candles, p.predDate, (p.barriers.window || 21) + 5);
      const core = L.tripleBarrier(fwd, p.entry, p.barriers);
      if (!core.resolved) { stillPending++; continue; }
      const secEtf = etfForSector(p.sector);
      const [spyFwd, secFwd] = [L.sliceForward(spy || [], p.predDate, (p.barriers.window || 21) + 5),
        L.sliceForward((await getBench(secEtf)) || [], p.predDate, (p.barriers.window || 21) + 5)];
      const spyRet = L.benchmarkReturn(spyFwd, p.barriers.window), secRet = L.benchmarkReturn(secFwd, p.barriers.window);
      resolved[p.id] = {
        ticker: p.ticker, predDate: p.predDate, horizon: p.evolveHorizon, contextKey: p.contextKey,
        specialists: p.specialists, contribs: p.contribs, probability: p.probability, decision: p.decision,
        won: core.won, barrier: core.barrier, label: core.label, terminalReturn: core.terminalReturn,
        mfe: core.mfe, mae: core.mae, barsToBarrier: core.barsToBarrier,
        spyRelReturn: spyRet == null ? null : +(core.terminalReturn - spyRet).toFixed(4),
        sectorRelReturn: secRet == null ? null : +(core.terminalReturn - secRet).toFixed(4),
        resolvedAt: today,
      };
      newlyResolved++;
    }
  }
  await S.writeEvolveResolved(resolved);
  // Full recompute of specialist performance + calibrator from ALL resolved (idempotent,
  // no read-modify-write race on counts).
  const perf = recomputePerf(resolved);
  const calibrator = E.fitCalibrator(Object.values(resolved).map(r => ({ p: r.probability, won: r.won })));
  await S.writeEvolvePerf(perf);
  if (calibrator) { const model = await S.readEvolveModel(); model.calibrator = calibrator; model.updatedAt = today;
    if (!model.activeId) model.activeId = 'evolve-' + today; await S.writeEvolveModel(model); }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, newlyResolved, stillPending, totalResolved: Object.keys(resolved).length,
    tickersProcessed: tickers.length, pendingTickers: byTicker.size, calibrated: !!calibrator, ms: Date.now() - t0 });
}

// Rebuild bySpecialist {global, byContext, recent} + driftBySpecialist from resolved.
function recomputePerf(resolved) {
  const rows = Object.values(resolved).sort((a, b) => (a.predDate < b.predDate ? -1 : 1));
  const bySpecialist = {};
  const ensure = (sp) => (bySpecialist[sp] || (bySpecialist[sp] = { global: { wins: 0, n: 0 }, byContext: {}, _recent: [] }));
  for (const r of rows) {
    const won = r.won ? 1 : 0;
    for (const cb of (r.contribs || (r.specialists || []).map(s => ({ specialist: s, p: r.probability })))) {
      const sp = ensure(cb.specialist);
      sp.global.n++; sp.global.wins += won;
      const cx = sp.byContext[r.contextKey] || (sp.byContext[r.contextKey] = { wins: 0, n: 0 });
      cx.n++; cx.wins += won;
      sp._recent.push({ p: cb.p, ret: r.terminalReturn, won });
    }
  }
  const driftBySpecialist = {};
  for (const [sp, o] of Object.entries(bySpecialist)) {
    const recent = o._recent.slice(-RECENT_WINDOW);
    const globalHit = o.global.n ? o.global.wins / o.global.n : 0.4;
    const recentHit = recent.length ? recent.filter(x => x.won).length / recent.length : globalHit;
    const ic = recent.length >= 8 ? spearman(recent.map(x => x.p), recent.map(x => x.ret)) : null;
    o.recent = { n: recent.length, hit: +recentHit.toFixed(3), ic: ic == null ? null : +ic.toFixed(3),
      // recency-performance factor consumed by metaWeights (bounded ± around global).
      edge: +Math.max(-0.15, Math.min(0.15, recentHit - globalHit)).toFixed(3) };
    if (o.recent.ic == null) o.recent.ic = o.recent.edge;   // fall back to hit-edge when IC not yet estimable
    delete o._recent;
    // Drift: recent hit-rate materially below the global baseline (Wilson-guarded so a
    // small unlucky streak doesn't false-alarm). Mirrors the app's asymmetric drift rule.
    if (recent.length >= 15) {
      const up = wilson(recent.filter(x => x.won).length, recent.length).hi;
      if (up < globalHit - 0.15) driftBySpecialist[sp] = 'BROKEN';
      else if (recentHit < globalHit - 0.08) driftBySpecialist[sp] = 'DEGRADING';
    }
  }
  return { version: E.EVOLVE_VERSION, bySpecialist, driftBySpecialist, n: rows.length, updatedAt: new Date().toISOString() };
}
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

// ── op=evolvehealth (drift / calibration / coverage / per-specialist record) ─────────
async function runEvolveHealth(req, res) {
  const [perf, model, resolved] = await Promise.all([S.readEvolvePerf(), S.readEvolveModel(), S.readEvolveResolved()]);
  const rows = Object.values(resolved || {});
  // Rank-quality of the calibrated probability as a ranker of realized outcomes.
  const rq = RQ.analyzeRankQuality(rows.map(r => ({ score: (r.probability || 0) * 100, outcome: r.terminalReturn, won: r.won })), { minN: 20 });
  const cal = rows.length ? RQ.calibration(rows.map(r => ({ score: (r.probability || 0) * 100, won: r.won })), 5) : null;
  const specialists = Object.entries((perf && perf.bySpecialist) || {}).map(([sp, o]) => ({
    specialist: sp, meta: E.SPECIALIST_META[sp], global: o.global, recent: o.recent,
    drift: (perf.driftBySpecialist || {})[sp] || 'HEALTHY',
    hitRate: o.global.n ? +(o.global.wins / o.global.n).toFixed(3) : null,
  })).sort((a, b) => (b.global.n) - (a.global.n));
  // Coverage: how many decision-days logged, resolved vs pending, abstention rate today.
  const days = await S.readAllEvolveDays().catch(() => []);
  const logged = days.reduce((s, d) => s + ((d.predictions || []).length), 0);
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  return res.json({ ok: true, version: E.EVOLVE_VERSION,
    resolved: rows.length, logged, decisionDays: days.length,
    calibrated: !!(model && model.calibrator), calibrationError: model && model.calibrator ? model.calibrator.error : null,
    rankQuality: rq, calibration: cal, specialists,
    note: rows.length < 20 ? 'Accruing — health metrics stabilize after ~20 resolved predictions.' : null });
}

// ── op=evolvewalkforward (OOS metrics over the accrued ledger vs baselines) ──────────
// The live ledger is out-of-sample by construction (predictions logged before outcomes
// were known). We report EVOLVE's realized precision/hit/payoff by decision-state and
// horizon, next to baselines computed on the SAME resolved set. Honest "accruing" when
// thin. (A full historical purged walk-forward would reuse lib/ghost-backtest.js — future.)
async function runEvolveWalkforward(req, res) {
  const resolved = await S.readEvolveResolved();
  const rows = Object.values(resolved || {});
  const summ = (items) => {
    if (!items.length) return { n: 0 };
    const wins = items.filter(x => x.won).length;
    const rets = items.map(x => x.terminalReturn);
    const spyRel = items.map(x => x.spyRelReturn).filter(v => v != null);
    return { n: items.length, hitRate: +(wins / items.length).toFixed(3),
      avgReturn: +(mean(rets) * 100).toFixed(2), medianReturn: +(median(rets) * 100).toFixed(2),
      avgSpyRel: spyRel.length ? +(mean(spyRel) * 100).toFixed(2) : null,
      wilsonLB: +wilson(wins, items.length).lo.toFixed(3) };
  };
  const byState = {};
  for (const st of E.DECISION_STATES) byState[st] = summ(rows.filter(r => r.decision === st));
  const byHorizon = {};
  for (const h of L.EVOLVE_HORIZONS) byHorizon[h] = summ(rows.filter(r => r.horizon === h));
  // Baselines on the same names: all-resolved (random eligible), and the SPY-relative
  // benchmark (0 excess = matched market). Momentum/52wk/RVOL baselines require replaying
  // the universe — surfaced as a documented gap, not silently faked.
  const baselines = {
    allEligible: summ(rows),
    tradeCandidatesVsSpy: byState.TRADE_CANDIDATE.avgSpyRel,
    note: 'Momentum / 52-wk-high / RVOL baselines need a universe replay (lib/ghost-backtest.js); not yet wired.',
  };
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({ ok: true, version: E.EVOLVE_VERSION, resolved: rows.length,
    byDecisionState: byState, byHorizon, baselines,
    verdict: rows.length < 30 ? 'accruing' : verdictFor(byState.TRADE_CANDIDATE),
    note: rows.length < 30 ? 'Out-of-sample ledger still accruing (need ~30 resolved for a read).' : null });
}
function verdictFor(trade) {
  if (!trade || !trade.n) return 'no-trades';
  if (trade.wilsonLB > 0.5 && (trade.avgSpyRel == null || trade.avgSpyRel > 0)) return 'edge-holding';
  if (trade.avgSpyRel != null && trade.avgSpyRel < 0) return 'no-edge-vs-market';
  return 'inconclusive';
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ── op=evolveomegawf (OMEGA Phase A: purged + embargoed historical walk-forward) ─────
// The rigorous OOS test op=evolvewalkforward's live-ledger read can't do yet: trains
// specialist performance only on the strict past, purges + embargoes the boundary so a
// 63-day label can't leak into the test block, and reports the purged read next to a
// deliberately leaky one so the leakage inflation is measured. Heavy (replays history) but
// READ-ONLY — rate-limited, not privileged. Never writes the ledger.
async function runEvolveOmegaWalkforward(req, res) {
  const scope = req.query.scope || 'large';
  const limit = req.query.limit != null ? +req.query.limit : 80;
  const months = req.query.months != null ? +req.query.months : 18;
  const step = req.query.step != null ? +req.query.step : 21;
  const range = /^(1|2|5)y$/.test(req.query.range || '') ? req.query.range : '2y';
  const folds = req.query.folds != null ? +req.query.folds : 4;
  const embargo = req.query.embargo != null ? +req.query.embargo : undefined;
  const volAdjust = req.query.volAdjust === '1' || req.query.volAdjust === 'true';
  // ?regime=favorable (risk-on+neutral) | riskon (risk-on only) | comma-list of labels
  const regimeAllow = req.query.regime === 'favorable' ? ['risk-on', 'neutral']
    : req.query.regime === 'riskon' ? ['risk-on']
    : (typeof req.query.regime === 'string' && req.query.regime) ? req.query.regime.split(',') : null;
  const { date } = nowET();
  const WF = require('./evolve-walkforward');
  const out = await WF.runEvolveOmegaWalkForward({ scope, limit, months, step, folds, embargo, volAdjust, regimeAllow, range, now: date, deadlineMs: 48000 });
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({ ok: true, ...out });
}

// ── op=evolvebackfill (seed specialist performance from history) ─────────────────────
// Heavy + writes → cron/manual-with-bearer only. Replays point-in-time, generates resolved
// triple-barrier labels, merges them into the ledger, and recomputes specialist performance
// so the LIVE ensemble is grounded in history immediately (instead of after weeks of accrual).
async function runEvolveBackfillOp(req, res) {
  if (!S.hasStore()) return res.json({ ok: false, note: 'Blob storage not configured' });
  const { runEvolveBackfill } = require('./evolve-backfill');
  const { date } = nowET();
  const scope = req.query.scope || 'large';
  const limit = req.query.limit != null ? +req.query.limit : 80;
  const months = req.query.months != null ? +req.query.months : 18;
  const step = req.query.step != null ? +req.query.step : 21;
  const { additions, stats } = await runEvolveBackfill({ scope, limit, months, step, now: date, deadlineMs: 48000 });
  const added = Object.keys(additions).length;
  if (added) {
    const resolved = await S.readEvolveResolved();
    Object.assign(resolved, additions);                 // bf|… ids never collide with live ids
    await S.writeEvolveResolved(resolved);
    const perf = recomputePerf(resolved);
    await S.writeEvolvePerf(perf);
    stats.totalResolved = Object.keys(resolved).length;
    stats.perfSummary = Object.fromEntries(Object.entries(perf.bySpecialist).map(([sp, o]) =>
      [sp, { n: o.global.n, hitRate: o.global.n ? +(o.global.wins / o.global.n).toFixed(3) : null, contexts: Object.keys(o.byContext).length }]));
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, added, stats });
}

module.exports = {
  runEvolve, runEvolveScore, runEvolveResolve, runEvolveHealth, runEvolveWalkforward, runEvolveOmegaWalkforward, runEvolveBackfillOp,
  buildEvolvePayload, collectSignals, recomputePerf, regimeSupportFor, etfForSector, BARRIERS,
};
